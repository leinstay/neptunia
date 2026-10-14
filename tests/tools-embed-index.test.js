// Tests for tools/embed-index.mjs: the meaning index built for history from a fixture record and
// archive in a temporary data/ directory, with an injected fake embedding client (no network, no
// real data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../tools/embed-index.mjs';
import { CliError } from '../tools/lib/cli.mjs';
import { createAppendStore } from '../src/memory/append-store.js';
import { archiveEntry, createArchive } from '../src/memory/archive.js';
import { createRecord } from '../src/memory/record.js';

const GUILD = '600000000000000001';
const ELENI = '411111111111111111';
const NIKOS = '422222222222222222';
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const quiet = { info() {}, warn() {}, error() {} };

function line(messageId, at, text, by, overrides = {}) {
  return { kind: 'seen', messageId, revision: 1, occurredAt: at, scope: { channel: 'c1' }, by, text, participants: [by], ...overrides };
}

/** A bot directory with a record over September and October, a private layer and one archived episode. */
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-embed-index-'));
  const dataDir = path.join(root, 'data');
  const stores = [createAppendStore({ fsyncMs: 0, log: quiet }), createAppendStore({ fsyncMs: 0, log: quiet })];
  const record = createRecord({ appendStore: stores[0], dataDir, log: quiet });
  const archive = createArchive({ appendStore: stores[1], dataDir, log: quiet, now: () => NOW });
  await record.append(GUILD, [
    line('m1', '2026-09-20T10:00:00.000Z', 'the lighthouse song', ELENI),
    line('m2', '2026-09-20T10:01:00.000Z', 'café crème again', NIKOS),
    line('m3', '2026-10-02T10:00:00.000Z', 'chess night', ELENI),
    line('m4', '2026-10-02T10:02:00.000Z', 'won twice', NIKOS),
  ]);
  await record.append(GUILD, [line('p1', '2026-10-03T10:00:00.000Z', 'a private word', ELENI)], { privateUserId: ELENI });
  await archive.append(GUILD, [
    archiveEntry({ date: '2026-10-02', what: 'won the chess night twice', quote: 'twice!' }, { itemKind: 'episode', event: 'backfill', scope: { user: NIKOS }, now: () => NOW }),
  ]);
  await Promise.all(stores.map((store) => store.close()));
  fs.mkdirSync(path.join(dataDir, 'guilds', GUILD, 'users'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'guilds', GUILD, 'users', `${ELENI}.json`), JSON.stringify({ names: ['Ελένη'] }));
  const hot = {
    config: {
      features: {},
      bot: { nameTriggers: ['persona'] },
      roles: { embedding: 'test/embed-model' },
      embed: { dimensions: 4, batch: 2 },
      llm: { maxRequestTokens: 50000 },
    },
  };
  const calls = [];
  const embedClient = {
    async embed(texts, opts) {
      calls.push({ texts, opts });
      return texts.map((_, i) => Float32Array.from([1, i + 1, 0, 0]));
    },
  };
  const run = (argv) => main(argv, { cwd: root, now: () => NOW, hot, embedClient, log: quiet });
  return { root, dataDir, hot, calls, run };
}

const sentTexts = (calls) => calls.flatMap((call) => call.texts);
const manifest = (dataDir, month, privateUserId = null) =>
  JSON.parse(fs.readFileSync(
    privateUserId
      ? path.join(dataDir, 'guilds', GUILD, 'private', privateUserId, 'vectors', month, 'manifest.json')
      : path.join(dataDir, 'guilds', GUILD, 'vectors', month, 'manifest.json'),
    'utf8',
  ));

test('embed-index estimate: counts, tokens and USD per month and layer, never a message text', async () => {
  const kit = await fixture();
  const out = await kit.run(['estimate']);
  assert.match(out, /^2026-09 guild +2 +0 /m);
  assert.match(out, /^2026-10 guild +2 +1 /m);
  assert.match(out, /^2026-10 private +1 +0 /m);
  assert.match(out, /total: 6 chunks/);
  for (const text of ['lighthouse', 'café', 'chess', 'private word', 'twice']) assert.equal(out.includes(text), false, text);
  assert.equal(kit.calls.length, 0);
});

test('embed-index build: --max-usd is required, an estimate above it is refused, a dry run sends nothing', async () => {
  const kit = await fixture();
  await assert.rejects(kit.run(['build']), (err) => err instanceof CliError && err.exitCode === 1);
  await assert.rejects(kit.run(['build', '--max-usd', '0']), (err) => err instanceof CliError && err.exitCode === 2);
  const dry = await kit.run(['build', '--max-usd', '1', '--dry-run']);
  assert.match(dry, /dry run/);
  assert.equal(kit.calls.length, 0);
  assert.equal(fs.existsSync(path.join(kit.dataDir, 'guilds', GUILD, 'vectors')), false);
});

test('embed-index build: embeds each month with context in batches, the private layer apart; the estimate matches what is sent', async () => {
  const kit = await fixture();
  const estimate = await kit.run(['estimate']);
  const out = await kit.run(['build', '--max-usd', '1']);
  const texts = sentTexts(kit.calls);
  assert.equal(texts.length, 6);
  assert.ok(texts.includes('Ελένη: the lighthouse song\n422222222222222222: café crème again'));
  assert.ok(texts.includes('won the chess night twice "twice!"'));
  assert.ok(texts.includes('Ελένη: a private word'));
  assert.ok(kit.calls.every((call) => call.texts.length <= 2), 'embed.batch');
  const tokens = texts.reduce((sum, text) => sum + Math.ceil(text.length / 3.5), 0);
  assert.match(estimate, new RegExp(`total: 6 chunks, ${tokens} tokens`));
  assert.equal(manifest(kit.dataDir, '2026-09').rows, 2);
  assert.equal(manifest(kit.dataDir, '2026-10').rows, 3);
  assert.equal(manifest(kit.dataDir, '2026-10').model, 'test/embed-model');
  assert.equal(manifest(kit.dataDir, '2026-10', ELENI).rows, 1);
  assert.match(out, /built: 3 month layer\(s\)/);
  for (const text of ['lighthouse', 'café', 'private word']) assert.equal(out.includes(text), false, text);
});

test('embed-index build: indexed months are skipped; --rebuild writes the range again as a new generation', async () => {
  const kit = await fixture();
  await kit.run(['build', '--max-usd', '1']);
  const first = kit.calls.length;
  const again = await kit.run(['build', '--max-usd', '1']);
  assert.equal(kit.calls.length, first, 'nothing sent');
  assert.match(again, /3 already indexed/);
  const gen = manifest(kit.dataDir, '2026-10').gen;
  await kit.run(['build', '--max-usd', '1', '--rebuild', '--from', '2026-10', '--to', '2026-10']);
  assert.deepEqual(sentTexts(kit.calls.slice(first)).length, 4);
  assert.equal(manifest(kit.dataDir, '2026-10').gen, gen + 1);
  assert.equal(manifest(kit.dataDir, '2026-10').rows, 3, 'no duplicate rows');
  assert.equal(manifest(kit.dataDir, '2026-09').gen, 1, 'outside the range untouched');
});

test('embed-index build: a member the ledger forgot after their lines is not sent; a forget under way refuses', async () => {
  const kit = await fixture();
  const guildDir = path.join(kit.dataDir, 'guilds', GUILD);
  fs.writeFileSync(path.join(guildDir, 'forgotten.json'), JSON.stringify([{ userId: NIKOS, at: '2026-10-13T00:00:00.000Z' }]));
  await kit.run(['build', '--max-usd', '1']);
  const texts = sentTexts(kit.calls);
  assert.equal(texts.some((text) => text.includes('café') || text.includes('won')), false);
  fs.mkdirSync(path.join(guildDir, 'forgetting'), { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'forgetting', `${ELENI}.json`), '{}');
  await assert.rejects(kit.run(['build', '--max-usd', '1', '--rebuild']), /a forget is under way/);
});

test('embed-index build: while the bot runs with its live queue on, the current month is left to it', async () => {
  const kit = await fixture();
  fs.mkdirSync(path.join(kit.dataDir, 'guilds', GUILD, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(kit.dataDir, 'guilds', GUILD, 'journal', '.running'), '{}');
  kit.hot.config.features = { meaningSearch: true, embedIndex: true };
  const out = await kit.run(['build', '--max-usd', '1']);
  assert.match(out, /2 left to the live queue/);
  assert.equal(sentTexts(kit.calls).length, 2);
  assert.equal(fs.existsSync(path.join(kit.dataDir, 'guilds', GUILD, 'vectors', '2026-10')), false);
});

/** Mark the bot as running on the fixture's data/ with its live queue on. */
function liveBot(kit) {
  fs.mkdirSync(path.join(kit.dataDir, 'guilds', GUILD, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(kit.dataDir, 'guilds', GUILD, 'journal', '.running'), '{}');
  kit.hot.config.features = { meaningSearch: true, embedIndex: true };
}

/** More record lines in the fixture's data/ (the stores closed again after). */
async function recordMore(kit, lines) {
  const store = createAppendStore({ fsyncMs: 0, log: quiet });
  await createRecord({ appendStore: store, dataDir: kit.dataDir, log: quiet }).append(GUILD, lines);
  await store.close();
}

test('embed-index build --include-live: the current month gets only its missing rows older than the catch-up window, appended', async () => {
  const kit = await fixture();
  await kit.run(['build', '--max-usd', '1']);
  const before = manifest(kit.dataDir, '2026-10');
  await recordMore(kit, [
    line('m5', '2026-10-05T10:00:00.000Z', 'a missing line', ELENI),
    line('m6', '2026-10-14T10:00:00.000Z', 'inside the catch-up window', NIKOS),
  ]);
  liveBot(kit);
  const sent = kit.calls.length;
  const left = await kit.run(['build', '--max-usd', '1']);
  assert.match(left, /left to the live queue/);
  assert.equal(kit.calls.length, sent, 'without --include-live the live month is the queue\'s');
  const out = await kit.run(['build', '--max-usd', '1', '--include-live']);
  assert.deepEqual(sentTexts(kit.calls.slice(sent)), ['Ελένη: chess night\n422222222222222222: won twice\nΕλένη: a missing line']);
  const after = manifest(kit.dataDir, '2026-10');
  assert.equal(after.gen, before.gen, 'appended, never replaced');
  assert.equal(after.rows, before.rows + 1);
  assert.match(out, /built: 1 month layer\(s\)/);
  // Run again: nothing is missing any more.
  await kit.run(['build', '--max-usd', '1', '--include-live']);
  assert.equal(kit.calls.length, sent + 1);
  assert.equal(manifest(kit.dataDir, '2026-10').rows, before.rows + 1);
});

test('embed-index: --include-live belongs to build, --coverage and --hours to stats', async () => {
  const kit = await fixture();
  await assert.rejects(kit.run(['stats', '--include-live']), (err) => err instanceof CliError);
  await assert.rejects(kit.run(['build', '--max-usd', '1', '--coverage']), (err) => err instanceof CliError);
  await assert.rejects(kit.run(['stats', '--hours', '5']), (err) => err instanceof CliError);
  await assert.rejects(kit.run(['stats', '--coverage', '--hours', '0']), (err) => err instanceof CliError);
});

test('embed-index stats --coverage: the record of the last hours against the index, counts only', async () => {
  const kit = await fixture();
  const before = await kit.run(['stats', '--coverage', '--hours', '300']);
  assert.match(before, /coverage, last 300 h: 3 messages, 0 indexed, 3 missing, oldest missing 2026-10-02T10:00:00.000Z/);
  await kit.run(['build', '--max-usd', '1']);
  const after = await kit.run(['stats', '--coverage', '--hours', '300']);
  assert.match(after, /coverage, last 300 h: 3 messages, 3 indexed, 0 missing, oldest missing none/);
  assert.match(await kit.run(['stats', '--coverage']), /coverage, last 72 h: 0 messages/, 'embed.catchUpHours by default');
  for (const text of ['chess', 'private word']) assert.equal(after.includes(text), false, text);
});

test('embed-index stats: rows per month and the private layers summed', async () => {
  const kit = await fixture();
  await kit.run(['build', '--max-usd', '1']);
  const out = await kit.run(['stats']);
  assert.match(out, /^2026-09 +2 /m);
  assert.match(out, /guild: 2 month\(s\), 5 rows/);
  assert.match(out, /private: 1 layer\(s\), 1 rows/);
});
