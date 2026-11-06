// `neptunia worker watcher` (deploy/neptunia-watcher.service): one inspection (src/watcher/inspection.ts) through the
// subharness's backend, in the mode of `watcher`, working in the checkout. It files on the board over the core's socket as
// the client `NEPTUNIA_TASK_CLIENT` (default `watcher`, whose token is `NEPTUNIA_TASK_TOKEN` or
// `<private>/clients/watcher.token`), and it opens that link only when there is something to file. The exit code is 0 for a
// committed report, also with its filing deferred, for a cancelled run, for a run already in progress and while
// `watcher.enabled` is false. It is 1 for a failed run and for a board that refused a task, with the code on stderr.

import path from 'node:path';
import { listAgents, promptFilesOf } from '../src/agent-runner/profiles.ts';
import { readConfig } from '../src/config.ts';
import { serviceCredential } from '../src/keys/file.ts';
import { proxyForRun } from '../src/net/proxy.ts';
import { readKeys } from '../src/keys/file.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { backendOfAgent } from '../src/subharness/control.ts';
import { defaultDenyDir, runAgent } from '../src/subharness/run.ts';
import { installFacts, watcherMemory } from '../src/watcher/install.ts';
import { runInspection } from '../src/watcher/inspection.ts';
import type { InspectionDeps } from '../src/watcher/inspection.ts';
import { moneyFacts, moneyKeysOf, requestsTodayOf } from '../src/watcher/money.ts';
import type { MoneyFacts } from '../src/watcher/money.ts';
import {
  WATCHER_RUN_TIMEOUT_MS,
  currentRun,
  defaultProcessStart,
  finishRun,
  runStoreOf,
} from '../src/watcher/lifecycle.ts';
import { reportsDirOf, watcherDir } from '../src/watcher/read.ts';
import { watcherSettings } from '../src/watcher/settings.ts';
import { openBoardCaller } from './neptunia-task.ts';

type Where = { rootDir: string; privateDir: string; dataDir: string };

/** The backend, model and effort of the watcher as keys.json holds them, for the log line of the run. */
function selectedOf(privateDir: string): InspectionDeps['selected'] {
  try {
    const { subharness } = readKeys(privateDir);
    return {
      backend: backendOfAgent(subharness, 'watcher'),
      model: subharness.models.watcher ?? null,
      effort: subharness.efforts.watcher ?? null,
    };
  } catch {
    return { backend: null, model: null, effort: null };
  }
}

/** The prompt files of the watcher's definition; none when it is missing, which the inspection fails as `no-prompt`. */
function promptFiles(where: Where): Array<string> {
  const agentPaths = { rootDir: where.rootDir, dataDir: where.dataDir, env: process.env };
  const definition = listAgents(agentPaths).find((agent) => agent.kind === 'watcher');
  return definition ? promptFilesOf(definition.id, { ...agentPaths, prompt: definition.prompt }) : [];
}

/**
 * The money fact of this run: every key of keys.json by slot, the roles' extra keys, today's request count and the
 * spend of the memory database, read over a read-only connection held until the key reads are done. The key values go
 * to `moneyFacts` and nowhere else. A database that cannot be opened fails the read, and the brief then holds no `<money>`.
 */
async function moneyOf(where: Where, config: unknown): Promise<MoneyFacts> {
  const store = readKeys(where.privateDir);
  const handle = openMemoryDb(path.join(where.dataDir, 'memory.db'), { readOnly: true });
  try {
    const db = dbOf(handle);
    const now = Date.now();
    return await moneyFacts({
      db,
      keys: moneyKeysOf(store),
      roleSlots: store.roles,
      requestsToday: requestsTodayOf(db, now),
      fetch: (url, init) => fetch(url, init),
      now: () => now,
      config,
    });
  } finally {
    handle.close();
  }
}

/** Runs the worker and answers its exit code. */
export async function runWatcherWorker(where: Where): Promise<number> {
  const config = readConfig(where.rootDir, { privateDir: where.privateDir });
  const reportsDir = reportsDirOf(where.privateDir, watcherDir(config));
  const store = runStoreOf(path.dirname(reportsDir));
  if (!watcherSettings(config).enabled) {
    // A trigger that came before the disable leaves a claim only this start can end.
    const pending = currentRun(store);
    if (pending?.owner === null) finishRun(store, pending.runId, { state: 'cancelled', code: 'disabled' });
    console.log('watcher: off (watcher.enabled is false)');
    return 0;
  }
  let close = (): void => {};
  try {
    const done = await runInspection({
      store,
      reportsDir,
      self: { pid: process.pid, startId: defaultProcessStart(process.pid) ?? 'unknown' },
      source: 'timer',
      timeoutMs: WATCHER_RUN_TIMEOUT_MS,
      promptFiles: promptFiles(where),
      retryPromptFiles: [path.join(where.rootDir, 'agents', 'watcher', 'retry.md')],
      selected: selectedOf(where.privateDir),
      install: () => installFacts({ rootDir: where.rootDir, dataDir: where.dataDir }),
      memory: () => watcherMemory({ dataDir: where.dataDir, config }),
      money: () => moneyOf(where, config),
      // Read again when the run files, so a switch made during a long run counts for it.
      draftsOnly: () => watcherSettings(readConfig(where.rootDir, { privateDir: where.privateDir })).draftsOnly,
      runAgent: async (brief, { signal, timeoutMs, runId }) =>
        runAgent(
          {
            proxy: await proxyForRun({ url: serviceCredential(where.dataDir, 'proxy'), config }),
            agent: 'watcher',
            brief,
            cwd: where.rootDir,
            timeoutMs,
            signal,
            runId,
            // `services watcher evidence` under the agent reads the same layers as this worker.
            env: { NEPTUNIA_PRIVATE_DIR: where.privateDir, NEPTUNIA_DATA_DIR: where.dataDir },
          },
          { privateDir: where.privateDir, denyDir: defaultDenyDir() }
        ),
      openBoard: async () => {
        const opened = await openBoardCaller({
          ...process.env,
          NEPTUNIA_TASK_CLIENT: process.env.NEPTUNIA_TASK_CLIENT || 'watcher',
        });
        if (typeof opened === 'string') throw new Error(opened);
        close = () => opened.close();
        return opened.board;
      },
    });
    console.log(`watcher: run ${done.runId} ${done.state}, filing ${done.filing}`);
    if (done.state === 'failed') console.error(`watcher: the run failed: ${done.code ?? 'unknown'}`);
    if (done.filing === 'failed') console.error('watcher: the board refused a task');
    return done.state === 'failed' || done.filing === 'failed' ? 1 : 0;
  } finally {
    close();
  }
}
