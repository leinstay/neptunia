// Tests for `/nep memory journal message:<id|link>` (memory.journal.read): the journal's turn
// record of the turn that posted one of the persona's messages, found by the message's own UTC
// day (from its snowflake) and the next, shown whole. The pure lookup (turnOfMessage), the
// journal's search (findTurn, a real journal over a fake append store), the operation by id and
// by link, and the persona's call naming a transcript line `#N`. No disk, no real data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import '../src/ops/index.js';
import { createAdmin } from '../src/admin.js';
import { createJournal, turnOfMessage, turnView } from '../src/memory/journal.js';
import { snowflakeAt } from '../src/behavior/recall.js';
import { executeCall, resolveCall } from '../src/skills/executors.js';
import { skillRegistry } from '../src/skills/registry.js';

const OWNER = '42';
const SELF = 'self-1';
const DATA = path.join('fake-root', 'data');

/** A snowflake of a message sent at `ms`, `n` keeping ids of the same millisecond apart. */
const idAt = (ms, n = 1) => (BigInt(snowflakeAt(ms)) + BigInt(n)).toString();

function fakeAppendStore() {
  const lines = [];
  return {
    lines,
    append: async (file, line) => {
      lines.push({ file, line });
    },
    async *iterate(file) {
      for (const entry of lines) if (entry.file === file) yield { offset: 0, line: entry.line };
    },
  };
}

function journalAt(clock) {
  let n = 0;
  const appendStore = fakeAppendStore();
  const journal = createJournal({ appendStore, dataDir: DATA, config: () => ({ thinkChars: 4000 }), now: () => clock.ms, uuid: () => `u-${(n += 1)}` });
  return { journal, appendStore };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A long think in Greek: far past the 80 characters a day line shows. */
const THINK = `Η Ελένη ρωτά για το ταξίδι. ${'Σκέφτομαι τι να πω, και πώς. '.repeat(90)}Τέλος.`;

/**
 * One turn written as a live turn writes it: `turn.start` at `startMs`, a post operation closed
 * `succeeded` with `postedId` at `postMs`, the `turn` record at `endMs`. `oldShape`: the record
 * keeps no `posted` ids (only the action line names the post). `call`: a skill call of the turn.
 */
async function writeTurn(journal, clock, { startMs, postMs, endMs, triggerId, postedId, oldShape = false, call = false, channelId = 'c1' }) {
  clock.ms = startMs;
  const started = journal.start('g1', { channelId, mode: 'reply', trigger: { kind: 'mention', messageId: triggerId, authorId: '7' }, participants: ['7'], sourceMessageIds: [triggerId] });
  await tick();
  clock.ms = postMs;
  const op = journal.op('g1', { turnId: started.turnId, name: 'post', by: 'persona', channelId, intent: { replyTo: triggerId, text: 'γεια' } });
  await op.started();
  await op.succeeded({ messageId: postedId });
  const actions = [op.opId];
  if (call) {
    const skill = journal.op('g1', { turnId: started.turnId, name: 'skill', by: 'persona', channelId, input: { skill: 'memory.profile.read', invocationId: 'inv-1' } });
    await skill.proposed({ input: { skill: 'memory.profile.read', invocationId: 'inv-1', args: ['user'], body: false } });
    await skill.started({ target: { user: '7' } });
    await skill.succeeded({});
    actions.push(skill.opId);
  }
  clock.ms = endMs;
  await journal.turn('g1', {
    turnId: started.turnId,
    attemptId: started.attemptId,
    startedAt: started.startedAt,
    channelId,
    mode: 'reply',
    outcome: 'spoke',
    reason: null,
    seen: { messageIds: [triggerId] },
    think: THINK,
    posted: oldShape ? [] : [{ opId: op.opId, messageId: postedId, replyTo: triggerId }],
    actions,
  });
  return started;
}

/** An admin over the journal, the persona's own id `SELF`, the owner `OWNER`. */
function makeAdmin(journal) {
  const hot = { config: { features: { skills: true, journal: true }, skills: { safeMode: false }, bot: { owners: [OWNER], access: {} } }, prompts: { labels: {} } };
  const store = { state: { data: {}, markDirty() {} }, getUser: () => null, getGuild: () => ({}), isPingsOff: () => false };
  return createAdmin({ hot, store, client: { user: { id: SELF } }, getGuildId: () => 'g1', journal });
}

const D = Date.UTC(2026, 9, 13, 12, 0, 0);

test('turnOfMessage: the turn whose posted names the message, its start, its posts and its skill call', async () => {
  const clock = { ms: D };
  const { journal, appendStore } = journalAt(clock);
  const postedId = idAt(D + 3000);
  const started = await writeTurn(journal, clock, { startMs: D, postMs: D + 3000, endMs: D + 5000, triggerId: 'm-trigger', postedId, call: true });
  const records = appendStore.lines.map(({ line }) => JSON.parse(line));

  const found = turnOfMessage(records, postedId);
  assert.equal(found.turn.turnId, started.turnId);
  assert.equal(found.start.trigger.messageId, 'm-trigger');
  assert.deepEqual(found.posted, [postedId]);
  assert.deepEqual(found.calls, [{ skill: 'memory.profile.read', args: ['user'], target: { user: '7' }, phase: 'succeeded', code: null, messageId: null }]);
  assert.equal(turnOfMessage(records, 'm-trigger'), null, 'the message that started the turn is not one it posted');
  assert.equal(turnOfMessage(records, 'm-none'), null);
  assert.equal(turnOfMessage(null, postedId), null);

  // The view: every field, the think whole.
  const view = turnView(found);
  assert.ok(view.includes(THINK), 'the stored think, whole');
  for (const part of [started.turnId, 'reply', 'spoke', 'mention m-trigger', postedId, 'c1', 'memory.profile.read', started.startedAt]) assert.ok(view.includes(part), part);
});

test('turnOfMessage: an old record without posted ids is found through its post operation', async () => {
  const clock = { ms: D };
  const { journal, appendStore } = journalAt(clock);
  const postedId = idAt(D + 3000);
  const started = await writeTurn(journal, clock, { startMs: D, postMs: D + 3000, endMs: D + 5000, triggerId: 'm-t', postedId, oldShape: true });
  const records = appendStore.lines.map(({ line }) => JSON.parse(line));
  const found = turnOfMessage(records, postedId);
  assert.equal(found.turn.turnId, started.turnId);
  assert.deepEqual(found.posted, [postedId], 'the posted ids from the operation line');

  // A record whose posted list holds bare strings, empty ones among them, still reads.
  const legacy = records.map((record) => (record.kind === 'turn' ? { ...record, posted: ['', postedId] } : record));
  assert.deepEqual(turnOfMessage(legacy, postedId).posted, [postedId]);
});

test('findTurn: a turn that crossed midnight -- the record of the next day, the start of the day before', async () => {
  const clock = { ms: D };
  const { journal } = journalAt(clock);
  // Posted at 23:59:58, the turn record written at 00:00:05 the next day.
  const lateStart = Date.UTC(2026, 9, 13, 23, 59, 50);
  const latePost = Date.UTC(2026, 9, 13, 23, 59, 58);
  const lateId = idAt(latePost);
  const late = await writeTurn(journal, clock, { startMs: lateStart, postMs: latePost, endMs: Date.UTC(2026, 9, 14, 0, 0, 5), triggerId: 'm-late', postedId: lateId });
  const found = await journal.findTurn('g1', { messageId: lateId, at: latePost });
  assert.equal(found.turn.turnId, late.turnId);
  assert.equal(found.start.trigger.messageId, 'm-late');

  // Started at 23:59:50, posted after midnight: the start is read from the day before.
  const earlyStart = Date.UTC(2026, 9, 14, 23, 59, 50);
  const earlyPost = Date.UTC(2026, 9, 15, 0, 0, 2);
  const earlyId = idAt(earlyPost);
  const early = await writeTurn(journal, clock, { startMs: earlyStart, postMs: earlyPost, endMs: Date.UTC(2026, 9, 15, 0, 0, 4), triggerId: 'm-early', postedId: earlyId });
  const crossed = await journal.findTurn('g1', { messageId: earlyId, at: earlyPost });
  assert.equal(crossed.turn.turnId, early.turnId);
  assert.equal(crossed.start.trigger.messageId, 'm-early');

  // Two days later nothing of these is searched.
  assert.equal(await journal.findTurn('g1', { messageId: lateId, at: latePost + 2 * 86_400_000 }), null);
});

test('memory.journal.read: by message id or link, the turn record whole; not hers or no record is not-found', async () => {
  const clock = { ms: D };
  const { journal } = journalAt(clock);
  const postedId = idAt(D + 3000);
  const triggerId = idAt(D - 60_000);
  const started = await writeTurn(journal, clock, { startMs: D, postMs: D + 3000, endMs: D + 5000, triggerId, postedId });
  const admin = makeAdmin(journal);

  const byId = await admin.run('memory.journal', { messageId: postedId }, { guildId: 'g1', userId: OWNER });
  assert.ok(byId.includes(THINK), 'the think whole, not its first 80 characters');
  assert.ok(byId.includes(started.turnId));
  const byLink = await admin.run('memory.journal', { messageId: `https://discord.com/channels/111/222/${postedId}` }, { guildId: 'g1', userId: OWNER });
  assert.equal(byLink, byId);

  // Someone else's message (it started the turn), an unknown one, and junk.
  await assert.rejects(admin.run('memory.journal', { messageId: triggerId }, { guildId: 'g1', userId: OWNER }), { code: 'not-found' });
  await assert.rejects(admin.run('memory.journal', { messageId: idAt(D + 4000, 9) }, { guildId: 'g1', userId: OWNER }), { code: 'not-found' });
  await assert.rejects(admin.run('memory.journal', { messageId: 'not an id' }, { guildId: 'g1', userId: OWNER }), { code: 'unknown-message' });
});

test('memory.journal.read: the persona names her line #N; it resolves to the message id as message.edit does', async () => {
  const clock = { ms: D };
  const { journal } = journalAt(clock);
  const postedId = idAt(D + 3000);
  await writeTurn(journal, clock, { startMs: D, postMs: D + 3000, endMs: D + 5000, triggerId: 'm-t', postedId });
  const admin = makeAdmin(journal);
  const lines = new Map([[2, { id: postedId, conversationId: 'c1', authorId: SELF, self: true }]]);

  const resolved = resolveCall({ skill: 'memory.journal.read', args: { message: '#2' }, body: '' }, { skills: skillRegistry(), messageAt: (n) => lines.get(n) ?? null, selfId: SELF });
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.args, { message: postedId });
  const result = await executeCall(resolved, {
    envelope: Object.freeze({ actor: 'persona', requester: { id: OWNER, roleIds: [] }, mixed: false, invocationId: 'inv-1', originChannelId: 'c1' }),
    runCommand: admin.runCommand,
    runOwnCommand: admin.runOwnCommand,
    opContext: { guildId: 'g1', channelId: 'c1' },
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.data.text.includes(THINK));
  assert.equal(resolveCall({ skill: 'memory.journal.read', args: { message: '#9' }, body: '' }, { skills: skillRegistry(), messageAt: (n) => lines.get(n) ?? null }).code, 'unknown-message');
});
