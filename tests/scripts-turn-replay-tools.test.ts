// The gate of a replayed turn's tools (scripts/lib/turn-tools.ts): a tool whose effect class is `read` runs through
// the operation it is given, every other tool is kept as a call and answered with a plain success.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatedOps, gatedPersonLinks } from '../scripts/lib/turn-tools.ts';
import type { KeptCall } from '../scripts/lib/turn-tools.ts';

/** An operation runner that counts what it ran and answers each run with its name. */
function counting() {
  const ran: Array<string> = [];
  const run = (op: unknown) => {
    ran.push(String(op));
    return Promise.resolve({ status: 'ok', data: { text: `ran ${String(op)}` } });
  };
  return { ran, run };
}

test('runs a read tool through its operation', async () => {
  const real = counting();
  const gate = gatedOps({ runOp: real.run, runOwnOp: real.run, runInitiativeOp: real.run, now: () => 5 });
  const result = await gate.runOp('memory.recent.read', { place: 'γενικό' }, {});
  assert.deepEqual(real.ran, ['memory.recent.read']);
  assert.equal((result as { data: { text: string } }).data.text, 'ran memory.recent.read');
  assert.equal(gate.calls.length, 0);
});

test('keeps a write tool as a call and never runs it', async () => {
  const real = counting();
  const gate = gatedOps({ runOp: real.run, runOwnOp: real.run, runInitiativeOp: real.run, now: () => 5 });
  const result = await gate.runOwnOp('message.create', { text: 'Γεια' }, {});
  const intention = await gate.runInitiativeOp('intention.set', { text: 'Αύριο' }, {});
  assert.deepEqual(real.ran, []);
  assert.equal((result as { status: string }).status, 'ok');
  assert.equal((intention as { status: string }).status, 'ok');
  assert.deepEqual(
    gate.calls.map((call) => call.op),
    ['message.create', 'intention.set']
  );
});

test('keeps a call of an unknown tool and runs nothing', async () => {
  const real = counting();
  const gate = gatedOps({ runOp: real.run, runOwnOp: real.run, runInitiativeOp: real.run, now: () => 5 });
  await gate.runOp('no.such.tool', {}, {});
  assert.deepEqual(real.ran, []);
  assert.equal(gate.calls.length, 1);
});

test('keeps a person link as a call and starts no link', async () => {
  const calls: Array<KeptCall> = [];
  const links = gatedPersonLinks(calls, () => 5);
  const result = await links.start({ iface: 'fake', native: 'member-1', chatId: '1', person: 'Ελένη' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    calls.map((call) => call.op),
    ['person.link']
  );
  assert.equal(links.isWithheld('fake', '1', 'p-1'), false);
});
