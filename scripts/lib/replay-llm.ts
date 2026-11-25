// The model side of the replay modes: the routing of a mode, the recording client of the diary and inner modes, the
// usage and cost they add up, the cache switch of a run, and the estimates the spend gate reads.

import { roleModel } from '../../src/llm/roles.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { offlineCore } from './answers-dir.ts';
import { privateDirOf } from './cli.ts';
import type { Rec } from './replay-types.ts';
import { scriptRouting, routesText } from './script-routes.ts';
import type { RouteRole, Variant, ScriptRouting } from './script-routes.ts';

/** The estimate per model request this tool sends: about what a persona answer costs on the live key. */
export const USD_PER_ANSWER = 0.15;

/** The estimate per embedding request: well above what one text of a turn's recall or search costs to embed. */
export const USD_PER_EMBEDDING = 0.01;

/** A turn's requests at most: the persona's answer and up to four tool-loop steps (wakes.loop.maxSteps' default). */
export const TURN_REQUESTS = 5;

/**
 * The llm client of a diary run: every request the tool's own (`origin: 'replay'`, never
 * counted against the daily cap, no calibration; `noCache`: no prompt-cache marker), each one
 * recorded in `calls` as `{ purpose, text, toolCalls, finishReason, usage, error, code }` (`toolCalls`: the
 * completion's calls of the answer; `code`: the short failure code of `errorCodeOf`, when given, else `error`).
 */
export function recordingLlm(realLlm: Untyped, calls: Rec, { noCache = false, errorCodeOf = null }: Rec = {}): Rec {
  return new Proxy(realLlm, {
    get(target, prop) {
      if (prop === 'complete') {
        return async (messages: Untyped, options: Untyped = {}) => {
          const call: Rec = {
            purpose: options?.purpose ?? null,
            text: null,
            toolCalls: null,
            finishReason: null,
            usage: null,
            error: null,
            code: null,
            // The turn's blocks with their sizes, as it hands them to the request archive.
            ...(Array.isArray(options?.blocks) ? { blocks: options.blocks } : {}),
          };
          calls.push(call);
          try {
            const completion = await target.complete(messages, {
              ...options,
              origin: 'replay',
              countAgainstDailyCap: false,
              skipCalibration: true,
              ...(noCache ? { cache: false } : {}),
            });
            call.text = completion?.text ?? null;
            call.toolCalls = Array.isArray(completion?.toolCalls) ? completion.toolCalls : null;
            call.finishReason = completion?.finishReason ?? null;
            call.usage = completion?.usage ?? null;
            return completion;
          } catch (err: Untyped) {
            call.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
            call.code = typeof errorCodeOf === 'function' ? errorCodeOf(err) : 'error';
            throw err;
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** What one recorded request cost, as the provider reported it (else 0). */
function callCost(call: Untyped) {
  const details = call.usage?.cost_details as { upstream_inference_cost?: unknown } | undefined;
  const cost = Number(details?.upstream_inference_cost ?? call.usage?.cost ?? 0);
  return Number.isFinite(cost) ? cost : 0;
}

/** `usage` with the recorded requests `mine` added. */
export function addUsage(usage: Untyped, mine: Untyped): Untyped {
  let out = usage;
  for (const call of mine) {
    out = {
      ...out,
      requests: out.requests + 1,
      promptTokens: out.promptTokens + (Number(call.usage?.prompt_tokens) || 0),
      completionTokens: out.completionTokens + (Number(call.usage?.completion_tokens) || 0),
      cost: Math.round((out.cost + callCost(call)) * 10000) / 10000,
    };
  }
  return out;
}

/** The roles a replay mode spends, one start line each. */
const REPLAY_ROLES: ReadonlyArray<RouteRole> = ['core', 'analyzer', 'vision', 'video', 'embedding', 'director'];

/**
 * The routing of a replay mode (scripts/lib/script-routes.ts) over the live client `createLlm`: the chains of the data
 * folder `privateDir` (that of the checkout `root` by default), with the roles of `routes` replaced, said on stderr. With `answers` (`--answers-dir`) every request of every role answers from
 * the files, and no provider or harness is reached. `drawing` adds the start line of the `drawing` role. A tool bridge it serves stays open to the end of the process, whose
 * exit removes its socket folder.
 */
export async function replayRouting(
  createLlm: Untyped,
  hot: Untyped,
  calibrator: unknown,
  state: { data: object; markDirty(): void },
  {
    root,
    privateDir = privateDirOf(root),
    answers,
    routes,
    drawing = false,
  }: { root: string; privateDir?: string; answers: Untyped; routes: Variant; drawing?: boolean }
): Promise<ScriptRouting> {
  const routing = await scriptRouting('replay-cli', {
    privateDir,
    roles: drawing ? [...REPLAY_ROLES, 'drawing'] : REPLAY_ROLES,
    variant: routes,
    getConfig: (): unknown => hot.config,
    createDirect: (keys, getConfig) => createLlm({ apiKey: '', keys, getConfig, calibrator, state }),
    state,
    ...(answers ? { offline: offlineCore(answers, (why) => roleModel(hot.config, 'core', why)) } : {}),
  });
  process.stderr.write(routesText('replay-cli', routing.said));
  return routing;
}

/**
 * Whether the replay's requests go out without the prompt-cache marker: one sample
 * outside a scenario file, or `--no-cache`. The trigger runs (`--loop-triggers`) are marked like a live turn, their steps included, so the cache numbers and the cost they report are real.
 * @param hasScenarios A `--skills` file is run.
 */
export function replayWithoutCache(
  args: {
    noCache?: boolean;
    samples?: number | null;
    loopTriggers?: boolean;
  },
  hasScenarios: boolean
): boolean {
  if (args.noCache) return true;
  return args.samples === 1 && !hasScenarios && !args.loopTriggers;
}

/**
 * `llm` under the spend cap of a run of many turns: each answer adds what the provider reports it cost (else the
 * estimate per request), and once the total reaches `budget` the next request is refused and `stopped` aborts. The
 * stop signal of the run aborts it too.
 */
export function cappedLlm(
  llm: { complete: (messages: unknown, options?: unknown) => Promise<unknown> },
  budget: number | null,
  signal?: AbortSignal
): {
  llm: { complete: (messages: unknown, options?: unknown) => Promise<unknown> };
  spent: () => number;
  stopped: AbortSignal;
} {
  let spent = 0;
  const stop = new AbortController();
  if (signal?.aborted) stop.abort();
  else signal?.addEventListener('abort', () => stop.abort(), { once: true });
  return {
    spent: () => Math.round(spent * 10000) / 10000,
    stopped: stop.signal,
    llm: {
      async complete(messages, options) {
        if (budget !== null && spent >= budget) {
          stop.abort();
          throw new Error('replay-cli: --spend reached');
        }
        const completion = (await llm.complete(messages, options)) as { usage?: { cost?: unknown } } | null;
        const cost = Number(completion?.usage?.cost);
        spent += Number.isFinite(cost) ? cost : USD_PER_ANSWER;
        if (budget !== null && spent >= budget) stop.abort();
        return completion;
      },
    },
  };
}
