#!/usr/bin/env bash
# Android emulator (with Google Play) for GitHub Codespaces, viewable in the browser on port 6080.
# Usage:  bash android-play.sh [start|stop|logs|rebuild]
set -euo pipefail

DIR="$HOME/android-play"
IMAGE="android-play"
NAME="android"
CMD="${1:-start}"

write_files() {
mkdir -p "$DIR"

cat > "$DIR/Dockerfile" <<'DOCKEREOF'
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android \
    ANDROID_SDK_ROOT=/opt/android \
    DISPLAY=:0
ENV PATH=$PATH:/opt/android/cmdline-tools/latest/bin:/opt/android/platform-tools:/opt/android/emulator

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless wget unzip ca-certificates procps \
    xvfb x11vnc novnc websockify fluxbox \
    libgl1 libpulse0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 \
    libasound2 libx11-xcb1 libxkbfile1 libxrandr2 libxdamage1 libxfixes3 \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/android/cmdline-tools && cd /opt/android/cmdline-tools \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O t.zip \
    && unzip -q t.zip && rm t.zip && mv cmdline-tools latest

RUN yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "emulator" "platforms;android-34" \
       "system-images;android-34;google_apis_playstore;x86_64"

RUN echo no | avdmanager create avd -n pixel --force -d pixel_6 \
       -k "system-images;android-34;google_apis_playstore;x86_64" \
    && sed -i 's/^hw.lcd.width=.*/hw.lcd.width=720/; s/^hw.lcd.height=.*/hw.lcd.height=1560/; s/^hw.lcd.density=.*/hw.lcd.density=320/' \
       /root/.android/avd/pixel.avd/config.ini

COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 6080
CMD ["/start.sh"]
DOCKEREOF

cat > "$DIR/start.sh" <<'STARTEOF'
#!/usr/bin/env bash
Xvfb :0 -screen 0 900x1650x24 &
sleep 2
fluxbox &
x11vnc -display :0 -forever -shared -nopw -rfbport 5900 -quiet &
websockify --web /usr/share/novnc 6080 localhost:5900 &
exec emulator -avd pixel -no-audio -no-snapshot -no-boot-anim \
  -gpu swiftshader_indirect -memory 3072 -cores 3 -accel on
STARTEOF
}

case "$CMD" in
  start|rebuild)
    if [ ! -e /dev/kvm ]; then
      echo "ERROR: /dev/kvm not found. Use a 4-core+ Codespace machine type (hardware virtualization is required)."
      exit 1
    fi
    write_files
    if [ "$CMD" = "rebuild" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "Building image (first time takes several minutes, ~5 GB download)..."
      docker build -t "$IMAGE" "$DIR"
    fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" --device /dev/kvm -p 6080:6080 "$IMAGE"
    echo
    echo "Started. Android takes 1-3 minutes to boot."
    echo "Open the Ports tab, find port 6080, and open it in the browser, then go to:"
    echo "  /vnc.html?autoconnect=true&resize=scale"
    ;;
  stop)
    docker rm -f "$NAME"
    ;;
  logs)
    docker logs -f "$NAME"
    ;;
  *)
    echo "Usage: bash android-play.sh [start|stop|logs|rebuild]"
    exit 1
    ;;
esac
