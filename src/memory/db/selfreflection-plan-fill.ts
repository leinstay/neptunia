// The owner's plan fill for old selfreflection entries (`/memory backfill-plans [--dry-run|status]`, writer kind
// `selfreflection-plan-fill`). An entry written before the planner's plan was kept has no `extra.plan`. The run shows each
// live one, oldest first, to the analyzer once (purpose `selfreflection-plan-fill`, prompts/selfreflection-plan-fill.md):
// its kind, its text, its scene (the description of its first picture, else its drawing prompt) and, for an entry that
// shows a scene, the seed families of prompts/selfreflection-seeds.md with every line. The answer follows a strict JSON
// schema (`planFillSchema`), and `planFromAnswer` turns it into the plan stored: the brief, one combination of one line
// of each family in the families' order (`seed` 1), or the brief alone (`seeds` empty, `seed` 0) for a kind that built
// on no seed and an entry with no scene. The plan carries `reconstructed: true` and is written through the one writer
// (`applySelfreflectionPlanFill` in selfreflection-plan-write.ts), which changes nothing else of the entry.
//
// A request that fails or an answer that does not fit leaves its entry for the next run, counted under its code, and the
// run goes on. The daily request cap stops the run (`stopped`, code `daily-cap`), and the next run goes on from the first
// entry still without a plan. A dry run counts with no request and no write. Logs: codes only.

import { DailyCapError, railReason, roleRequestOptions } from '../../llm/openrouter.ts';
import { roleModel } from '../../llm/roles.ts';
import { parseSeedFamilies } from '../../behavior/selfreflection.ts';
import { oneLine } from '../clamp.ts';
import { entryPictureDescriptions } from './media-store.ts';
import { extraOf } from './selfreflection-plan-write.ts';
import { asText } from './types.ts';
import type { FilledPlan } from './selfreflection-plan-write.ts';
import type { Db, Row } from './types.ts';

/** The usage purpose of a fill request. */
export const PLAN_FILL_PURPOSE = 'selfreflection-plan-fill';
/** The prompt file of a fill request. */
const PROMPT = 'selfreflection-plan-fill';
/** The kinds that show no scene and build on no seed (src/behavior/selfreflection.ts#SELFREFLECTION_KINDS). */
const NO_SCENE_KINDS = new Set(['thought', 'people', 'news', 'facts', 'meme']);
/** The planner's answer settings when `selfreflection` holds none (config/config.json's values). */
const MAX_OUTPUT_TOKENS = 2000;
const TIMEOUT_MS = 60000;

/**
 * The JSON schema of the answer for an entry: `brief`, a string, and, when `scene`, one field per family of `families`
 * whose value is one of that family's lines. Every field is required and no other is allowed, as a strict
 * `response_format` needs.
 */
export function planFillSchema(families: Record<string, Array<string>>, scene: boolean): object {
  const properties: Record<string, object> = { brief: { type: 'string' } };
  if (scene)
    for (const [family, lines] of Object.entries(families)) properties[family] = { type: 'string', enum: lines };
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * The plan to store from a parsed answer: null when it is not an object, its brief is missing or blank, or, when `scene`,
 * a family's field is missing or names no line of that family.
 */
export function planFromAnswer(
  answer: unknown,
  families: Record<string, Array<string>>,
  scene: boolean
): FilledPlan | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const given = answer as Record<string, unknown>;
  if (typeof given.brief !== 'string' || given.brief.trim() === '') return null;
  const brief = oneLine(given.brief);
  if (!scene) return { brief, seeds: [], seed: 0, reconstructed: true };
  const combination: Array<string> = [];
  for (const [family, lines] of Object.entries(families)) {
    const line = given[family];
    if (typeof line !== 'string' || !lines.includes(line)) return null;
    combination.push(line);
  }
  return { brief, seeds: [combination], seed: 1, reconstructed: true };
}

/** What a run came to. */
export type PlanFillReport = {
  /** Live entries with no plan when the run began. */
  toFill: number;
  filled: number;
  /** Filled with a combination of seed lines. */
  withSeeds: number;
  /** Filled with the brief alone. */
  briefOnly: number;
  failed: number;
  /** The failures by code. */
  codes: Record<string, number>;
  /** Entries still with no plan. */
  left: number;
};

/** What a run looks like from the owner's command. `stopped` is a run the daily request cap ended early. */
export type PlanFillDeskState = {
  state: 'idle' | 'running' | 'done' | 'stopped' | 'failed';
  report: PlanFillReport | null;
  code?: string;
};

/** One entry the run asks about. */
type Entry = { id: string; kind: string | null; text: string; scene: string };

/** The live entries with no plan, oldest first. An entry whose metadata cannot be read is left alone. */
function entriesToFill(db: Db): Array<Entry> {
  const rows = db
    .prepare(
      `SELECT id, kind, text, gist, picture_prompt, extra FROM selfreflection
        WHERE retired_at IS NULL ORDER BY at_ms, rowid`
    )
    .all()
    .filter((row) => {
      const extra = extraOf(row.extra);
      return extra !== null && extra.plan === undefined;
    });
  const described = entryPictureDescriptions(
    db,
    rows.map((row) => asText(row.id))
  );
  return rows.map((row) => {
    const id = asText(row.id);
    const text = typeof row.text === 'string' && row.text.trim() ? row.text : asText(row.gist ?? '');
    const prompt = typeof row.picture_prompt === 'string' ? oneLine(row.picture_prompt) : '';
    return {
      id,
      kind: typeof row.kind === 'string' && row.kind ? row.kind : null,
      text,
      scene: described.get(id) ?? prompt,
    };
  });
}

/** The families with at least one line. */
function familiesOf(seeds: unknown): Record<string, Array<string>> {
  return Object.fromEntries(Object.entries(parseSeedFamilies(seeds)).filter(([, lines]) => lines.length > 0));
}

/** Whether an entry is asked for seed lines: it shows a scene, its kind builds on seeds, and there are families. */
const showsScene = (entry: Entry, families: Record<string, Array<string>>): boolean =>
  entry.scene !== '' && !NO_SCENE_KINDS.has(entry.kind ?? '') && Object.keys(families).length > 0;

/** The user message of a fill request: the entry's blocks, and the families for an entry with a scene. */
function requestOf(entry: Entry, families: Record<string, Array<string>>, scene: boolean): string {
  const blocks: Array<string> = [];
  if (entry.kind) blocks.push(`<kind>\n${entry.kind}\n</kind>`);
  if (entry.text) blocks.push(`<entry>\n${entry.text}\n</entry>`);
  if (entry.scene) blocks.push(`<scene>\n${entry.scene}\n</scene>`);
  if (scene) {
    const lines = Object.entries(families).map(([family, seeds]) => [`# ${family}`, ...seeds].join('\n'));
    blocks.push(`<families>\n${lines.join('\n')}\n</families>`);
  }
  return blocks.join('\n\n');
}

/** The code of a failed request: its own code, a rail's reason, else `error`. */
function codeOf(error: unknown): string {
  const own = (error as { code?: unknown } | null)?.code;
  if (typeof own === 'string' && own) return own;
  return railReason(error, 'error');
}

/** The ports of a run: the model's answer for a request, and the write of one plan. */
type Ports = {
  ask(entry: Entry, user: string, schema: object): Promise<string>;
  write(id: string, plan: FilledPlan): Promise<unknown>;
  warn(message: string, fields?: Row): void;
};

/** One answer read as JSON, or a code. */
function parsed(text: string): { ok: true; value: unknown } | { ok: false; code: string } {
  if (text.trim() === '') return { ok: false, code: 'empty' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: 'bad-json' };
  }
}

/** The run: see the head of this file. Resolves its report and whether the daily cap stopped it. */
async function fillPlans({
  db,
  seeds,
  dryRun,
  ...ports
}: Ports & { db: Db; seeds: unknown; dryRun: boolean }): Promise<{ report: PlanFillReport; capped: boolean }> {
  const families = familiesOf(seeds);
  const entries = entriesToFill(db);
  const report: PlanFillReport = {
    toFill: entries.length,
    filled: 0,
    withSeeds: 0,
    briefOnly: 0,
    failed: 0,
    codes: {},
    left: entries.length,
  };
  if (dryRun) return { report, capped: false };
  const fail = (code: string): void => {
    report.failed += 1;
    report.codes[code] = (report.codes[code] ?? 0) + 1;
    ports.warn('memory db: plan fill failed', { code });
  };
  for (const entry of entries) {
    const scene = showsScene(entry, families);
    let text: string;
    try {
      text = await ports.ask(entry, requestOf(entry, families, scene), planFillSchema(families, scene));
    } catch (error) {
      if (error instanceof DailyCapError) {
        ports.warn('memory db: plan fill stopped', { code: 'daily-cap', filled: report.filled, left: report.left });
        return { report, capped: true };
      }
      fail(codeOf(error));
      continue;
    }
    const answer = parsed(text);
    if (!answer.ok) {
      fail(answer.code);
      continue;
    }
    const plan = planFromAnswer(answer.value, families, scene);
    if (!plan) {
      fail('bad-answer');
      continue;
    }
    try {
      const done = (await ports.write(entry.id, plan)) as { written?: unknown } | null;
      if (done?.written !== 1) {
        fail('not-written');
        continue;
      }
    } catch (error) {
      fail(codeOf(error));
      continue;
    }
    report.filled += 1;
    report.left -= 1;
    if (plan.seed === 1) report.withSeeds += 1;
    else report.briefOnly += 1;
  }
  return { report, capped: false };
}

type Llm = { complete(messages: Array<{ role: string; content: string }>, options: object): Promise<unknown> };
type Hot = { config: unknown; prompts: unknown };

/**
 * The owner's command over a run, like `createEnglishDesk` (media-english.ts): one at a time, in the background, its last
 * state held for `status`. A dry run answers at once; a run asked while one goes answers that one's state. Requests go on
 * the `analyzer` role with `selfreflection.planMaxOutputTokens` and `selfreflection.planTimeoutMs`; the settings and the
 * prompts are read at each request.
 */
export function selfreflectionPlanFillDesk({
  memoryDb,
  llm,
  hot,
  now,
  log,
}: {
  memoryDb: { database(): unknown; memoryWrite(update: unknown): Promise<unknown> };
  llm: Llm;
  hot: Hot;
  now: () => number;
  log: { warn(message: string, fields?: Row): void };
}): { start(options: { dryRun: boolean }): Promise<PlanFillDeskState>; status(): PlanFillDeskState } {
  let current: PlanFillDeskState = { state: 'idle', report: null };
  const prompts = (): Row => (hot.prompts ?? {}) as Row;
  const ask = async (_entry: Entry, user: string, schema: object): Promise<string> => {
    const { config } = hot;
    const settings = ((config as Row | null)?.selfreflection ?? {}) as Row;
    const answer = (await llm.complete(
      [
        { role: 'system', content: asText(prompts()[PROMPT] ?? '') },
        { role: 'user', content: user },
      ],
      {
        model: roleModel(config, 'analyzer', PLAN_FILL_PURPOSE),
        ...roleRequestOptions(config, {
          role: 'analyzer',
          maxOutputTokens:
            typeof settings.planMaxOutputTokens === 'number' ? settings.planMaxOutputTokens : MAX_OUTPUT_TOKENS,
          timeoutMs: typeof settings.planTimeoutMs === 'number' ? settings.planTimeoutMs : TIMEOUT_MS,
          purpose: PLAN_FILL_PURPOSE,
        }),
        responseFormat: { name: 'selfreflection_plan', schema },
      }
    )) as { text?: unknown } | null;
    return typeof answer?.text === 'string' ? answer.text : '';
  };
  const write = (id: string, plan: FilledPlan): Promise<unknown> =>
    memoryDb.memoryWrite({ kind: 'selfreflection-plan-fill', id, plan, now: now() });
  return {
    status: () => current,
    async start({ dryRun }) {
      const db = memoryDb.database() as Db | null;
      if (db === null) return { state: 'failed', report: null, code: 'DB_CLOSED' };
      const prompt = prompts()[PROMPT];
      if (typeof prompt !== 'string' || prompt.trim() === '')
        return { state: 'failed', report: null, code: 'NO_PROMPT' };
      const run = (dry: boolean) =>
        fillPlans({
          db,
          seeds: prompts()['selfreflection-seeds'],
          dryRun: dry,
          ask,
          write,
          warn: (message, fields) => log.warn(message, fields),
        });
      if (dryRun) return { state: 'done', report: (await run(true)).report };
      if (current.state === 'running') return current;
      current = { state: 'running', report: null };
      run(false)
        .then(({ report, capped }) => {
          current = capped ? { state: 'stopped', report, code: 'daily-cap' } : { state: 'done', report };
        })
        .catch((error: unknown) => {
          const code = codeOf(error);
          log.warn('memory db: plan fill failed', { code });
          current = { state: 'failed', report: null, code };
        });
      return current;
    },
  };
}
