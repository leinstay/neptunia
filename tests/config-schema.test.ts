// The settings schema of PR 7c (src/config/schema.ts): one entry per key with its JSON types, its reader (the module
// that reads it), its default and one line of text. A map (a section whose keys are free, such as `bot.access` or
// `models.abilities`, keyed by tool or model ids that hold dots) is one entry of type `map`. `schemaDefaults` builds the
// settings object the defaults give, which is `config/config.json` exactly. The tests read the schema and the tracked
// file, never a local layer.
// PR 7d cuts the settings (tests/fixtures/config-cut.ts): each group leaves the schema and the tracked file whole, and a
// local layer shaped like production's still derives the settings it derived before the cut
// (tests/fixtures/config-cut-before.json, written from the readers of the commit before the cut over the same layer).
// A declared field may change or go: a daily cap of plan section 4.5 and a switch that became code. The schema ends
// under 300 keys with every kept key in it, the daily caps leave it while the request rail stays, and the Discord keys
// live in the Discord package's own settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_SCHEMA, schemaDefaults } from '../src/config/schema.ts';
import type { SchemaEntry } from '../src/config/schema.ts';
import { ROOT } from './fixtures/private-layer.ts';
import { readConfig } from '../src/config.ts';
import { DailyCapError, countLlmRequest } from '../src/llm/openrouter.ts';
import { audioMapSettings } from '../src/media/audio-map.ts';
import { recentSettings } from '../src/memory/recent.ts';
import { participationSettings } from '../src/memory/participation.ts';
import { indexSettings } from '../src/memory/db/index-policy.ts';
import { dbSettings } from '../src/memory/db/recall.ts';
import { graphSettings } from '../src/memory/db/graph.ts';
import { focusSettings } from '../src/memory/db/focus.ts';
import { backupSettings } from '../src/memory/db/backup.ts';
import { captureSettings } from '../src/memory/db/observe.ts';
import { sessionSettings } from '../src/memory/db/session.ts';
import { boardSettings } from '../src/board/board.ts';
import { participationPickSettings } from '../src/behavior/participation-pick.ts';
import { routeSettings } from '../src/behavior/route.ts';
import { pullSettings } from '../src/behavior/pull.ts';
import { setSettings } from '../src/behavior/diary.ts';
import { catchUpSettings } from '../src/behavior/catch-up.ts';
import { elsewhereSettings } from '../src/behavior/elsewhere.ts';
import { splitSettings } from '../src/behavior/split.ts';
import { gifPickSettings } from '../src/behavior/gif-pick.ts';
import { innerSettings } from '../src/behavior/inner/settings.ts';
import { missedSettings } from '../src/behavior/missed.ts';
import { recallSettings } from '../src/behavior/recall.ts';
import { loopSettings, paceSettings } from '../src/turn/settings.ts';
import { hedgeSettings } from '../src/llm/openrouter.ts';
import { attentionSettings, heartbeatLimits, intentionSettings } from '../src/intentions/model.ts';
import { agentSettings } from '../src/agent-runner/profiles.ts';
import { CUT, CUT_GROUPS, KEPT, PRODUCTION_LAYER } from './fixtures/config-cut.ts';
import type { CutGroup } from './fixtures/config-cut.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The number of config keys Hermes has (hermes_cli/config_defaults.py), the bound plan section 4.5 sets. */
const HERMES_KEYS = 1010;

test('builds the nested settings from the defaults, a map entry holding its whole object', () => {
  const schema: ReadonlyArray<SchemaEntry> = [
    { key: 'a.b', types: ['number'], reader: 'src/a.js', default: 1, text: 'one' },
    { key: 'a.m', types: ['map'], reader: 'src/a.js', default: { 'x.y': [1] }, text: 'a map' },
    { key: 'c', types: ['string', 'null'], reader: 'src/c.js', default: null, text: 'c' },
  ];
  assert.deepEqual(schemaDefaults(schema), { a: { b: 1, m: { 'x.y': [1] } }, c: null });
});

test('builds an empty object from an empty schema', () => {
  assert.deepEqual(schemaDefaults([]), {});
});

test('the defaults of the schema are config/config.json, key for key and value for value', () => {
  const tracked: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  assert.deepEqual(schemaDefaults(CONFIG_SCHEMA), tracked);
});

test('names no key twice', () => {
  const seen = new Set<string>();
  const twice = CONFIG_SCHEMA.map((entry) => entry.key).filter((key) => seen.size === seen.add(key).size);
  assert.deepEqual(twice, []);
});

test('holds fewer keys than Hermes has', () => {
  assert.ok(CONFIG_SCHEMA.length < HERMES_KEYS, `${CONFIG_SCHEMA.length} keys`);
});

// The generated document prints this line for each key: an empty or a two-line text breaks its table row.
test('gives every key one line of text', () => {
  const bad = CONFIG_SCHEMA.filter((entry) => entry.text.trim() === '' || entry.text.includes('\n')).map(
    (entry) => entry.key
  );
  assert.deepEqual(bad, []);
});

test('gives every key a type its default has', () => {
  const typeOf = (value: unknown): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'map';
    return typeof value;
  };
  const bad = CONFIG_SCHEMA.filter((entry) => !entry.types.some((one) => one === typeOf(entry.default))).map(
    (entry) => entry.key
  );
  assert.deepEqual(bad, []);
});

// ---- the cut of PR 7d ----------------------------------------------------------------------------------------------

type Tree = Record<string, unknown>;

/** The defaults the Discord package ships for the keys it takes over; production's intents stay in its local layer. */
const DISCORD_DEFAULTS: Readonly<Record<string, unknown>> = {
  'discord.intents.presences': false,
  'discord.intents.members': false,
  'context.maxUrlChars': 200,
  'media.embedTextChars': 200,
};

/** The lead's bound for the settings after the cut (plan section 4.5). */
const KEY_BOUND = 300;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at a dotted path of `tree`, undefined when a segment is missing. */
function at(tree: unknown, dotted: string): unknown {
  let node: unknown = tree;
  for (const segment of dotted.split('.')) {
    if (!isTree(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

const tracked = (): unknown => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
const schemaKeys = (): Set<string> => new Set(CONFIG_SCHEMA.map((entry) => entry.key));

/** The settings this checkout reads with `PRODUCTION_LAYER` as the private layer's settings file. */
function productionConfig(): Tree {
  const dir = tempDir('nep-cut-');
  fs.mkdirSync(path.join(dir, 'config.local'));
  fs.writeFileSync(path.join(dir, 'config.local', 'config.json'), JSON.stringify(PRODUCTION_LAYER));
  const config: unknown = readConfig(ROOT, { privateDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(isTree(config));
  return config;
}

/** The settings objects the readers derive from `config`, by the names of the snapshot file. */
const READERS: ReadonlyArray<{ name: string; group: CutGroup; read: (config: Tree) => unknown }> = [
  { name: 'pullSettings', group: 'context', read: (config) => pullSettings(config) },
  { name: 'recallSettings', group: 'recall', read: (config) => recallSettings(config) },
  { name: 'dbSettings', group: 'recall', read: (config): unknown => dbSettings(config) },
  { name: 'indexSettings', group: 'recall', read: (config) => indexSettings(config) },
  { name: 'recentSettings', group: 'memory', read: (config) => recentSettings(config) },
  { name: 'participationSettings', group: 'memory', read: (config) => participationSettings(config) },
  { name: 'participationPickSettings', group: 'memory', read: (config) => participationPickSettings(config) },
  { name: 'graphSettings', group: 'memory', read: (config) => graphSettings(config) },
  { name: 'focusSettings', group: 'memory', read: (config) => focusSettings(config) },
  { name: 'captureSettings', group: 'memory', read: (config) => captureSettings(config) },
  { name: 'sessionSettings', group: 'memory', read: (config) => sessionSettings(config) },
  { name: 'backupSettings', group: 'memory', read: (config) => backupSettings(config, '/data') },
  { name: 'innerSettings', group: 'inner life', read: (config) => innerSettings(config) },
  { name: 'heartbeatLimits', group: 'inner life', read: (config) => heartbeatLimits(config) },
  { name: 'intentionSettings', group: 'inner life', read: (config) => intentionSettings(config) },
  { name: 'attentionSettings', group: 'inner life', read: (config) => attentionSettings(config) },
  { name: 'loopSettings inner', group: 'inner life', read: (config) => loopSettings(config, { inner: true }) },
  {
    name: 'audioMapSettings',
    group: 'media and diary',
    read: (config) => audioMapSettings(at(config, 'media.video.audioMap')),
  },
  { name: 'setSettings', group: 'media and diary', read: (config) => setSettings(config.diary) },
  { name: 'gifPickSettings', group: 'media and diary', read: (config) => gifPickSettings(config) },
  { name: 'loopSettings diary', group: 'media and diary', read: (config) => loopSettings(config, { diary: true }) },
  { name: 'hedgeSettings', group: 'llm and models', read: (config) => hedgeSettings(config) },
  { name: 'boardSettings', group: 'the rest', read: (config) => boardSettings(config) },
  { name: 'routeSettings', group: 'the rest', read: (config) => routeSettings(config) },
  { name: 'splitSettings', group: 'the rest', read: (config) => splitSettings(config) },
  { name: 'catchUpSettings', group: 'the rest', read: (config) => catchUpSettings(config) },
  { name: 'elsewhereSettings', group: 'the rest', read: (config) => elsewhereSettings(config) },
  { name: 'missedSettings', group: 'the rest', read: (config) => missedSettings(config) },
  { name: 'paceSettings', group: 'the rest', read: (config) => paceSettings(config) },
  { name: 'loopSettings', group: 'the rest', read: (config) => loopSettings(config) },
  ...['scout', 'server', 'thinker', 'dev'].map((agent) => ({
    name: `agentSettings ${agent}`,
    group: 'the rest' as const,
    read: (config: Tree) => agentSettings(agent, config),
  })),
];

/**
 * The fields of the snapshot that may change or go: the daily caps (plan section 4.5) and their twins in the
 * derived objects, and the switches whose behaviour became code. A switch left in its object keeps its value.
 */
const MAY_CHANGE: ReadonlyArray<string> = [
  'recallSettings.maxPerDay',
  'dbSettings.maxPerDay',
  'attentionSettings.perDayDefault',
  'innerSettings.attention.perDayDefault',
  'innerSettings.wakes',
  'agentSettings scout.daily',
  'agentSettings server.daily',
];
const MAY_GO: ReadonlyArray<string> = [
  'paceSettings.typingWhilePreparing',
  'paceSettings.unpromptedWaits',
  'innerSettings.review.enabled',
  'innerSettings.heartbeat.intentionsOnly',
  'recallSettings.fallbackOnClassifierFailure',
  'recallSettings.meaningWithReply',
  'dbSettings.fallbackOnClassifierFailure',
  'dbSettings.meaningWithReply',
];

const BEFORE: unknown = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'config-cut-before.json'), 'utf8')
);

/** The dotted paths where `after` differs from `before` under `name`, past the declared fields. */
function differences(name: string, before: unknown, after: unknown): Array<string> {
  if (MAY_CHANGE.includes(name)) return [];
  if (MAY_GO.includes(name) && after === undefined) return [];
  if (isTree(before) && isTree(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => differences(`${name}.${key}`, before[key], after[key]));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [name];
}

for (const group of CUT_GROUPS) {
  test(`the cut of ${group}: its keys leave the schema and config.json, and the derived settings stay`, () => {
    const keys = schemaKeys();
    const file = tracked();
    const rows = CUT.filter((row) => row.group === group);
    assert.ok(rows.length > 0, `the cut names keys of ${group}`);
    assert.deepEqual(
      rows.filter((row) => keys.has(row.key)).map((row) => row.key),
      [],
      'no cut key is in the schema'
    );
    assert.deepEqual(
      rows.filter((row) => at(file, row.key) !== undefined).map((row) => row.key),
      [],
      'no cut key is in config/config.json'
    );
    const config = productionConfig();
    const changed = READERS.filter((reader) => reader.group === group).flatMap((reader) =>
      differences(reader.name, isTree(BEFORE) ? BEFORE[reader.name] : undefined, reader.read(config))
    );
    assert.deepEqual(changed, [], 'the derived settings are the production values');
  });
}

test('holds fewer than 300 keys after the cut, every kept key among them', () => {
  const keys = schemaKeys();
  assert.deepEqual(
    KEPT.filter((key) => !keys.has(key)),
    [],
    'a key the cut keeps is missing'
  );
  assert.ok(CONFIG_SCHEMA.length < KEY_BOUND, `${CONFIG_SCHEMA.length} keys`);
});

test('keeps the two privacy switches under private and one budget entry per field for every wake kind', () => {
  const keys = schemaKeys();
  const added = CUT.filter((row) => row.becomes === 'rename' || row.becomes === 'wildcard').map((row) => row.to ?? '');
  assert.deepEqual(
    [...new Set(added)].filter((key) => !keys.has(key)),
    [],
    'a renamed or wildcard key is missing'
  );
  const file = tracked();
  assert.equal(at(file, 'private.enabled'), false, 'private chat stays off in the tracked defaults');
  assert.equal(at(file, 'private.likeServer'), true);
});

test('drops the daily caps of plan section 4.5 and keeps the one request rail, which refuses the 5,001st request', () => {
  const caps = CUT.filter((row) => row.becomes === 'cap').map((row) => row.key);
  const keys = schemaKeys();
  assert.deepEqual(
    caps.filter((key) => keys.has(key)),
    [],
    'a daily cap is still a key'
  );
  const file = tracked();
  assert.equal(at(file, 'llm.maxRequestsPerDay'), 5000);
  assert.equal(at(file, 'llm.maxRequestTokens'), 50000);
  const state = { data: {}, markDirty() {} };
  const day = Date.parse('2026-10-31T12:00:00Z');
  for (let n = 0; n < 5000; n += 1) countLlmRequest(state, 5000, day);
  assert.throws(() => countLlmRequest(state, 5000, day), DailyCapError);
});

test('moves the Discord keys out of the core settings into the Discord package', () => {
  assert.deepEqual(
    CONFIG_SCHEMA.filter((entry) => entry.key.startsWith('discord.')).map((entry) => entry.key),
    [],
    'the core schema has no discord key'
  );
  assert.equal(at(tracked(), 'discord'), undefined, 'config/config.json has no discord section');
  const own: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'interfaces', 'discord', 'config.json'), 'utf8'));
  const moved = CUT.filter((row) => row.becomes === 'discord').map((row) => row.key);
  assert.deepEqual(
    Object.fromEntries(moved.map((key) => [key, at(own, key)])),
    Object.fromEntries(moved.map((key) => [key, DISCORD_DEFAULTS[key]]))
  );
});
