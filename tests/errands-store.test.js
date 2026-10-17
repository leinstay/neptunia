// Tests for src/errands/store.js: the persona's errand tasks on disk, per guild, in a temp
// data/ directory. A task moves queued -> running -> done | failed | cancelled, tasks.json holds
// the list and tasks.jsonl one line per transition, the caps refuse with their codes (open at
// once, tasks and dollars per UTC day), the journal gets one operation per task with counts
// only, and a file handle resolves only to a file the task's result lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskStore, fileHandle, parseFileHandle } from '../src/errands/store.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-17T10:00:00Z');

function tempDataDir() {
  return tempDir('errands-store-');
}

function makeStore({ dataDir = tempDataDir(), clock = { t: T0 }, agents = {}, journal = null, journalOn = true } = {}) {
  const config = {
    features: { journal: journalOn },
    agents: {
      maxOpen: 3,
      web: { daily: { tasks: 5, usd: 1 }, out: '/var/lib/agent-web/out' },
      server: { daily: { tasks: 2, usd: 0.5 }, out: '/var/lib/agent-server/out' },
      ...agents,
    },
  };
  let n = 0;
  const store = createTaskStore({ dataDir, guildId: 'g1', now: () => clock.t, config: () => config, journal, uuid: () => `${(n += 1).toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd` });
  return { store, dataDir, clock, config };
}

const asked = { agent: 'web', goal: 'find the release notes', requester: { userId: 'u1', kind: 'member' }, origin: { channelId: 'c1', messageId: 'm1' }, scope: 'group' };

test('task store: a new task is queued and written to tasks.json and tasks.jsonl', async () => {
  await withCapturedLogs(() => {
    const { store, dataDir } = makeStore();
    const added = store.add(asked);
    assert.equal(added.ok, true);
    const { task } = added;
    assert.match(task.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(task.state, 'queued');
    assert.equal(task.agent, 'web');
    assert.equal(task.goal, 'find the release notes');
    assert.deepEqual(task.requester, { userId: 'u1', kind: 'member' });
    assert.deepEqual(task.origin, { channelId: 'c1', messageId: 'm1' });
    assert.equal(task.scope, 'group');
    assert.equal(task.createdAt, T0);
    assert.equal(task.seen, false);
    assert.equal(task.result, null);
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.json'), 'utf8'));
    assert.equal(file.tasks.length, 1);
    const lines = fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).state, 'queued');
    // A second store over the same directory reads the list back.
    const again = createTaskStore({ dataDir, guildId: 'g1', now: () => T0 });
    assert.equal(again.get(task.id).goal, 'find the release notes');
  });
});

test('task store: queued -> running -> done; the end is written once, a late one ignored', async () => {
  await withCapturedLogs(() => {
    const { store, dataDir, clock } = makeStore();
    const { task } = store.add(asked);
    clock.t += 1000;
    assert.equal(store.start(task.id).state, 'running');
    assert.equal(store.start(task.id), null, 'only a queued task starts');
    assert.deepEqual(store.open().map((t) => t.id), [task.id]);
    clock.t += 5000;
    const done = store.finish(task.id, { status: 'done', result: { text: 'here', sources: ['https://example.org'], files: [] }, usage: { usd: 0.25, steps: 3 } });
    assert.equal(done.state, 'done');
    assert.equal(done.endedAt, T0 + 6000);
    assert.equal(done.result.text, 'here');
    assert.equal(done.usage.usd, 0.25);
    assert.equal(done.error, null);
    assert.equal(Object.hasOwn(done.result, 'filesDropped'), false, 'none held back, no key');
    assert.equal(store.finish(task.id, { status: 'failed' }), null);
    assert.deepEqual(store.open(), []);
    assert.deepEqual(store.unseen().map((t) => t.id), [task.id]);
    assert.equal(store.markSeen(task.id).seen, true);
    assert.deepEqual(store.unseen(), []);
    assert.equal(store.today('web').usd, 0.25);
    const states = fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).state);
    assert.deepEqual(states, ['queued', 'running', 'done']);
  });
});

test('task store: the files the runner held back are kept as names only', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { task } = store.add(asked);
    store.start(task.id);
    const done = store.finish(task.id, { status: 'done', result: { text: 'here', filesDropped: [{ name: 'x.env', reason: 'secret' }, { name: 'a.txt', reason: 'withheld' }, { name: 'b', reason: 'other' }] } });
    assert.deepEqual(done.result.filesDropped, ['x.env', 'a.txt']);
  });
});

test('task store: a cancel closes an open task; the runner\'s later end changes nothing', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { task } = store.add(asked);
    store.start(task.id);
    const cancelled = store.cancel(task.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.error, 'cancelled');
    assert.equal(store.finish(task.id, { status: 'done', result: { text: 'late' } }), null);
    assert.equal(store.get(task.id).state, 'cancelled');
    assert.equal(store.cancel(task.id), null);
    assert.equal(store.cancel('nope'), null);
  });
});

test('task store: the caps refuse with cap-open, cap-tasks and cap-usd, and the day rolls over', async () => {
  await withCapturedLogs(() => {
    const { store, clock } = makeStore({ agents: { maxOpen: 2 } });
    assert.equal(store.add(asked).ok, true);
    const second = store.add(asked);
    assert.equal(second.ok, true);
    assert.deepEqual(store.add(asked), { ok: false, code: 'cap-open' });
    assert.equal(store.budget('web').spent, true);
    assert.equal(store.budget('web').key, 'agents.maxOpen');
    store.finish(store.open()[0].id, { status: 'done', result: { text: '' }, usage: { usd: 0.1 } });
    store.finish(second.task.id, { status: 'failed', error: 'x' });
    // server: two tasks a day.
    const server = { ...asked, agent: 'server', requester: { userId: 'owner', kind: 'owner' } };
    const s1 = store.add(server).task;
    store.finish(s1.id, { status: 'done', usage: { usd: 0.1 } });
    const s2 = store.add(server).task;
    store.finish(s2.id, { status: 'done', usage: { usd: 0.1 } });
    assert.deepEqual(store.add(server), { ok: false, code: 'cap-tasks' });
    // web: one dollar a day.
    const w = store.add(asked).task;
    store.finish(w.id, { status: 'done', usage: { usd: 0.95 } });
    assert.deepEqual(store.add(asked), { ok: false, code: 'cap-usd' });
    assert.equal(store.budget('web').key, 'agents.web.daily.usd');
    // A new UTC day: both rails start again.
    clock.t += DAY;
    assert.equal(store.add(asked).ok, true);
    assert.equal(store.add(server).ok, true);
    assert.deepEqual(store.add({ ...asked, agent: 'mail' }), { ok: false, code: 'unknown-agent' });
    assert.deepEqual(store.add({ ...asked, goal: '  ' }), { ok: false, code: 'bad-goal' });
  });
});

test('task store: every transition is one journal operation, counts only', async () => {
  const lines = [];
  const journal = { action: async (guildId, record) => lines.push({ guildId, ...record }) };
  await withCapturedLogs(async () => {
    const { store } = makeStore({ journal });
    const { task } = store.add(asked);
    store.start(task.id);
    store.finish(task.id, { status: 'done', result: { text: 'secret answer text', sources: ['https://a', 'https://b'], files: [{ path: '/x/a.png', name: 'a.png', contentType: 'image/png', bytes: 3 }] }, usage: { usd: 0.02, steps: 2 } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lines.map((line) => line.phase), ['proposed', 'started', 'succeeded']);
    assert.equal(new Set(lines.map((line) => line.opId)).size, 1, 'one operation per task');
    for (const line of lines) {
      assert.equal(line.name, 'task');
      assert.equal(line.channelId, 'c1');
      assert.deepEqual(line.participants, ['u1']);
      assert.deepEqual(line.sourceMessageIds, ['m1']);
    }
    assert.deepEqual(lines[2].result, { taskId: task.id, state: 'done', chars: 18, sources: 2, files: 1, usage: { usd: 0.02, steps: 2, seconds: 0 } });
    const all = JSON.stringify(lines);
    assert.ok(!all.includes('release notes') && !all.includes('secret answer'), 'never the goal or the result');
    // A failure closes with its code; the journal off writes nothing.
    const failedTask = store.add(asked).task;
    store.finish(failedTask.id, { status: 'failed', error: 'withheld-path' });
    await new Promise((r) => setImmediate(r));
    assert.equal(lines.at(-1).phase, 'failed');
    assert.equal(lines.at(-1).result.code, 'withheld-path');
  });
  const quiet = [];
  await withCapturedLogs(() => {
    const { store } = makeStore({ journal: { action: async (g, r) => quiet.push(r) }, journalOn: false });
    store.add(asked);
  });
  assert.deepEqual(quiet, []);
});

test('task store: a DM task journals into the requester\'s private layer', async () => {
  const lines = [];
  await withCapturedLogs(async () => {
    const { store } = makeStore({ journal: { action: async (guildId, record) => lines.push(record) } });
    store.add({ ...asked, scope: 'dm', origin: { channelId: 'dm1', messageId: 'm9' } });
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(lines[0].privateUserId, 'u1');
  assert.equal(lines[0].channelId, undefined);
});

test('task store: a file handle resolves only to a file the task lists, inside its out directory', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore();
    const { task } = store.add(asked);
    store.finish(task.id, { status: 'done', result: { text: 'ok', files: [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 1234 }] } });
    const handle = fileHandle(task.id, 'meme.png');
    assert.equal(handle, `file:${task.id}/meme.png`);
    assert.deepEqual(parseFileHandle(handle), { id: task.id, name: 'meme.png' });
    const file = store.fileOf(handle);
    assert.equal(file.path, path.resolve('/var/lib/agent-web/out', task.id, 'meme.png'), 'the out directory, never the path the runner wrote');
    assert.equal(file.contentType, 'image/png');
    assert.equal(file.bytes, 1234);
    assert.equal(store.fileOf(`file:${task.id}/other.png`), null);
    assert.equal(store.fileOf('file:tnope/meme.png'), null);
    assert.equal(store.fileOf(`file:${task.id}/../meme.png`), null);
    assert.equal(parseFileHandle(`file:${task.id}/..`), null);
    assert.equal(store.fileOf('meme.png'), null);
  });
});

test('task store: recent lists newest first; failOpen fails what a restart left open', async () => {
  await withCapturedLogs(() => {
    const { store, clock } = makeStore({ agents: { maxOpen: 5 } });
    const a = store.add(asked).task;
    clock.t += 10;
    const b = store.add(asked).task;
    clock.t += 10;
    const c = store.add(asked).task;
    store.start(b.id);
    assert.deepEqual(store.recent(2).map((t) => t.id), [c.id, b.id]);
    assert.equal(store.failOpen('restarted'), 3);
    assert.deepEqual(store.open(), []);
    for (const id of [a.id, b.id, c.id]) {
      assert.equal(store.get(id).state, 'failed');
      assert.equal(store.get(id).error, 'restarted');
    }
  });
});

test('task store: a finished task\'s files expire once the runner removed its directory; the handle then names nothing', async () => {
  await withCapturedLogs(() => {
    const out = tempDir('errands-out-');
    const { store, dataDir } = makeStore({ agents: { maxOpen: 5, web: { daily: { tasks: 5, usd: 1 }, out } } });
    const files = [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 12 }];
    const kept = store.add(asked).task;
    const gone = store.add(asked).task;
    const bare = store.add(asked).task;
    const open = store.add(asked).task;
    for (const id of [kept.id, gone.id]) store.finish(id, { status: 'done', result: { text: 'ok', files } });
    store.finish(bare.id, { status: 'done', result: { text: 'no files' } });
    fs.mkdirSync(path.join(out, kept.id));
    // The directory of `gone` was never there (as after the runner's sweep), nor that of `bare` or `open`.
    assert.equal(store.get(gone.id).filesExpired, true);
    assert.equal(store.get(kept.id).filesExpired, undefined);
    assert.equal(store.get(bare.id).filesExpired, undefined, 'a task without files has nothing to expire');
    assert.equal(store.get(open.id).filesExpired, undefined, 'an open task is never marked');
    assert.equal(store.fileOf(fileHandle(gone.id, 'meme.png')), null);
    assert.ok(store.fileOf(fileHandle(kept.id, 'meme.png')));
    assert.ok(store.unseen().find((t) => t.id === gone.id).filesExpired);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.json'), 'utf8'));
    assert.equal(saved.tasks.find((t) => t.id === gone.id).filesExpired, true, 'written to tasks.json');
    assert.equal(store.expireFiles(), 0, 'marked once');
    fs.rmSync(path.join(out, kept.id), { recursive: true });
    assert.equal(store.recent(10).find((t) => t.id === kept.id).filesExpired, true);
  });
});

test('task store: no out dir at all (no runner on this host) expires nothing', async () => {
  await withCapturedLogs(() => {
    const { store } = makeStore({ agents: { web: { daily: { tasks: 5, usd: 1 }, out: path.join(os.tmpdir(), 'errands-no-such-out-dir') } } });
    const { task } = store.add(asked);
    store.finish(task.id, { status: 'done', result: { text: 'ok', files: [{ path: '/x/a.png', name: 'a.png' }] } });
    assert.equal(store.expireFiles(), 0);
    assert.equal(store.get(task.id).filesExpired, undefined);
  });
});

test('task store: forgetUser drops the member\'s tasks and transition lines atomically; wipe deletes both files', async () => {
  await withCapturedLogs(() => {
    const { store, dataDir } = makeStore({ agents: { maxOpen: 5 } });
    const mine = store.add(asked).task;
    const theirs = store.add({ ...asked, requester: { userId: 'u2', kind: 'member' } }).task;
    store.start(mine.id);
    const logFile = path.join(dataDir, 'guilds', 'g1', 'tasks.jsonl');
    fs.appendFileSync(logFile, 'not json u1\nnot json u9\n');
    const vault = path.join(dataDir, 'vault', 'forget-u1');
    assert.deepEqual(store.forgetUser('u1', { vault }), { removed: 1, lines: 3 });
    assert.deepEqual(store.recent(10).map((t) => t.id), [theirs.id]);
    const left = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(left.slice(-1), ['not json u9']);
    assert.equal(JSON.parse(left[0]).id, theirs.id);
    assert.equal(fs.readFileSync(path.join(vault, 'guilds', 'g1', 'tasks.jsonl.dropped.jsonl'), 'utf8').trim().split('\n').length, 3);
    assert.deepEqual(store.forgetUser('u1'), { removed: 0, lines: 0 });
    assert.deepEqual(store.wipe(), { files: 2 });
    assert.equal(fs.existsSync(logFile), false);
    assert.deepEqual(store.recent(10), []);
    assert.deepEqual(store.wipe(), { files: 0 });
  });
});

test('task store: setLedgerId keeps the ledger\'s id on the task (tasks.json written, the later transition lines carry it); none for an unknown task', async () => {
  await withCapturedLogs(() => {
    const { store, dataDir } = makeStore();
    const { task } = store.add(asked);
    assert.equal(Object.hasOwn(task, 'ledgerId'), false, 'optional: absent until the ledger answers');
    assert.equal(store.setLedgerId(task.id, 'L7').ledgerId, 'L7');
    assert.equal(store.setLedgerId(task.id, 12).ledgerId, '12');
    assert.equal(store.setLedgerId(task.id, 'L7').ledgerId, 'L7');
    assert.equal(store.setLedgerId('tnone', 'L8'), null);
    assert.equal(store.setLedgerId(task.id, ''), null);
    store.start(task.id);
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.json'), 'utf8'));
    assert.equal(file.tasks[0].ledgerId, 'L7');
    const lines = fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => [line.state, line.ledgerId ?? null]), [['queued', null], ['running', 'L7']]);
    // A second store over the same directory reads it back.
    assert.equal(createTaskStore({ dataDir, guildId: 'g1', now: () => T0 }).get(task.id).ledgerId, 'L7');
  });
});
