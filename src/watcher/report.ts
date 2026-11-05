// The watcher's report: the check a text must pass (the seven headings in order, a line under each, no key or token
// anywhere), the commit that happens only when the text passes, and the lines of the tasks the engine filed under "Tasks
// filed". src/watcher/inspection.ts calls all three. A refusal's detail never holds the text that caused it, so a planted
// key is copied nowhere.

import fs from 'node:fs';
import path from 'node:path';
import { VERSIONS_DIR, isDay, versionFileOf } from './read.ts';

export const REPORT_HEADINGS = [
  'Her day',
  'Misunderstandings',
  'Memory',
  'The project',
  'The server',
  'Tasks filed',
  'For the owner',
] as const;

export type ReportCode =
  'missing-heading' | 'extra-heading' | 'heading-order' | 'empty-section' | 'preamble' | 'secret' | 'invalid-day';
export type ReportCheck = { ok: true } | { ok: false; code: ReportCode; detail: string };

// An OpenRouter or OpenAI style key, a GitHub token, an AWS key id, a bearer header and the task token variable.
const SECRETS: ReadonlyArray<RegExp> = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /NEPTUNIA_TASK_TOKEN=\S+/,
];

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

/** Whether `text` is a report: the seven headings of `REPORT_HEADINGS`, each once, in order, each with a line. */
export function checkReport(text: string): ReportCheck {
  const secretLine = findSecret(text);
  if (secretLine !== null) return { ok: false, code: 'secret', detail: `a key-looking string on line ${secretLine}` };
  const { headings, preamble, sections } = scan(text);
  if (preamble) return { ok: false, code: 'preamble', detail: 'text before the first heading' };
  const known: ReadonlyArray<string> = REPORT_HEADINGS;
  const seen = new Set<string>();
  for (const heading of headings) {
    if (heading.level !== 2 || !known.includes(heading.name) || seen.has(heading.name)) {
      return { ok: false, code: 'extra-heading', detail: `an extra heading on line ${heading.line}` };
    }
    seen.add(heading.name);
  }
  const missing = REPORT_HEADINGS.filter((name) => !seen.has(name));
  if (missing.length > 0) return { ok: false, code: 'missing-heading', detail: `missing: ${missing.join(', ')}` };
  if (headings.some((heading, i) => heading.name !== REPORT_HEADINGS[i])) {
    return { ok: false, code: 'heading-order', detail: 'the headings are out of order' };
  }
  const empty = headings.find((_, i) => sections.get(i) !== true);
  if (empty !== undefined) return { ok: false, code: 'empty-section', detail: `nothing under "${empty.name}"` };
  return { ok: true };
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

const NOTHING = /^nothing found\.?$/i;

/**
 * The engine's lines right under the "Tasks filed" heading, before the agent's own text. A section that says only "nothing
 * found" gives that line up, since there is something to say. No lines leave the text as it was.
 */
export function insertFilingLines(text: string, added: ReadonlyArray<string>): string {
  if (added.length === 0) return text;
  const lines = text.split('\n');
  const at = lines.findIndex((line) => /^##\s+Tasks filed\s*$/.test(line));
  if (at === -1) return text;
  let end = lines.findIndex((line, i) => i > at && /^##\s/.test(line));
  if (end === -1) end = lines.length;
  const body = lines.slice(at + 1, end);
  const own = body.map((line) => line.trim()).filter((line) => line !== '');
  const kept = own.length === 1 && NOTHING.test(own[0] ?? '') ? [] : body;
  const tail = kept.length === 0 || (kept[0] ?? '').trim() !== '' ? ['', ...kept] : kept;
  return [...lines.slice(0, at + 1), '', ...added, ...tail, ...lines.slice(end)].join('\n');
}
