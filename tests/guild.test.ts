import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveGuild, resolveGuilds } from '../interfaces/discord/index.ts';
import { wrongly } from './fixtures/loose-types.ts';

test("resolveGuild: configured id present among the bot's guilds resolves to it", () => {
  const guilds = [
    { id: 'g1', name: 'Alpha' },
    { id: 'g2', name: 'Beta' },
  ];
  assert.deepEqual(resolveGuild('g2', guilds), { guildId: 'g2' });
});

test("resolveGuild: configured id not among the bot's guilds is an error naming it and listing what it is in", () => {
  const guilds = [
    { id: 'g1', name: 'Alpha' },
    { id: 'g2', name: 'Beta' },
  ];
  const result = wrongly<{ error: string }>(resolveGuild('g3', guilds));
  assert.ok(result.error);
  assert.match(result.error, /g3/);
  assert.match(result.error, /Alpha \(g1\)/);
  assert.match(result.error, /Beta \(g2\)/);
});

test('resolveGuild: no configured id and exactly one guild resolves to it without an error', () => {
  const guilds = [{ id: 'g1', name: 'Alpha' }];
  assert.deepEqual(resolveGuild('', guilds), { guildId: 'g1' });
});

test('resolveGuild: no configured id and zero guilds is an error', () => {
  const result = wrongly<{ error: string }>(resolveGuild('', []));
  assert.ok(result.error);
});

test('resolveGuild: no configured id and several guilds is an error listing them', () => {
  const guilds = [
    { id: 'g1', name: 'Alpha' },
    { id: 'g2', name: 'Beta' },
  ];
  const result = wrongly<{ error: string }>(resolveGuild('', guilds));
  assert.ok(result.error);
  assert.match(result.error, /Alpha \(g1\)/);
  assert.match(result.error, /Beta \(g2\)/);
});

test('resolveGuilds keeps the listed servers the bot is in and reports the others as missing or waiting', () => {
  // Bug: one server still waiting for its invite stops the bot on all the others.
  // Changed by the spec of 2026-11-11 (joining a root): a server the bot is in and the list does not name no longer
  // stops the start with an error. It waits for the owner, so the answer carries `waiting` and a list the bot is in
  // none of starts with nothing served.
  const guilds = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  assert.deepEqual(resolveGuilds(['b', 'c'], '', guilds), {
    guildIds: ['b'],
    missing: ['c'],
    waiting: [{ id: 'a', name: 'A' }],
  });
  assert.deepEqual(resolveGuilds(['c'], '', guilds), { guildIds: [], missing: ['c'], waiting: guilds });
  assert.deepEqual(resolveGuilds([], 'a', guilds), { guildIds: ['a'], missing: [], waiting: [{ id: 'b', name: 'B' }] });
});

test('resolveGuilds with no list serves none of several servers and reports each as waiting', () => {
  // Bug: a bot invited to a second server while the list is empty never starts again.
  const guilds = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  assert.deepEqual(resolveGuilds([], '', guilds), { guildIds: [], missing: [], waiting: guilds });
});

test('resolveGuilds with no list serves the only server the bot is in', () => {
  // Catches: the one-server install of a new owner left waiting for an accept it never needed.
  assert.deepEqual(resolveGuilds([], '', [{ id: 'a', name: 'A' }]), { guildIds: ['a'], missing: [], waiting: [] });
});
