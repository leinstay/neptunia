// Tests for scripts/lib/replay-steps.ts: a step's burst played as the live queue plays it, and what a replayed turn
// leaves in a scenario's channel for the next turn, read off the writes its port recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burstTurns, carriedLines, replyParams, seededSelfLine } from '../../../scripts/lib/replay-steps.ts';
import { taskInput } from '../../../src/turn/task-input.ts';
import { scenarioTrigger } from '../../../scripts/lib/replay-scenarios.ts';
import { asRecord } from '../../fixtures/records.ts';

const OWNER = '100000000000000042';
const MEMBER = '100000000000000007';
const OTHER = '100000000000000009';
const SELF = '100000000000000001';
const HERE = '200000000000000001';
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const NAMES: Record<string, string> = { [OWNER]: 'Élodie', [MEMBER]: 'Zoë', [OTHER]: 'Νίκος' };

test('burstTurns: the live queue over a burst -- the first message starts the turn, calls wait in arrival order, one follow-up slot, the cap', () => {
  const here = { id: HERE, name: 'γενικά' };
  const line = (author: string, text: string, i: number) =>
    scenarioTrigger({
      text,
      authorId: author,
      authorName: NAMES[author],
      channel: here,
      selfId: SELF,
      at: NOW + i * 5000,
      tagged: false,
    });
  const a = line(OWNER, `<@${SELF}> α`, 0);
  const b = line(OWNER, `<@${SELF}> β`, 1);
  const c = line(MEMBER, 'γ', 2);
  const d = line(OTHER, `<@${SELF}> δ`, 3);
  const e = line(MEMBER, 'ε', 4);
  assert.deepEqual(asRecord(d).mentionedAccountIds, [SELF], 'a tag written in the text tags the persona');
  // A name in the text calls nobody.
  const config = {};
  const plan = burstTurns([a, b, c, d, e], { selfId: SELF, config });
  assert.deepEqual(
    plan.turns.map((t) => [t.line.id, t.kind]),
    [
      [asRecord(a).id, 'mention'],
      [asRecord(b).id, 'mention'],
      [asRecord(d).id, 'mention'],
      [asRecord(e).id, 'followUp'],
    ]
  );
  assert.deepEqual(plan.replaced, [{ id: asRecord(c).id, by: asRecord(e).id }]);
  assert.deepEqual(plan.dropped, []);
  // The trigger author's own waiting calls carry no author (labels.task.queued); another member's do.
  const [first, second, , fourth] = plan.turns;
  assert.deepEqual(first.queued, [
    { id: asRecord(b).id, text: `<@${SELF}> β` },
    { id: asRecord(d).id, text: `<@${SELF}> δ`, author: 'Νίκος' },
    { id: asRecord(e).id, text: 'ε', author: 'Zoë' },
  ]);
  assert.deepEqual(second.queued, [
    { id: asRecord(d).id, text: `<@${SELF}> δ`, author: 'Νίκος' },
    { id: asRecord(e).id, text: 'ε', author: 'Zoë' },
  ]);
  assert.deepEqual(fourth.queued, []);
  // mention.maxPending: the oldest waiting entry is dropped when the queue is full.
  const capped = burstTurns([a, b, d, e], { selfId: SELF, config: { ...config, mention: { maxPending: 2 } } });
  assert.deepEqual(capped.dropped, [{ id: asRecord(b).id, reason: 'full' }]);
  assert.deepEqual(
    capped.turns.map((t) => t.line.id),
    [asRecord(a).id, asRecord(d).id, asRecord(e).id]
  );
  // A reply to the persona's own line is a reply call.
  const mine = { id: '300000000000000001', self: true, authorId: SELF, ts: NOW - 1000 };
  const reply = { ...line(MEMBER, 'ναι', 0), replyToId: mine.id };
  const [replied] = burstTurns([reply], {
    selfId: SELF,
    config,
    history: [mine],
  } as unknown as Parameters<typeof burstTurns>[1]).turns;
  assert.equal(replied.kind, 'reply');
  assert.deepEqual(burstTurns([], { selfId: SELF, config }), { turns: [], replaced: [], dropped: [] });
});

test("carriedLines: the persona's messages sent here join the channel as the persona's lines at the turn's moment, in the order they went out", () => {
  const here = { id: HERE, name: 'γενικά' };
  const asked = scenarioTrigger({
    text: 'α;',
    authorId: MEMBER,
    authorName: 'Zoë',
    channel: here,
    selfId: SELF,
    at: NOW,
  });
  const lines = carriedLines({
    lines: [asked],
    writes: [
      { op: 'send', at: NOW + 1000, args: [{ iface: 'discord', chatId: HERE }, { text: 'πρώτο' }] },
      { op: 'send', at: NOW + 1000, args: [{ iface: 'discord', chatId: '200000000000000002' }, { text: 'αλλού' }] },
      { op: 'send', at: NOW + 1000, args: [{ iface: 'discord', chatId: HERE }, { text: 'δεύτερο' }] },
    ],
    at: NOW + 500,
    channel: here,
    selfId: SELF,
    selfName: 'Nep',
  });
  assert.deepEqual(
    lines.map((line) => [line.content, line.self ?? false, line.authorName, line.ts]),
    [
      ['α;', false, 'Zoë', NOW],
      ['πρώτο', true, 'Nep', NOW + 500],
      ['δεύτερο', true, 'Nep', NOW + 500],
    ]
  );
  // The persona's lines sort after the message they answer and apart from each other by their ids, as a platform's would.
  const ids = lines.map((line) => BigInt(String(line.id)));
  assert.ok(ids[0] < ids[1] && ids[1] < ids[2]);
});

test("carriedLines: the persona's reaction lands once on the line it names; a reaction elsewhere leaves the channel as it was", () => {
  const here = { id: HERE, name: 'γενικά' };
  const asked = scenarioTrigger({
    text: 'α;',
    authorId: MEMBER,
    authorName: 'Zoë',
    channel: here,
    selfId: SELF,
    at: NOW,
  });
  const react = (chatId: string, emoji: string) => ({
    op: 'react' as const,
    at: NOW + 1000,
    args: [{ iface: 'discord', chatId, messageId: asRecord(asked).id }, emoji],
  });
  const [line] = carriedLines({
    lines: [asked],
    writes: [react(HERE, '👍'), react(HERE, '👍'), react('200000000000000002', '🎉')],
    at: NOW + 500,
    channel: here,
    selfId: SELF,
    selfName: 'Nep',
  });
  assert.deepEqual(asRecord(line).reactions, [{ emoji: '👍', count: 1, mine: true }]);
});

test("seededSelfLine: a line of the persona's with the list fields a platform line carries, tagging whom its text tags", () => {
  const line = seededSelfLine({
    text: `<@${MEMBER}> ναι`,
    at: NOW,
    selfId: SELF,
    selfName: 'Nep',
    channel: { id: HERE },
  });
  assert.deepEqual(
    [line.self, line.authorId, line.authorName, line.ts, asRecord(line).mentionedAccountIds, line.reactions],
    [true, SELF, 'Nep', NOW, [MEMBER], []]
  );
});

test('replyParams: the calls still waiting reach the turn as the drain hands them, so its task names them', () => {
  const trigger = { id: '300000000000000001', authorId: MEMBER, content: 'α' };
  const waiting = [{ id: '300000000000000002', text: 'β', author: NAMES[OTHER] }];
  const params = replyParams(trigger, 'mention', waiting);
  const told = taskInput({ queued: params.queued, labels: { task: { queuedOthers: '{others}' } } });
  assert.deepEqual(told.input?.queuedOthers, [{ author: NAMES[OTHER], text: 'β' }]);
  assert.deepEqual([...told.deferred], ['300000000000000002']);
  assert.equal('queued' in replyParams(trigger, 'mention', []), false);
});
