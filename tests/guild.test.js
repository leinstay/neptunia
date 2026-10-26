import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveGuild } from '../interfaces/discord/index.js';

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
  const result = resolveGuild('g3', guilds);
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
  const result = resolveGuild('', []);
  assert.ok(result.error);
});

test('resolveGuild: no configured id and several guilds is an error listing them', () => {
  const guilds = [
    { id: 'g1', name: 'Alpha' },
    { id: 'g2', name: 'Beta' },
  ];
  const result = resolveGuild('', guilds);
  assert.ok(result.error);
  assert.match(result.error, /Alpha \(g1\)/);
  assert.match(result.error, /Beta \(g2\)/);
});
