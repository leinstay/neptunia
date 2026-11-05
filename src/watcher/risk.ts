// The risk of a watcher finding. The model writes a level on each finding line (src/watcher/report.ts), and code alone
// decides whether the finding repeats an earlier successful report. A repeat is lowered to `low` with a fixed mark, new
// evidence brings the model's level back, and a finding whose task was done with a merged pull request counts as new when
// it comes back. A level is the model's opinion, the repeat is a fact. Pure: src/watcher/inspection.ts brings the history.

import { findingLines } from './report.ts';
import type { FindingLevel, OpenCounts } from './report.ts';

export type RiskLevel = FindingLevel;
export type ReportRisk = RiskLevel | 'none';
export type RiskHistoryEntry = {
  day: string;
  /** `level` as the report saved it: the level a finding came in at, on its first sighting. */
  findings: ReadonlyArray<{ key: string; text: string; level?: RiskLevel }>;
  /** Keys resolved by this moment: what was seen before it no longer counts. */
  resolved?: ReadonlyArray<string>;
};
export type RiskFinding = { key: string; level: RiskLevel; text: string };
export type RatedFinding = {
  key: string;
  level: RiskLevel;
  modelLevel: RiskLevel;
  text: string;
  repeat: { count: number; firstDay: string; cameInAt?: RiskLevel } | null;
};
export type RiskResult = { findings: Array<RatedFinding>; risk: ReportRisk; newFindings: number; repeats: number };

const ORDER: ReadonlyArray<RiskLevel> = ['critical', 'high', 'medium', 'low'];
const REPEAT_MARK = /\s*\(repeat \d+, first \d{4}-\d{2}-\d{2}\)\s*$/;

// What differs from one sighting to the next and proves nothing: ids and moments. A bare count is left out by never being
// read as evidence, so "14 retries" and "15 retries" are the same finding.
const NOISE: ReadonlyArray<RegExp> = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?/gi,
  /(?<![\w:])\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g,
  /\b(?:run|task|req|t)-[\w-]+/gi,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi,
  /\b\d{6,}\b/g,
];
// What the evidence is: a path or file with its line, a snake_case or kebab-case code. A kebab word of plain
// English counts too: a finding wrongly called new costs a line, and a new failure wrongly lowered costs the warning.
const EVIDENCE = [
  /[\w.-]*\/[\w./-]*\w(?::\d+)?/g,
  /\b[\w-]+\.[a-z][a-z0-9]{0,4}(?::\d+)?\b/g,
  /\b[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+\b/g,
];

/** The evidence a finding's text names: its paths, lines and codes, sorted. Prose, moments and ids leave no trace. */
export function evidenceFingerprint(text: string): string {
  let cleaned = text;
  for (const noise of NOISE) cleaned = cleaned.replace(noise, ' ');
  // An errno is told from a word by its capitals, so it is read before the lower-casing.
  const tokens = new Set<string>([...cleaned.matchAll(/\bE[A-Z]{4,}\b/g)].map(([word]) => word.toLowerCase()));
  let rest = cleaned.toLowerCase();
  for (const pattern of EVIDENCE) {
    rest = rest.replace(pattern, (token) => {
      tokens.add(token);
      return ' ';
    });
  }
  return [...tokens].sort().join(' ');
}

type Sighting = { key: string; fingerprint: string; day: string; level?: RiskLevel };

/** Every sighting that still counts, in order: a resolution clears its key and whatever evidence that key had. */
function sightingsOf(history: ReadonlyArray<RiskHistoryEntry>): Array<Sighting> {
  let sightings: Array<Sighting> = [];
  for (const entry of history) {
    for (const key of entry.resolved ?? []) {
      const evidence = new Set(
        sightings.filter((one) => one.key === key && one.fingerprint !== '').map((one) => one.fingerprint)
      );
      sightings = sightings.filter((one) => one.key !== key && !evidence.has(one.fingerprint));
    }
    for (const { key, text, level } of entry.findings) {
      sightings.push({
        key,
        fingerprint: evidenceFingerprint(text),
        day: entry.day,
        ...(level === undefined ? {} : { level }),
      });
    }
  }
  return sightings;
}

/**
 * The earlier sightings a finding repeats, from the last change of evidence under its key on. Equal evidence is the same
 * finding under any key. With no evidence to compare, the key decides, and a key that names no evidence today brings none new.
 */
function repeatsOf(key: string, fingerprint: string, sightings: ReadonlyArray<Sighting>): Array<Sighting> {
  const same = (one: Sighting): boolean => (fingerprint === '' ? one.key === key : one.fingerprint === fingerprint);
  let changed = -1;
  sightings.forEach((one, index) => {
    if (one.key === key && !same(one)) changed = index;
  });
  return sightings.slice(changed + 1).filter(same);
}

/** The findings of a report as the rules leave them, with the report's risk and its counts. */
export function applyRiskRules(
  findings: ReadonlyArray<RiskFinding>,
  history: ReadonlyArray<RiskHistoryEntry>
): RiskResult {
  const sightings = sightingsOf(history);
  const rated = findings.map(({ key, level, text }): RatedFinding => {
    const earlier = repeatsOf(key, evidenceFingerprint(text), sightings);
    const first = earlier[0];
    if (first === undefined) return { key, level, modelLevel: level, text, repeat: null };
    const cameInAt = first.level === undefined ? {} : { cameInAt: first.level };
    const repeat = { count: earlier.length + 1, firstDay: first.day, ...cameInAt };
    return { key, level: 'low', modelLevel: level, text, repeat };
  });
  const fresh = rated.filter((one) => one.repeat === null);
  return {
    findings: rated,
    risk: ORDER.find((level) => fresh.some((one) => one.level === level)) ?? 'none',
    newFindings: fresh.length,
    repeats: rated.length - fresh.length,
  };
}

/**
 * What this report holds open, per level. A new finding counts at its level and a repeat at the level of its first sighting,
 * which is the one saved before the rules lowered it. A finding the report omits is closed.
 */
export function openCounts(rated: ReadonlyArray<RatedFinding>): OpenCounts {
  const counts: OpenCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const one of rated) counts[one.repeat?.cameInAt ?? (one.repeat === null ? one.level : one.modelLevel)] += 1;
  return counts;
}

/** The findings of a report's two risk subsections, without a mark and without "Tasks filed". */
export function findingsOf(
  reportText: string
): Array<{ section: string; key: string; level: RiskLevel; text: string }> {
  return findingLines(reportText).map(({ section, key, level, text }) => ({
    section,
    key,
    level,
    text: text.replace(REPEAT_MARK, ''),
  }));
}

/** `reportText` with each finding line as the rules left it: its level and, on a repeat, the one fixed mark. */
export function markFindings(reportText: string, rated: ReadonlyArray<RatedFinding>): string {
  const lines = reportText.split('\n');
  findingLines(reportText).forEach(({ line }, index) => {
    const one = rated[index];
    if (one === undefined) return;
    const mark = one.repeat === null ? '' : ` (repeat ${one.repeat.count}, first ${one.repeat.firstDay})`;
    lines[line] = `- [${one.level}] ${one.key}: ${one.text}${mark}`;
  });
  return lines.join('\n');
}
