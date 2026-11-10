// The think of her running turn on the command line's status row: `latestThink` in interfaces/cli/turn-state.ts reads it from
// the turn's progress, and the chat's status row shows it after the call names until the turn ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callsInProgress, emptyTurns, latestThink, reduceTurns, turnOf } from '../interfaces/cli/turn-state.ts';
import type { ClientTurnEvent, TurnsState } from '../interfaces/cli/turn-state.ts';
import { chatEnv, shows, until, withChat } from './fixtures/chat-rig.ts';

const AT = 1000;
const fold = (events: ReadonlyArray<ClientTurnEvent>): TurnsState => events.reduce(reduceTurns, emptyTurns());
const accepted: ClientTurnEvent = { type: 'accepted', turnId: 't1', seq: 1, at: AT };
const running: ClientTurnEvent = { type: 'running', turnId: 't1', seq: 2, at: AT, streaming: false };
const think = (seq: number, detail: string): ClientTurnEvent => ({
  type: 'progress',
  turnId: 't1',
  seq,
  at: AT,
  kind: 'think',
  name: 'think',
  detail,
});
const call = (seq: number, name: string, detail: string): ClientTurnEvent => ({
  type: 'progress',
  turnId: 't1',
  seq,
  at: AT,
  kind: 'tool',
  name,
  detail,
});

test('returns the newest think of a turn that got two', () => {
  // Bug: the row keeps showing the first reason after she moved on to the next step.
  const turn = turnOf(fold([accepted, running, think(3, 'first reason'), think(4, 'second reason')]), 't1');
  assert.ok(turn);
  assert.equal(latestThink(turn), 'second reason');
});

test('returns null for a turn with call progress only', () => {
  // Bug: a call's step word shows as her thinking.
  const turn = turnOf(fold([accepted, running, call(3, 'lore.list', 'started'), call(4, 'lore.list', 'ok')]), 't1');
  assert.ok(turn);
  assert.equal(latestThink(turn), null);
});

test('keeps a think out of the calls in progress', () => {
  // Bug: the think's text counts as an open call and shows as "using think".
  const turn = turnOf(fold([accepted, running, think(3, 'why'), call(4, 'lore.list', 'started')]), 't1');
  assert.ok(turn);
  assert.deepEqual(callsInProgress(turn), ['lore.list']);
});

test('the status row shows the think after the call names while the turn runs, and neither once it committed', async () => {
  // Bug: the think stays on the row after the answer, or never shows.
  const { env, listeners } = chatEnv();
  const event = (one: ClientTurnEvent): void => listeners.turn?.(one);
  await withChat(env, async (rig) => {
    event(accepted);
    event(running);
    event(call(3, 'lore.list', 'started'));
    event(think(4, 'checking the lore before I answer'));
    await until(shows(rig, 'checking the lore before I answer'));
    const row = rig.screen().join('\n');
    assert.ok(row.includes('using lore.list'), 'the call names are still there');
    assert.ok(row.indexOf('using lore.list') < row.indexOf('checking the lore'), 'the think follows the names');
    event({ type: 'committed', turnId: 't1', seq: 5, at: AT, text: 'done' });
    await until(() => !shows(rig, 'checking the lore')());
    assert.equal(shows(rig, 'using lore.list')(), false);
  });
});
