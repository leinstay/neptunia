// Tests for src/errands/service.js: the secrets every run carries to its agent runner. Over a real
// task store (a temp data/ directory) with a FAKE journal, a FAKE errand client and a FAKE log:
// a run carries the key of its agent's model role as the bot resolves a role's key
// (`llm.keyByRole`), never the persona's main key; the web agent also gets the proxy in its http
// form and the search key, the server agent neither; without the role's key no secrets go out;
// and no secret reaches a log call, a journal line or the store's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTaskStores } from '../src/errands/store.js';
import { createErrandService } from '../src/errands/service.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const SECRETS = ['sk-agent-SECRET', 'sk-persona-SECRET', 'pw-SECRET', 'search-SECRET', 'sk-dev-SECRET'];

/** A fake errand client: records each run and ends it at once. */
function fakeClient() {
  const runs = [];
  return {
    runs,
    configured: () => true,
    async run(task) {
      runs.push(task);
      return { status: 'done', result: { text: 'found it' }, usage: { usd: 0.01 } };
    },
    cancel: () => true,
  };
}

/** A fake log that records every call. */
function fakeLog() {
  const calls = [];
  const record = (level) => (msg, fields) => calls.push({ level, msg, fields });
  return { calls, info: record('info'), warn: record('warn'), error: record('error') };
}

function makeService(env, { keyByRole } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-errands-service-'));
  const hot = {
    config: {
      features: { journal: true },
      llm: { keyByRole: keyByRole ?? { 'agent.web': 'OPENROUTER_AGENT_KEY', 'agent.server': 'OPENROUTER_AGENT_KEY', 'agent.dev': 'OPENROUTER_DEV_KEY' } },
      agents: { maxOpen: 3, web: { enabled: true, daily: { tasks: 10, usd: 5 } }, server: { enabled: true, daily: { tasks: 10, usd: 5 } } },
    },
  };
  const journalLines = [];
  const journal = { action: async (guildId, line) => journalLines.push(line) };
  const log = fakeLog();
  const client = fakeClient();
  const stores = createTaskStores({ dataDir: path.join(rootDir, 'data'), config: () => hot.config, journal, log });
  const errands = createErrandService({ client, stores, hot, env, getGuildId: () => 'g1', log, defer: (fn) => fn() });
  const cleanup = () => fs.rmSync(rootDir, { recursive: true, force: true });
  return { errands, client, log, journalLines, rootDir, cleanup };
}

const ask = (agent) => ({ agent, goal: 'find the changelog', requester: { userId: '7', kind: 'member' }, origin: { channelId: 'c1', messageId: 'm1' }, scope: 'group' });

/** Every file under `dir`, read as text and joined. */
function filesText(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), 'utf8'))
    .join('\n');
}

const ENV = {
  OPENROUTER_API_KEY: 'sk-persona-SECRET',
  OPENROUTER_AGENT_KEY: 'sk-agent-SECRET',
  OPENROUTER_DEV_KEY: 'sk-dev-SECRET',
  MEDIA_VIDEO_PROXY: 'socks5h://user:pw-SECRET@proxy.example:1080',
  OPENCODE_WEBSEARCH_KEY: 'search-SECRET',
};

test('errands service: a web run carries its role\'s key, the proxy in its http form and the search key; no secret in a log, a journal line or a file', async () => {
  const { errands, client, log, journalLines, rootDir, cleanup } = makeService(ENV);
  try {
    const { logs } = await withCapturedLogs(async () => {
      assert.equal(errands.submit(ask('web')).ok, true);
      await errands.idle();
    });
    assert.equal(client.runs.length, 1);
    assert.deepEqual(client.runs[0].secrets, {
      openrouterKey: 'sk-agent-SECRET',
      proxy: 'http://user:pw-SECRET@proxy.example:1080',
      searchKey: 'search-SECRET',
    });
    assert.ok(journalLines.length >= 2, 'the task was journaled');
    assert.ok(log.calls.length > 0, 'the run was logged');
    const recorded = JSON.stringify({ calls: log.calls, journalLines, logs }) + filesText(rootDir);
    for (const secret of SECRETS) assert.ok(!recorded.includes(secret), `${secret} never recorded`);
  } finally {
    cleanup();
  }
});

test('errands service: a server run carries only its role\'s key; never the persona\'s or the development key', async () => {
  const { errands, client, cleanup } = makeService(ENV);
  try {
    await withCapturedLogs(async () => {
      errands.submit(ask('server'));
      await errands.idle();
    });
    assert.deepEqual(client.runs[0].secrets, { openrouterKey: 'sk-agent-SECRET' });
  } finally {
    cleanup();
  }
});

test('errands service: the key follows llm.keyByRole read now; an http proxy is sent as it is; no search key, none sent', async () => {
  const env = { ...ENV, OPENROUTER_WEB_ONLY: 'sk-web-only', MEDIA_VIDEO_PROXY: 'http://proxy.example:8000', OPENCODE_WEBSEARCH_KEY: '' };
  const { errands, client, cleanup } = makeService(env, { keyByRole: { 'agent.web': 'OPENROUTER_WEB_ONLY' } });
  try {
    await withCapturedLogs(async () => {
      errands.submit(ask('web'));
      await errands.idle();
    });
    assert.deepEqual(client.runs[0].secrets, { openrouterKey: 'sk-web-only', proxy: 'http://proxy.example:8000' });
  } finally {
    cleanup();
  }
});

test('errands service: without the role\'s key no secrets are sent (never the main key); the missing name is logged, never a value', async () => {
  const env = { OPENROUTER_API_KEY: 'sk-persona-SECRET', MEDIA_VIDEO_PROXY: 'socks5h://user:pw-SECRET@proxy.example:1080' };
  const { errands, client, log, cleanup } = makeService(env, { keyByRole: { 'agent.web': 'OPENROUTER_UNSET_AGENT_KEY' } });
  try {
    const { logs } = await withCapturedLogs(async () => {
      errands.submit(ask('web'));
      errands.submit(ask('server'));
      await errands.idle();
    });
    assert.equal(client.runs.length, 2);
    for (const run of client.runs) assert.equal(Object.hasOwn(run, 'secrets'), false, run.agent);
    const missing = logs.filter((entry) => entry.msg === 'llm: role key missing');
    assert.deepEqual(missing.map((entry) => [entry.role, entry.name]), [['agent.web', 'OPENROUTER_UNSET_AGENT_KEY']]);
    const recorded = JSON.stringify({ calls: log.calls, logs });
    for (const secret of SECRETS) assert.ok(!recorded.includes(secret), `${secret} never recorded`);
  } finally {
    cleanup();
  }
});
