// The selector's pure reducer (interfaces/cli/selector.ts): it owns the selected stable id, the query, the loading state, the overlay
// id and the generation, so a result that belongs to a closed or replaced overlay is refused by its identifiers. Browsing
// has no effect, and a commit leaves as one effect carrying the row's original value. `SelectorView` draws the states
// through Ink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';
import {
  SelectorView,
  closedSelector,
  selectorReduce,
  selectorViewport,
  visibleRows,
} from '../interfaces/cli/selector.ts';
import type { SelectorEffect, SelectorEvent, SelectorRow, SelectorState } from '../interfaces/cli/selector.ts';

const row = (id: string, over: Partial<SelectorRow> = {}): SelectorRow => ({
  id,
  label: id,
  value: `value of ${id}`,
  ...over,
});
const ROWS = [row('alpha'), row('bravo'), row('charlie')];

/** Runs `events` from `from`, collecting every effect. */
function play(
  from: SelectorState,
  events: ReadonlyArray<SelectorEvent>
): { state: SelectorState; effects: Array<SelectorEffect> } {
  let state = from;
  const effects: Array<SelectorEffect> = [];
  for (const event of events) {
    const step = selectorReduce(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const opened = (overlayId = 'o1', rows: ReadonlyArray<SelectorRow> = ROWS): SelectorState => {
  const open = play(closedSelector, [{ kind: 'open', overlayId }]);
  return play(open.state, [{ kind: 'loaded', overlayId, generation: open.state.generation, rows }]).state;
};
const moves = (delta: 1 | -1, count: number): Array<SelectorEvent> =>
  Array.from({ length: count }, () => ({ kind: 'move', delta }));
const commits = (effects: ReadonlyArray<SelectorEffect>): Array<string> =>
  effects.flatMap((one) => (one.kind === 'commit' ? [one.rowId] : []));
const ids = (state: SelectorState): Array<string> => visibleRows(state).map((one) => one.id);

test('opening an overlay loads it under a new generation and asks for its rows once', () => {
  // Catches: a reopened overlay sharing the old generation, so the previous load's answer is taken for the new one.
  const first = play(closedSelector, [{ kind: 'open', overlayId: 'o1' }]);
  assert.equal(first.state.status, 'loading');
  assert.deepEqual(first.effects, [{ kind: 'load', overlayId: 'o1', generation: first.state.generation }]);
  const second = play(first.state, [{ kind: 'open', overlayId: 'o1' }]);
  assert.ok(second.state.generation > first.state.generation);
});

test('a result of selector A arriving after B replaced it leaves B and commits nothing', () => {
  // Catches: the slow answer of a closed menu drawing its rows over the menu the owner is reading.
  const a = play(closedSelector, [{ kind: 'open', overlayId: 'a' }]);
  const b = play(a.state, [{ kind: 'open', overlayId: 'b' }]);
  const shown = play(b.state, [
    { kind: 'loaded', overlayId: 'b', generation: b.state.generation, rows: [row('bee')] },
  ]).state;
  const late = play(shown, [{ kind: 'loaded', overlayId: 'a', generation: a.state.generation, rows: [row('ant')] }]);
  assert.equal(late.state.overlayId, 'b');
  assert.equal(late.state.selectedId, 'bee');
  assert.deepEqual(ids(late.state), ['bee']);
  assert.deepEqual(late.effects, []);
});

test('the same overlay id with an older generation is refused too', () => {
  // Catches: a stale check keyed by overlay id alone, which a reopened menu of one command passes.
  const first = play(closedSelector, [{ kind: 'open', overlayId: 'o1' }]);
  const again = play(first.state, [{ kind: 'open', overlayId: 'o1' }]);
  const late = play(again.state, [
    { kind: 'loaded', overlayId: 'o1', generation: first.state.generation, rows: [row('old')] },
  ]);
  assert.equal(late.state.status, 'loading');
  assert.deepEqual(ids(late.state), []);
});

test('a closed overlay ignores a late load, a late failure and a late apply', () => {
  // Catches: a result reopening or repainting an overlay the owner already left.
  const shown = opened();
  const closed = play(shown, [{ kind: 'close' }]).state;
  const { overlayId, generation } = shown;
  const late = play(closed, [
    { kind: 'loaded', overlayId, generation, rows: [row('late')] },
    { kind: 'failed', overlayId, generation, error: 'late' },
    { kind: 'applied', overlayId, generation, ok: true },
  ]);
  assert.equal(late.state.status, 'closed');
  assert.equal(late.state.error, null);
  assert.deepEqual(late.effects, []);
});

test('double Enter commits the selected row once, with its original value', () => {
  // Catches: the key repeat that saves twice, or a commit that sends the label instead of the stable value.
  const { state, effects } = play(opened(), [{ kind: 'move', delta: 1 }, { kind: 'enter' }, { kind: 'enter' }]);
  assert.equal(state.pending, true);
  assert.deepEqual(effects, [
    { kind: 'commit', overlayId: 'o1', generation: state.generation, rowId: 'bravo', value: 'value of bravo' },
  ]);
});

test('Enter on an empty list commits nothing and shows the empty state', () => {
  // Catches: a placeholder row answering the question.
  const { state, effects } = play(opened('o1', []), [{ kind: 'enter' }]);
  assert.equal(state.status, 'empty');
  assert.equal(state.selectedId, null);
  assert.deepEqual(effects, []);
});

test('Enter on a filter that matches nothing commits nothing', () => {
  // Catches: the row hidden by the filter still being the selection, and committing unseen.
  const { state, effects } = play(opened(), [{ kind: 'filter', query: 'zzz' }, { kind: 'enter' }]);
  assert.equal(state.selectedId, null);
  assert.deepEqual(effects, []);
});

test('a disabled row can be read but Enter does not commit it', () => {
  // Catches: an unavailable source chosen by Enter, or a reason nobody can reach with the arrows.
  const rows = [row('off', { disabled: 'not logged in' }), row('on')];
  const atOff = play(opened('o1', rows), [{ kind: 'enter' }]);
  assert.equal(atOff.state.selectedId, 'off');
  assert.equal(atOff.state.pending, false);
  assert.deepEqual(atOff.effects, []);
  const atOn = play(atOff.state, [{ kind: 'move', delta: 1 }, { kind: 'enter' }]);
  assert.deepEqual(commits(atOn.effects), ['on']);
});

test('a failed apply keeps the overlay and the selection, and Enter retries once', () => {
  // Catches: a failed save closing the menu as if it worked, or the pending flag staying set so retry is dead.
  const pending = play(opened(), [{ kind: 'move', delta: 1 }, { kind: 'enter' }]).state;
  const failed = play(pending, [
    { kind: 'applied', overlayId: 'o1', generation: pending.generation, ok: false, error: 'refused' },
  ]).state;
  assert.equal(failed.status, 'ready');
  assert.equal(failed.pending, false);
  assert.equal(failed.selectedId, 'bravo');
  assert.equal(failed.error, 'refused');
  assert.deepEqual(commits(play(failed, [{ kind: 'enter' }]).effects), ['bravo']);
});

test('a successful apply closes the overlay', () => {
  // Catches: a saved choice leaving the menu holding the keys.
  const pending = play(opened(), [{ kind: 'enter' }]).state;
  const done = play(pending, [{ kind: 'applied', overlayId: 'o1', generation: pending.generation, ok: true }]);
  assert.equal(done.state.status, 'closed');
});

test('a failed load offers a retry under a new generation, and the old failure cannot undo it', () => {
  // Catches: the second copy of a failure arriving after the retry and hiding the loading state.
  const open = play(closedSelector, [{ kind: 'open', overlayId: 'o1' }]).state;
  const old = open.generation;
  const failed = play(open, [{ kind: 'failed', overlayId: 'o1', generation: old, error: 'no answer' }]).state;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'no answer');
  const retried = play(failed, [{ kind: 'retry' }]);
  assert.ok(retried.state.generation > old);
  assert.deepEqual(retried.effects, [{ kind: 'load', overlayId: 'o1', generation: retried.state.generation }]);
  const late = play(retried.state, [{ kind: 'failed', overlayId: 'o1', generation: old, error: 'no answer' }]);
  assert.equal(late.state.status, 'loading');
});

test('an updated list keeps the selection on its stable id, not its position', () => {
  // Catches: a refresh that reorders rows and silently moves the selection to another model.
  const at = play(opened(), [{ kind: 'move', delta: 1 }]).state;
  const refreshed = play(at, [
    { kind: 'loaded', overlayId: 'o1', generation: at.generation, rows: [row('new'), row('charlie'), row('bravo')] },
  ]).state;
  assert.equal(refreshed.selectedId, 'bravo');
});

test('a filter keeps a selection it still shows and moves off one it hides', () => {
  // Catches: Enter after typing committing a row that has left the screen.
  const at = play(opened(), [{ kind: 'move', delta: 1 }]).state;
  assert.equal(play(at, [{ kind: 'filter', query: 'bra' }]).state.selectedId, 'bravo');
  const hidden = play(at, [{ kind: 'filter', query: 'char' }]).state;
  assert.equal(hidden.selectedId, 'charlie');
  assert.deepEqual(ids(hidden), ['charlie']);
});

test('moving and filtering produce no effect at all', () => {
  // Catches: a setting applied while the owner is still browsing.
  const { effects } = play(opened(), [
    { kind: 'move', delta: 1 },
    { kind: 'filter', query: 'c' },
    { kind: 'filter', query: '' },
    { kind: 'move', delta: -1 },
  ]);
  assert.deepEqual(effects, []);
});

test('moving past either end stays on a row', () => {
  // Catches: a selection index running off the list, so Enter finds nothing.
  assert.equal(play(opened(), moves(-1, 1)).state.selectedId, 'alpha');
  assert.equal(play(opened(), moves(1, 9)).state.selectedId, 'charlie');
});

test('a shorter terminal keeps the selected row inside the viewport', () => {
  // Catches: a resize hiding the row Enter would commit.
  const many = Array.from({ length: 30 }, (_, index) => row(`r${index}`));
  const at = play(opened('o1', many), moves(1, 20)).state;
  assert.equal(at.selectedId, 'r20');
  for (const height of [12, 5, 1]) {
    const view = selectorViewport(at, height);
    assert.ok(view.rows.length <= height, `height ${height}`);
    assert.ok(
      view.rows.some((one) => one.id === 'r20'),
      `height ${height}`
    );
  }
  assert.ok(
    selectorViewport(at, 0).rows.some((one) => one.id === 'r20'),
    'a height of nothing still shows the selection'
  );
});

// What it draws

function drawn(state: SelectorState, height = 10): string {
  let last = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        const visible = stripVTControlCharacters(String(chunk));
        if (visible.trim() !== '') last = visible;
        done();
      },
    }),
    { columns: 80, rows: 24 }
  );
  const app = render(createElement(SelectorView, { state, height }), {
    stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  app.unmount();
  return last;
}

test('a row shows its name, the selected row its description, and the current value is marked', () => {
  // Catches: raw ids on the screen, or nothing telling which model is in force now.
  const text = drawn(
    opened('o1', [
      { id: 'a', label: 'Readable alpha', value: 'a', detail: 'what alpha does', current: 'in force now' },
      { id: 'b', label: 'Readable bravo', value: 'b' },
    ])
  );
  for (const part of ['Readable alpha', 'Readable bravo', 'what alpha does', 'in force now'])
    assert.ok(text.includes(part), `${part} in ${text}`);
});

test('a disabled row draws the reason it was given', () => {
  // Catches: an unavailable row that looks like the others, or vanishes with its setup hint.
  const text = drawn(opened('o1', [row('a', { disabled: 'run the login command first' })]));
  assert.ok(text.includes('run the login command first'), text);
});

test('the failed state draws its error, and empty differs from loading', () => {
  // Catches: a failure and an empty list looking alike, so the owner cannot tell whether to retry.
  const open = play(closedSelector, [{ kind: 'open', overlayId: 'o1' }]).state;
  const failed = play(open, [
    { kind: 'failed', overlayId: 'o1', generation: open.generation, error: 'the listing did not answer' },
  ]).state;
  assert.ok(drawn(failed).includes('the listing did not answer'));
  const empty = drawn(opened('o1', []));
  assert.notEqual(empty.trim(), '');
  assert.notEqual(empty, drawn(open));
});
