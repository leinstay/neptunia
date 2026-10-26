// Pure HTML-to-text for web lookup: when someone links a page, the bot reads
// it and a cheap model condenses what it says, so the page must first become
// plain readable text -- the article itself, without menus, cookie footers,
// scripts or markup. Hand-written on purpose (the project keeps one runtime
// dependency): a small linear tokenizer, never a regex over the whole page
// that could backtrack, and nothing here ever throws on malformed HTML.
//
// The rules, in order:
//   - comments, `<!doctype>`/`<?xml?>` and the raw-text elements (script,
//     style, noscript, template, svg) vanish with their contents;
//   - nav, header, footer, aside, form and title lose their contents (the
//     title is read separately by `pageTitle`); should that leave nothing at
//     all (an unclosed `<header>` swallowing the page) the text is taken again
//     without this step;
//   - the largest `<article>`/`<main>` is the page when present, else `<body>`,
//     else the whole document;
//   - block-level tags become line breaks, table cells a space, other tags
//     nothing; entities are decoded; whitespace collapses to single spaces and
//     at most one blank line; control characters and byte-order marks go;
//   - `maxChars` cuts on a word boundary with an ellipsis, in code points.

const RAW_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg']);
const BOILERPLATE = new Set(['nav', 'header', 'footer', 'aside', 'form', 'title']);
const SCOPES = new Set(['article', 'main']);
const BLOCK = new Set([
  'p',
  'div',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'br',
  'tr',
  'blockquote',
  'pre',
  'section',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'table',
  'hr',
  'article',
  'main',
  'figure',
  'figcaption',
  'body',
]);
const CELL = new Set(['td', 'th']);
const ELLIPSIS = '\u2026';
const TITLE_MAX_CHARS = 300;
const TITLE_SCAN_CHARS = 64 * 1024;

// Latin-1 letters 0xC0-0xFF by their entity names, plus the usual punctuation.
const LATIN1_NAMES = [
  'Agrave',
  'Aacute',
  'Acirc',
  'Atilde',
  'Auml',
  'Aring',
  'AElig',
  'Ccedil',
  'Egrave',
  'Eacute',
  'Ecirc',
  'Euml',
  'Igrave',
  'Iacute',
  'Icirc',
  'Iuml',
  'ETH',
  'Ntilde',
  'Ograve',
  'Oacute',
  'Ocirc',
  'Otilde',
  'Ouml',
  'times',
  'Oslash',
  'Ugrave',
  'Uacute',
  'Ucirc',
  'Uuml',
  'Yacute',
  'THORN',
  'szlig',
  'agrave',
  'aacute',
  'acirc',
  'atilde',
  'auml',
  'aring',
  'aelig',
  'ccedil',
  'egrave',
  'eacute',
  'ecirc',
  'euml',
  'igrave',
  'iacute',
  'icirc',
  'iuml',
  'eth',
  'ntilde',
  'ograve',
  'oacute',
  'ocirc',
  'otilde',
  'ouml',
  'divide',
  'oslash',
  'ugrave',
  'uacute',
  'ucirc',
  'uuml',
  'yacute',
  'thorn',
  'yuml',
];
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['ndash', '\u2013'],
  ['mdash', '\u2014'],
  ['hellip', '\u2026'],
  ['laquo', '\u00ab'],
  ['raquo', '\u00bb'],
  ['lsquo', '\u2018'],
  ['rsquo', '\u2019'],
  ['ldquo', '\u201c'],
  ['rdquo', '\u201d'],
  ['bull', '\u2022'],
  ['middot', '\u00b7'],
  ['copy', '\u00a9'],
  ['reg', '\u00ae'],
  ['trade', '\u2122'],
  ['deg', '\u00b0'],
  ['euro', '\u20ac'],
  ['pound', '\u00a3'],
  ['yen', '\u00a5'],
  ['cent', '\u00a2'],
  ['sect', '\u00a7'],
  ...LATIN1_NAMES.map((name, i) => [name, String.fromCharCode(0xc0 + i)]),
]);

const TAG_OPEN = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
// Control characters other than tab/newline, zero-width space and byte-order marks.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f\u200b\ufeff]/g;

/** Decode named (the common set) and numeric entities; unknown ones stay as written. */
function decodeEntities(text) {
  return text.replace(ENTITY, (whole, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES.get(body) ?? whole;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(code);
  });
}

/**
 * The end index (of `>`) of a tag whose name ends at `from`. A quote opens an
 * attribute value only right after `=`, so a bare apostrophe in a malformed
 * tag does not swallow the page; an unterminated quote falls back to the
 * first `>`. -1 when there is no `>` at all.
 */
function tagEnd(s, from) {
  let quote = null;
  let prev = '';
  for (let j = from; j < s.length; j += 1) {
    const c = s[j];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && prev === '=') quote = c;
    else if (c === '>') return j;
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prev = c;
  }
  return s.indexOf('>', from);
}

/** Split `s` into `{ type: 'text', value }` and `{ type: 'tag', name, closing, selfClosing }` tokens. */
function tokenize(s) {
  const tokens = [];
  let i = 0;
  let textStart = 0;
  const pushText = (end) => {
    if (end > textStart) tokens.push({ type: 'text', value: s.slice(textStart, end) });
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    if (s.startsWith('<!--', lt)) {
      pushText(lt);
      const end = s.indexOf('-->', lt + 4);
      i = textStart = end === -1 ? s.length : end + 3;
      continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') {
      pushText(lt);
      const end = s.indexOf('>', lt + 2);
      i = textStart = end === -1 ? s.length : end + 1;
      continue;
    }
    TAG_OPEN.lastIndex = lt;
    const m = TAG_OPEN.exec(s);
    if (!m) {
      i = lt + 1; // a literal '<' in the text
      continue;
    }
    pushText(lt);
    const end = tagEnd(s, lt + m[0].length);
    const stop = end === -1 ? s.length : end;
    const name = m[2].toLowerCase();
    const closing = m[1] === '/';
    tokens.push({ type: 'tag', name, closing, selfClosing: s[stop - 1] === '/' });
    i = textStart = end === -1 ? s.length : end + 1;
    if (!closing && RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}[\\s/>]`, 'gi');
      close.lastIndex = i;
      const found = close.exec(s);
      if (!found) {
        i = textStart = s.length;
      } else {
        const after = s.indexOf('>', found.index);
        i = textStart = after === -1 ? s.length : after + 1;
      }
    }
  }
  pushText(s.length);
  return tokens;
}

/** `tokens` without the contents of the boilerplate elements (nested ones counted). */
function dropBoilerplate(tokens) {
  const depth = new Map();
  let open = 0;
  const out = [];
  for (const token of tokens) {
    if (token.type === 'tag' && BOILERPLATE.has(token.name) && !token.selfClosing) {
      const current = depth.get(token.name) ?? 0;
      if (!token.closing) {
        depth.set(token.name, current + 1);
        open += 1;
      } else if (current > 0) {
        depth.set(token.name, current - 1);
        open -= 1;
      }
      continue;
    }
    if (open === 0) out.push(token);
  }
  return out;
}

/** `[start, end)` ranges of the outermost elements named in `names` (unclosed ones run to the end). */
function elementRanges(tokens, names) {
  const ranges = [];
  let current = null;
  let depth = 0;
  tokens.forEach((token, idx) => {
    if (token.type !== 'tag' || token.selfClosing) return;
    if (!current) {
      if (!token.closing && names.has(token.name)) {
        current = { name: token.name, start: idx + 1 };
        depth = 1;
      }
      return;
    }
    if (token.name !== current.name) return;
    depth += token.closing ? -1 : 1;
    if (depth === 0) {
      ranges.push([current.start, idx]);
      current = null;
    }
  });
  if (current) ranges.push([current.start, tokens.length]);
  return ranges;
}

/** Tokens -> normalised plain text (see the header comment). */
function render(tokens) {
  const parts = [];
  for (const token of tokens) {
    if (token.type === 'text') parts.push(decodeEntities(token.value).replace(/\s+/g, ' '));
    else if (BLOCK.has(token.name)) parts.push('\n');
    else if (CELL.has(token.name)) parts.push(' ');
  }
  return parts
    .join('')
    .replace(INVISIBLE, '')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The text of the page's main scope: the largest article/main, else body, else everything. */
function scopedText(tokens) {
  let best = '';
  for (const [start, end] of elementRanges(tokens, SCOPES)) {
    const text = render(tokens.slice(start, end));
    if (text.length > best.length) best = text;
  }
  if (best) return best;
  const [body] = elementRanges(tokens, new Set(['body']));
  return render(body ? tokens.slice(body[0], body[1]) : tokens);
}

/**
 * Cut `text` to at most `maxChars` code points, the ellipsis included, at the
 * last whitespace inside the window (a hard cut only for one very long word).
 * A non-finite or non-positive `maxChars` means no limit.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function truncateText(text, maxChars) {
  const value = String(text ?? '');
  const limit = Math.floor(Number(maxChars));
  if (!Number.isFinite(limit) || limit <= 0) return value;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  const room = limit - 1;
  let cut = -1;
  for (let i = Math.min(room, points.length - 1); i > 0; i -= 1) {
    if (/\s/.test(points[i])) {
      cut = i;
      break;
    }
  }
  if (cut === -1) cut = room;
  return `${points.slice(0, cut).join('').trimEnd()}${ELLIPSIS}`;
}

/**
 * The readable text of an HTML page (see the header comment for the rules).
 * Never throws; non-string input reads as an empty page.
 * @param {string} html
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 */
export function htmlToText(html, { maxChars } = {}) {
  try {
    const tokens = tokenize(typeof html === 'string' ? html : '');
    const text = scopedText(dropBoilerplate(tokens)) || scopedText(tokens);
    return truncateText(text, maxChars);
  } catch {
    return '';
  }
}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Attribute name -> value of one tag's source (the part after the tag name),
 * names lowercased; attributes without `=` are skipped. One forward pass --
 * no regex, so a long malformed tag cannot backtrack.
 */
function attributes(tagSource) {
  const out = {};
  const s = tagSource;
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (isSpace(s[i]) || s[i] === '/')) i += 1;
    const nameStart = i;
    while (i < s.length && !isSpace(s[i]) && s[i] !== '=' && s[i] !== '>' && s[i] !== '/') i += 1;
    const name = s.slice(nameStart, i).toLowerCase();
    if (!name) {
      i += 1;
      continue;
    }
    while (i < s.length && isSpace(s[i])) i += 1;
    if (s[i] !== '=') continue;
    i += 1;
    while (i < s.length && isSpace(s[i])) i += 1;
    let value;
    if (s[i] === '"' || s[i] === "'") {
      const close = s.indexOf(s[i], i + 1);
      value = s.slice(i + 1, close === -1 ? s.length : close);
      i = close === -1 ? s.length : close + 1;
    } else {
      const valueStart = i;
      while (i < s.length && !isSpace(s[i]) && s[i] !== '>') i += 1;
      value = s.slice(valueStart, i);
    }
    out[name] = value;
  }
  return out;
}

/**
 * The next opening `<name` tag at or after `from` (case-insensitive, a whole
 * tag name): `{ start, nameEnd }`, or null. Plain indexOf scanning.
 */
function findTag(s, lower, name, from) {
  const needle = `<${name}`;
  let at = lower.indexOf(needle, from);
  while (at !== -1) {
    const after = s[at + needle.length];
    if (after === undefined || after === '>' || after === '/' || isSpace(after))
      return { start: at, nameEnd: at + needle.length };
    at = lower.indexOf(needle, at + 1);
  }
  return null;
}

/** Entities decoded, whitespace collapsed, invisible characters removed, capped. */
function cleanTitle(raw) {
  const text = decodeEntities(raw).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return text ? truncateText(text, TITLE_MAX_CHARS) : null;
}

/**
 * The page title: the `<title>` element, else the `og:title` meta, else null.
 * Entities decoded, whitespace collapsed. Only the first 64 KB of the
 * document are scanned (the head lives there), with indexOf and the
 * tokenizer's `tagEnd` -- no backtracking regex, linear on any input.
 * Never throws.
 * @param {string} html
 * @returns {string|null}
 */
export function pageTitle(html) {
  if (typeof html !== 'string') return null;
  try {
    const s = html.slice(0, TITLE_SCAN_CHARS);
    // Lowercasing ASCII only keeps every index aligned with `s`.
    const lower = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
    const title = findTag(s, lower, 'title', 0);
    if (title) {
      const open = tagEnd(s, title.nameEnd);
      if (open !== -1) {
        let close = lower.indexOf('</title', open + 1);
        while (close !== -1) {
          const after = s[close + 7];
          if (after === undefined || after === '>' || isSpace(after)) break;
          close = lower.indexOf('</title', close + 1);
        }
        const fromTitle = close === -1 ? null : cleanTitle(s.slice(open + 1, close));
        if (fromTitle) return fromTitle;
      }
    }
    let from = 0;
    for (let meta = findTag(s, lower, 'meta', from); meta; meta = findTag(s, lower, 'meta', from)) {
      const end = tagEnd(s, meta.nameEnd);
      if (end === -1) break; // no `>` left: no further tag can close
      const attrs = attributes(s.slice(meta.nameEnd, end));
      const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
      if (key === 'og:title' && attrs.content) {
        const fromMeta = cleanTitle(attrs.content);
        if (fromMeta) return fromMeta;
      }
      from = end + 1;
    }
    return null;
  } catch {
    return null;
  }
}
