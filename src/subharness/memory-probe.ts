// The probe of her memory writer's path and the sleep it decides. One probe is one minimal request on the memory
// role's key for the direct path (`checkRole`, src/keys/check.ts, the request `keys check memory` sends), or one
// one-word reply through the backend for the subharness path (src/subharness/memory-path.ts). The subscriptions'
// five-hour and weekly limits cannot be read, so the probe is the only signal of them. The watch probes at core start,
// every `memory.probeMinutes` (default 30) and at once after a refused writer run. A failed probe while she runs pauses
// her with the reason `memory-down` through the core's pause (src/keys/commands.ts#PauseControl), the next passing
// probe resumes her, and neither touches a pause of another reason: the owner's and `no-core-key` stay as they are. A
// source the vendor's own status command reports logged out fails with no model run. A pass on a subharness path names
// the controls that path lacks in `gaps`, so a green probe claims no parity with the direct one.

import type { BackendResult } from '../agent-runner/backend.ts';
import { checkRole } from '../keys/check.ts';
import type { PauseControl } from '../keys/commands.ts';
import { log } from '../log.ts';
import { MEMORY_ROLE } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { memoryPath } from './memory-path.ts';
import { memoryGaps } from './memory-writer.ts';
import { sourceState } from './sources.ts';

/** The pause reason of a failed memory probe. */
export const MEMORY_DOWN = 'memory-down';

/** The interval of an absent or unusable `memory.probeMinutes`. */
const DEFAULT_PROBE_MINUTES = 30;

/** The one-word brief of the subharness probe. */
const PROBE_BRIEF = 'Reply with the single word ok.';

const MINUTE_MS = 60_000;

export type ProbeResult = { ok: true; at: number; gaps?: Array<string> } | { ok: false; code: string; at: number };

export type MemoryProbeDeps = {
  privateDir: string;
  /** The key the memory role goes out on now (the ring's route, else the `.env` variable); null when there is none. */
  route(): { name: string; value: string } | null;
  fetch: typeof fetch;
  baseUrl: string;
  /** The direct model of the memory role now. */
  model(): string;
  runBackend(name: 'codex' | 'claude', brief: string, model?: string, effort?: EffortLevel): Promise<BackendResult>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One probe, which may throw on an unreadable keys.json. */
async function probeOnce(deps: MemoryProbeDeps, at: number): Promise<ProbeResult> {
  const path = memoryPath(deps.privateDir);
  if (path.kind === 'direct') {
    const route = deps.route();
    if (route === null) return { ok: false, code: 'no-memory-key', at };
    const result = await checkRole({
      fetch: deps.fetch,
      baseUrl: deps.baseUrl,
      role: MEMORY_ROLE,
      model: deps.model(),
      keyName: route.name,
      value: route.value,
    });
    return result.ok ? { ok: true, at } : { ok: false, code: 'model-failed', at };
  }
  if ((await sourceState(deps.privateDir, path.backend)).code === 'not-logged-in')
    return { ok: false, code: 'not-logged-in', at };
  const outcome = await deps.runBackend(path.backend, PROBE_BRIEF, path.model, path.effort ?? undefined);
  if (outcome.ok && outcome.text.trim() !== '') return { ok: true, at, gaps: memoryGaps(path.backend) };
  return { ok: false, code: outcome.error ?? 'no-reply', at };
}

/** One probe of the writer's path as keys.json names it now. Never rejects. `at` is `now`. */
export async function memoryProbe(deps: MemoryProbeDeps, now: number): Promise<ProbeResult> {
  try {
    return await probeOnce(deps, now);
  } catch {
    return { ok: false, code: 'probe-error', at: now };
  }
}

/** `memory.probeMinutes` of the live config: a positive finite number, else the default 30. */
export function probeMinutes(config: unknown): number {
  const memory = isRecord(config) ? config.memory : undefined;
  const minutes = isRecord(memory) ? memory.probeMinutes : undefined;
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_PROBE_MINUTES;
}

export type MemoryWatchDeps = {
  probe(now: number): Promise<ProbeResult>;
  pause: PauseControl;
  now(): number;
  /** The live config, read at every tick. */
  config(): unknown;
};

export type MemoryWatch = {
  /** The probe at core start. */
  start(): Promise<ProbeResult>;
  /** The core's timer: probes when `memory.probeMinutes` passed since the last probe of any kind, else resolves null. */
  tick(): Promise<ProbeResult | null>;
  /** After a refused writer run: probes at once, whatever the interval. */
  refused(): Promise<ProbeResult>;
};

export function createMemoryWatch(deps: MemoryWatchDeps): MemoryWatch {
  let lastAt = Number.NEGATIVE_INFINITY;
  let running: Promise<ProbeResult> | null = null;

  /** Pauses on a failure while she runs, resumes a `memory-down` pause on a pass, and touches nothing else. */
  async function follow(result: ProbeResult): Promise<void> {
    const pauseControl = deps.pause;
    const reason = pauseControl.reason();
    if (!result.ok && reason === null) {
      log.warn('memory probe: failed, she sleeps', { code: result.code });
      await pauseControl.pause(MEMORY_DOWN);
    } else if (result.ok && reason === MEMORY_DOWN) {
      log.info('memory probe: passed, she wakes', {});
      await pauseControl.resume(MEMORY_DOWN);
    } else if (!result.ok) {
      log.warn('memory probe: failed', { code: result.code, paused: reason });
    }
  }

  async function probeNow(): Promise<ProbeResult> {
    const at = deps.now();
    lastAt = at;
    let result: ProbeResult;
    try {
      result = await deps.probe(at);
    } catch {
      result = { ok: false, code: 'probe-error', at };
    }
    try {
      await follow(result);
    } catch (error) {
      log.warn('memory probe: the pause did not go through', { error });
    }
    return result;
  }

  /** One probe at a time: a probe asked for while one runs gets that one's result. */
  function probe(): Promise<ProbeResult> {
    running ??= probeNow().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    start: probe,
    tick() {
      if (deps.now() - lastAt < probeMinutes(deps.config()) * MINUTE_MS) return Promise.resolve(null);
      return probe();
    },
    refused: probe,
  };
}
