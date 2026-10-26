// The runner's task engine: the persona's agents run on OpenCode (the raw
// agent harness), one task = one `opencode run` child process in a fresh
// working directory under the profile's out dir. The child gets, through its
// environment, the OpenCode config this task needs (the profile's agent
// definition, the model -- the task's own, else the profile's model role,
// `models.errands.scout` / `models.errands.server`, read at each task -- and its cost,
// the permission ruleset for the scope)
// and a per-task database, with project/claude config, auto-update and the
// price fetch disabled so nothing of this server leaks into the worker and
// the run is reproducible. The agent's OpenRouter key (its own, never the
// persona's) comes from the core with each task (`secrets.openrouterKey`; the
// runner cannot read the bot's .env), else from the runner's environment, and
// is passed as OPENROUTER_API_KEY; the scout agent's proxy (HTTPS_PROXY /
// HTTP_PROXY, http form) and search key likewise. A profile's own commands
// (the scout agent's `web-search`, src/web/web-search.js) come first on the
// child's PATH, node's folder after them; the scout child also gets the search
// model of the config read at the task (NEPTUNIA_WEB_SEARCH_MODEL). A task with no key from
// either fails `no-key` (one warning per runner). No secret is ever logged.
// A task may bring the deployment's shared preamble (`preamble`, read by the
// core from its private prompt layer, which this process never reads): the
// system prompt is then the preamble, a blank line and the profile's prompt;
// the preamble itself is never logged.
//
// The child prints one JSON event per line (`--format json`): `step_finish`
// gives tokens and the cost OpenCode estimates per step (summed; a step
// without a cost raises `costUnknown`), `text` is the assistant's answer,
// `tool_use` drives progress and, in a filtered scope, the withheld-path
// backstop (src/agent-runner/policy.js). OpenCode's own permissions refuse
// most reads of a withheld path step by step (src/agent-runner/profiles.js);
// a tool call that names one anyway (a `bash -c`, a pipe) is not stopped: its
// output never enters the runner's record (its progress event says
// `withheld` and the path), the task goes on, the final text passes the
// redaction, and `result.withheld` lists every withheld path the agent
// reached for ("visible, not readable here"). `error` fails the task. The usd and seconds caps stop the child (SIGTERM, then
// SIGKILL); the step cap is the agent's own. Files the agent saved under its
// working directory are the result's files, minus `result.filesDropped`
// (all of them after a withheld read in a filtered scope, and in every scope a
// text file that carries a secret); the result text is redacted in a
// filtered scope. Resolves, never rejects.
//
// OpenCode's cost is a catalog estimate, not OpenRouter's billed cost, so the
// usd cap is a soft cap; the hard cap is the runner key's OpenRouter credit limit.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from '../log.js';
import { isPlainObject } from '../config.js';
import { roleModel } from '../llm/roles.js';
import { containsSecret, isFiltered, redactorFor, scopeOf, withheldInToolUse } from './policy.js';
import { httpProxyForm } from './protocol.js';
import { WEB_SEARCH_MODEL_ENV, webSearchModel } from '../web/web-search.js';

/** The OpenCode binary by default. */
export const DEFAULT_OPENCODE_PATH = '/opt/opencode/bin/opencode';
/** The grace between SIGTERM and SIGKILL when a cap stops the child (ms). */
const KILL_GRACE_MS = 10_000;
/** A file's content type by extension (the result's `contentType`). */
const CONTENT_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
]);

/** The read errors that make an override (any file but the last) count as absent. */
const UNREADABLE_CODES = new Set(['EACCES', 'EPERM']);
/** The overrides already reported unreadable (one warning per file per process). */
const warnedUnreadable = new Set();

/**
 * The text of the first existing file of `paths` (a local override first,
 * then the tracked file). An override that exists but this process may not
 * read (EACCES, EPERM: the runner's user lacks access to the private
 * directory) counts as absent, with one `profiles: override unreadable`
 * warning per file per process; the last file's read errors, and any other
 * error, still throw. Throws naming the paths when none exists, or when the
 * chosen file is empty. `read` is injectable for tests.
 * @param {string[]} paths
 * @param {{ read?: (file: string) => string }} [options]
 * @returns {string}
 */
export function readPromptFile(paths, { read = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p);
  for (const [index, file] of list.entries()) {
    let text;
    try {
      text = read(file);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      if (index < list.length - 1 && UNREADABLE_CODES.has(err?.code)) {
        if (!warnedUnreadable.has(file)) {
          warnedUnreadable.add(file);
          log.warn('profiles: override unreadable', { file, reason: err.code });
        }
        continue;
      }
      throw err;
    }
    const trimmed = text.replace(/^﻿/, '').trim();
    if (!trimmed) throw new Error(`agent-runner: prompt file empty: ${file}`);
    return trimmed;
  }
  throw new Error(`agent-runner: prompt file missing: ${list.join(', ') || '(none given)'}`);
}

/** The task prompt: the goal and, when present, the context as JSON. */
export function taskPrompt(goal, context) {
  const parts = [`<goal>\n${String(goal ?? '').trim()}\n</goal>`];
  const ctx = isPlainObject(context) ? context : {};
  const shown = Object.fromEntries(Object.entries(ctx).filter(([key]) => key !== 'scope'));
  if (Object.keys(shown).length) parts.push(`<context>\n${JSON.stringify(shown, null, 1)}\n</context>`);
  return parts.join('\n');
}

/** The flags that isolate a worker run (config roots off, no auto-update, no price fetch). */
export function isolationEnv() {
  return {
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
}

/** Kill `child` and its process group. */
function killTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** A finite non-negative number, else 0. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** OpenCode's own files in the task directory (its HOME): never a result. */
const NOT_A_RESULT = /^(\.|opencode\.db)/;

/** The files the agent saved under `dir` (recursively), as result file handles; OpenCode's own files skipped. */
async function collectFiles(dir, id) {
  const base = path.join(dir, id);
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (NOT_A_RESULT.test(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        let bytes = 0;
        try {
          bytes = (await fsp.stat(full)).size;
        } catch {
          continue;
        }
        out.push({
          path: full,
          name: entry.name,
          contentType: CONTENT_TYPES.get(path.extname(entry.name).toLowerCase()) ?? '',
          bytes,
        });
      }
    }
  }
  await walk(base);
  return out;
}

/** The bytes read to tell a text file from a binary one (a NUL in them = binary). */
const SNIFF_BYTES = 8 * 1024;
/** The largest file scanned for secrets (2 MB). A binary file or a bigger one is delivered unscanned:
 * the scan guards against a copied secret file (.env, a key file), which is small text. */
const SCAN_MAX_BYTES = 2 * 1024 * 1024;

/** Whether the file at `file` is text no larger than SCAN_MAX_BYTES and carries a secret
 * (src/agent-runner/policy.js#containsSecret). An unreadable file counts as carrying one. */
async function fileCarriesSecret(file) {
  if (file.bytes > SCAN_MAX_BYTES) return false;
  let content;
  try {
    content = await fsp.readFile(file.path);
  } catch {
    return true;
  }
  if (content.subarray(0, SNIFF_BYTES).includes(0)) return false;
  return containsSecret(content.toString('utf8'));
}

/**
 * The result files actually delivered, and the ones dropped with their reason. In a filtered scope a
 * run that reached a withheld path delivers no file (reason `withheld`): a `cp` that slipped past the
 * rules could have copied the withheld file whole. In every scope, `core` included, a text file that
 * carries a secret is dropped (reason `secret`). Nothing of a file's content is logged.
 * @returns {Promise<{ files: object[], dropped: { name: string, reason: 'withheld' | 'secret' }[] }>}
 */
async function deliverableFiles(collected, { scope, withheldCount }) {
  if (isFiltered(scope) && withheldCount > 0) {
    return { files: [], dropped: collected.map((f) => ({ name: f.name, reason: 'withheld' })) };
  }
  const files = [];
  const dropped = [];
  for (const file of collected) {
    if (await fileCarriesSecret(file)) dropped.push({ name: file.name, reason: 'secret' });
    else files.push(file);
  }
  return { files, dropped };
}

/**
 * @param {object} options
 * @param {object} options.profile  A profile from src/agent-runner/profiles.js.
 * @param {string} options.outDir  The runner's out dir (`<outDir>/<id>/` is a task's working dir).
 * @param {Record<string,string>} [options.env]  The base environment (the child's; may hold the keys a
 *   task's `secrets` do not bring).
 * @param {string} [options.opencodePath]  `agents.opencodePath`.
 * @param {string} [options.openrouterKeyEnv]  The env name of the OpenRouter key when a task brings none.
 * @param {string} [options.searchKeyEnv]  The env name of the web-search provider key (scout profile) when a task brings none.
 * @param {string} [options.proxyEnv]  The env name of the scout profile's proxy when a task brings none.
 * @param {() => object} [options.getConfig]  The engine config, read at each task: the model of a task
 *   without one is `models.<group>.<profile.modelRole>` (src/llm/roles.js#roleModel), else the profile's default.
 * @param {() => number} [options.now]
 * @param {typeof spawn} [options.spawnImpl]
 */
export function createOpencodeRunner({
  profile,
  outDir,
  env = process.env,
  opencodePath = DEFAULT_OPENCODE_PATH,
  openrouterKeyEnv = 'OPENROUTER_ERRAND_KEY',
  searchKeyEnv = 'OPENCODE_WEBSEARCH_KEY',
  proxyEnv = 'PROXY_URL',
  getConfig = () => ({}),
  now = Date.now,
  spawnImpl = spawn,
}) {
  if (!profile) throw new Error('agent-runner: no profile');
  let warnedNoKey = false;

  /** The config read now; undefined (warned) when it cannot be read. */
  function configNow() {
    try {
      return getConfig();
    } catch (err) {
      log.warn('agent-runner: config unreadable', { profile: profile.name, reason: err?.code ?? err?.name ?? 'read' });
      return undefined;
    }
  }

  /** The model of the profile's role in `config`; undefined without a config. */
  function modelOfRole(config) {
    return config && profile.modelRole ? roleModel(config, profile.modelRole) : undefined;
  }

  /**
   * Work one task through an OpenCode child.
   * @param {{ id, goal, context?, limits?, model?, cost?, searchProvider?, secrets?, preamble?, signal?, onProgress? }} task
   *   `secrets` (src/agent-runner/protocol.js): `{ openrouterKey, proxy?, searchKey? }`, each over the
   *   environment's. `preamble`: the deployment's shared text, put before the profile's prompt.
   * @returns {Promise<{ status, result: { text, sources, files, withheld?, filesDropped? }, usage, error? }>}
   *   `filesDropped`: `[{ name, reason }]`, the files saved but not delivered: reason `withheld` (a
   *   filtered-scope run that reached a withheld path delivers no file) or `secret` (a text file of at
   *   most 2 MB that carries a secret, in every scope).
   */
  async function run({
    id,
    goal,
    context,
    limits = {},
    model,
    cost,
    searchProvider,
    secrets,
    preamble,
    signal,
    onProgress = () => {},
  }) {
    const startedAt = now();
    const scope = scopeOf(context);
    const redact = redactorFor(scope);
    const usage = { input: 0, output: 0, usd: 0, steps: 0, seconds: 0, costUnknown: 0 };
    const sources = new Set();
    const steps =
      Number.isFinite(limits.steps) && limits.steps > 0 ? Math.floor(limits.steps) : profile.defaultLimits.steps;
    const secondsCap =
      Number.isFinite(limits.seconds) && limits.seconds > 0 ? limits.seconds : profile.defaultLimits.seconds;

    const dir = path.join(outDir, id);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err) {
      log.warn('agent-runner: workdir failed', { id, reason: err?.code ?? 'mkdir' });
      return finish('failed', '', 'workdir');
    }

    let systemPrompt;
    try {
      systemPrompt = readPromptFile(profile.promptFiles);
    } catch {
      return finish('failed', '', 'no-prompt');
    }
    const shared = typeof preamble === 'string' ? preamble.trim() : '';
    if (shared) systemPrompt = `${shared}\n\n${systemPrompt}`;

    const taskModel = typeof model === 'string' && model ? model : '';
    // Read only when needed: the model of a task without one, the scout agent's search model.
    const config = !taskModel || profile.name === 'scout' ? configNow() : undefined;
    const providerModel = taskModel || (modelOfRole(config) ?? profile.defaultModel);
    const configContent = JSON.stringify(
      profile.buildConfig({ systemPrompt, providerModel, steps, scope, cost, toolResultChars: limits.toolResultChars })
    );
    const childEnv = {
      ...env,
      ...isolationEnv(),
      // The profile's own variables (the server agent's git settings; src/agent-runner/profiles.js#SERVER_CHILD_ENV).
      ...profile.childEnv,
      OPENCODE_CONFIG_CONTENT: configContent,
      OPENCODE_DB: path.join(dir, 'opencode.db'),
      HOME: dir,
      PWD: dir,
      // The profile's own commands (the scout agent's `web-search`), then node's folder, which they
      // run on, ahead of the inherited PATH.
      ...(Array.isArray(profile.pathDirs) && profile.pathDirs.length
        ? { PATH: [...profile.pathDirs, path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter) }
        : {}),
      XDG_DATA_HOME: path.join(dir, '.local', 'share'),
      XDG_CONFIG_HOME: path.join(dir, '.config'),
      XDG_CACHE_HOME: path.join(dir, '.cache'),
    };
    // The core's secrets first, the runner's environment after; never a value in a log.
    const given = isPlainObject(secrets) ? secrets : {};
    const pick = (value, name) => (typeof value === 'string' && value ? value : env[name] || '');
    const openrouterKey = pick(given.openrouterKey, openrouterKeyEnv);
    if (!openrouterKey) {
      if (!warnedNoKey) {
        warnedNoKey = true;
        log.warn('agent-runner: no model key', { profile: profile.name, env: openrouterKeyEnv });
      }
      return finish('failed', '', 'no-key');
    }
    childEnv.OPENROUTER_API_KEY = openrouterKey;
    if (profile.name === 'scout') {
      // v1.19.3 picks the web search provider from OPENCODE_WEBSEARCH_PROVIDER
      // (`exa`, keyless, or `parallel`, which needs PARALLEL_API_KEY). The
      // provider key, when set, goes to that provider's own env name.
      const provider =
        typeof searchProvider === 'string' && searchProvider
          ? searchProvider
          : (profile.defaultSearchProvider ?? 'exa');
      childEnv.OPENCODE_WEBSEARCH_PROVIDER = provider;
      const searchKey = pick(given.searchKey, searchKeyEnv);
      if (searchKey) childEnv[provider === 'parallel' ? 'PARALLEL_API_KEY' : 'EXA_API_KEY'] = searchKey;
      // The model of the agent's `web-search` command (src/web/web-search.js), from the config read now.
      childEnv[WEB_SEARCH_MODEL_ENV] = webSearchModel(config ?? {});
      // The proxy in its http form, under the names curl and OpenCode read (curl reads only the
      // lowercase http_proxy); without one the environment's own proxy variables stay.
      const proxy = httpProxyForm(pick(given.proxy, proxyEnv));
      if (proxy) {
        for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) childEnv[name] = proxy;
        // The model API goes direct, never through the residential proxy; so does anything local.
        for (const name of ['NO_PROXY', 'no_proxy']) childEnv[name] = 'openrouter.ai,localhost,127.0.0.1';
      }
    }

    const args = [
      'run',
      '--format',
      'json',
      '--agent',
      profile.agentId,
      '--model',
      providerModel,
      '--title',
      id,
      taskPrompt(goal, context),
    ];

    let resultText = '';
    let errorMessage = null;
    let capHit = null;
    const withheld = new Set();
    let killed = false;
    let child;

    function finish(status, text, error) {
      usage.seconds = Math.round((now() - startedAt) / 100) / 10;
      const out = { status, result: { text: redact(text ?? ''), sources: [...sources], files: [] }, usage };
      if (error) out.error = error;
      return out;
    }

    const progress = (fields) => {
      try {
        onProgress(fields);
      } catch {
        // a listener's failure is its own
      }
    };

    const stopChild = (reason) => {
      if (killed) return;
      killed = true;
      capHit = capHit ?? reason;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS).unref?.();
    };

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        clearInterval(ticker);
        resolve(value);
      };
      const onAbort = () => {
        stopChild('cancelled');
      };
      if (signal) {
        if (signal.aborted) stopChild('cancelled');
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const ticker = setInterval(() => {
        if ((now() - startedAt) / 1000 >= secondsCap) stopChild('time-cap');
      }, 1000);
      if (ticker.unref) ticker.unref();

      try {
        child = spawnImpl(opencodePath, args, {
          cwd: dir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (err) {
        settle({ exitCode: null, spawnError: err?.code ?? 'spawn' });
        return;
      }

      let buffer = '';
      const onLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return;
        }
        handleEvent(event);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          onLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      child.stderr?.on?.('data', () => {});
      child.on('error', (err) => settle({ exitCode: null, spawnError: err?.code ?? 'spawn' }));
      child.on('close', (code) => {
        if (buffer.trim()) onLine(buffer);
        settle({ exitCode: code, spawnError: null });
      });

      function handleEvent(event) {
        const type = event?.type;
        if (type === 'step_finish') {
          usage.steps += 1;
          const part = isPlainObject(event.part) ? event.part : {};
          const tokens = isPlainObject(part.tokens) ? part.tokens : {};
          usage.input += count(tokens.input);
          usage.output += count(tokens.output) + count(tokens.reasoning);
          const stepCost = part.cost;
          if (typeof stepCost === 'number' && Number.isFinite(stepCost) && stepCost > 0) usage.usd += stepCost;
          else usage.costUnknown += 1;
          progress({ step: usage.steps, tool: null, note: '' });
          return;
        }
        if (type === 'text') {
          const text = isPlainObject(event.part) ? event.part.text : '';
          if (typeof text === 'string' && text.trim()) resultText = text;
          return;
        }
        if (type === 'tool_use') {
          const part = isPlainObject(event.part) ? event.part : {};
          const toolName = part.tool ?? part.name ?? '';
          const input = isPlainObject(part.state?.input)
            ? part.state.input
            : isPlainObject(part.input)
              ? part.input
              : {};
          // A withheld path (refused by OpenCode or slipped past it): recorded as refused, never
          // as what the tool returned; the task goes on.
          const hit = withheldInToolUse({ tool: toolName, input }, scope);
          if (hit) withheld.add(hit);
          progress({ step: usage.steps, tool: String(toolName), note: hit ? `withheld: ${hit}` : '' });
          // The scout agent's sources are the pages it fetched.
          if ((toolName === 'webfetch' || toolName === 'fetch') && typeof input.url === 'string')
            sources.add(input.url);
          return;
        }
        if (type === 'error') {
          const err = event.error;
          const message = isPlainObject(err)
            ? typeof err.message === 'string'
              ? err.message
              : typeof err.data?.message === 'string'
                ? err.data.message
                : typeof err.name === 'string'
                  ? err.name
                  : 'error'
            : String(err ?? 'error');
          if (!errorMessage) errorMessage = message;
          return;
        }
      }
    });

    if (outcome.spawnError) {
      log.warn('agent-runner: spawn failed', { id, profile: profile.name, reason: outcome.spawnError });
      return finish('failed', '', 'spawn');
    }

    const { files, dropped } = await deliverableFiles(await collectFiles(outDir, id), {
      scope,
      withheldCount: withheld.size,
    });
    const base = finish(signal?.aborted ? 'cancelled' : 'done', resultText, undefined);
    base.result.files = files;
    if (dropped.length > 0) {
      base.result.filesDropped = dropped;
      log.info('agent-runner: files dropped', {
        id,
        profile: profile.name,
        count: dropped.length,
        reason: dropped[0].reason,
      });
    }

    if (withheld.size > 0) {
      base.result.withheld = [...withheld];
      log.info('agent-runner: withheld', { id, profile: profile.name, count: withheld.size });
    }
    if (signal?.aborted) {
      base.status = 'cancelled';
      base.error = 'cancelled';
      return base;
    }
    if (capHit === 'time-cap') {
      base.status = 'failed';
      base.error = capHit;
      return base;
    }
    if (errorMessage) {
      base.status = 'failed';
      base.error = 'agent-error';
      log.warn('agent-runner: task error', { id, profile: profile.name, steps: usage.steps });
      return base;
    }
    if (outcome.exitCode !== 0) {
      base.status = 'failed';
      base.error = `exit-${outcome.exitCode ?? 'signal'}`;
      return base;
    }
    if (!base.result.text.trim() && !files.length) {
      base.status = 'failed';
      base.error = 'empty-answer';
    }
    return base;
  }

  return { run, checkPrompt: () => readPromptFile(profile.promptFiles) };
}
