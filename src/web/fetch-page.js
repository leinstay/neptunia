// Fetches a web page someone linked so the persona can read it, as plain
// text. The URL comes from a chat message, i.e. from anyone, so this module
// is first of all an SSRF guard: only http/https; never localhost or an IP
// literal; the hostname is resolved before EVERY request (the first one and
// each redirect, which are followed by hand) and refused when any address it
// resolves to is loopback, private, link-local, unspecified (or an
// IPv4-mapped IPv6 form of one). The request then connects to exactly the
// address that was checked (node:http/https with a `lookup` that returns
// it), so a DNS answer that changes after the check is never used. The body
// is streamed under a byte cap and a single timeout covers the whole chain,
// DNS included.
//
// Every call resolves to a result object and never rejects. One warn line per
// failure, carrying the reason, an HTTP status and `host/path` -- never a
// query string (tracking ids, tokens), never the page text.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { log } from '../log.js';
import { bareContentType, safeLocation } from '../media/video-sites.js';
import { htmlToText, pageTitle, truncateText } from './readable.js';

const REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (compatible; neptunia-bot/1.0)',
  Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
});
// A header value as sent: printable ASCII only, so a configured value can never split the header block.
const HEADER_VALUE = /^[\x20-\x7e]+$/;
/** Redirects followed by hand (each one checked by the guard) before a fetch fails with `redirects`. */
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const PLAIN_TYPE = 'text/plain';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const CHARSET_SNIFF_BYTES = 2048;

/** The four octets of a dotted IPv4 address, or null. */
function ipv4Octets(ip) {
  if (net.isIPv4(ip) !== true) return null;
  return ip.split('.').map(Number);
}

function isForbiddenIpv4([a, b]) {
  return a === 0 // this network, 0.0.0.0 included
    || a === 127 // loopback
    || a === 10 // private
    || (a === 172 && b >= 16 && b <= 31) // private
    || (a === 192 && b === 168) // private
    || (a === 169 && b === 254) // link-local
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 198 && (b === 18 || b === 19)) // benchmarking 198.18/15
    || a >= 224; // multicast, reserved, broadcast
}

/** The eight 16-bit groups of an IPv6 address (zone id already removed), or null. */
function ipv6Groups(ip) {
  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const dotted = text.slice(lastColon + 1);
  if (dotted.includes('.')) {
    // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes its two hex groups.
    const octets = ipv4Octets(dotted);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(missing).fill(0), ...rest];
  return groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * Whether the bot must never connect to `ip`: loopback (127/8, ::1), private
 * (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16,
 * fe80::/10), unspecified (0.0.0.0, ::), an IPv4-mapped or IPv4-compatible
 * IPv6 form of those -- plus 0/8, carrier-grade NAT (100.64/10),
 * benchmarking (198.18/15), site-local fec0::/10 and multicast/reserved
 * space, which no public page lives on either. NAT64 (64:ff9b::/96) and 6to4
 * (2002::/16) addresses are judged by the IPv4 address they embed. Anything
 * that is not a valid address fails closed (true).
 * @param {string} ip
 * @returns {boolean}
 */
export function isForbiddenAddress(ip) {
  if (typeof ip !== 'string' || !ip) return true;
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = ipv4Octets(bare);
  if (v4) return isForbiddenIpv4(v4);
  if (net.isIPv6(bare) !== true) return true;
  const g = ipv6Groups(bare);
  if (!g) return true;
  const firstFive = g.slice(0, 5).every((x) => x === 0);
  if (firstFive && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
    return isForbiddenIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]); // ::ffff:a.b.c.d, ::a.b.c.d
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isForbiddenIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]); // NAT64 64:ff9b::a.b.c.d
  }
  if (g[0] === 0x2002) return isForbiddenIpv4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff]); // 6to4 2002:AABB:CCDD::/48
  return (g[0] & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (g[0] & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (g[0] & 0xffc0) === 0xfec0 // site-local fec0::/10 (deprecated)
    || (g[0] & 0xff00) === 0xff00; // multicast
}

/** `promise`, rejected early when `signal` aborts. */
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Drop a response body we will not read, ignoring any error. */
function discardBody(response) {
  try {
    const body = response?.body;
    if (typeof body?.destroy === 'function') body.destroy();
    else body?.cancel?.()?.catch?.(() => {});
  } catch {
    // nothing to release
  }
}

/** One response header (a plain object with lowercase keys, as node gives them), first value of a list. */
function headerOf(response, name) {
  const value = response?.headers?.[name];
  return Array.isArray(value) ? value[0] : value ?? null;
}

/** `res` decoded when a server compresses although none was asked for; errors travel down the pipe. */
function decodedBody(res) {
  const encoding = String(res.headers?.['content-encoding'] ?? '').trim().toLowerCase();
  let decoder = null;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = zlib.createGunzip();
  else if (encoding === 'deflate') decoder = zlib.createInflate();
  else if (encoding === 'br') decoder = zlib.createBrotliDecompress();
  if (!decoder) return res;
  return pipeline(res, decoder, () => {});
}

/**
 * The real request: one GET over node:http/https that connects to
 * `lookupAddress` (the address the guard checked) instead of resolving the
 * hostname again. The Host header and the TLS server name still come from
 * the URL. No connection pooling, so no socket outlives its check.
 * @param {string} url
 * @param {{ lookupAddress: string, family: number, headers: object, signal: AbortSignal }} options
 * @returns {Promise<{ status: number, headers: object, body: AsyncIterable<Uint8Array> }>}
 */
function nodeRequest(url, { lookupAddress, family, headers, signal }) {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  const pinned = (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    if (options?.all) done(null, [{ address: lookupAddress, family }]);
    else done(null, lookupAddress, family);
  };
  return new Promise((resolve, reject) => {
    const req = transport.request(parsed, { method: 'GET', headers, signal, agent: false, lookup: pinned }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, body: decodedBody(res) });
    });
    req.on('error', reject);
    req.end();
  });
}

/** The charset to decode with: the header's, else an HTML meta declaration, else utf-8. */
function pickCharset(contentTypeHeader, bytes, isHtml) {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentTypeHeader ?? ''));
  if (fromHeader) return fromHeader[1];
  if (!isHtml) return 'utf-8';
  const head = bytes.subarray(0, CHARSET_SNIFF_BYTES).toString('latin1');
  const fromMeta = /<meta\b[^>]*charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : 'utf-8';
}

function decode(bytes, charset) {
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes);
}

/**
 * @param {object} [deps]
 * @param {(url: string, options: { lookupAddress: string, family: number, headers: object, signal: AbortSignal })
 *   => Promise<{ status: number, headers: object, body: AsyncIterable<Uint8Array> }>} [deps.requestImpl]
 *   One GET to `url` connected to `lookupAddress`; response headers as a plain object with lowercase keys.
 * @param {(host: string, options: { all: true }) => Promise<Array<{ address: string, family: number }>>} [deps.lookup]
 */
export function createPageFetcher({ requestImpl = nodeRequest, lookup = dns.promises.lookup } = {}) {
  /** One warn line (reason, status, host/path), then the failure object. */
  function fail(url, reason, status) {
    const meta = { reason };
    if (status !== undefined) meta.status = status;
    meta.location = safeLocation(url);
    log.warn('fetch-page: failed', meta);
    return status === undefined ? { ok: false, reason } : { ok: false, reason, status };
  }

  /**
   * `{ verdict: 'ok', address, family }` (the first resolved address, the
   * one to connect to) or `{ verdict: 'private'|'network' }` for `hostname`.
   * localhost and IP literals are refused without a lookup. A lookup cut
   * short by the timeout rethrows, so the caller reports `timeout`.
   */
  async function checkHost(hostname, signal) {
    const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost')) return { verdict: 'private' };
    if (net.isIP(host.split('%')[0]) !== 0) return { verdict: 'private' };
    let answers;
    try {
      answers = await raceAbort(lookup(host, { all: true }), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      return { verdict: 'network' };
    }
    const list = (Array.isArray(answers) ? answers : [answers]).filter(Boolean)
      .map((entry) => (typeof entry === 'string' ? { address: entry } : entry));
    if (!list.length) return { verdict: 'network' };
    if (list.some((entry) => isForbiddenAddress(entry.address))) return { verdict: 'private' };
    const [first] = list;
    const family = first.family === 4 || first.family === 6 ? first.family : net.isIP(first.address);
    return { verdict: 'ok', address: first.address, family };
  }

  /**
   * Fetch `url` as readable text behind the SSRF guard (see the header
   * comment). HTML goes through `htmlToText` (cut to `maxChars`) with its
   * title; text/plain comes back as written (cut to `maxChars` when given).
   * At most 3 redirects are followed. `acceptLanguage` (the caller reads
   * `web.acceptLanguage` at the moment of use) is sent as the Accept-Language
   * header when it is a non-empty printable ASCII string; otherwise the header
   * is left out. Never rejects.
   * @param {string} url
   * @param {{ maxBytes?: number, timeoutMs?: number, maxChars?: number, acceptLanguage?: string }} [options]
   * @returns {Promise<{ ok: true, text: string, title: string|null, contentType: string, bytes: number, finalUrl: string }
   *   | { ok: false, reason: 'scheme'|'private'|'redirects'|'type'|'size'|'timeout'|'http'|'network', status?: number }>}
   */
  async function fetchText(url, { maxBytes, timeoutMs, maxChars, acceptLanguage } = {}) {
    const byteCap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const language = typeof acceptLanguage === 'string' ? acceptLanguage.trim() : '';
    const headers = HEADER_VALUE.test(language) ? { ...REQUEST_HEADERS, 'Accept-Language': language } : { ...REQUEST_HEADERS };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, waitMs);

    let current = String(url ?? '');
    try {
      for (let hop = 0; ; hop += 1) {
        let parsed;
        try {
          parsed = new URL(current);
        } catch {
          return fail(current, 'scheme');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail(current, 'scheme');

        const checked = await checkHost(parsed.hostname, controller.signal);
        if (checked.verdict !== 'ok') return fail(current, checked.verdict);

        const response = await raceAbort(requestImpl(parsed.href, {
          lookupAddress: checked.address,
          family: checked.family,
          headers: { ...headers },
          signal: controller.signal,
        }), controller.signal);
        if (!response || typeof response !== 'object') return fail(current, 'network');
        const { status } = response;

        if (REDIRECT_STATUSES.has(status)) {
          discardBody(response);
          const location = headerOf(response, 'location');
          if (!location) return fail(current, 'http', status);
          if (hop >= MAX_REDIRECTS) return fail(current, 'redirects');
          try {
            current = new URL(location, parsed).href;
          } catch {
            return fail(current, 'http', status);
          }
          continue;
        }
        if (!(status >= 200 && status < 300)) {
          discardBody(response);
          return fail(current, 'http', status);
        }

        const rawType = headerOf(response, 'content-type');
        const contentType = bareContentType(rawType);
        const isHtml = HTML_TYPES.has(contentType);
        if (!isHtml && contentType !== PLAIN_TYPE) {
          discardBody(response);
          return fail(current, 'type');
        }
        const declared = Number(headerOf(response, 'content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > byteCap) {
          discardBody(response);
          return fail(current, 'size');
        }

        const chunks = [];
        let bytes = 0;
        if (response.body) {
          for await (const chunk of response.body) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buf.byteLength;
            if (bytes > byteCap) {
              controller.abort();
              return fail(current, 'size');
            }
            chunks.push(buf);
          }
        }
        const raw = Buffer.concat(chunks);
        const source = decode(raw, pickCharset(rawType, raw, isHtml));
        return {
          ok: true,
          text: isHtml ? htmlToText(source, { maxChars }) : truncateText(source, maxChars),
          title: isHtml ? pageTitle(source) : null,
          contentType,
          bytes,
          finalUrl: parsed.href,
        };
      }
    } catch {
      return fail(current, timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchText };
}
