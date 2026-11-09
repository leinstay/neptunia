// Fakes for the watcher's lifecycle tests: a watcher folder under a temp persona root, a run store with an injected
// clock and an injected table of live processes, and an agent that answers a canned text. The answers follow the report's exact template with its `coverage` block at the end, which the check of an inspection requires.
// Synthetic data only: no provider, no database, no socket.
import fs from 'node:fs';
import path from 'node:path';
import type { InspectionAgentResult, InspectionDeps } from '../../src/watcher/inspection.ts';
import type { ProcessIdentity, RunStore } from '../../src/watcher/lifecycle.ts';
import { tempDir } from './tmp.ts';
import { HEADINGS } from './watcher-rig.ts';

export const NOW = Date.parse('2026-11-04T06:00:00Z');
export const DAY = '2026-11-04';
export const MINUTE = 60_000;

/** The inspecting process as the tests' table of live processes knows it. */
export const SELF: ProcessIdentity = { pid: 4242, startId: 'boot-a' };

/** What `checkCoverage` of src/watcher/report.ts reads: one valid block, each field replaceable. */
export function coverageOf(fields: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    observation: { from: '2026-11-03T06:00:00.000Z', to: '2026-11-04T06:00:00.000Z' },
    backend: 'claude',
    account: 'the persona account',
    sources: ['model_requests', 'service journal'],
    defects: [],
    suspicious: [],
    inspected: ['memory cursors'],
    unavailable: ['provider quota'],
    ...fields,
  };
}

export const coverageBlock = (fields: Readonly<Record<string, unknown>> = {}): string =>
  '```coverage\n' + JSON.stringify(coverageOf(fields), null, 2) + '\n```\n';

export const SUBHEADINGS: ReadonlyArray<string> = [
  'Observed defects',
  'Suspicious evidence',
  'Inspected without a finding',
  'Unavailable checks',
];

/** What the fixed metadata block says, in its fixed order. */
export const METADATA: ReadonlyArray<readonly [string, string]> = [
  ['Observation interval', '2026-11-03T06:00:00.000Z to 2026-11-04T06:00:00.000Z'],
  ['Run id', 'run-template'],
  ['Selected backend', 'claude'],
  ['Model', 'model-m'],
  ['Effort', 'medium'],
  ['Effective account', 'the persona account'],
  ['Available sources', 'model_requests, service journal'],
  ['Risk', 'none'],
  ['New findings', '0, repeats: 0'],
  ['Open findings', 'critical 0, high 0, medium 0, low 0'],
];

/** One section's body: a string goes under `Inspected without a finding`, an object names the subheadings it fills. */
type SectionBody = string | Readonly<Record<string, string>>;

/**
 * A report in the exact template of `checkTemplate`. The options reorder or replace a part so a test can break one thing:
 * the title line, the metadata rows, the sections, the subheadings of each section, and the block at the end.
 */
export function templateOf(
  options: {
    day?: string;
    title?: string;
    metadata?: ReadonlyArray<readonly [string, string]>;
    bodies?: Readonly<Record<string, SectionBody>>;
    sections?: ReadonlyArray<string>;
    subheadings?: ReadonlyArray<string>;
    end?: string;
  } = {}
): string {
  const title = options.title ?? `# Watcher report ${options.day ?? DAY}`;
  const metadata = (options.metadata ?? METADATA).map(([label, value]) => `- ${label}: ${value}`).join('\n');
  const subheadings = options.subheadings ?? SUBHEADINGS;
  const sections = (options.sections ?? HEADINGS).map((heading) => {
    const body = options.bodies?.[heading] ?? {};
    const of = (name: string): string => {
      if (typeof body !== 'string') return body[name] ?? 'none';
      return name === 'Inspected without a finding' ? body : 'none';
    };
    const own = heading === 'For the owner' ? ['Decisions needed', ...subheadings] : subheadings;
    return [`## ${heading}`, ...own.map((name) => `### ${name}\n\n${of(name)}`)].join('\n\n');
  });
  return [title, metadata, ...sections, options.end ?? coverageBlock()].join('\n\n').trimEnd() + '\n';
}

/** A whole answer: the report in its template with `bodies`, each string under `Inspected without a finding`. */
export function answerOf(bodies: Readonly<Record<string, string>> = {}): string {
  return templateOf({ bodies });
}

export const said = (text: string): InspectionAgentResult => ({ ok: true, text, exitCode: 0 });

export type InspectionRig = {
  root: string;
  dir: string;
  reportsDir: string;
  promptFile: string;
  clock: { t: number };
  /** pid to start id of the processes alive at this moment. */
  alive: Map<number, string>;
  store: RunStore;
};

/** A persona root with `agents/watcher/prompt.md` and an empty `reports/`, the clock at `start`, `SELF` alive. */
export function inspectionRig(start: number = NOW): InspectionRig {
  const root = tempDir('nep-inspection-');
  const dir = path.join(root, 'agents', 'watcher');
  const reportsDir = path.join(dir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, 'PROMPT-SENTINEL');
  const clock = { t: start };
  const alive = new Map([[SELF.pid, SELF.startId]]);
  let made = 0;
  const store: RunStore = {
    dir,
    now: () => clock.t,
    newRunId: () => {
      made += 1;
      return `run-${made}`;
    },
    processStart: (pid) => alive.get(pid) ?? null,
  };
  return { root, dir, reportsDir, promptFile, clock, alive, store };
}

/** The deps of one inspection over `rig`, answering `answerOf()` unless the overrides say otherwise. */
export function inspectionDeps(rig: InspectionRig, overrides: Partial<InspectionDeps> = {}): InspectionDeps {
  return {
    store: rig.store,
    reportsDir: rig.reportsDir,
    self: SELF,
    source: 'timer',
    timeoutMs: 60 * MINUTE,
    promptFiles: [rig.promptFile],
    selected: { backend: 'claude', model: 'model-m', effort: 'medium' },
    runAgent: () => Promise.resolve(said(answerOf())),
    cancelPollMs: 5,
    ...overrides,
  };
}

/** Every file under `dir`, with its text: what a planted value must appear in nowhere. */
export function allTextUnder(dir: string): string {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

/** Resolves when `signal` aborts; a run that never hears the cancel fails the test in three seconds. */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('the run was never aborted')), 3_000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The body of the `## <heading>` section of a report. */
export function sectionOf(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}
