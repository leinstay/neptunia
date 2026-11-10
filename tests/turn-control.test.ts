// src/turn/control.ts: the core owns accepted, queued, running and terminal. A fake `run` stands for the turn itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnControl } from '../src/turn/control.ts';
import type { TurnEvent, TurnOutcome, TurnRun } from '../src/turn/control.ts';
import { readTurnAction, readTurnEvent } from '../src/protocol/turn-control.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function rig(capacity = 3) {
  const events: Array<TurnEvent> = [];
  const runs: Array<{ turn: TurnRun; signal: AbortSignal; finish: (outcome: TurnOutcome) => void }> = [];
  let serial = 0;
  const control = createTurnControl({
    capacity,
    newId: () => `t${(serial += 1)}`,
    now: () => 1000,
    emit: (event) => void events.push(event),
    run: (turn, { signal }) =>
      new Promise<TurnOutcome>((resolve) => {
        runs.push({ turn, signal, finish: resolve });
      }),
  });
  return { control, events, runs, typesOf: (id: string) => events.filter((e) => e.turnId === id).map((e) => e.type) };
}

const accepted = (answer: ReturnType<ReturnType<typeof rig>['control']['submit']>): string => {
  assert.equal(answer.status, 'accepted');
  return answer.status === 'accepted' ? answer.turnId : '';
};

test('a turn goes accepted, running and committed, with one rising sequence over its events', async () => {
  // Bug: the client reorders a reconnect's replay because events carry no order.
  const { control, events, runs, typesOf } = rig();
  const id = accepted(control.submit({ requestId: 'r1', text: 'hello', attachments: [] }));
  await tick();
  runs[0]?.finish({ status: 'committed', responseId: 'resp-1' });
  await tick();
  assert.deepEqual(typesOf(id), ['accepted', 'running', 'committed']);
  const seqs = events.map((event) => event.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b)
  );
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(events.at(-1)?.responseId, 'resp-1');
});

test('input during a running turn queues in order, and the next starts only when the first ended', async () => {
  // Bug: two turns run at once over one chat, or the second line overtakes the first.
  const { control, runs, typesOf } = rig();
  accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  const second = accepted(control.submit({ requestId: 'r2', text: 'two', attachments: [] }));
  const third = accepted(control.submit({ requestId: 'r3', text: 'three', attachments: [] }));
  await tick();
  assert.equal(runs.length, 1);
  assert.deepEqual(typesOf(second), ['accepted', 'queued']);
  runs[0]?.finish({ status: 'committed', responseId: 'x' });
  await tick();
  assert.deepEqual(
    runs.map((run) => run.turn.text),
    ['one', 'two']
  );
  runs[1]?.finish({ status: 'committed', responseId: 'y' });
  await tick();
  assert.equal(runs[2]?.turn.turnId, third);
});

test('the queue refuses past its capacity and keeps what it holds', async () => {
  // Bug: a held Enter grows the queue without end, or the refusal drops an accepted line.
  const { control } = rig(1);
  accepted(control.submit({ requestId: 'r1', text: 'running', attachments: [] }));
  await tick();
  accepted(control.submit({ requestId: 'r2', text: 'queued', attachments: [] }));
  const refused = control.submit({ requestId: 'r3', text: 'over', attachments: [] });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.status === 'refused' && refused.code, 'queue-full');
  assert.deepEqual(
    control.queued().map((turn) => turn.text),
    ['queued']
  );
});

test('the same request id resubmitted after a reconnect is the same turn, run once', async () => {
  // Bug: a resend on reconnect makes her answer the same line twice.
  const { control, runs } = rig();
  const first = accepted(control.submit({ requestId: 'r1', text: 'once', attachments: [] }));
  const again = accepted(control.submit({ requestId: 'r1', text: 'once', attachments: [] }));
  assert.equal(again, first);
  await tick();
  runs[0]?.finish({ status: 'committed', responseId: 'x' });
  await tick();
  assert.equal(accepted(control.submit({ requestId: 'r1', text: 'once', attachments: [] })), first);
  await tick();
  assert.equal(runs.length, 1);
});

test('a queued turn can be removed before dispatch, and not after', async () => {
  // Bug: a removal arrives after dispatch and the owner believes the turn was taken back.
  const { control, runs } = rig();
  const running = accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  accepted(control.submit({ requestId: 'r2', text: 'two', attachments: [] }));
  const removed = accepted(control.submit({ requestId: 'r3', text: 'three', attachments: [] }));
  await tick();
  assert.equal(control.remove(removed).status, 'ok');
  assert.equal(control.remove(running).status, 'too-late');
  assert.equal(control.remove('unknown').status, 'unknown');
  runs[0]?.finish({ status: 'committed', responseId: 'x' });
  await tick();
  assert.deepEqual(
    runs.map((run) => run.turn.text),
    ['one', 'two']
  );
});

test('attachments stay with a queued turn until it runs', async () => {
  // Bug: an image staged for a queued line is lost, or sent with the line before it.
  const { control, runs } = rig();
  const image = { id: 'a1', name: 'a.png', contentType: 'image/png', reference: 'ref', size: 8 };
  accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  accepted(control.submit({ requestId: 'r2', text: 'two', attachments: [image] }));
  await tick();
  assert.deepEqual(runs[0]?.turn.attachments, []);
  runs[0]?.finish({ status: 'committed', responseId: 'x' });
  await tick();
  assert.deepEqual(runs[1]?.turn.attachments, [image]);
});

test('cancelling a queued turn acknowledges at once and it never runs', async () => {
  // Bug: a cancelled line still reaches her because the queue only marks it.
  const { control, runs, typesOf } = rig();
  accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  const queued = accepted(control.submit({ requestId: 'r2', text: 'two', attachments: [] }));
  await tick();
  assert.equal(control.cancel(queued).status, 'cancelled');
  assert.equal(typesOf(queued).at(-1), 'cancelled');
  runs[0]?.finish({ status: 'committed', responseId: 'x' });
  await tick();
  assert.equal(runs.length, 1);
});

test('cancelling a running turn aborts its signal and stays running until the run really ended', async () => {
  // Bug: the client is told cancelled while the backend still generates and may yet commit.
  const { control, runs, typesOf } = rig();
  const id = accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  await tick();
  assert.equal(control.cancel(id).status, 'cancelling');
  assert.equal(runs[0]?.signal.aborted, true);
  assert.equal(typesOf(id).includes('cancelled'), false);
  runs[0]?.finish({ status: 'cancelled' });
  await tick();
  assert.equal(typesOf(id).at(-1), 'cancelled');
});

test('a run that committed despite the cancel reports committed', async () => {
  // Bug: a message she already sent is shown as cancelled, and the owner sends the line again.
  const { control, runs, typesOf } = rig();
  const id = accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  await tick();
  control.cancel(id);
  runs[0]?.finish({ status: 'committed', responseId: 'late' });
  await tick();
  assert.equal(typesOf(id).at(-1), 'committed');
  assert.equal(typesOf(id).includes('cancelled'), false);
});

test('a cancel after the commit, or of an unknown id, touches nothing and cannot reach a later turn', async () => {
  // Bug: a late acknowledgement of the old run aborts the turn that took its place.
  const { control, runs, typesOf } = rig();
  const first = accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  accepted(control.submit({ requestId: 'r2', text: 'two', attachments: [] }));
  await tick();
  runs[0]?.finish({ status: 'committed', responseId: 'x' });
  await tick();
  assert.equal(control.cancel(first).status, 'finished');
  assert.equal(control.cancel('unknown').status, 'unknown');
  assert.equal(runs[1]?.signal.aborted, false);
  assert.equal(typesOf(first).at(-1), 'committed');
});

test('a failed turn ends failed, and the queued one runs once with nothing rerun', async () => {
  // Bug: the failure retries the first line, or stalls the queue for good.
  const { control, runs, typesOf } = rig();
  const first = accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  accepted(control.submit({ requestId: 'r2', text: 'two', attachments: [] }));
  await tick();
  runs[0]?.finish({ status: 'failed', code: 'provider-down' });
  await tick();
  assert.equal(typesOf(first).at(-1), 'failed');
  assert.deepEqual(
    runs.map((run) => run.turn.text),
    ['one', 'two']
  );
});

test('a run that throws ends failed instead of stalling the queue', async () => {
  // Bug: one thrown error leaves the chat queued forever.
  const events: Array<TurnEvent> = [];
  let calls = 0;
  const control = createTurnControl({
    capacity: 3,
    newId: () => `t${(calls += 1)}`,
    now: () => 1000,
    emit: (event) => void events.push(event),
    run: () => Promise.reject(new Error('boom')),
  });
  accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  accepted(control.submit({ requestId: 'r2', text: 'two', attachments: [] }));
  await tick();
  await tick();
  assert.deepEqual(
    events.filter((event) => event.type === 'failed').map((event) => event.turnId),
    ['t1', 't2']
  );
  assert.equal(JSON.stringify(events).includes('boom'), false, 'an error message stays out of the events');
});

test('replay after a sequence returns what the client missed, in order and with no gap', async () => {
  // Bug: a reconnect loses the text that streamed while the link was down.
  const { control, events, runs } = rig();
  accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  await tick();
  runs[0]?.finish({ status: 'committed', responseId: 'x' });
  await tick();
  const cut = events[0]?.seq ?? 0;
  assert.deepEqual(control.replay(cut), events.slice(1));
  assert.deepEqual(control.replay(events.at(-1)?.seq ?? 0), []);
});

test('the control knows only its own turns: a watcher or task id is unknown to it', async () => {
  // Bug: a chat cancel ends the watcher or an errand because they share one controller.
  const { control, runs } = rig();
  const id = accepted(control.submit({ requestId: 'r1', text: 'one', attachments: [] }));
  await tick();
  control.cancel(id);
  assert.equal(control.cancel('watcher').status, 'unknown');
  assert.equal(control.cancel('task-1').status, 'unknown');
  runs[0]?.finish({ status: 'cancelled' });
});

test('the wire reader refuses an event or action without its turn id, and an unknown kind', () => {
  // Bug: a malformed acknowledgement reads as the cancel of whatever turn runs now.
  const event = { type: 'cancelled', turnId: 't1', seq: 4, at: 1000 };
  assert.deepEqual(readTurnEvent(event), { ok: true, event });
  assert.equal(readTurnEvent({ type: 'cancelled', seq: 4, at: 1000 }).ok, false);
  assert.equal(readTurnEvent({ type: 'cancelled', turnId: 't1', at: 1000 }).ok, false);
  assert.equal(readTurnEvent({ type: 'other', turnId: 't1', seq: 1, at: 1000 }).ok, false);
  assert.equal(readTurnEvent(null).ok, false);
  const action = { kind: 'turn.cancel', turnId: 't1' };
  assert.deepEqual(readTurnAction(action), { ok: true, action });
  assert.equal(readTurnAction({ kind: 'turn.cancel' }).ok, false);
  assert.equal(readTurnAction({ kind: 'errand.cancel', turnId: 't1' }).ok, false);
});

test('passes a think progress to the subscriber with its kind and detail', async () => {
  // Bug: the control drops or rewrites the kind of a step it does not know, and the row never sees the think.
  const { control, events, runs } = rig();
  const id = accepted(control.submit({ requestId: 'r1', text: 'hello', attachments: [] }));
  await tick();
  control.progress(id, { kind: 'think', name: 'think', detail: 'checking the list first' });
  runs[0]?.finish({ status: 'committed', responseId: 'resp-1' });
  await tick();
  const step = events.find((event) => event.type === 'progress');
  assert.equal(step?.kind, 'think');
  assert.equal(step?.detail, 'checking the list first');
});
