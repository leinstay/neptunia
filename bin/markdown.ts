// The console's small markdown renderer: `renderMarkdown(text, { color })` turns the markdown of a watcher report into
// text for a terminal (bin/report.ts). It knows headings, bullets, numbered items, quotes, rules, fenced code, tables,
// links, code spans, bold and italic, and nothing else; no wrapping. Without color the markers are only removed. With
// color a heading and bold are bold (`\x1b[1m`), italic is italic (`\x1b[3m`) and a code span is cyan (`\x1b[36m`).

const BOLD = ['\x1b[1m', '\x1b[22m'] as const;
const ITALIC = ['\x1b[3m', '\x1b[23m'] as const;
const CODE = ['\x1b[36m', '\x1b[39m'] as const;
// The escapes this file writes, matched to measure a cell's visible width.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
// Private-use characters stand in for a code span while the emphasis markers are read around it.
const OPEN = '';
const CLOSE = '';

type Options = { color: boolean };

const wrap = (pair: readonly [string, string], text: string, color: boolean): string =>
  color ? `${pair[0]}${text}${pair[1]}` : text;

/** The visible width of a cell: its characters without the color escapes. */
const widthOf = (text: string): number => Array.from(text.replace(ANSI, '')).length;

/** One line of text with its inline markers rendered. */
function inline(text: string, { color }: Options): string {
  const spans: Array<string> = [];
  let out = text.replace(/`([^`]+)`/g, (_, code: string) => {
    spans.push(code);
    return `${OPEN}${spans.length - 1}${CLOSE}`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  out = out.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, (_, body: string) => wrap(BOLD, body, color));
  out = out.replace(/(?<![A-Za-z0-9_])__(?!\s)(.+?)(?<!\s)__(?![A-Za-z0-9_])/g, (_, body: string) =>
    wrap(BOLD, body, color)
  );
  out = out.replace(/(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, (_, body: string) => wrap(ITALIC, body, color));
  out = out.replace(/(?<![A-Za-z0-9_])_(?![\s_])(.+?)(?<![\s_])_(?![A-Za-z0-9_])/g, (_, body: string) =>
    wrap(ITALIC, body, color)
  );
  return out.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, index: string) =>
    wrap(CODE, spans[Number(index)] ?? '', color)
  );
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The cells of a table row, split on pipes that are not escaped and not inside a code span. */
function cellsOf(line: string): Array<string> {
  const cells: Array<string> = [];
  let current = '';
  let inCode = false;
  const body = line.trim().replace(/^\|/, '');
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? '';
    if (char === '`') inCode = !inCode;
    if (char === '\\' && body[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') cells.push(current.trim());
  return cells;
}

type Align = 'left' | 'right' | 'center';

const alignOf = (cell: string): Align => {
  const spec = cell.trim();
  if (spec.startsWith(':') && spec.endsWith(':')) return 'center';
  return spec.endsWith(':') ? 'right' : 'left';
};

function pad(text: string, width: number, align: Align): string {
  const room = width - widthOf(text);
  if (align === 'right') return ' '.repeat(room) + text;
  if (align === 'center') return ' '.repeat(Math.floor(room / 2)) + text + ' '.repeat(room - Math.floor(room / 2));
  return text + ' '.repeat(room);
}

/** A table of rows (the first is the header) as aligned lines with a rule under the header. */
function tableLines(header: string, separator: string, rows: ReadonlyArray<string>, options: Options): Array<string> {
  const aligns = cellsOf(separator).map(alignOf);
  const grid = [header, ...rows].map((row) => cellsOf(row).map((cell) => inline(cell, options)));
  const columns = Math.max(...grid.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(...grid.map((row) => widthOf(row[c] ?? ''))));
  const line = (row: ReadonlyArray<string>): string =>
    widths.map((width, c) => pad(row[c] ?? '', width, aligns[c] ?? 'left')).join('  ');
  const [head = [], ...body] = grid;
  return [line(head), widths.map((width) => '─'.repeat(width)).join('  '), ...body.map(line)];
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** One line that is no table row and no code: a heading, a rule, a list item, a quote or a paragraph line. */
function blockLine(line: string, options: Options): string {
  const heading = HEADING.exec(line);
  if (heading !== null) return wrap(BOLD, inline(heading[1] ?? '', options), options.color);
  if (RULE.test(line)) return '─'.repeat(40);
  const bullet = BULLET.exec(line);
  if (bullet !== null) return `${bullet[1] ?? ''}• ${inline(bullet[2] ?? '', options)}`;
  const numbered = NUMBERED.exec(line);
  if (numbered !== null) return `${numbered[1] ?? ''}${numbered[2] ?? ''} ${inline(numbered[3] ?? '', options)}`;
  const quote = QUOTE.exec(line);
  if (quote !== null) return `│ ${inline(quote[1] ?? '', options)}`;
  return inline(line, options);
}

/** The markdown `text` for a terminal: see the head of this file. The result has no trailing newline. */
export function renderMarkdown(text: string, options: Options): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Array<string> = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(`    ${line}`);
      continue;
    }
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && next.includes('-') && SEPARATOR.test(next)) {
      const rows: Array<string> = [];
      let end = i + 2;
      while (end < lines.length && (lines[end] ?? '').includes('|')) {
        rows.push(lines[end] ?? '');
        end += 1;
      }
      out.push(...tableLines(line, next, rows, options));
      i = end - 1;
      continue;
    }
    out.push(blockLine(line, options));
  }
  return out.join('\n').replace(/\n+$/, '');
}
