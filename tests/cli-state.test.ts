// cli/state.ts and cli/galaxy.ts: the chat's behaviour without a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galaxyFrame, reducedMotion } from '../cli/galaxy.ts';
import {
  backspace,
  browse,
  emptyInput,
  filterLines,
  foldedText,
  insert,
  menuOf,
  moveCursor,
  statusLine,
  submit,
} from '../cli/state.ts';
import type { StatusBrief } from '../cli/state.ts';

const BRIEF: StatusBrief = {
  core: { state: 'paused', reason: 'memory-down', model: 'opus', route: 'claude-harness', bound: true },
  memory: { session: 'apply', model: 'opus', route: 'claude-harness', bound: true, probe: 'failed', checkedAt: 1000 },
  analyzer: { model: 'opus', route: 'direct-api', bound: true },
  interfaces: [
    { name: 'discord', enabled: true, connected: false },
    { name: 'telegram', enabled: false, connected: false },
  ],
};

/** All of it working: the core runs, memory writes, the analyzer has its key, Discord is connected. */
const HEALTHY: StatusBrief = {
  core: { state: 'running', reason: null, model: 'anthropic/claude-opus-4.6', route: 'claude-harness', bound: true },
  memory: {
    session: 'apply',
    model: 'claude-opus-4-6',
    route: 'claude-harness',
    bound: true,
    probe: 'ok',
    checkedAt: 1000,
  },
  analyzer: { model: 'google/gemini-3-flash', route: 'direct-api', bound: true },
  interfaces: [{ name: 'discord', enabled: true, connected: true }],
};

const header = (brief: StatusBrief): Array<string> =>
  statusLine(brief, { connected: true, polledAt: 1000, now: 2000 }).split('\n');
/** The state word of the line that starts with `label`. */
const stateOf = (lines: ReadonlyArray<string>, label: string): string | undefined =>
  lines
    .find((line) => line.startsWith(`${label}: `))
    ?.slice(label.length + 2)
    .split(/[ ·(]/)[0];

test('a multiline paste with non-Latin text stays whole and backspace removes one whole character', () => {
  // Bug: a pasted newline sends the line early, or backspace cuts an emoji in half.
  const pasted = insert(emptyInput(), 'γεια\nσου 🙂');
  assert.equal(pasted.text, 'γεια\nσου 🙂');
  assert.equal(backspace(pasted).text, 'γεια\nσου ');
  const left = moveCursor(pasted, -1);
  assert.equal(left.cursor, pasted.text.length - 2);
  assert.equal(insert(left, 'x').text, 'γεια\nσου x🙂');
});

test('history comes back newest first, and a secret never enters it', () => {
  // Bug: a typed key lands in the history file, or up and down walk the wrong way.
  let state = insert(emptyInput(['two', 'one']), 'three');
  const sent = submit(state, { secret: false });
  assert.deepEqual(sent.next.history, ['three', 'two', 'one']);
  state = browse(sent.next, -1);
  assert.equal(state.text, 'three');
  state = browse(browse(state, -1), 1);
  assert.equal(state.text, 'three');
  assert.equal(browse(state, 1).text, '');
  const secret = submit(insert(emptyInput(['two']), 'sk-or-secret'), { secret: true });
  assert.equal(secret.line, 'sk-or-secret');
  assert.deepEqual(secret.next.history, ['two']);
});

test('the slash menu completes nested commands and leaves arguments alone', () => {
  // Bug: the menu stays open over an argument, or finds nothing for a word of a command's description.
  const commands = [
    { name: 'status', help: 'the short summary' },
    { name: 'keys', help: 'the model keys' },
    { name: 'skills', help: 'her status of skills' },
  ];
  assert.deepEqual(
    menuOf('/s', commands).map((one) => one.name),
    ['status', 'skills', 'keys']
  );
  assert.deepEqual(menuOf('/status x', commands), []);
  assert.deepEqual(
    menuOf('/skills se', [{ name: 'skills setup', help: 'configure a skill' }]).map((one) => one.name),
    ['skills setup']
  );
  assert.deepEqual(menuOf('hello', commands), []);
});

test('a long answer folds with a count and expands whole', () => {
  // Bug: a long report pushes the whole chat off the screen, or the folded part cannot be reached.
  const text = Array.from({ length: 25 }, (_, i) => `l${i}`).join('\n');
  assert.equal(foldedText(text, false).hidden, 5);
  assert.equal(foldedText(text, true).text, text);
  assert.deepEqual(filterLines(['a key', 'b'], 'KEY'), ['a key']);
});

test('the header gives one line per role with its state, its model once and its route', () => {
  // Bug: the memory line names the model twice (the role's and the harness's) and runs past the width, and the core's and
  // the analyzer's models and routes are nowhere on the screen. The owner's header of 2026-11-08 replaced the old lines
  // (`Memory: ready · <model> · <path>`), so the expectations of the earlier test changed with it.
  const lines = header(HEALTHY);
  assert.deepEqual(
    lines.map((line) => line.split(':')[0]),
    ['Core', 'Memory', 'Analyzer', 'Interfaces']
  );
  const memory = lines[1] ?? '';
  assert.equal(memory.split('claude-opus-4-6').length - 1, 1, 'the model the route runs, once');
  assert.ok(!memory.includes('anthropic/claude-opus-4.6'), 'no second model name');
  assert.ok(memory.endsWith('claude-harness'), memory);
  assert.ok((lines[0] ?? '').includes('anthropic/claude-opus-4.6') && (lines[0] ?? '').endsWith('claude-harness'));
  assert.ok((lines[2] ?? '').includes('google/gemini-3-flash') && (lines[2] ?? '').endsWith('direct-api'));
});

test('one state word means the same on every line of the header', () => {
  // Bug: a running core reads `running`, a working memory `ready` and a connected interface `connected`, so the owner
  // cannot tell at a glance that everything works; or a broken part reads like a working one.
  const lines = header(HEALTHY);
  const working = ['Core', 'Memory', 'Analyzer'].map((label) => stateOf(lines, label));
  assert.equal(new Set(working).size, 1, working.join(' '));
  assert.match(lines[3] ?? '', new RegExp(`^Interfaces: Discord \\(${working[0] ?? ''}\\)$`));
  const broken = header(BRIEF);
  // A failed memory probe and a disconnected interface are the same fact: something that should work does not.
  assert.equal(stateOf(broken, 'Memory'), /\((\w+)\)$/.exec(broken[3] ?? '')?.[1]);
  assert.notEqual(stateOf(broken, 'Memory'), working[0]);
  assert.match(broken[0] ?? '', /\(memory-down\)/, 'a pause keeps its reason');
  assert.notEqual(stateOf(broken, 'Core'), working[0]);
  assert.doesNotMatch(broken.join('\n'), /telegram/i, 'only enabled interfaces');
});

test('a role with no key, a memory session that is off and an analyzer without a model each read as not working', () => {
  // Bug: a role whose direct route has no key shows as working, and her turns or sweeps fail with nothing on the screen.
  const active = stateOf(header(HEALTHY), 'Core');
  const unbound = header({ ...HEALTHY, analyzer: { ...HEALTHY.analyzer, bound: false } });
  assert.notEqual(stateOf(unbound, 'Analyzer'), active);
  const off = header({ ...HEALTHY, memory: { ...HEALTHY.memory, session: 'off' } });
  assert.notEqual(stateOf(off, 'Memory'), active);
  assert.notEqual(stateOf(off, 'Memory'), stateOf(unbound, 'Analyzer'), 'off and without a key are different facts');
  const noModel = header({ ...HEALTHY, analyzer: { ...HEALTHY.analyzer, model: null } });
  assert.equal(stateOf(noModel, 'Analyzer'), stateOf(off, 'Memory'), 'a role that does not run is off on every line');
});

test('a lost link or an old poll says so on every line', () => {
  // Bug: a dropped connection or an old poll still reads as healthy.
  const stale = statusLine(HEALTHY, { connected: true, polledAt: 1000, now: 100_000 }).split('\n');
  assert.equal(stale.filter((line) => line.endsWith(' (outdated)')).length, 4);
  const lost = statusLine(HEALTHY, { connected: false, polledAt: 1000, now: 2000 }).split('\n');
  assert.equal(lost.length, 4);
  assert.equal(new Set(lost.map((line) => line.split(': ')[1])).size, 1, 'nothing known, the same word on each line');
  assert.notEqual(stateOf(lost, 'Core'), stateOf(header(HEALTHY), 'Core'));
});

test('the galaxy turns tick by tick, repeats, and stands still under reduced motion', () => {
  // Bug: frames change size and flicker the input below them, or motion ignores the owner's setting.
  const first = galaxyFrame(0);
  assert.equal(first.length, 5);
  assert.ok(first.every((row) => row.length === 13));
  assert.notDeepEqual(galaxyFrame(1), first);
  assert.deepEqual(galaxyFrame(24), first);
  assert.equal(reducedMotion({ NEPTUNIA_REDUCED_MOTION: '1' }), true);
  assert.equal(reducedMotion({ TERM: 'xterm' }), false);
});
