// Web tools for Kestrel: search the web and read a page as text.
const dns = require('node:dns').promises;
const net = require('node:net');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) KSTRL/1.0 Safari/537.36';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});

function htmlToText(html) {
  return decode(html
    .replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => '\n' + '#'.repeat(+n) + ' ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// Don't let a page or prompt point Kestrel at this PC or the local network.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links can be opened');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('Local addresses are blocked');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (ips.some(privateIp)) throw new Error('Local and private network addresses are blocked');
  return u;
}

async function fetchUrl(raw, { maxChars = 20000 } = {}) {
  let u = await checkUrl(raw);
  let res;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(u, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(15000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = await checkUrl(new URL(res.headers.get('location'), u).toString()); continue; }
    break;
  }
  if (!res.ok) throw new Error(`The page answered ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/text|json|xml|javascript/.test(type)) throw new Error(`Not a text page (${type || 'unknown type'})`);
  const reader = res.body.getReader();
  let buf = '';
  const dec = new TextDecoder();
  while (buf.length < 2_000_000) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
  reader.cancel().catch(() => {});
  const title = decode((buf.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim());
  let text = /html/.test(type) ? htmlToText(buf) : buf;
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)';
  return { url: u.toString(), title, text };
}

async function search(query) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < 8) {
    let href = decode(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue; // ads
    results.push({ title: htmlToText(m[2]), url: href, snippet: htmlToText(m[3] || '') });
  }
  return results;
}

module.exports = { fetchUrl, search, htmlToText };
