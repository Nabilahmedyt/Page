#!/usr/bin/env node
'use strict';
/*
  Remote Browser for GitHub Codespaces  (single file, zero dependencies, Node 18.14+)

  Run:   node server.js
  Open:  Ports tab -> port 3000 -> click the globe icon

  How it works: your Codespace visits the site itself (its own cookies, browser-like
  headers, redirects handled server-side), rewrites the page so every link/image/script/
  stylesheet comes back through this app, and hands the finished page to your browser.
*/

const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');

const PORT = Number(process.env.PORT) || 3000;
const SEARCH_URL = 'https://duckduckgo.com/html/?q='; // used when you type something that isn't a URL
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ helpers */

const enc = s => Buffer.from(s).toString('base64url');
const dec = s => Buffer.from(s, 'base64url').toString();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// /p/<base64url(origin)>/path?query  ->  { origin, rest }
function parseProxyPath(p) {
  const m = /^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(p);
  if (!m) return null;
  try {
    const o = dec(m[1]);
    if (!/^https?:\/\/[^\/]+$/.test(o)) return null;
    return { origin: o, rest: m[2] || '/' };
  } catch { return null; }
}

function fromProxyUrl(s) {
  try {
    const u = new URL(s);
    const p = parseProxyPath(u.pathname);
    return p ? p.origin + p.rest + u.search : null;
  } catch { return null; }
}

function isBlocked(host) {
  if (process.env.ALLOW_LOCAL) return false;
  return /^(localhost|.*\.localhost|.*\.internal)$/i.test(host) ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) ||
    host === '[::1]' || /^\[f[cd]/i.test(host);
}

function fail(res, code, title, detail) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font:16px system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#444">' +
    '<h2>' + esc(title) + '</h2><p>' + esc(detail) + '</p></body>');
}

const readBody = req => new Promise((ok, no) => {
  const c = [];
  req.on('data', d => c.push(d));
  req.on('end', () => ok(Buffer.concat(c)));
  req.on('error', no);
});

/* ------------------------------------------------------------ cookie jars */
// Cookies live here on the server, like a real browser's cookie store.

const sessions = new Map(); // session id -> array of cookies
const sidOf = req => (/(?:^|;\s*)__psid=([a-f0-9]{32})/.exec(req.headers.cookie || '') || [])[1];

function getJar(req, res) {
  let sid = sidOf(req);
  if (!sid) {
    sid = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', '__psid=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000');
  }
  if (!sessions.has(sid)) sessions.set(sid, []);
  return sessions.get(sid);
}

function cookieString(jar, url, forScript) {
  const now = Date.now(), host = url.hostname, path = url.pathname, out = [];
  for (const c of jar) {
    if (c.exp && c.exp < now) continue;
    if (forScript && c.httpOnly) continue;
    if (c.secure && url.protocol !== 'https:') continue;
    const ok = c.hostOnly ? host === c.domain : (host === c.domain || host.endsWith('.' + c.domain));
    if (ok && path.startsWith(c.path)) out.push(c.name + '=' + c.value);
  }
  return out.join('; ');
}

function setCookie(jar, url, line, fromScript) {
  const [nv, ...attrs] = line.split(';');
  const i = nv.indexOf('=');
  if (i < 1) return;
  const c = { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim(), domain: url.hostname, hostOnly: true, path: '/', secure: false, httpOnly: false, exp: 0 };
  let maxAge = null, expires = 0;
  for (const a of attrs) {
    const j = a.indexOf('=');
    const k = (j < 0 ? a : a.slice(0, j)).trim().toLowerCase();
    const v = j < 0 ? '' : a.slice(j + 1).trim();
    if (k === 'domain' && v) {
      const d = v.replace(/^\./, '').toLowerCase();
      if (url.hostname === d || url.hostname.endsWith('.' + d)) { c.domain = d; c.hostOnly = false; }
    } else if (k === 'path' && v[0] === '/') c.path = v;
    else if (k === 'secure') c.secure = true;
    else if (k === 'httponly' && !fromScript) c.httpOnly = true;
    else if (k === 'max-age') maxAge = parseInt(v, 10);
    else if (k === 'expires') expires = Date.parse(v) || 0;
  }
  c.exp = maxAge !== null && !isNaN(maxAge) ? Date.now() + maxAge * 1000 : expires;
  const idx = jar.findIndex(x => x.name === c.name && x.domain === c.domain && x.path === c.path);
  if (idx >= 0) jar.splice(idx, 1);
  if (c.exp && c.exp <= Date.now()) return; // expired = deleted
  if (jar.length < 3000) jar.push(c);
}

/* ----------------------------------------------------------- page rewriting */

const SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|sms:|#|ws:|wss:)/i;

function rw(raw, base) {
  if (!raw) return raw;
  const s = raw.trim();
  if (!s || SKIP.test(s)) return raw;
  try {
    const u = new URL(s, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    return '/p/' + enc(u.origin) + u.pathname + u.search + u.hash;
  } catch { return raw; }
}

const rwAttr = (v, base) => rw(v.replace(/&amp;/g, '&'), base).replace(/&/g, '&amp;');

const rwSrcset = (v, base) => v.split(/,\s+/).map(part => {
  const t = part.trim();
  if (!t) return t;
  const [u, ...d] = t.split(/\s+/);
  return [rwAttr(u, base), ...d].join(' ');
}).join(', ');

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) => 'url(' + q + rw(u, base) + q + ')')
    .replace(/@import\s+(['"])(.*?)\1/gi, (m, q, u) => '@import ' + q + rw(u, base) + q);
}

function rewriteHtml(html, base) {
  const bm = /<base\s[^>]*?href\s*=\s*["']([^"']+)["']/i.exec(html);
  if (bm) { try { base = new URL(bm[1], base).href; } catch {} }

  html = html
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/\s(?:integrity|nonce)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/(\s(?:src|href|action|poster|formaction|data-src|data-href|data-original|background)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
      (m, pre, dq, sq) => { const q = dq !== undefined ? '"' : "'"; return pre + q + rwAttr(dq !== undefined ? dq : sq, base) + q; })
    .replace(/(\s(?:srcset|data-srcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
      (m, pre, dq, sq) => { const q = dq !== undefined ? '"' : "'"; return pre + q + rwSrcset(dq !== undefined ? dq : sq, base) + q; })
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, b, c) => a + rewriteCss(b, base) + c)
    .replace(/(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, dq, sq) => {
      const v = dq !== undefined ? dq : sq, q = dq !== undefined ? '"' : "'";
      return pre + q + (v.includes('url(') ? rewriteCss(v, base) : v) + q;
    })
    .replace(/(<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*?content\s*=\s*["'][^"']*?url\s*=\s*)([^"'>\s]+)/gi, (m, a, u) => a + rwAttr(u, base));

  const inject = '<meta name="referrer" content="same-origin"><script src="/__shim.js"></script>';
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, m => m + inject);
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, m => m + inject);
  else html = html.replace(/^(\s*<!doctype[^>]*>)?/i, m => m + inject);
  return html;
}

function decodeText(buf, ct) {
  let cs = (/charset=["']?([\w-]+)/i.exec(ct) || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1')) || [])[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

/* -------------------------------------------------------------- the fetcher */

const DROP = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie',
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security',
  'report-to', 'nel', 'alt-svc', 'link', 'referrer-policy', 'permissions-policy', 'location',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'access-control-allow-origin', 'access-control-allow-credentials', 'clear-site-data'
]);

async function proxy(req, res, url) {
  const p = parseProxyPath(url.pathname);
  if (!p) return fallback(req, res, url);

  let target;
  try { target = new URL(p.origin + p.rest + url.search); } catch { return fail(res, 400, 'Bad address', 'That address is not valid.'); }
  if (isBlocked(target.hostname)) return fail(res, 403, 'Address blocked', 'Local and private addresses are blocked. Start with ALLOW_LOCAL=1 to allow them.');

  const jar = getJar(req, res);
  const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readBody(req);
  const refReal = req.headers.referer && fromProxyUrl(req.headers.referer);

  const h = {
    'user-agent': UA,
    'accept': req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'referer': refReal || target.origin + '/'
  };
  if (req.headers['content-type']) h['content-type'] = req.headers['content-type'];
  if (req.headers.range) h.range = req.headers.range;
  if (body) { try { h.origin = refReal ? new URL(refReal).origin : target.origin; } catch { h.origin = target.origin; } }
  const ck = cookieString(jar, target, false);
  if (ck) h.cookie = ck;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);
  let r;
  try {
    r = await fetch(target, { method: req.method, headers: h, body, redirect: 'manual', signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    return fail(res, 502, "Couldn't reach " + target.host, (e.cause && (e.cause.code || e.cause.message)) || e.message);
  }
  clearTimeout(timer);

  for (const sc of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) setCookie(jar, target, sc, false);

  const out = {};
  for (const [k, v] of r.headers) if (!DROP.has(k)) out[k] = v;

  // Redirects: pass them on (rewritten) so the browser follows them through us.
  const loc = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && loc) {
    out.location = rw(loc, target.href);
    res.writeHead(r.status, out);
    return res.end();
  }

  const ct = r.headers.get('content-type') || '';
  const isHtml = /text\/html|application\/xhtml/i.test(ct);
  const isCss = /text\/css/i.test(ct);

  if ((isHtml || isCss) && req.method !== 'HEAD') {
    const buf = Buffer.from(await r.arrayBuffer());
    const txt = decodeText(buf, ct);
    const outBuf = Buffer.from(isHtml ? rewriteHtml(txt, target.href) : rewriteCss(txt, target.href), 'utf8');
    out['content-type'] = (isHtml ? 'text/html' : 'text/css') + '; charset=utf-8';
    out['content-length'] = outBuf.length;
    res.writeHead(r.status, out);
    return res.end(outBuf);
  }

  // Everything else (images, video, fonts, JS, JSON, downloads) streams straight through.
  const len = r.headers.get('content-length');
  if (len && !r.headers.get('content-encoding')) out['content-length'] = len;
  res.writeHead(r.status, out);
  if (!r.body || req.method === 'HEAD') return res.end();
  const s = Readable.fromWeb(r.body);
  s.on('error', () => res.destroy());
  res.on('close', () => s.destroy());
  s.pipe(res);
}

// Stray root-relative requests (e.g. "/img/x.png" built by JS) -> send them to the site the page came from.
function fallback(req, res, url) {
  const real = req.headers.referer && fromProxyUrl(req.headers.referer);
  if (real) {
    try {
      res.writeHead(307, { location: '/p/' + enc(new URL(real).origin) + url.pathname + url.search });
      return res.end();
    } catch {}
  }
  fail(res, 404, 'Not found', 'Nothing here.');
}

async function cookieApi(req, res, url) {
  const jar = getJar(req, res);
  let target;
  try { target = new URL(url.searchParams.get('u')); } catch { res.writeHead(400); return res.end(); }
  if (req.method === 'POST') {
    setCookie(jar, target, (await readBody(req)).toString(), true);
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.end(cookieString(jar, target, true));
}

/* ------------------------------------------- client script injected in pages */
// Runs inside every proxied page: keeps JS-made requests, popups, history and
// document.cookie working, and reports title/URL to the browser UI.

function shim() {
  if (window.__px) return;
  window.__px = 1;

  const enc = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const dec = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const parse = pathname => {
    const m = /^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
    if (!m) return null;
    try { const o = dec(m[1]); return /^https?:\/\/[^\/]+$/.test(o) ? o + (m[2] || '/') : null; } catch (e) { return null; }
  };
  const real = () => { const p = parse(location.pathname); return p ? p + location.search + location.hash : location.href; };
  const SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|sms:|#|ws:|wss:)/i;
  const SPECIAL = /^\/__(cookie|clear|shim\.js)/;

  const toProxy = u => {
    if (u == null) return u;
    let s = String(u);
    if (!s.trim() || SKIP.test(s.trim())) return u;
    try {
      const b = new URL(s, location.href);
      if (b.origin === location.origin) {
        if (parse(b.pathname) || SPECIAL.test(b.pathname)) return u; // already ours
        s = b.pathname + b.search + b.hash;                           // root-relative on the real site
      }
      const a = new URL(s, real());
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return u;
      return '/p/' + enc(a.origin) + a.pathname + a.search + a.hash;
    } catch (e) { return u; }
  };
  const fromProxy = s => {
    try {
      const a = new URL(s, location.href);
      const p = a.origin === location.origin ? parse(a.pathname) : null;
      return p ? p + a.search + a.hash : a.href;
    } catch (e) { return String(s); }
  };
  const post = m => { try { if (window.parent !== window && window.parent === window.top) window.parent.postMessage(m, '*'); } catch (e) {} };

  // fetch / XHR / beacon
  const of = window.fetch;
  if (of) window.fetch = function (i, init) {
    try { i = (i instanceof Request) ? new Request(toProxy(i.url), i) : toProxy(i); } catch (e) {}
    return of.call(this, i, init);
  };
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { const a = [].slice.call(arguments); a[1] = toProxy(u); return xo.apply(this, a); };
  if (navigator.sendBeacon) { const sb = navigator.sendBeacon; navigator.sendBeacon = function (u, d) { return sb.call(navigator, toProxy(u), d); }; }

  // history API
  ['pushState', 'replaceState'].forEach(k => {
    const o = History.prototype[k];
    History.prototype[k] = function (s, t, u) { return o.call(this, s, t, u == null ? u : toProxy(u)); };
  });

  // element.src = ..., element.href = ..., setAttribute('src', ...)
  const pat = (C, p) => {
    try {
      const d = Object.getOwnPropertyDescriptor(C.prototype, p);
      if (!d || !d.set) return;
      Object.defineProperty(C.prototype, p, { configurable: true, enumerable: d.enumerable, get: d.get, set(v) { d.set.call(this, toProxy(v)); } });
    } catch (e) {}
  };
  [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLIFrameElement, 'src'], [HTMLSourceElement, 'src'],
   [HTMLMediaElement, 'src'], [HTMLEmbedElement, 'src'], [HTMLTrackElement, 'src'], [HTMLInputElement, 'src'],
   [HTMLLinkElement, 'href'], [HTMLAnchorElement, 'href'], [HTMLFormElement, 'action'], [HTMLObjectElement, 'data']
  ].forEach(x => pat(x[0], x[1]));

  const sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    const k = String(n).toLowerCase(), t = this.tagName;
    if (k === 'src' || k === 'href' || (k === 'action' && t === 'FORM') || (k === 'poster' && t === 'VIDEO') || (k === 'data' && t === 'OBJECT')) v = toProxy(v);
    return sa.call(this, n, v);
  };

  // popups / target=_blank -> new tab in the browser UI; never let a page replace the UI itself
  window.open = function (u) {
    if (u && !/^(about:|javascript:)/i.test(String(u))) { try { post({ px: 'open', url: new URL(String(u), real()).href }); } catch (e) {} }
    return null;
  };
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const t = (a.getAttribute('target') || '').toLowerCase();
    if (t === '_blank' || t === '_new' || e.ctrlKey || e.metaKey || e.button === 1) {
      e.preventDefault();
      const h = a.getAttribute('href');
      if (h && !/^(javascript:|#)/i.test(h)) post({ px: 'open', url: fromProxy(a.href) });
    } else if (t === '_top' || t === '_parent') sa.call(a, 'target', '_self');
  }, true);
  document.addEventListener('submit', e => {
    const f = e.target;
    if (f && typeof f.target === 'string' && /^_(top|parent|blank|new)$/i.test(f.target)) f.target = '_self';
  }, true);

  // document.cookie <-> the server-side cookie jar
  const ckCall = (method, body) => {
    try {
      const x = new XMLHttpRequest();
      xo.call(x, method, '/__cookie?u=' + encodeURIComponent(real()), false);
      xs.call(x, body);
      return x.responseText;
    } catch (e) { return ''; }
  };
  let ck = '', ckT = 0;
  try {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get() { if (Date.now() - ckT > 1000) { ck = ckCall('GET'); ckT = Date.now(); } return ck; },
      set(v) { ckCall('POST', String(v)); ckT = 0; }
    });
  } catch (e) {}

  // tell the browser UI where we are
  let last = '';
  const report = () => {
    try {
      const r = real(), l = document.querySelector('link[rel~="icon"]');
      const icon = l && l.href ? l.href : '/p/' + enc(new URL(r).origin) + '/favicon.ico';
      const s = JSON.stringify([r, document.title, icon]);
      if (s !== last) { last = s; post({ px: 'state', url: r, title: document.title, icon: icon }); }
    } catch (e) {}
  };
  addEventListener('DOMContentLoaded', report);
  addEventListener('load', report);
  addEventListener('beforeunload', () => post({ px: 'loading' }));
  setInterval(report, 800);
}

/* ------------------------------------------------------------ browser window */

function ui() {
  const $ = s => document.querySelector(s);
  const enc = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const prox = u => { const a = new URL(u); return '/p/' + enc(a.origin) + a.pathname + a.search + a.hash; };
  const norm = s => {
    s = s.trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[^\s\/]+\.[a-z]{2,}([\/?#]\S*)?$/i.test(s) || /^localhost(:\d+)?([\/?#]\S*)?$/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([\/?#]\S*)?$/.test(s)) return 'https://' + s;
    return window.SEARCH + encodeURIComponent(s);
  };

  const DEFAULTS = [['DuckDuckGo', 'https://duckduckgo.com/'], ['Wikipedia', 'https://en.wikipedia.org/'], ['YouTube', 'https://www.youtube.com/'], ['GitHub', 'https://github.com/'], ['Reddit', 'https://old.reddit.com/']];
  let bm = null;
  try { bm = JSON.parse(localStorage.getItem('bm')); } catch (e) {}
  if (!Array.isArray(bm)) bm = DEFAULTS.slice();

  const tabs = [];
  let active = null;
  const omni = $('#omni');

  let progOn = false;
  function setProg(on) {
    if (on === progOn) return;
    progOn = on;
    const p = $('#prog');
    if (on) { p.className = ''; void p.offsetWidth; p.className = 'go'; } else p.className = 'done';
  }

  function render() {
    tabs.forEach(t => {
      t.el.classList.toggle('on', t === active);
      t.el.querySelector('.ttl').textContent = t.title;
      const f = t.el.querySelector('.fav');
      f.classList.toggle('spin', t.loading);
      f.style.backgroundImage = t.icon && !t.loading ? 'url("' + t.icon.replace(/"/g, '%22') + '")' : '';
      t.frame.classList.toggle('on', t === active && !!t.url);
    });
    $('#newtab').hidden = !!active.url;
    if (document.activeElement !== omni) omni.value = active.url;
    $('#lock').textContent = !active.url ? '' : /^https:/i.test(active.url) ? '🔒' : 'ⓘ';
    $('#reload').textContent = active.loading ? '✕' : '↻';
    $('#reload').title = active.loading ? 'Stop' : 'Reload';
    $('#star').textContent = bm.some(b => b[1] === active.url) ? '★' : '☆';
    setProg(!!active.loading);
    document.title = active.url ? active.title + ' – Browser' : 'New Tab';
  }

  function renderBm() {
    const bar = $('#bm'), tiles = $('#tiles');
    bar.textContent = '';
    tiles.textContent = '';
    bm.forEach(b => {
      const c = document.createElement('div');
      c.className = 'chip';
      c.textContent = b[0];
      c.title = b[1];
      c.onclick = () => go(active, b[1]);
      bar.appendChild(c);
    });
    bm.slice(0, 8).forEach(b => {
      const d = document.createElement('div'), i = document.createElement('i'), s = document.createElement('span');
      d.className = 'tile';
      i.textContent = b[0].charAt(0);
      s.textContent = b[0];
      d.append(i, s);
      d.onclick = () => go(active, b[1]);
      tiles.appendChild(d);
    });
  }

  function go(t, input) {
    const u = norm(input);
    if (!u) return;
    let src;
    try { src = prox(u); } catch (e) { alert('That address is not valid.'); return; }
    t.url = u; t.loading = true; t.icon = ''; t.title = u.replace(/^https?:\/\//, '');
    t.frame.src = src;
    render();
  }

  function select(t) { active = t; render(); }

  function close(t) {
    const i = tabs.indexOf(t);
    tabs.splice(i, 1);
    t.el.remove();
    t.frame.remove();
    if (!tabs.length) { newTab(); return; }
    if (active === t) active = tabs[Math.min(i, tabs.length - 1)];
    render();
  }

  function newTab(url) {
    const t = { title: 'New Tab', url: '', icon: '', loading: false };
    t.frame = document.createElement('iframe');
    t.frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock allow-presentation');
    t.frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture');
    t.frame.addEventListener('load', () => { if (t.url) { t.loading = false; render(); } });
    $('#views').appendChild(t.frame);

    t.el = document.createElement('div');
    t.el.className = 'tab';
    t.el.innerHTML = '<span class="fav"></span><span class="ttl"></span><button class="x" title="Close tab">×</button>';
    t.el.addEventListener('click', () => select(t));
    t.el.addEventListener('auxclick', e => { if (e.button === 1) close(t); });
    t.el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); close(t); });
    $('#tabs').appendChild(t.el);

    tabs.push(t);
    active = t;
    render();
    t.el.scrollIntoView({ inline: 'nearest' });
    if (url) go(t, url);
    return t;
  }

  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || !d.px) return;
    const t = tabs.find(x => x.frame.contentWindow === e.source);
    if (!t) return;
    if (d.px === 'open' && /^https?:\/\//i.test(d.url || '')) { newTab(d.url); return; }
    if (d.px === 'loading') t.loading = true;
    if (d.px === 'state') { t.url = d.url; t.title = d.title || d.url.replace(/^https?:\/\//, ''); t.icon = d.icon || ''; t.loading = false; }
    render();
  });

  omni.addEventListener('keydown', e => { if (e.key === 'Enter') { go(active, omni.value); omni.blur(); } });
  omni.addEventListener('focus', () => setTimeout(() => omni.select(), 0));
  omni.addEventListener('blur', render);

  $('#ntp').addEventListener('keydown', e => { if (e.key === 'Enter') { go(active, e.target.value); e.target.value = ''; } });
  $('#plus').onclick = () => newTab();
  $('#back').onclick = () => { try { active.frame.contentWindow.history.back(); } catch (e) {} };
  $('#fwd').onclick = () => { try { active.frame.contentWindow.history.forward(); } catch (e) {} };
  $('#reload').onclick = () => {
    if (active.loading) { try { active.frame.contentWindow.stop(); } catch (e) {} active.loading = false; render(); }
    else if (active.url) { try { active.frame.contentWindow.location.reload(); active.loading = true; render(); } catch (e) { go(active, active.url); } }
  };
  $('#home').onclick = () => { active.url = ''; active.title = 'New Tab'; active.icon = ''; active.loading = false; active.frame.src = 'about:blank'; render(); };
  $('#star').onclick = () => {
    if (!active.url) return;
    const i = bm.findIndex(b => b[1] === active.url);
    if (i >= 0) bm.splice(i, 1); else bm.push([(active.title || active.url).slice(0, 24), active.url]);
    try { localStorage.setItem('bm', JSON.stringify(bm)); } catch (e) {}
    renderBm();
    render();
  };

  const menu = $('#menu');
  $('#dots').onclick = () => { menu.hidden = !menu.hidden; };
  menu.addEventListener('click', e => {
    const a = e.target.dataset.act;
    menu.hidden = true;
    if (a === 'new') newTab();
    if (a === 'full') (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
    if (a === 'clear') fetch('/__clear', { method: 'POST' }).then(() => alert('Cookies and site data cleared.'));
  });
  document.addEventListener('click', e => { if (!e.target.closest('#menu, #dots')) menu.hidden = true; });
  window.addEventListener('blur', () => { menu.hidden = true; });

  renderBm();
  newTab(new URLSearchParams(location.search).get('url') || '');
}

const UI_CSS = `
:root{--frame:#dee1e6;--bar:#fff;--text:#202124;--sub:#5f6368;--pill:#f1f3f4;--hover:rgba(60,64,67,.12);--accent:#1a73e8;--line:#dadce0}
@media(prefers-color-scheme:dark){:root{--frame:#202124;--bar:#35363a;--text:#e8eaed;--sub:#9aa0a6;--pill:#202124;--hover:rgba(255,255,255,.12);--accent:#8ab4f8;--line:#4a4c50}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--bar)}
#app{position:relative;display:flex;flex-direction:column;height:100%}
#strip{display:flex;align-items:flex-end;gap:4px;padding:8px 8px 0;background:var(--frame)}
#tabs{display:flex;align-items:flex-end;min-width:0;overflow-x:auto;scrollbar-width:none}
#tabs::-webkit-scrollbar{display:none}
.tab{display:flex;flex:0 1 200px;align-items:center;gap:8px;width:200px;min-width:56px;height:32px;padding:0 6px 0 12px;border-radius:8px 8px 0 0;color:var(--sub);white-space:nowrap;cursor:default}
.tab:hover{background:var(--hover)}
.tab.on{background:var(--bar);color:var(--text)}
.fav{flex:none;width:16px;height:16px;border-radius:50%;background:var(--line) center/contain no-repeat}
.fav.spin{background:none;border:2px solid var(--line);border-top-color:var(--accent);animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.ttl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.x{flex:none;width:20px;height:20px;border:0;border-radius:50%;background:none;color:inherit;font-size:15px;line-height:1;cursor:pointer;opacity:.7}
.x:hover{background:var(--hover);opacity:1}
#plus{margin-bottom:3px}
#bar{display:flex;align-items:center;gap:4px;padding:6px 8px;background:var(--bar)}
.ib{flex:none;display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:50%;background:none;color:var(--sub);font-size:17px;cursor:pointer}
.ib:hover{background:var(--hover)}
#omniwrap{flex:1;min-width:0;display:flex;align-items:center;gap:8px;height:34px;padding:0 14px;border:1px solid transparent;border-radius:17px;background:var(--pill)}
#omniwrap:focus-within{border-color:var(--accent);background:var(--bar)}
#lock{font-size:11px;min-width:12px}
#omni{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--text);font:inherit;font-size:14px}
#prog{height:2px;width:0;background:var(--accent)}
#prog.go{width:85%;transition:width 10s cubic-bezier(.1,.8,.3,1)}
#prog.done{width:100%;opacity:0;transition:width .2s,opacity .4s .2s}
#bm{display:flex;align-items:center;gap:2px;min-height:30px;padding:2px 8px;overflow-x:auto;border-bottom:1px solid var(--line);scrollbar-width:none}
.chip{padding:4px 10px;border-radius:14px;font-size:12px;white-space:nowrap;cursor:pointer}
.chip:hover{background:var(--hover)}
#views{position:relative;flex:1;min-height:0;background:#fff}
#views iframe{position:absolute;inset:0;display:none;width:100%;height:100%;border:0;background:#fff}
#views iframe.on{display:block}
#newtab{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;padding:0 16px;background:var(--bar)}
#newtab[hidden]{display:none}
#newtab h1{margin:0;font-size:40px;font-weight:400;letter-spacing:-.5px}
#ntp{width:min(560px,100%);height:46px;padding:0 22px;border:1px solid var(--line);border-radius:23px;outline:0;background:var(--bar);color:var(--text);font-size:16px}
#ntp:focus{border-color:transparent;box-shadow:0 1px 8px rgba(32,33,36,.3)}
#tiles{display:flex;flex-wrap:wrap;justify-content:center;gap:16px;max-width:600px}
.tile{width:92px;text-align:center;cursor:pointer}
.tile i{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 6px;border-radius:50%;background:var(--pill);font-size:20px;font-style:normal;text-transform:uppercase}
#menu{position:absolute;top:84px;right:8px;z-index:10;min-width:230px;padding:6px 0;border:1px solid var(--line);border-radius:8px;background:var(--bar);box-shadow:0 4px 16px rgba(0,0,0,.28)}
#menu[hidden]{display:none}
#menu div{padding:9px 16px;cursor:pointer}
#menu div:hover{background:var(--hover)}
`;

const UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>New Tab</title>
<style>${UI_CSS}</style></head>
<body><div id="app">
  <div id="strip"><div id="tabs"></div><button class="ib" id="plus" title="New tab">+</button></div>
  <div id="bar">
    <button class="ib" id="back" title="Back">←</button>
    <button class="ib" id="fwd" title="Forward">→</button>
    <button class="ib" id="reload" title="Reload">↻</button>
    <button class="ib" id="home" title="New tab page">⌂</button>
    <div id="omniwrap"><span id="lock"></span><input id="omni" type="text" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" placeholder="Search or enter address"></div>
    <button class="ib" id="star" title="Bookmark this page">☆</button>
    <button class="ib" id="dots" title="Menu">⋮</button>
  </div>
  <div id="prog"></div>
  <div id="bm"></div>
  <div id="views">
    <div id="newtab"><h1>Browse</h1><input id="ntp" type="text" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Search or enter address"><div id="tiles"></div></div>
  </div>
  <div id="menu" hidden>
    <div data-act="new">New tab</div>
    <div data-act="full">Toggle full screen</div>
    <div data-act="clear">Clear cookies and site data</div>
  </div>
</div>
<script>window.SEARCH=${JSON.stringify(SEARCH_URL)};(${ui.toString()})();</script>
</body></html>`;

const SHIM_JS = '(' + shim.toString() + ')();';

/* ------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const fromPage = !!(req.headers.referer && fromProxyUrl(req.headers.referer));

    if ((p === '/' || p === '/index.html') && !fromPage) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(UI_HTML);
    }
    if (p === '/__shim.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(SHIM_JS);
    }
    if (p === '/__cookie') return await cookieApi(req, res, url);
    if (p === '/__clear') {
      const sid = sidOf(req);
      if (sid) sessions.delete(sid);
      res.writeHead(204);
      return res.end();
    }
    if (p.startsWith('/p/')) return await proxy(req, res, url);
    return fallback(req, res, url);
  } catch (e) {
    if (!res.headersSent) fail(res, 500, 'Something went wrong', String((e && e.message) || e));
    else res.destroy();
  }
});

process.on('uncaughtException', e => console.error('error:', e && e.message));
process.on('unhandledRejection', e => console.error('error:', e && e.message));

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Remote Browser is running on port ' + PORT);
  if (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    console.log('  Open: https://' + process.env.CODESPACE_NAME + '-' + PORT + '.' + process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN + '/');
  } else {
    console.log('  Open: http://localhost:' + PORT + '/');
  }
  console.log('  Keep the port set to Private so only you can use it.\n');
});
