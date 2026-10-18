#!/usr/bin/env node
// The agent runner process: one per profile (`web` or `server`), started by
// its systemd unit (deploy/neptunia-agent-<profile>.service). It reads the
// engine config (never the bot's .env), opens the Unix socket the core connects to
// (src/agent-runner/server.js), and works each task it receives by spawning
// one `opencode run` child (src/agent-runner/opencode.js). It never imports
// discord.js or the bot; it shares only config/log/web helpers.
//
//   node bin/agent-runner.mjs --profile web|server [--socket PATH] [--out DIR]
//                             [--journal FILE] [--opencode PATH]
//
// Keys come from the core with each task (`secrets` of the `run` message: the
// agents' OpenRouter key, never the persona's, and for the web profile the
// proxy and the search key), since every key lives in the bot's .env, which
// this process cannot read. Its own environment (the unit's optional
// EnvironmentFile: OPENROUTER_AGENT_KEY, OPENCODE_WEBSEARCH_KEY, PROXY_URL) is
// used only for what a task does not bring. Caps and the model's
// cost come from `agents.<profile>` in config; the model from the profile's
// model role (`models.agents.web`, `models.agents.server`), read again at each task
// so a `/nep model set` reaches the next one. It prints one ready line
// (a log line) when it is listening, and on SIGTERM ends open tasks and
// exits. At start and then hourly it deletes the task directories under its
// out dir older than `agents.keepFilesHours` (read from the config at each
// sweep; src/agent-runner/sweep.js): the core can read them, not delete them.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { log } from '../src/log.js';
import { createRunnerServer } from '../src/agent-runner/server.js';
import { createOpencodeRunner, DEFAULT_OPENCODE_PATH } from '../src/agent-runner/opencode.js';
import { profileOf } from '../src/agent-runner/profiles.js';
import { startSweeper } from '../src/agent-runner/sweep.js';

/** Parse `--flag value` and `--flag=value` into a plain object. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[arg.slice(2)] = next;
        i += 1;
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

function fail(message) {
  log.error('agent-runner: start failed', { reason: message });
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args.profile;
  const profile = profileOf(name);
  if (!profile) fail(`unknown profile: ${name ?? '(none)'} (expected web or server)`);

  // The runner never reads the bot's .env: the bot's secrets file is inaccessible to it by design, and
  // the keys come with each task. Config `${env:NAME}` references it cannot resolve become empty
  // strings with one warning each.
  // A config still holding the flat `roles` map throws here (src/config.js#assertModelsShape): the
  // runner does not start on a config it would misread.
  const { config } = loadConfig();
  const agents = config.agents ?? {};
  const settings = agents[name] ?? {};

  const socketPath = args.socket || settings.socket;
  if (!socketPath) fail('no socket path (--socket or agents.<profile>.socket)');
  const outDir = args.out || settings.out;
  if (!outDir) fail('no out dir (--out or agents.<profile>.out)');
  const opencodePath = args.opencode || agents.opencodePath || DEFAULT_OPENCODE_PATH;
  const journalFile = typeof args.journal === 'string' ? args.journal : null;

  // No key of its own is needed: the core sends one with each task. A task that brings none
  // while this environment has none either fails `no-key`, with one warning
  // (src/agent-runner/opencode.js).
  if (!process.env.OPENROUTER_AGENT_KEY) log.info('agent-runner: no key in the environment, each task brings its own', { profile: name });

  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    fail(`cannot create out dir: ${err?.code ?? 'mkdir'}`);
  }

  // The config as of each task (for the model role); the last readable one when the files are mid-edit.
  let lastConfig = config;
  const currentConfig = () => {
    try {
      lastConfig = loadConfig().config;
    } catch (err) {
      log.warn('agent-runner: config reload failed', { profile: name, reason: err?.name ?? 'read' });
    }
    return lastConfig;
  };

  // Fail fast when the prompt file is missing, rather than failing every task.
  const engineRunner = createOpencodeRunner({ profile, outDir, env: process.env, opencodePath, getConfig: currentConfig });
  try {
    engineRunner.checkPrompt();
  } catch (err) {
    fail(err?.message ?? 'prompt file missing');
  }

  const journalWrite = journalFile
    ? (line) => {
      try {
        fs.appendFileSync(journalFile, `${JSON.stringify(line)}\n`);
      } catch {
        // the journal is a record, never a reason to drop a task
      }
    }
    : () => {};

  // Merge config defaults into each task so the core may omit the cost and limits; a task without
  // a model runs on its profile's model role (src/agent-runner/opencode.js).
  const limitsDefault = { ...profile.defaultLimits, ...(settings.limits ?? {}), toolResultChars: agents.toolResultChars };
  const runner = {
    run(task) {
      journalWrite({ event: 'task-start', id: task.id, profile: name });
      return engineRunner.run({
        ...task,
        limits: { ...limitsDefault, ...(task.limits ?? {}) },
        model: task.model,
        cost: task.cost ?? settings.cost,
        searchProvider: task.searchProvider ?? settings.search?.provider,
      }).then((outcome) => {
        journalWrite({ event: 'task-end', id: task.id, profile: name, status: outcome.status, usage: outcome.usage });
        return outcome;
      });
    },
  };

  const server = createRunnerServer({ profile: name, runner, socketPath });
  await server.start();
  log.info('agent-runner: ready', { profile: name, socket: socketPath, out: outDir, opencode: opencodePath });

  // Old task output, deleted here because the out dir is this user's alone.
  const sweeper = startSweeper({
    profile: name,
    outDir,
    keepHours: () => currentConfig()?.agents?.keepFilesHours,
    liveIds: () => server.liveIds(),
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('agent-runner: shutting down', { profile: name, signal });
    sweeper.stop();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => fail(err?.message ?? String(err)));
