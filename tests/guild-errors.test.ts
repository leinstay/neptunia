import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveGuild, resolveGuilds } from '../interfaces/discord/index.ts';
import { wrongly } from './fixtures/loose-types.ts';

// Bug: the errors told the owner to set `bot.guildId`, a core setting that the shipped config does not have. The
// interface chooses its servers from `servers` in `interfaces/discord/config.json`.

const guilds = [
  { id: 'g1', name: 'Alpha' },
  { id: 'g2', name: 'Beta' },
];

test('resolveGuild points at the servers setting when the configured server is not one the bot is in', () => {
  const result = wrongly<{ error: string }>(resolveGuild('g3', guilds));
  assert.match(result.error, /servers/);
  assert.doesNotMatch(result.error, /bot\.guildId/);
});

test('resolveGuild points at the servers setting when the bot is in several servers and none is chosen', () => {
  const result = wrongly<{ error: string }>(resolveGuild('', guilds));
  assert.match(result.error, /servers/);
  assert.doesNotMatch(result.error, /bot\.guildId/);
});

test('resolveGuild tells the owner to invite the bot when it is in no server and none is chosen', () => {
  const result = wrongly<{ error: string }>(resolveGuild('', []));
  assert.match(result.error, /invite/i);
  assert.doesNotMatch(result.error, /bot\.guildId/);
});

test('resolveGuilds keeps the servers wording when no list is given and the one configured server is missing', () => {
  const result = wrongly<{ error: string }>(resolveGuilds([], 'g3', guilds));
  assert.match(result.error, /servers/);
  assert.doesNotMatch(result.error, /bot\.guildId/);
});
