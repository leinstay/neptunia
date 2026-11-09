// The prose check. Reads the tracked prose files (`git ls-files`: the root documents, `docs/`, the interface
// READMEs, `scripts/README.md` and the markdown under `.github/`) and enforces the objective rules of `WRITING.md`.
//
//   hard rules   fail the run unless `scripts/config/prose-baseline.json` records them
//     dash       an em dash, an en dash or a spaced double hyphen in prose
//     label      a "Label: explanation" row outside a table: a list item or paragraph that opens with a label of at
//                most four words (bold or not), a colon and at least three more words. A lead-in that ends in a
//                colon, a bare value ("Default: 30"), a bold label that ends in a full stop, a heading and a table
//                row pass
//     slash      two or more words joined by a slash outside code ("and/or", "docs/comments"). Acronyms written in
//                capitals ("I/O", "TCP/IP"), fractions and anything in backticks pass
//   warnings     printed, never failing: three sentences in a row that open with the same word, a sentence that
//                opens with "Additionally", "Furthermore", "Moreover" or "Notably", a sentence over 40 words
//
// Fenced code, inline code, link targets, URLs, HTML tags and comments and block quotes are not prose. A violation
// above the baseline fails the run, and so does a count below it, so the improvement is written down:
//
//   node scripts/prose-check.ts            check the tracked prose files (exit 0 or 1)
//   node scripts/prose-check.ts --update   rewrite the baseline; refuses while something grew past an existing one
//
// `npm run prose` and `npm run prose:update` call it. The pure functions are exported for tests/prose-check.test.js.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'scripts', 'config', 'prose-baseline.json');

const MAX_LABEL_WORDS = 4;
const MIN_EXPLANATION_WORDS = 3;
const MAX_SENTENCE_WORDS = 40;
const REPEATED_OPENER_RUN = 3;
const TRANSITIONS = new Set(['additionally', 'furthermore', 'moreover', 'notably']);

type Finding = { line: number; rule: string };
type Findings = { violations: Array<Finding>; warnings: Array<Finding> };
type Counts = Record<string, Record<string, number>>;

type Change = { file: string; code: string; was: number; now: number };

/** Compares the current counts with the baseline, both lists sorted by file, then code. */
function compareToBaseline(baseline: Counts, current: Counts): { grew: Array<Change>; shrank: Array<Change> } {
  const grew: Array<Change> = [];
  const shrank: Array<Change> = [];
  const files = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  for (const file of files) {
    const was = baseline[file] ?? {};
    const now = current[file] ?? {};
    const codes = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
    for (const code of codes) {
      const before = was[code] ?? 0;
      const after = now[code] ?? 0;
      if (after > before) grew.push({ file, code, was: before, now: after });
      else if (after < before) shrank.push({ file, code, was: before, now: after });
    }
  }
  return { grew, shrank };
}

/**
 * Whether a tracked path is a prose file this check covers.
 * @param file A repository-relative path with forward slashes.
 */
export function isProseFile(file: string): boolean {
  if (!file.endsWith('.md')) return false;
  if (!file.includes('/')) return true;
  return (
    file.startsWith('docs/') ||
    /^interfaces\/[^/]+\/README\.md$/.test(file) ||
    file === 'scripts/README.md' ||
    file.startsWith('.github/')
  );
}

/**
 * Removes what is not prose from one line. Code spans become a run of `X` in the strict form and `@@name` in the
 * soft form (one word that keeps its identity). Link targets, URLs and HTML tags disappear.
 */
function maskInline(line: string, soft: boolean): string {
  return line
    .replace(/(`+)(.+?)\1(?!`)/g, (_all: string, _ticks: string, body: string) =>
      soft ? `@@${body.replace(/\s+/g, '')}` : 'X'.repeat(Math.max(1, body.length))
    )
    .replace(/\[([^\]\s]*\/[^\]\s]*)\]\(/g, (_all: string, label: string) => `[${'X'.repeat(label.length)}](`)
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/^\s*\[[^\]]+\]:\s*\S+/, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
}

type Row = {
  n: number;
  kind: 'blank' | 'skip' | 'heading' | 'table' | 'list' | 'text';
  strict: string;
  soft: string;
  rest: string;
};

/** Classifies the lines of a markdown text. Fenced code, HTML comments, block quotes and rules are `skip`. */
function readRows(text: string): Array<Row> {
  const rows: Array<Row> = [];
  let fence: { char: string; length: number } | null = null;
  let inComment = false;
  const lines = text.split('\n');
  lines.forEach((raw, index) => {
    const n = index + 1;
    /** @param kind @param {string} [body] */
    const push = (kind: Row['kind'], body = '') =>
      rows.push({ n, kind, strict: maskInline(body, false), soft: maskInline(body, true), rest: body });
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) fence = null;
      push('skip');
      return;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      push('skip');
      return;
    }
    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) return push('skip');
      inComment = false;
      line = line.slice(end + 3);
    }
    line = line.replace(/<!--.*?-->/g, ' ');
    const open = line.indexOf('<!--');
    if (open !== -1) {
      inComment = true;
      line = line.slice(0, open);
    }
    if (line.trim() === '') return push(raw.trim() === '' ? 'blank' : 'skip');
    if (/^\s*>/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return push('skip');
    if (/^#{1,6}\s/.test(line)) return push('heading', line);
    if (/^\s*\|/.test(line)) return push('table', line);
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) return push('list', item[1]);
    return push('text', line.trim());
  });
  return rows;
}

function words(s: string): Array<string> {
  return s.split(/\s+/).filter(Boolean);
}

/**
 * Whether a block opens with a "Label: explanation" row.
 * @param strict The first line of the block, code masked.
 */
function isLabelRow(strict: string, isListItem: boolean): boolean {
  const bold = /^(?:\*\*|__)([^*_:]+?)(?::(?:\*\*|__)|(?:\*\*|__):)\s+(\S.*)$/.exec(strict);
  if (bold) return words(bold[1]).length <= MAX_LABEL_WORDS;
  const plain = /^([^:.!?,;()*_]+?):\s+(\S.*)$/.exec(strict);
  if (!plain) return false;
  if (!isListItem && !/^[A-Z]/.test(plain[1])) return false;
  return words(plain[1]).length <= MAX_LABEL_WORDS && words(plain[2]).length >= MIN_EXPLANATION_WORDS;
}

function hasSlashList(strict: string): boolean {
  for (const m of strict.matchAll(/(?<![\w/])[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z][A-Za-z0-9_-]*)+/g)) {
    const parts = m[0].split('/');
    if (!parts.every((p) => /^[A-Z][A-Z0-9]*$/.test(p))) return true;
  }
  return false;
}

/** Splits a block into sentences and reports the warnings. */
function sentenceWarnings(block: Array<Row>): Array<Finding> {
  const found: Array<Finding> = [];
  const starts: Array<{ at: number; n: number }> = [];
  let joined = '';
  for (const row of block) {
    starts.push({ at: joined.length, n: row.n });
    joined += row.soft + ' ';
  }
  const lineAt = (offset: number) => {
    let n = starts[0].n;
    for (const s of starts) if (s.at <= offset) n = s.n;
    return n;
  };
  const sentences: Array<{ text: string; n: number }> = [];
  let from = 0;
  for (const cut of joined.matchAll(/[.!?]["')\]*]*\s+(?=[A-Z0-9@"'([*_])/g)) {
    const end = cut.index + cut[0].length;
    sentences.push({ text: joined.slice(from, end).trim(), n: lineAt(from) });
    from = end;
  }
  sentences.push({ text: joined.slice(from).trim(), n: lineAt(from) });

  let run = 1;
  let previous = '';
  for (const s of sentences) {
    const tokens = words(s.text);
    if (tokens.length === 0) continue;
    const opener = tokens[0].replace(/^[*_"'([]+|[^\w@]+$/g, '').toLowerCase();
    if (TRANSITIONS.has(opener)) found.push({ line: s.n, rule: 'transition-opener' });
    if (tokens.length > MAX_SENTENCE_WORDS) found.push({ line: s.n, rule: 'long-sentence' });
    run = opener !== '' && opener === previous ? run + 1 : 1;
    if (run === REPEATED_OPENER_RUN) found.push({ line: s.n, rule: 'repeated-opener' });
    previous = opener;
  }
  return found;
}

/** Checks one markdown text. */
export function checkProse(text: string): Findings {
  const out: Findings = { violations: [], warnings: [] };
  const rows = readRows(text);
  let block: Array<Row> = [];
  const closeBlock = () => {
    if (block.length > 0) out.warnings.push(...sentenceWarnings(block));
    block = [];
  };
  for (const row of rows) {
    if (row.kind === 'blank' || row.kind === 'skip') {
      closeBlock();
      continue;
    }
    if (/[–—]|\s--\s/.test(row.strict)) out.violations.push({ line: row.n, rule: 'dash' });
    if (hasSlashList(row.strict)) out.violations.push({ line: row.n, rule: 'slash' });
    if (row.kind === 'heading' || row.kind === 'table') {
      closeBlock();
      continue;
    }
    if (row.kind === 'list') closeBlock();
    if (block.length === 0 && isLabelRow(row.strict, row.kind === 'list'))
      out.violations.push({ line: row.n, rule: 'label' });
    block.push(row);
  }
  closeBlock();
  out.violations.sort((a, b) => a.line - b.line);
  out.warnings.sort((a, b) => a.line - b.line);
  return out;
}

/** Counts violations per file and rule. A file without violations is left out. */
export function countViolations(byFile: Record<string, Array<Finding>>): Counts {
  const counts: Counts = {};
  for (const [file, violations] of Object.entries(byFile)) {
    for (const v of violations) {
      counts[file] ??= {};
      counts[file][v.rule] = (counts[file][v.rule] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Checks a set of files against the baseline.
 * @param files Path to text.
 */
export function runCheck(
  files: Record<string, string>,
  baseline: Counts
): {
  status: number;
  counts: Counts;
  grew: ReturnType<typeof compareToBaseline>['grew'];
  shrank: ReturnType<typeof compareToBaseline>['shrank'];
  violations: Record<string, Array<Finding>>;
  warnings: Record<string, Array<Finding>>;
} {
  const violations: Record<string, Array<Finding>> = {};
  const warnings: Record<string, Array<Finding>> = {};
  for (const [file, text] of Object.entries(files)) {
    const found = checkProse(text);
    violations[file] = found.violations;
    warnings[file] = found.warnings;
  }
  const counts = countViolations(violations);
  const { grew, shrank } = compareToBaseline(baseline, counts);
  return { status: grew.length > 0 || shrank.length > 0 ? 1 : 0, counts, grew, shrank, violations, warnings };
}

/** Serialises counts with sorted keys, so the file diffs cleanly. */
function stringify(counts: Counts): string {
  const sorted: Counts = {};
  for (const file of Object.keys(counts).sort()) {
    sorted[file] = {};
    for (const rule of Object.keys(counts[file]).sort()) sorted[file][rule] = counts[file][rule];
  }
  return JSON.stringify(sorted, null, 2) + '\n';
}

function readTrackedProse(): Record<string, string> {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files: Record<string, string> = {};
  for (const file of listed.split('\0').filter(isProseFile).sort()) {
    if (fs.existsSync(path.join(root, file))) files[file] = fs.readFileSync(path.join(root, file), 'utf8');
  }
  return files;
}

function readBaseline(): Counts {
  const parsed: unknown = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  return parsed as Counts;
}

function main() {
  const update = process.argv.includes('--update');
  const files = readTrackedProse();
  const baseline: Counts = fs.existsSync(baselinePath) ? readBaseline() : {};
  const result = runCheck(files, baseline);
  const total = Object.values(result.counts).reduce(
    (n, rules) => n + Object.values(rules).reduce((a, b) => a + b, 0),
    0
  );

  for (const [file, list] of Object.entries(result.warnings)) {
    for (const w of list) console.log(`warning ${file}:${w.line} ${w.rule}`);
  }

  if (update) {
    if (result.grew.length > 0 && fs.existsSync(baselinePath)) {
      console.error(`Refusing to update: ${result.grew.length} file and rule pairs grew, fix them first.`);
      return 1;
    }
    fs.writeFileSync(baselinePath, stringify(result.counts));
    console.log(`prose-baseline.json written: ${total} violations in ${Object.keys(result.counts).length} files`);
    return 0;
  }

  if (result.grew.length > 0) {
    const grown = new Set(result.grew.map((c) => `${c.file}\0${c.code}`));
    for (const [file, list] of Object.entries(result.violations)) {
      for (const v of list) if (grown.has(`${file}\0${v.rule}`)) console.error(`${file}:${v.line} ${v.rule}`);
    }
    console.error(`New prose violations (${result.grew.length} file and rule pairs grew).`);
    return 1;
  }
  if (result.shrank.length > 0) {
    const lines = result.shrank.map((c) => `  ${c.file} ${c.code}: ${c.was} -> ${c.now}`).join('\n');
    console.error(
      `The baseline shrank (${result.shrank.length} file and rule pairs), run npm run prose:update:\n${lines}`
    );
    return 1;
  }
  console.log(`prose check matches the baseline: ${total} violations in ${Object.keys(files).length} files`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
