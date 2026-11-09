// Trusted recall carriers reach the SQLite reader through the memory tool on synthetic stored evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecall } from '../src/behavior/recall-run.ts';
import { runMemorySearch } from '../src/tools/tools.ts';
import { channelPlaceId, dmPlaceId } from '../src/memory/db/ids.ts';
import { personId } from './fixtures/memory-db/spelled-ids.ts';
import { dmScope } from '../src/memory/db/scope.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { fixture } from './fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { channel as channelInfo, rig } from './fixtures/reads-rig.ts';
import { labels } from './fixtures/labels.ts';

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const BOB = 'u-bob';

function runner(env: ReturnType<typeof fixture>) {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        {
          id: channelPlaceId('discord', 'c1'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c1',
          scope_kind: 'group',
          name: 'general',
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: personId('discord', BOB),
        },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const hot = {
    config: { features: { recall: true, meaningSearch: false }, bot: { timezone: 'UTC' } },
    prompts: { 'recall-summary': 'Summarize the stored evidence.', labels },
  };
  const recaller = createRecall({
    reads: rig().reads,
    hot,
    store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [] },
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('quoted SQLite reads need no model')) },
    now: () => NOW,
    memoryDb: { database: () => env.db },
  });
  return { recaller, hot, args: { placeId: 'g1', channel: channelInfo('c1', { name: 'general' }) } };
}

test('the memory tool expands a trusted source carrier even when its ordinary anchor text is empty', async () => {
  const env = fixture();
  try {
    env.say({
      native: 'carrier-before',
      at: NOW - DAY - 60_000,
      place: channelPlaceId('discord', 'c1'),
      text: 'carrier-neighbor-731',
    });
    const sourceId = env.say({
      native: 'carrier-anchor',
      at: NOW - DAY,
      place: channelPlaceId('discord', 'c1'),
      text: 'anchor',
    });
    const s = runner(env);
    const result = await runMemorySearch({
      recall: s.recaller,
      config: s.hot.config,
      labels,
      ...s.args,
      args: { anchor: '', move: 'up', messages: 1 },
      resolvedAnchor: { kind: 'source', sourceId },
      now: NOW,
    });
    assert.equal(result.status, 'ok');
    assert.ok(result.data?.text.includes('carrier-neighbor-731'));
  } finally {
    env.done();
  }
});

test('the memory tool never falls back from a hidden trusted source to visible ordinary anchor text', async () => {
  const env = fixture();
  try {
    env.say({
      native: 'visible-before',
      at: NOW - DAY - 60_000,
      place: channelPlaceId('discord', 'c1'),
      text: 'visible-fallback-731',
    });
    env.say({
      native: 'visible-anchor',
      at: NOW - DAY,
      place: channelPlaceId('discord', 'c1'),
      text: 'visible anchor',
    });
    const hidden = env.say({
      native: 'hidden-anchor',
      at: NOW - DAY,
      place: dmPlaceId('discord', BOB),
      scope: dmScope(personId('discord', BOB), 'discord'),
      text: 'hidden-secret-842',
    });
    const s = runner(env);
    const result = await runMemorySearch({
      recall: s.recaller,
      config: s.hot.config,
      labels,
      ...s.args,
      args: { anchor: 'visible-anchor', move: 'up', messages: 1 },
      resolvedAnchor: { kind: 'source', sourceId: hidden },
      now: NOW,
    });
    assert.deepEqual([result.status, result.code], ['invalid', 'unknown-message']);
    assert.equal(JSON.stringify(result).includes('hidden-secret-842'), false);
    assert.equal(JSON.stringify(result).includes('visible-fallback-731'), false);
  } finally {
    env.done();
  }
});
