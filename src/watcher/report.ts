// The watcher's report: one exact template (`checkTemplate`), the coverage block at its end (`checkCoverage`), the rows
// the engine stamps into the metadata, the commit, and the gaps the engine itself knows.
// src/watcher/inspection.ts calls them all. `checkReport` is the last guard of the commit, the sections and no key. A
// refusal's detail names the template's words and a line number, never the text that caused it, so a planted key is
// copied nowhere. docs/prompt-contract.md holds the template.

import fs from 'node:fs';
import path from 'node:path';
import { VERSIONS_DIR, isDay, versionFileOf } from './read.ts';

export const REPORT_HEADINGS = [
  'Her day',
  'Service runs',
  'Memory',
  'Money',
  'Errors',
  'Misunderstandings',
  'Project',
  'Modules and structure',
  'Trash',
  'The server',
  'Wishes',
  'For the owner',
] as const;

export const REPORT_SUBHEADINGS = [
  'Observed defects',
  'Suspicious evidence',
  'Inspected without a finding',
  'Unavailable checks',
] as const;

/** What only `For the owner` holds, ahead of the shared four: the actions the owner has to take. */
export const OWNER_SUBHEADINGS = ['Decisions needed', ...REPORT_SUBHEADINGS] as const;
const OWNER_SECTION = 'For the owner';
/** The section whose lines cite the turn they speak of, so nothing retells a chat. */
const TURN_SECTION = 'Misunderstandings';
const TURN_ID = /(?<![\w-])t-[0-9a-f]{6,}(?![\w-])/;

/** The two subsections whose every line is a finding with its risk. */
const FINDING_SUBHEADINGS: ReadonlyArray<string> = ['Observed defects', 'Suspicious evidence'];
/** What an empty subsection says, exactly. */
export const EMPTY_WORD = 'none';
export const FINDING_LEVELS = ['critical', 'high', 'medium', 'low'] as const;
export type FindingLevel = (typeof FINDING_LEVELS)[number];

const FINDING_LINE = /^- \[(critical|high|medium|low)\] ([A-Za-z0-9][\w.-]*): (.*\S)\s*$/;
const LEVEL_LINE = /^\s*- \[(?:critical|high|medium|low)\]/;
const OTHER_EMPTY = /^(?:none\.?|nothing(?: found)?\.?|n\/a\.?|nil\.?|no findings?\.?)$/i;
const TITLE = /^# Watcher report (\d{4}-\d{2}-\d{2})$/;
const COUNTS = /^(\d+), repeats: (\d+)$/;
const OPEN = /^critical (\d+), high (\d+), medium (\d+), low (\d+)$/;
const RISKS: ReadonlyArray<string> = ['none', ...FINDING_LEVELS];

/** The rows of the metadata block in their fixed order, each with its name in the check's answer. */
const METADATA_ROWS = [
  ['Observation interval', 'observationInterval'],
  ['Run id', 'runId'],
  ['Selected backend', 'backend'],
  ['Model', 'model'],
  ['Effort', 'effort'],
  ['Effective account', 'account'],
  ['Available sources', 'sources'],
  ['Risk', 'risk'],
  ['New findings', 'counts'],
  ['Open findings', 'open'],
] as const;

/** The findings standing in a report, per level: a repeat at the level it came in at. */
export type OpenCounts = Record<FindingLevel, number>;

export type ReportMetadata = {
  observationInterval: string;
  runId: string;
  backend: string;
  model: string;
  effort: string;
  account: string;
  sources: string;
  risk: string;
  newFindings: number;
  repeats: number;
  open: OpenCounts;
};

export type ReportCode =
  'missing-heading' | 'extra-heading' | 'heading-order' | 'empty-section' | 'preamble' | 'secret' | 'invalid-day';
export type ReportCheck = { ok: true } | { ok: false; code: ReportCode; detail: string };
export type TemplateCode =
  | 'secret'
  | 'preamble'
  | 'bad-title'
  | 'bad-metadata'
  | 'stray-text'
  | 'extra-heading'
  | 'missing-heading'
  | 'heading-order'
  | 'heading-level'
  | 'empty-subsection'
  | 'empty-word'
  | 'coverage-missing'
  | 'coverage-misplaced'
  | 'trailing-content'
  | 'bad-risk'
  | 'missing-turn-ref';
export type TemplateCheck =
  { ok: true; day: string; metadata: ReportMetadata } | { ok: false; code: TemplateCode; detail: string };
export type Coverage = {
  observation: { from: string; to: string };
  backend: string;
  account: string;
  sources: Array<string>;
  defects: Array<string>;
  suspicious: Array<string>;
  inspected: Array<string>;
  unavailable: Array<string>;
};
export type CoverageCheck =
  { ok: true; coverage: Coverage } | { ok: false; code: 'coverage-missing' | 'coverage-invalid'; detail: string };

// An OpenRouter or OpenAI style key, a GitHub token, an AWS key id, a bearer header and the task token variable.
const SECRETS: ReadonlyArray<RegExp> = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /NEPTUNIA_TASK_TOKEN=\S+/,
];

/** `text` with every key-looking string replaced, and how many there were. */
export function maskCredentials(text: string): { text: string; masked: number } {
  let masked = 0;
  let out = text;
  for (const pattern of SECRETS) {
    out = out.replace(new RegExp(pattern.source, 'g'), () => {
      masked += 1;
      return '[masked]';
    });
  }
  return { text: out, masked };
}

/** The 1-based line of the first key-looking string in `text`, or null. */
export function findSecret(text: string): number | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (SECRETS.some((pattern) => pattern.test(lines[i] ?? ''))) return i + 1;
  }
  return null;
}

const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

type Heading = { name: string; level: number; line: number };

/** The ATX headings outside code fences, and whether any text comes before the first one. */
function scan(text: string): { headings: Array<Heading>; preamble: boolean; sections: Map<number, boolean> } {
  const headings: Array<Heading> = [];
  const sections = new Map<number, boolean>();
  let preamble = false;
  let fenced = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (FENCE.test(line)) {
      fenced = !fenced;
    } else if (!fenced && HEADING.test(line)) {
      const found = HEADING.exec(line);
      headings.push({ name: (found?.[2] ?? '').trim(), level: found?.[1]?.length ?? 0, line: i + 1 });
      sections.set(headings.length - 1, false);
      continue;
    }
    if (line.trim() === '') continue;
    if (headings.length === 0) preamble = true;
    else sections.set(headings.length - 1, true);
  }
  return { headings, preamble, sections };
}

const isSubheading = (heading: Heading): boolean =>
  heading.level === 3 && (OWNER_SUBHEADINGS as ReadonlyArray<string>).includes(heading.name);
const isTitle = (heading: Heading, index: number): boolean =>
  index === 0 && heading.level === 1 && TITLE.test(`# ${heading.name}`);

/**
 * Whether `text` holds the sections of `REPORT_HEADINGS`, each once, in order, each with something in it, and no
 * key. The commit's last guard: the exact layout is `checkTemplate`'s, so a title and the four subheadings pass here.
 */
export function checkReport(text: string): ReportCheck {
  const secretLine = findSecret(text);
  if (secretLine !== null) return { ok: false, code: 'secret', detail: `a key-looking string on line ${secretLine}` };
  const scanned = scan(text);
  if (scanned.preamble) return { ok: false, code: 'preamble', detail: 'text before the first heading' };
  const known: ReadonlyArray<string> = REPORT_HEADINGS;
  const seen = new Set<string>();
  const sections: Array<{ heading: Heading; filled: boolean }> = [];
  for (const [index, heading] of scanned.headings.entries()) {
    if (isTitle(heading, index)) continue;
    const last = sections.at(-1);
    if (isSubheading(heading) && last !== undefined) {
      last.filled = true;
      continue;
    }
    if (heading.level !== 2 || !known.includes(heading.name) || seen.has(heading.name)) {
      return { ok: false, code: 'extra-heading', detail: `an extra heading on line ${heading.line}` };
    }
    seen.add(heading.name);
    sections.push({ heading, filled: scanned.sections.get(index) === true });
  }
  const missing = known.filter((name) => !seen.has(name));
  if (missing.length > 0) return { ok: false, code: 'missing-heading', detail: `missing: ${missing.join(', ')}` };
  if (sections.some(({ heading }, i) => heading.name !== known[i])) {
    return { ok: false, code: 'heading-order', detail: 'the headings are out of order' };
  }
  const empty = sections.find((one) => !one.filled);
  if (empty !== undefined) {
    return { ok: false, code: 'empty-section', detail: `nothing under "${empty.heading.name}"` };
  }
  return { ok: true };
}

type TemplateRefusal = Extract<TemplateCheck, { ok: false }>;
const refuse = (code: TemplateCode, detail: string): TemplateRefusal => ({ ok: false, code, detail });

/** One line of a report outside any fence, or a fence as one thing. */
type Part =
  | { kind: 'line'; text: string; at: number }
  | { kind: 'heading'; level: number; name: string; at: number }
  | { kind: 'fence'; info: string; closed: boolean; at: number; end: number };

/** The lines of `lines` from `start` on: a closing fence has the opener's marker and nothing after it. */
function partsOf(lines: ReadonlyArray<string>, start: number): Array<Part> {
  const parts: Array<Part> = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const open = /^\s*(```+|~~~+)(.*)$/.exec(line);
    if (open !== null) {
      const marker = open[1] ?? '';
      let end = i + 1;
      while (end < lines.length && (lines[end] ?? '').trim() !== marker) end += 1;
      parts.push({ kind: 'fence', info: (open[2] ?? '').trim(), closed: end < lines.length, at: i, end });
      i = end;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      parts.push({ kind: 'heading', level: heading[1]?.length ?? 0, name: (heading[2] ?? '').trim(), at: i });
    } else parts.push({ kind: 'line', text: line, at: i });
  }
  return parts;
}

type Heads = { kind: 'heading'; level: number; name: string; at: number };

/** The subheadings of a section, in order. */
const subheadingsOf = (section: string): ReadonlyArray<string> =>
  section === OWNER_SECTION ? OWNER_SUBHEADINGS : REPORT_SUBHEADINGS;

/** A heading no template level allows, or a known word at the other level. */
function atWrongLevel(head: Heads): boolean {
  if (head.level === 1 || head.level > 3) return true;
  const words: ReadonlyArray<string> = head.level === 3 ? REPORT_HEADINGS : OWNER_SUBHEADINGS;
  return words.includes(head.name);
}

/** The first refusal the headings earn: a known word at the wrong level, then an unknown or second one, then a gap, then the order. */
function checkHeadings(heads: ReadonlyArray<Heads>, sectionNames: ReadonlyArray<string>): TemplateRefusal | null {
  const misplaced = heads.find((head) => atWrongLevel(head));
  if (misplaced !== undefined)
    return refuse('heading-level', `a heading at the wrong level on line ${misplaced.at + 1}`);
  const sections: Array<{ name: string; subs: Array<string> }> = [];
  for (const head of heads) {
    const current = sections.at(-1);
    const known =
      head.level === 2 ? sectionNames.includes(head.name) : subheadingsOf(current?.name ?? '').includes(head.name);
    const again =
      head.level === 2 ? sections.some((one) => one.name === head.name) : current?.subs.includes(head.name) === true;
    if (!known || again || (head.level === 3 && current === undefined)) {
      return refuse('extra-heading', `a heading outside the template on line ${head.at + 1}`);
    }
    if (head.level === 2) sections.push({ name: head.name, subs: [] });
    else current?.subs.push(head.name);
  }
  return checkComplete(sections, sectionNames);
}

/** Every section and subheading there, then in order. */
function checkComplete(
  sections: ReadonlyArray<{ name: string; subs: ReadonlyArray<string> }>,
  sectionNames: ReadonlyArray<string>
): TemplateRefusal | null {
  const missing = sectionNames.find((name) => !sections.some((one) => one.name === name));
  if (missing !== undefined) return refuse('missing-heading', `missing the section ${missing}`);
  for (const { name, subs } of sections) {
    const gap = subheadingsOf(name).find((sub) => !subs.includes(sub));
    if (gap !== undefined) return refuse('missing-heading', `${name} is missing ${gap}`);
  }
  const wrongOrder =
    sections.some((one, i) => one.name !== sectionNames[i]) ||
    sections.some((one) => one.subs.some((sub, i) => sub !== subheadingsOf(one.name)[i]));
  return wrongOrder ? refuse('heading-order', 'the headings are out of order') : null;
}

/** One subsection's body, as the template allows it. */
function checkBody(section: string, sub: string, body: ReadonlyArray<Part>): TemplateRefusal | null {
  const where = `${section}, ${sub}`;
  const texts = body
    .flatMap((part) => (part.kind === 'line' ? [part.text.trim()] : ['```']))
    .filter((one) => one !== '');
  if (texts.length === 0) return refuse('empty-subsection', `nothing under ${where}`);
  if (texts.length === 1 && texts[0] === EMPTY_WORD) return null;
  if (texts.some((text) => text === EMPTY_WORD || OTHER_EMPTY.test(text))) {
    return refuse('empty-word', `${where} says nothing in a word other than ${EMPTY_WORD}, or beside a finding`);
  }
  return checkLevels(section, sub, texts) ?? checkTurnRefs(section, sub, texts);
}

/** Lines that must carry a level and a key, or must not. */
function checkLevels(section: string, sub: string, texts: ReadonlyArray<string>): TemplateRefusal | null {
  const where = `${section}, ${sub}`;
  const levelled = FINDING_SUBHEADINGS.includes(sub) || sub === 'Decisions needed';
  if (levelled) {
    return texts.some((text) => !FINDING_LINE.test(text))
      ? refuse('bad-risk', `a line of ${where} has no level and key`)
      : null;
  }
  return !levelled && texts.some((text) => LEVEL_LINE.test(text))
    ? refuse('bad-risk', `a finding under ${where}`)
    : null;
}

/** Every line of `Misunderstandings` cites its turn, but for what could not be read. */
function checkTurnRefs(section: string, sub: string, texts: ReadonlyArray<string>): TemplateRefusal | null {
  if (section !== TURN_SECTION || sub === 'Unavailable checks') return null;
  return texts.every((text) => TURN_ID.test(text))
    ? null
    : refuse('missing-turn-ref', `a line of ${section}, ${sub} cites no turn`);
}

/** The body checks, walking the parts between the headings. */
function checkBodies(parts: ReadonlyArray<Part>): TemplateRefusal | null {
  let section = '';
  let sub: string | null = null;
  let body: Array<Part> = [];
  const close = (): TemplateRefusal | null => (sub === null ? null : checkBody(section, sub, body));
  for (const part of parts) {
    if (part.kind === 'heading') {
      const closed = close();
      if (closed !== null) return closed;
      body = [];
      sub = part.level === 3 ? part.name : null;
      if (part.level === 2) section = part.name;
    } else if (sub !== null) {
      body.push(part);
    } else if (part.kind === 'fence' || part.text.trim() !== '') {
      return refuse('stray-text', `text before the first subheading of ${section}`);
    }
  }
  return close();
}

/** The metadata block under the title: the rows and where they end, or the refusal. */
function readMetadata(
  lines: ReadonlyArray<string>,
  start: number
): { metadata: ReportMetadata; end: number } | TemplateRefusal {
  let at = start;
  while (at < lines.length && (lines[at] ?? '').trim() === '') at += 1;
  const values: Record<string, string> = {};
  for (const [label, name] of METADATA_ROWS) {
    const line = lines[at] ?? '';
    const prefix = `- ${label}:`;
    if (!line.startsWith(prefix)) return refuse('bad-metadata', `the row ${label} is missing or out of order`);
    const value = line.slice(prefix.length).trim();
    if (value === '') return refuse('bad-metadata', `the row ${label} is blank`);
    if (value === EMPTY_WORD && label !== 'Risk') return refuse('bad-metadata', `the row ${label} says ${EMPTY_WORD}`);
    values[name] = value;
    at += 1;
  }
  if ((lines[at] ?? '').trim() !== '') return refuse('bad-metadata', 'a row after the last of the metadata');
  if (!RISKS.includes(values.risk ?? '')) return refuse('bad-metadata', 'the row Risk is no level');
  const { counts: written, open: standing, ...rows } = values;
  const counts = COUNTS.exec(written ?? '');
  if (counts === null) return refuse('bad-metadata', 'the row New findings is no count with its repeats');
  const levels = OPEN.exec(standing ?? '');
  if (levels === null) return refuse('bad-metadata', 'the row Open findings is no count per level');
  const open = {
    critical: Number(levels[1]),
    high: Number(levels[2]),
    medium: Number(levels[3]),
    low: Number(levels[4]),
  };
  const metadata = { ...rows, newFindings: Number(counts[1]), repeats: Number(counts[2]), open } as ReportMetadata;
  return { metadata, end: at };
}

/** Where the one coverage block sits: the refusal, or the parts before it. */
function checkBlock(parts: ReadonlyArray<Part>): { before: ReadonlyArray<Part> } | TemplateRefusal {
  const isBlock = (part: Part): boolean => part.kind === 'fence' && part.info === 'coverage';
  const blocks = parts.filter(isBlock);
  if (blocks.length === 0) return refuse('coverage-missing', 'no coverage block');
  if (blocks.length > 1) return refuse('coverage-misplaced', 'more than one coverage block');
  const index = parts.findIndex(isBlock);
  const after = parts.slice(index + 1);
  const names: ReadonlyArray<string> = [...REPORT_HEADINGS, ...OWNER_SUBHEADINGS];
  if (after.some((part) => part.kind === 'heading' && names.includes(part.name))) {
    return refuse('coverage-misplaced', 'the coverage block is inside a section');
  }
  if (after.some((part) => part.kind !== 'line' || part.text.trim() !== '')) {
    return refuse('trailing-content', 'something after the coverage block');
  }
  return { before: parts.slice(0, index) };
}

/** Whether `text` is a report in the exact template: its day and metadata, or the first thing wrong with it. */
export function checkTemplate(text: string): TemplateCheck {
  const secretLine = findSecret(text);
  if (secretLine !== null) return refuse('secret', `a key-looking string on line ${secretLine}`);
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return refuse('bad-title', 'the report is blank');
  const title = lines[first] ?? '';
  if (!title.startsWith('#')) return refuse('preamble', 'text before the title');
  const day = TITLE.exec(title.trim())?.[1];
  if (day === undefined || !isDay(day)) return refuse('bad-title', 'the title is no "# Watcher report <day>"');
  const read = readMetadata(lines, first + 1);
  if ('code' in read) return read;
  const parts = partsOf(lines, read.end);
  const firstHeading = parts.findIndex((part) => part.kind === 'heading');
  const stray = parts.slice(0, firstHeading === -1 ? parts.length : firstHeading);
  const block = checkBlock(parts);
  if ('code' in block) return block;
  if (stray.some((part) => part.kind !== 'line' || part.text.trim() !== '')) {
    return refuse('stray-text', 'text after the metadata');
  }
  const body = block.before.slice(stray.length);
  const heads = body.filter((part): part is Heads => part.kind === 'heading');
  const refused = checkHeadings(heads, REPORT_HEADINGS) ?? checkBodies(body);
  return refused ?? { ok: true, day, metadata: read.metadata };
}

/** The lines of the metadata with the rows in `rows` replaced; the text is otherwise as it came. */
export function stampMetadata(text: string, rows: Readonly<Record<string, string>>): string {
  return text
    .split('\n')
    .map((line) => {
      const label = /^- ([^:]+):/.exec(line)?.[1];
      return label !== undefined && Object.hasOwn(rows, label) && METADATA_ROWS.some(([one]) => one === label)
        ? `- ${label}: ${rows[label] ?? ''}`
        : line;
    })
    .join('\n');
}

/** The coverage block with its interval and backend replaced by the engine's, so it cannot disagree with the metadata. */
export function stampCoverage(text: string, observation: { from: string; to: string }, backend: string): string {
  const lines = text.split('\n');
  const block = partsOf(lines, 0).find((part) => part.kind === 'fence' && part.info === 'coverage');
  if (block?.kind !== 'fence') return text;
  const held = JSON.parse(lines.slice(block.at + 1, block.end).join('\n')) as Record<string, unknown>;
  const body = JSON.stringify({ ...held, observation, backend }, null, 2);
  return [...lines.slice(0, block.at + 1), body, ...lines.slice(block.end)].join('\n');
}

const LISTS = ['defects', 'suspicious', 'inspected', 'unavailable'] as const;

/** Why the fields of a coverage block fail, naming the field and never its value; null when they hold. */
function coverageProblem(fields: Record<string, unknown>): string | null {
  const observation = fields.observation as { from?: unknown; to?: unknown } | undefined;
  if (typeof observation !== 'object' || observation === null) return 'observation is missing';
  const from = typeof observation.from === 'string' ? Date.parse(observation.from) : NaN;
  const to = typeof observation.to === 'string' ? Date.parse(observation.to) : NaN;
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 'observation is no interval';
  for (const name of ['backend', 'account']) {
    const value = fields[name];
    if (typeof value !== 'string' || value.trim() === '') return `${name} is blank or missing`;
  }
  const isList = (value: unknown): value is Array<string> =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (!isList(fields.sources) || fields.sources.length === 0) return 'sources is empty or missing';
  const seen = new Map<string, string>();
  for (const name of LISTS) {
    const list = fields[name];
    if (!isList(list)) return `${name} is no list or missing`;
    for (const item of list) {
      const earlier = seen.get(item);
      if (earlier !== undefined && earlier !== name) return `one item is under both ${earlier} and ${name}`;
      seen.set(item, name);
    }
  }
  return null;
}

/** The one coverage block of `text` as data, or why not. A refusal never quotes the block. */
export function checkCoverage(text: string): CoverageCheck {
  const lines = text.split('\n');
  const blocks = partsOf(lines, 0).flatMap((part) => (part.kind === 'fence' && part.info === 'coverage' ? [part] : []));
  const [block] = blocks;
  if (block === undefined) return { ok: false, code: 'coverage-missing', detail: 'no coverage block' };
  const bad = (detail: string): CoverageCheck => ({ ok: false, code: 'coverage-invalid', detail });
  if (blocks.length > 1) return bad('more than one coverage block');
  if (!block.closed) return bad('the coverage block is not closed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(block.at + 1, block.end).join('\n'));
  } catch {
    return bad('the coverage block is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return bad('the block is no object');
  const problem = coverageProblem(parsed as Record<string, unknown>);
  return problem === null ? { ok: true, coverage: parsed as Coverage } : bad(problem);
}

/** One finding line and its place in the text, for the risk rules (src/watcher/risk.ts). */
export type FindingLine = { section: string; line: number; level: FindingLevel; key: string; text: string };

/** The finding lines of the two risk subsections of each section, in order. */
export function findingLines(text: string): Array<FindingLine> {
  const found: Array<FindingLine> = [];
  let section = '';
  let sub = '';
  for (const part of partsOf(text.split('\n'), 0)) {
    if (part.kind === 'heading') {
      if (part.level === 2) section = part.name;
      sub = part.level === 3 ? part.name : '';
    } else if (part.kind === 'line' && FINDING_SUBHEADINGS.includes(sub)) {
      const line = FINDING_LINE.exec(part.text.trim());
      if (line !== null) {
        found.push({
          section,
          line: part.at,
          level: line[1] as FindingLevel,
          key: line[2] ?? '',
          text: line[3] ?? '',
        });
      }
    }
  }
  return found;
}

/**
 * Commits the report of one run: its immutable file in `runs/`, then `<day>.md` swapped atomically to link to it, so a day
 * reader sees the old report or the new one and never a part. A plain `<day>.md` from before versions stays readable
 * under the identity `legacy-<day>`. Only a text that passes `checkReport` is committed.
 */
export function commitReport(input: {
  reportsDir: string;
  day: string;
  runId: string;
  at: number;
  text: string;
}): ReportCheck & { path?: string } {
  const { reportsDir, day, runId, at, text } = input;
  if (!isDay(day)) return { ok: false, code: 'invalid-day', detail: 'the day is not a date' };
  const checked = checkReport(text);
  if (!checked.ok) return checked;
  const versions = path.join(reportsDir, VERSIONS_DIR);
  fs.mkdirSync(versions, { recursive: true });
  const name = versionFileOf(day, at, runId);
  const file = path.join(versions, name);
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  const view = path.join(reportsDir, `${day}.md`);
  if (fs.lstatSync(view, { throwIfNoEntry: false })?.isFile() === true) {
    fs.linkSync(view, path.join(versions, versionFileOf(day, 0, `legacy-${day}`)));
  }
  fs.rmSync(`${view}.tmp`, { force: true });
  fs.symlinkSync(path.join(VERSIONS_DIR, name), `${view}.tmp`);
  fs.renameSync(`${view}.tmp`, view);
  return { ok: true, path: file };
}

/**
 * `added` at the head of one subsection, before what the agent wrote there. A subsection that says only `none` gives that
 * word up, since there is something to say. No lines leave the text as it was.
 */
function insertLines(text: string, section: string, sub: string, added: ReadonlyArray<string>): string {
  if (added.length === 0) return text;
  const lines = text.split('\n');
  const parts = partsOf(lines, 0);
  const sectionAt = parts.findIndex((part) => part.kind === 'heading' && part.level === 2 && part.name === section);
  const subAt = parts.findIndex(
    (part, i) => i > sectionAt && part.kind === 'heading' && part.level === 3 && part.name === sub
  );
  if (sectionAt === -1 || subAt === -1) return text;
  const start = parts[subAt]?.at ?? 0;
  const next = parts
    .slice(subAt + 1)
    .find((part) => part.kind === 'heading' || (part.kind === 'fence' && part.info === 'coverage'));
  const end = next?.at ?? lines.length;
  const body = lines.slice(start + 1, end);
  const own = body.map((line) => line.trim()).filter((line) => line !== '');
  const kept = own.length === 1 && own[0] === EMPTY_WORD ? [''] : body;
  return [...lines.slice(0, start + 1), '', ...added, ...kept, ...lines.slice(end)].join('\n');
}

/** A gap the engine itself knows, under `### Unavailable checks` of `section`. */
export const insertUnavailable = (text: string, section: string, added: ReadonlyArray<string>): string =>
  insertLines(text, section, 'Unavailable checks', added);
