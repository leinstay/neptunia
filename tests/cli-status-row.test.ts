// The mounted chat's fixed rows around the input: the status row under it that holds every short notice, the slash menu's
// rule and blank row above it, and the header's line of interfaces. Measured in the frame the chat wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, press, shows, until, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';
import type { ClientTurnEvent } from '../cli/turn-state.ts';
import type { StatusBrief } from '../cli/state.ts';

const AT = 1000;
const ROWS = 24;

/** The zero-based screen row of the input box's lower border. */
const lowerBorder = (rig: Rig): number => rig.screen().findLastIndex((line) => /^\s*╰─+╯\s*$/.test(line));
/** The zero-based screen row of the input box's upper border. */
const upperBorder = (rig: Rig): number => rig.screen().findLastIndex((line) => /^\s*╭─+╮\s*$/.test(line));
/** Everything drawn above the input box. */
const aboveInput = (rig: Rig): string => rig.screen().slice(0, upperBorder(rig)).join('\n');

test('the status row under the input is always there, blank when nothing is said, and the input never moves', async () => {
  // Bug: a notice or her running turn takes a row above the input, so the input and the transcript jump by one row each
  // time a notice comes or goes.
  const rig = chatEnv();
  const event = (one: ClientTurnEvent): void => rig.listeners.turn?.(one);
  await withChat(rig.env, async (screen) => {
    await until(() => lowerBorder(screen) >= 0);
    assert.equal(lowerBorder(screen), ROWS - 2, 'one row stands under the input');
    assert.equal((screen.screen()[ROWS - 1] ?? '').trim(), '', 'the status row is blank with nothing to say');
    await press(screen, KEY.ctrlV, shows(screen, 'Images are not available'));
    assert.equal(lowerBorder(screen), ROWS - 2, 'a notice leaves the input where it was');
    assert.match(screen.screen()[ROWS - 1] ?? '', /Images are not available/);
    assert.ok(!aboveInput(screen).includes('Images are not available'), 'no notice above the input');
    await press(screen, 'x', () => !screen.screen().join('\n').includes('Images are not available'));
    event({ type: 'accepted', turnId: 't1', seq: 1, at: AT });
    event({ type: 'running', turnId: 't1', seq: 2, at: AT, streaming: false });
    await until(shows(screen, 'Her turn is running'));
    assert.equal(lowerBorder(screen), ROWS - 2, 'her running turn leaves the input where it was');
    assert.match(screen.screen()[ROWS - 1] ?? '', /Her turn is running/);
  });
});

test('the calls of her running turn show on the status row and not above the input', async () => {
  // Bug: `using <tool>` takes a row between the transcript and the input and pushes the chat up while she works.
  const rig = chatEnv();
  const event = (one: ClientTurnEvent): void => rig.listeners.turn?.(one);
  await withChat(rig.env, async (screen) => {
    event({ type: 'accepted', turnId: 't1', seq: 1, at: AT });
    event({ type: 'running', turnId: 't1', seq: 2, at: AT, streaming: false });
    event({
      type: 'progress',
      turnId: 't1',
      seq: 3,
      at: AT,
      kind: 'tool',
      name: 'conversation.read',
      detail: 'started',
    });
    await until(shows(screen, 'using conversation.read'));
    assert.match(screen.screen().at(-1) ?? '', /using conversation\.read/);
    assert.ok(!aboveInput(screen).includes('using'), 'nothing of the turn above the input');
  });
});

const OSC52 = '\u001b]52;c;';

test('the copy notice of a mouse selection shows on the status row and not above the input', async () => {
  // Bug: `copied N chars to clipboard` takes a row above the input, so the selected rows jump as the copy lands.
  const { env, entry } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'alpha beta gamma' });
    await until(shows(rig, 'alpha beta gamma'));
    const screen = rig.screen();
    const row = screen.findIndex((line) => line.includes('alpha'));
    const column = (screen[row] ?? '').indexOf('alpha') + 1;
    rig.type(`\u001b[<0;${column};${row + 1}M`);
    rig.type(`\u001b[<32;${column + 9};${row + 1}M`);
    rig.type(`\u001b[<0;${column + 9};${row + 1}m`);
    await until(shows(rig, 'copied 10 chars to clipboard'));
    const copiedScreen = rig.screen();
    const above = aboveInput(rig);
    const border = lowerBorder(rig);
    // A key drops the selection first, so a failed assertion still lets Ctrl+C close the chat instead of copying again.
    await press(rig, KEY.escape, () => !rig.screen().join('\n').includes('copied'));
    assert.ok(rig.frames().includes(OSC52), 'the copy reached the terminal');
    assert.match(copiedScreen.at(-1) ?? '', /copied 10 chars to clipboard/);
    assert.ok(!above.includes('copied'), 'no notice above the input');
    assert.equal(border, ROWS - 2);
  });
});

test('the slash menu stands under a rule with a blank row between it and the last chat line', async () => {
  // Bug: the menu opens right under the newest message, so its first command reads as part of her line.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'the newest line of hers' });
    await until(shows(rig, 'the newest line of hers'));
    await press(rig, '/', shows(rig, '/status'));
    const screen = rig.screen();
    const rule = screen.findIndex((line) => /^─{20,}$/.test(line.trim()));
    assert.ok(rule > 1, `a rule above the menu:\n${screen.join('\n')}`);
    assert.match(screen[rule + 1] ?? '', /\/status/, 'the menu starts under the rule');
    assert.equal((screen[rule - 1] ?? '').trim(), '', 'one blank row above the rule');
    assert.match(screen[rule - 2] ?? '', /the newest line of hers/, 'then the last chat line');
  });
});

const brief = (interfaces: StatusBrief['interfaces']): StatusBrief => ({
  core: { state: 'running', reason: null, model: 'a/model', route: 'direct-api', bound: true },
  memory: { session: 'apply', probe: 'ok', checkedAt: 1, model: 'a/model', route: 'direct-api', bound: true },
  analyzer: { model: 'a/model', route: 'direct-api', bound: true },
  interfaces,
});

const interfacesRow = (rig: Rig): string =>
  (rig.screen().find((line) => line.includes('Interfaces:')) ?? '').replace(/^.*Interfaces:/, 'Interfaces:').trim();

test('the header lists the command line and the interfaces that work, by name alone', async () => {
  // Bug: a disconnected or disabled interface shows with a state word, and the command line the owner types in is missing.
  const working = brief([
    { name: 'discord', enabled: true, connected: true },
    { name: 'telegram', enabled: true, connected: false },
    { name: 'slack', enabled: false, connected: false },
  ]);
  const { env } = chatEnv({ title: 'Project Neptunia', status: () => Promise.resolve(working) });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'Interfaces: CLI'));
    assert.equal(interfacesRow(rig), 'Interfaces: CLI, Discord');
  });
});

test('the header of a fresh install lists the command line alone', async () => {
  // Bug: with no platform set up the line reads `disabled`, as if the chat the owner types in did not work.
  const { env } = chatEnv({ title: 'Project Neptunia', status: () => Promise.resolve(brief([])) });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'Interfaces: CLI'));
    assert.equal(interfacesRow(rig), 'Interfaces: CLI');
  });
});
