// cli/turn-state.ts: the client's picture of the turns, built only from the core's events; and the keys on the mounted chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTurn, emptyTurns, queuedTurns, reduceTurns, requestCancel, turnOf } from '../cli/turn-state.ts';
import type { ClientTurnEvent, TurnsState } from '../cli/turn-state.ts';
import { KEY, chatEnv, pause, withChat } from './fixtures/chat-rig.ts';

const fold = (events: ReadonlyArray<ClientTurnEvent>, start: TurnsState = emptyTurns()): TurnsState =>
  events.reduce(reduceTurns, start);

const AT = 1000;
const accepted = (turnId: string, seq: number): ClientTurnEvent => ({ type: 'accepted', turnId, seq, at: AT });
const running = (turnId: string, seq: number, streaming = true): ClientTurnEvent => ({
  type: 'running',
  turnId,
  seq,
  at: AT,
  streaming,
});
const text = (turnId: string, seq: number, chunk: string): ClientTurnEvent => ({
  type: 'text',
  turnId,
  seq,
  at: AT,
  text: chunk,
});

test('text chunks build in sequence order, and a replayed event adds nothing', () => {
  // Bug: a reconnect's replay doubles a sentence.
  const state = fold([
    accepted('t1', 1),
    running('t1', 2),
    text('t1', 3, 'one '),
    text('t1', 4, 'two'),
    text('t1', 3, 'one '),
    text('t1', 4, 'two'),
  ]);
  assert.equal(turnOf(state, 't1')?.text, 'one two');
});

test('the final response stands as the core sent it, with its identity', () => {
  // Bug: the client keeps the streamed draft, and the shown answer differs from what she sent.
  const state = fold([
    accepted('t1', 1),
    running('t1', 2),
    text('t1', 3, 'draft'),
    { type: 'committed', turnId: 't1', seq: 4, at: AT, responseId: 'resp-1', text: 'The  final\ntext ' },
  ]);
  const turn = turnOf(state, 't1');
  assert.equal(turn?.state, 'committed');
  assert.equal(turn?.responseId, 'resp-1');
  assert.equal(turn?.text, 'The  final\ntext ');
  assert.equal(activeTurn(state), null);
});

test('a route without streaming shows no text until the final one', () => {
  // Bug: a progress bar of synthesized words pretends the model is streaming.
  const state = fold([accepted('t1', 1), running('t1', 2, false)]);
  assert.equal(turnOf(state, 't1')?.streaming, false);
  assert.equal(turnOf(state, 't1')?.text, '');
});

test('tool and task progress keep their order on the turn', () => {
  // Bug: the running tool shown is the first ever, or progress of a finished turn reappears.
  const state = fold([
    accepted('t1', 1),
    running('t1', 2),
    { type: 'progress', turnId: 't1', seq: 3, at: AT, kind: 'tool', name: 'search', detail: 'started' },
    { type: 'progress', turnId: 't1', seq: 4, at: AT, kind: 'tool', name: 'search', detail: 'done' },
    { type: 'progress', turnId: 't1', seq: 5, at: AT, kind: 'task', name: 'errand', detail: 'running' },
  ]);
  assert.deepEqual(
    turnOf(state, 't1')?.progress.map((one) => one.detail),
    ['started', 'done', 'running']
  );
});

test('asking to cancel changes nothing but the mark: only the core says a turn has stopped', () => {
  // Bug: the client draws cancelled while the backend still runs.
  const before = fold([accepted('t1', 1), running('t1', 2)]);
  const asked = requestCancel(before, 't1');
  assert.equal(turnOf(asked, 't1')?.state, 'running');
  assert.equal(turnOf(asked, 't1')?.cancelRequested, true);
  const ended = reduceTurns(asked, { type: 'cancelled', turnId: 't1', seq: 3, at: AT });
  assert.equal(turnOf(ended, 't1')?.state, 'cancelled');
  assert.equal(activeTurn(ended), null);
});

test('an acknowledgement for an old turn leaves the running one alone', () => {
  // Bug: the late ack of the first turn marks the second as stopped.
  const state = fold([
    accepted('t1', 1),
    running('t1', 2),
    { type: 'committed', turnId: 't1', seq: 3, at: AT, responseId: 'x', text: 'done' },
    accepted('t2', 4),
    running('t2', 5),
    { type: 'cancelled', turnId: 't1', seq: 6, at: AT },
  ]);
  assert.equal(activeTurn(state)?.turnId, 't2');
  assert.equal(turnOf(state, 't1')?.state, 'committed', 'a terminal state is final');
  assert.equal(requestCancel(state, 'unknown'), state);
});

test('the queue shows in core order, and a failure of the turn before it leaves it queued', () => {
  // Bug: the client drops the queued lines when the turn before them fails.
  const state = fold([
    accepted('t1', 1),
    running('t1', 2),
    accepted('t2', 3),
    { type: 'queued', turnId: 't2', seq: 4, at: AT },
    accepted('t3', 5),
    { type: 'queued', turnId: 't3', seq: 6, at: AT },
    { type: 'failed', turnId: 't1', seq: 7, at: AT, code: 'provider-down' },
  ]);
  assert.deepEqual(
    queuedTurns(state).map((turn) => turn.turnId),
    ['t2', 't3']
  );
});

test('no events means no active turn and an empty queue', () => {
  // Bug: a fresh chat offers a cancel of nothing.
  assert.equal(activeTurn(emptyTurns()), null);
  assert.deepEqual(queuedTurns(emptyTurns()), []);
});

function turnChat() {
  const cancels: Array<string> = [];
  const rig = chatEnv({ cancelTurn: (turnId) => void cancels.push(turnId) });
  const event = (one: ClientTurnEvent): void => rig.listeners.turn?.(one);
  return { ...rig, cancels, event };
}

test('Escape with text clears only the draft, and the running turn goes on', async () => {
  // Bug: clearing a typo cancels her reply.
  const { env, cancels, event } = turnChat();
  await withChat(env, async (rig) => {
    event(accepted('t1', 1));
    event(running('t1', 2));
    await pause();
    rig.type('a typo');
    await pause();
    rig.type(KEY.escape);
    await pause();
    assert.equal(rig.screen().join('\n').includes('a typo'), false);
  });
  assert.deepEqual(cancels, []);
});

test('Escape on an empty draft asks the core once, and the chat shows running until the acknowledgement', async () => {
  // Bug: double Escape sends two cancels, the second reaching the next turn; or the chat claims it stopped.
  const { env, cancels, event } = turnChat();
  await withChat(env, async (rig) => {
    event(accepted('t1', 1));
    event(running('t1', 2));
    await pause();
    const runningScreen = rig.screen().join('\n');
    rig.type(KEY.escape);
    await pause(60);
    rig.type(KEY.escape);
    await pause(60);
    assert.deepEqual(cancels, ['t1']);
    assert.notEqual(rig.screen().join('\n'), runningScreen, 'the request shows');
    event({ type: 'cancelled', turnId: 't1', seq: 3, at: AT });
    await pause();
    rig.type(KEY.escape);
    await pause(60);
    assert.deepEqual(cancels, ['t1'], 'nothing runs, nothing to cancel');
  });
});

test('with no turn running Escape asks nothing of the core', async () => {
  // Bug: a stray Escape sends a cancel for a turn that ended long ago.
  const { env, cancels } = turnChat();
  await withChat(env, async (rig) => {
    rig.type(KEY.escape);
    await pause(60);
  });
  assert.deepEqual(cancels, []);
});

test('leaving the chat does not cancel the running turn', async () => {
  // Bug: closing the terminal aborts her reply.
  const { env, cancels, event } = turnChat();
  await withChat(env, async () => {
    event(accepted('t1', 1));
    event(running('t1', 2));
    await pause();
  });
  assert.deepEqual(cancels, []);
});

test('a line sent during a turn goes to the core, and shows as queued once the core says so', async () => {
  // Bug: the client holds the line itself and it is lost on disconnect, or it shows as sent to her.
  const { env, sent, event } = turnChat();
  await withChat(env, async (rig) => {
    event(accepted('t1', 1));
    event(running('t1', 2));
    await pause();
    rig.type('next line');
    await pause();
    rig.type(KEY.enter);
    await pause();
    rig.type(KEY.enter);
    await pause();
    assert.deepEqual(sent, ['next line'], 'a second Enter on the empty draft sends nothing');
    const before = rig.screen().join('\n');
    event({ type: 'accepted', turnId: 't2', seq: 3, at: AT, text: 'next line' });
    event({ type: 'queued', turnId: 't2', seq: 4, at: AT });
    await pause();
    assert.notEqual(rig.screen().join('\n'), before, 'the queue shows');
  });
});

test('a lost link says so, and the turn state stays what the core last said until the replay', async () => {
  // Bug: a disconnect clears the running turn, and a replay then duplicates its text.
  const { env, event, listeners } = turnChat();
  await withChat(env, async (rig) => {
    event(accepted('t1', 1));
    event(running('t1', 2));
    event(text('t1', 3, 'partial-words'));
    await pause();
    listeners.connected?.(false);
    await pause();
    assert.match(rig.screen().join('\n'), /partial-words/);
    listeners.connected?.(true);
    event(text('t1', 3, 'partial-words'));
    event(text('t1', 4, ' and-more'));
    await pause();
    const shown = rig.screen().join('\n');
    assert.equal(shown.split('partial-words').length - 1, 1);
    assert.match(shown, /and-more/);
  });
});
