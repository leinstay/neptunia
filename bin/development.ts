// `neptunia worker development` (bin/neptunia.ts hands it `runDevelopment`, deploy/neptunia-development.service runs it):
// the development worker over the core's socket (src/development/worker.ts, docs/selfimprovement.md). This file holds
// what the worker takes as arguments: its edges over `selfimprovement.checkout` (src/development/edges.ts), the board,
// and the brief from the agent's prompt and `prompts/executor-brief.md`. This code runs from the install, and the
// checkout is only what it works on, so it refuses a checkout that is the install. The first start writes the boundary
// `development.startedAt`. `neptunia worker development held` lists what the boundary holds back and starts nothing. It
// connects as the client `development`, whose token is `NEPTUNIA_TASK_TOKEN` or `<private>/clients/development.token`, and
// `neptunia setup` makes that file. Exit 0 when stopped by a signal or after the list, 1 with no token, without a usable
// checkout, when the board cannot be reached or the link is lost, which is what makes systemd start it again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardSettings } from '../src/board/board.ts';
import type { TaskRecord } from '../src/board/board.ts';
import { ROOT_DIR } from '../src/config.ts';
import { briefFrom, fixBriefOf } from '../src/development/brief.ts';
import { developmentEdges } from '../src/development/edges.ts';
import type { DevelopmentEdges } from '../src/development/edges.ts';
import { developmentSettings, ensureStartedAt } from '../src/development/settings.ts';
import { createDevelopmentWorker, listHeldBack, serveDevelopment } from '../src/development/worker.ts';
import type { DevelopmentDeps, SkillPackageAnswer } from '../src/development/worker.ts';
import { listAgents, promptFilesOf } from '../src/agent-runner/profiles.ts';
import { createHot } from '../src/hot.ts';
import { serviceCredential } from '../src/keys/file.ts';
import { proxyForRun } from '../src/net/proxy.ts';
import { log } from '../src/log.ts';
import { resolvePaths } from '../src/paths.ts';
import { selfimprovementSettings } from '../src/selfimprovement/settings.ts';
import { defaultDenyDir } from '../src/subharness/run.ts';
import { openBoardCaller } from './neptunia-task.ts';
import type { BoardLink } from './neptunia-task.ts';

/** The client the worker connects as: the board's builtin principal of the same name. */
const CLIENT = 'development';
/** How long one agent run may take before its process group is killed (ms). */
const RUN_TIMEOUT_MS = 60 * 60 * 1000;
/** The lease of a claimed task and its renewal: a dead worker's task comes back within minutes, a live one keeps it. */
const LEASE_MINUTES = 10;
const LEASE_RENEW_MS = 2 * 60 * 1000;

/** The agent's own prompt: the persona's copy first, else the shipped one; the first of them that can be read. */
function agentPrompt(agent: string, where: { rootDir: string; dataDir: string }): string {
  for (const file of promptFilesOf(agent, where)) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      // The next candidate.
    }
  }
  throw new Error(`agents/${agent}/prompt.md cannot be read; the checkout is not whole`);
}

/** The tool names the agent's profile.json declares, read when the run starts; none when it has no profile. */
function profileTools(agent: string, where: { rootDir: string; dataDir: string }): ReadonlyArray<string> | undefined {
  const definition = listAgents({ ...where, env: process.env }).find((one) => one.id === agent);
  return definition && 'tools' in definition ? definition.tools : undefined;
}

/**
 * A skill task's package: the one pending version whose `task` names the task, bound to it by the core's `bindPackage`
 * (`skill.pending { name, task }`). This process has the link and no skills access, so the core does the binding.
 */
export async function skillPackage(link: Pick<BoardLink, 'command'>, task: TaskRecord): Promise<SkillPackageAnswer> {
  const answer = await link.command('skill.pending', { json: true });
  if (answer.status !== 'ok') return { code: 'refused', reason: `${answer.status}: ${answer.text}` };
  const pending: unknown = JSON.parse(answer.text);
  const named = (Array.isArray(pending) ? (pending as Array<{ task?: unknown; skill?: unknown }>) : []).filter(
    (one) => one?.task === task.id
  );
  const [only] = named;
  if (only === undefined) return { code: 'refused', reason: `no pending skill version names ${task.id}` };
  if (named.length > 1) return { code: 'refused', reason: `more than one pending skill version names ${task.id}` };
  const bound = await link.command('skill.pending', { name: only.skill, task: task.id });
  return bound.status === 'ok' ? { code: 'pending' } : { code: 'refused', reason: `${bound.status}: ${bound.text}` };
}

/** The edges over the checkout of the settings, or why the worker cannot work there. */
function edgesOf(where: { rootDir: string; privateDir: string; dataDir: string }, config: unknown): DevelopmentEdges {
  const { checkout } = selfimprovementSettings(config);
  const edges = developmentEdges({
    checkout,
    liveDir: where.rootDir,
    privateDir: where.privateDir,
    dataDir: where.dataDir,
    env: process.env,
    denyDir: defaultDenyDir(),
    tmpDir: os.tmpdir(),
  });
  edges.prepare();
  return edges;
}

export async function runDevelopment(argv: ReadonlyArray<string>): Promise<number> {
  const where = resolvePaths({ rootDir: ROOT_DIR });
  const tokenFile = path.join(where.privateDir, 'clients', `${CLIENT}.token`);
  if (!process.env.NEPTUNIA_TASK_TOKEN && !fs.existsSync(tokenFile)) {
    console.error(
      `the board is not reachable: no token in ${tokenFile}: run neptunia setup, which makes the client ${CLIENT}`
    );
    return 1;
  }
  const opened = await openBoardCaller({ ...process.env, NEPTUNIA_TASK_CLIENT: CLIENT });
  if (typeof opened === 'string') {
    console.error(`the board is not reachable: ${opened}`);
    return 1;
  }
  const hot = createHot({ rootDir: where.rootDir, privateDir: where.privateDir });
  try {
    if (argv[0] === 'held') {
      const { startedAt } = developmentSettings(hot.config);
      for (const task of await listHeldBack(opened.board, startedAt))
        console.log(`${task.id} ${task.status} ${task.title}`);
      return 0;
    }
    let edges: DevelopmentEdges;
    try {
      // The unit's write paths follow the checkout, so another checkout takes a new unit and a restart, never a live read.
      edges = edgesOf(where, hot.config);
    } catch (error) {
      console.error((error as Error).message);
      return 1;
    }
    ensureStartedAt(where.privateDir, hot.config, Date.now());
    const taskCommand = `${process.execPath} ${path.join(where.rootDir, 'bin', 'neptunia.ts')} task`;
    const deps: DevelopmentDeps = {
      board: opened.board,
      git: edges.git,
      gh: edges.gh,
      tests: edges.tests,
      runAgent: async (run) => {
        const tools = profileTools(run.agent, where);
        const proxy = await proxyForRun({ url: serviceCredential(where.dataDir, 'proxy'), config: hot.config });
        return edges.runAgent({ ...run, ...(tools === undefined ? {} : { tools }), proxy });
      },
      brief: (request) => {
        const template: unknown = hot.prompts['executor-brief'];
        const filled = briefFrom(typeof template === 'string' ? template : '', fixBriefOf(request));
        return `${agentPrompt(request.agent, where)}\n\n${filled}`;
      },
      // The thinker holds the worker's client, whose roles merge nothing, and edges.runAgent hides every gh login.
      agentEnv: (agent) => ({
        NEPTUNIA_DATA_DIR: where.dataDir,
        ...(agent === 'thinker'
          ? {
              NEPTUNIA_TASK_CLIENT: CLIENT,
              NEPTUNIA_PRIVATE_DIR: where.privateDir,
              NEPTUNIA_TASK_COMMAND: taskCommand,
            }
          : {}),
      }),
      settings: () => {
        const { mode, base, repository } = selfimprovementSettings(hot.config);
        const { thinkerTurns, startedAt } = developmentSettings(hot.config);
        return { mode, base, repository, thinkerTurns, startedAt };
      },
      check: () =>
        edges.check(
          selfimprovementSettings(hot.config).repository,
          (hot.prompts.labels ?? {}) as Record<string, unknown>
        ),
      triage: () => boardSettings(hot.config).autoTriage,
      packageSkill: ({ task }) => skillPackage(opened, task),
      journal: (line) => log.info('development', line),
      fileExists: (dir, relative) => fs.existsSync(path.join(dir, relative)),
      repoDir: edges.repoDir,
      worktreeRoot: edges.worktreeRoot,
      runTimeoutMs: RUN_TIMEOUT_MS,
      leaseMinutes: LEASE_MINUTES,
      leaseRenewMs: LEASE_RENEW_MS,
    };
    const controller = new AbortController();
    const stop = (): void => {
      controller.abort();
      opened.close();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await serveDevelopment({
      worker: createDevelopmentWorker(deps),
      signal: controller.signal,
      lookEveryMs: () => developmentSettings(hot.config).lookEveryMs,
      async waitForBoard(from, waitMs) {
        const answer = await opened.command('task.wait', {
          from,
          ...(waitMs === null ? {} : { wait_ms: waitMs }),
          json: true,
        });
        if (answer.status !== 'ok') throw new Error(`${answer.status}: ${answer.text}`);
        // The answer is the JSON of the board's event rows, each with its `seq`.
        return JSON.parse(answer.text) as ReadonlyArray<{ seq: number }>;
      },
    });
    return 0;
  } finally {
    hot.close();
    opened.close();
  }
}
