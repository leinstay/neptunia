// The config step of the offline conversion to places (src/memory/migration/convert-config.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { convertConfig } from '../src/memory/migration/convert-config.ts';
import { tempDir } from './fixtures/tmp.ts';

function converted(config: object): { config: Record<string, Record<string, unknown>>; out: string; report: object } {
  const root = tempDir('nep-convert-config-');
  const from = path.join(root, 'in');
  const out = path.join(root, 'out');
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, 'config.json'), JSON.stringify(config));
  const report = convertConfig(from, out);
  return {
    config: JSON.parse(fs.readFileSync(path.join(out, 'config.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >,
    out,
    report,
  };
}

test('the diary channel of the old setting becomes the selfreflection place', () => {
  // Bug: her diary loses its channel at the cutover because the converted config still spells the old key.
  const { config, report } = converted({ selfreflection: { channelId: 'c-diary', gistChars: 200 } });
  assert.deepEqual(config.selfreflection, { gistChars: 200, placeId: 'c-diary' });
  assert.deepEqual(report, {
    removed: [],
    moved: [{ from: 'selfreflection.channelId', to: 'selfreflection.placeId' }],
  });
});

test('a config with no diary channel moves nothing', () => {
  // Bug: a fresh install gains an empty place id, and the diary reads it as a channel.
  const { config, report } = converted({ selfreflection: { gistChars: 200 } });
  assert.deepEqual(config.selfreflection, { gistChars: 200 });
  assert.deepEqual(report, { removed: [], moved: [] });
});

test('the served server moves to the interface settings and the main channel is gone', () => {
  // Bug: the home guild or the fallback channel survives the cutover in the converted config.
  const { config, out, report } = converted({
    bot: { guildId: 'g1', timezone: 'UTC' },
    memory: { mainChannelIds: ['c1'], aliasHalfLifeDays: 3 },
  });
  assert.deepEqual(config.bot, { timezone: 'UTC' });
  assert.deepEqual(config.memory, { aliasHalfLifeDays: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'interfaces', 'discord.json'), 'utf8')), {
    servers: ['g1'],
  });
  assert.deepEqual(report, {
    removed: ['memory.mainChannelIds'],
    moved: [{ from: 'bot.guildId', to: 'interfaces/discord.json#servers' }],
  });
});
