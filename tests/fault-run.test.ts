// The fault run (scripts/fault-run.ts, scripts/lib/fault-run.ts): every side effect counted by its effect key, and the run
// passes when no key repeats and each expected effect happened once. The ledger and the reading of a request are
// checked on small inputs. The short run is the real one over the real core: repeated events (at once, one after
// another, after a reconnect, while the link is down), an edit and a delete racing a turn, a reaction cut off by the call
// timeout, a core stopped mid-turn, and simulated weeks over a fake clock, one of them with an errand that runs an hour.
// A scripted model and the fake interface stand in for the provider and the platform. The long run is the same code with
// a bigger plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { CliError } from '../scripts/lib/cli.ts';
import { parseArgs } from '../scripts/fault-run.ts';
import {
  LONG_PLAN,
  SHORT_PLAN,
  createLedger,
  directiveOf,
  faultRun,
  observe,
  tableOf,
} from '../scripts/lib/fault-run.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

test('the ledger names a key that happened twice and a key that never happened', () => {
  const ledger = createLedger();
  ledger.record('send', 'c1:a');
  ledger.record('send', 'c1:a');
  ledger.record('send', 'c1:b');
  assert.deepEqual(ledger.repeats(), [['send:c1:a', 2]]);
  assert.deepEqual(ledger.missing(['send:c1:a', 'send:c1:b', 'send:c1:c']), ['send:c1:a', 'send:c1:c']);
});

test('observe counts a send by chat and text and a reaction by message, and the adapter still acts', async () => {
  const adapter = createFakeAdapter({ selfId: 'self-id' });
  adapter.seedChat({
    id: 'c1',
    kind: 'channel',
    rootId: 'g1',
    name: 'room',
    topic: null,
    iface: 'fake',
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: null,
  });
  const ledger = createLedger();
  observe(adapter, ledger);
  const ref = { iface: 'fake', chatId: 'c1' };
  const sent = await adapter.send(ref, { text: 'hello' });
  await adapter.send(ref, { text: 'hello' });
  const first = adapter.messagesIn('c1')[0];
  assert.ok(first, 'the adapter stored what was sent');
  await adapter.react({ ...ref, messageId: first.ref.messageId }, '👍');
  assert.equal(sent.status, 'ok');
  assert.deepEqual(
    [...ledger.counts()],
    [
      ['send:c1:hello', 2],
      [`react:c1/${first.ref.messageId}/👍`, 1],
    ]
  );
});

test('a directive comes from the newest chat line of a message turn and from the due intention of a wake', () => {
  const chat = '<chat>\\n#1 [10:00] Eleni (@u1): do:say:old\\n#2 [10:01] Eleni (@u1): do:react:new\\n</chat>';
  assert.deepEqual(directiveOf(chat, false), { verb: 'react', word: 'new', line: 2 });
  const wake = '<wake>\\nIntention i1 is due: do:say:later. This is your earlier decision.\\n</wake>' + chat;
  assert.deepEqual(directiveOf(wake, false), { verb: 'say', word: 'later', line: null });
});

test('a request that follows a tool result, or reminds her of an open intention, carries no directive', () => {
  const chat = '<chat>\\n#1 [10:00] Eleni (@u1): do:say:old\\n</chat>';
  assert.equal(directiveOf(chat, true), null);
  assert.equal(directiveOf(`${chat} Intentions you woke for that you have not changed yet: i1.`, false), null);
});

test('the arguments pick the short or the long plan and override one number of it', () => {
  assert.deepEqual(parseArgs(['--short']), SHORT_PLAN);
  assert.deepEqual(parseArgs([]), LONG_PLAN);
  assert.deepEqual(parseArgs(['--rounds', '3', '--weeks', 'restart,promises']), {
    ...LONG_PLAN,
    rounds: 3,
    weeks: ['restart', 'promises'],
  });
  assert.throws(() => parseArgs(['--rounds', '0']), CliError);
  assert.throws(() => parseArgs(['--unknown']), CliError);
});

test('the report table says FAILED when a key repeated', () => {
  const failed = tableOf({
    ok: false,
    ms: 1200,
    rows: [{ scenario: 'week x', effects: 3, repeats: [['wake:x:w1', 2]], missing: [] }],
  });
  assert.match(failed, /wake:x:w1 x2/);
  assert.match(failed, /FAILED/);
});

test(
  'the short run counts every effect once: no key repeats and every expected effect happened',
  { timeout: 30_000 },
  async () => {
    const report = await withCapturedLogs(() => faultRun(SHORT_PLAN));
    const rows = report.result.rows;
    assert.deepEqual(
      rows.map((row) => row.scenario),
      ['live core, round 1', 'week hour-errand', 'week restart', 'week recurring', 'week stalled-errand']
    );
    for (const row of rows) {
      assert.deepEqual(row.repeats, [], `${row.scenario} repeated an effect`);
      assert.deepEqual(row.missing, [], `${row.scenario} missed an effect`);
      assert.ok(row.effects > 0, `${row.scenario} counted nothing`);
    }
    assert.equal(report.result.ok, true);
  }
);
