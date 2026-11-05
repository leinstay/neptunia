// src/interface/commands/table.ts rows of src/interface/commands/module-setup.ts: the owner's commands over a module's setup contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { MODULE_ACTIONS } from '../src/interface/commands/module-setup.ts';

test('every action of the contract has its command, and the chat parses the targeted commands of both module kinds', () => {
  // Bug: the table lacks a command the setup promises, so the owner cannot change one value without the whole walk.
  for (const [line, name] of [
    ['/interfaces setup discord', 'interfaces.setup'],
    ['/interfaces settings discord', 'interfaces.settings'],
    ['/interfaces set discord token', 'interfaces.set'],
    ['/interfaces clear discord token', 'interfaces.clear'],
    ['/interfaces add discord servers 111', 'interfaces.add'],
    ['/interfaces remove discord servers 111', 'interfaces.remove'],
    ['/skills setup gifs', 'skills.setup'],
    ['/skills settings gifs', 'skills.settings'],
    ['/skills set gifs key', 'skills.set'],
    ['/skills clear gifs key', 'skills.clear'],
  ]) {
    const parsed = parseCommandLine(line);
    assert.equal(typeof parsed === 'object' && parsed !== null && 'name' in parsed ? parsed.name : parsed, name, line);
  }
});

test('the actions the console routes are the ones the table offers', () => {
  // Bug: an action of the contract has no row, so `moduleCommand` can never reach it from the chat.
  for (const action of MODULE_ACTIONS) {
    const words = action === 'setup' || action === 'settings' ? 'gifs' : 'gifs key value';
    assert.match(JSON.stringify(parseCommandLine(`/skills ${action} ${words}`)), new RegExp(`skills\\.${action}`));
  }
});
