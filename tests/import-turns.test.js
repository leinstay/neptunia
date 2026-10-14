// Tests for tools/import-turns.mjs and tools/lib/import-turns.mjs: the persona's reply turns from
// before the journal, read from stored generations, matched to her posted messages in the record
// and written as imported journal turns. A temporary data/ directory, a fake fetch (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../tools/import-turns.mjs';
import {
  classify, contentOf, generationsOf, matchTurns, parseCsv, replyMatcher, similarity,
} from '../tools/lib/import-turns.mjs';
import { CliError } from '../tools/lib/cli.mjs';
import { createAppendStore } from '../src/memory/append-store.js';
import { createJournal } from '../src/memory/journal.js';
import { createRecord } from '../src/memory/record.js';

const GUILD = '600000000000000001';
const SELF = '700000000000000007';
const ELENI = '411111111111111111';
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const quiet = { info() {}, warn() {}, error() {} };
const REPLY_SYSTEM = 'You are Ariadne, a regular member of this Discord server, not a general-purpose assistant. The card.\n\n### More text';
const TEMPLATE = 'You are {{name}}, a regular member of this Discord server, not a general-purpose assistant. The card.\n\n### More';

// ---- CSV ------------------------------------------------------------------------

test('import-turns csv: quoted fields, commas and CRLF inside, a BOM, the header names the columns', () => {
  const text = '﻿generation_id,created_at,model_permaslug,api_key_name\r\n' +
    'gen-1,2026-09-22 10:00:00.123,"vendor/model, v2",persona\r\n' +
    '"gen-2","2026-09-23 11:30:05.000","say ""hi""",helper\r\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].generation_id, 'gen-1');
  assert.equal(rows[0].model_permaslug, 'vendor/model, v2');
  assert.equal(rows[1].model_permaslug, 'say "hi"');
  assert.equal(rows[1].api_key_name, 'helper');
});

test('import-turns csv: generations in UTC, inside the bounds, of one key name, once each, oldest first', () => {
  const rows = parseCsv(
    'generation_id,created_at,generation_time,api_key_name\n' +
    'gen-b,2026-09-23 11:30:05.500,4200,persona\n' +
    'gen-a,2026-09-22 10:00:00.123,,persona\n' +
    'gen-a,2026-09-22 10:00:00.123,,persona\n' +
    'gen-c,2026-10-13 13:00:00.000,1000,persona\n' +
    'gen-d,2026-09-24 09:00:00.000,1000,helper\n' +
    'gen-e,not a time,1000,persona\n',
  );
  const all = generationsOf(rows, {});
  assert.deepEqual(all.map((gen) => gen.id), ['gen-a', 'gen-b', 'gen-d', 'gen-c']);
  assert.equal(all[0].createdAt, Date.UTC(2026, 8, 22, 10, 0, 0, 123));
  assert.equal(all[0].genMs, null);
  assert.equal(all[1].genMs, 4200);
  const bounded = generationsOf(rows, { fromMs: Date.UTC(2026, 8, 23), toMs: Date.UTC(2026, 9, 13, 12, 40), keyName: 'persona' });
  assert.deepEqual(bounded.map((gen) => gen.id), ['gen-b']);
});

// ---- the stored generation ------------------------------------------------------

test('import-turns content: the system text, the task line and the output from the shapes the endpoint may use', () => {
  const input = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: REPLY_SYSTEM }] },
      { role: 'user', content: [{ type: 'text', text: 'stable' }, { type: 'text', text: '<chat>\n#1 Ελένη: γεια\n</chat>\n<task>\nAnswer #1.\nMore.\n</task>' }] },
    ],
  };
  const asString = contentOf({ data: { input, output: '<msg>γεια σου</msg>' } });
  assert.equal(asString.system.startsWith('You are Ariadne'), true);
  assert.equal(asString.task, 'Answer #1.');
  assert.equal(asString.output, '<msg>γεια σου</msg>');
  assert.equal(contentOf({ data: { input, output: { choices: [{ message: { content: '<skip/>' } }] } } }).output, '<skip/>');
  assert.equal(contentOf({ data: { input, output: { content: '<skip/>' } } }).output, '<skip/>');
  assert.equal(contentOf({ data: { input, output: { completion: '<skip/>' } } }).output, '<skip/>');
  assert.equal(contentOf({ data: { input, output: [{ role: 'assistant', content: [{ type: 'text', text: '<skip/>' }] }] } }).output, '<skip/>');
  assert.equal(contentOf({ data: { input: { messages: [{ role: 'system', content: 'Summarise.' }] }, output: { weird: 1 } } }).output, null);
  assert.equal(contentOf({ data: { input: { prompt: 'x' } } }).system, null);
});

test('import-turns classify: a reply turn needs the reply system prompt and an action tag', () => {
  const isReply = replyMatcher({ template: TEMPLATE });
  assert.equal(classify({ system: REPLY_SYSTEM, output: '<think>hm</think><msg>γεια</msg>' }, isReply), 'reply');
  assert.equal(classify({ system: REPLY_SYSTEM, output: '<skip/>' }, isReply), 'reply');
  assert.equal(classify({ system: REPLY_SYSTEM, output: '<react to="#2">🙂</react>' }, isReply), 'reply');
  assert.equal(classify({ system: REPLY_SYSTEM, output: '{"users": []}' }, isReply), 'other');
  assert.equal(classify({ system: 'You maintain the memory of a Discord server.', output: '<msg>x</msg>' }, isReply), 'other');
  assert.equal(classify({ system: null, output: '<msg>x</msg>' }, isReply), 'other');
  // A rendered name, and an explicit prefix.
  assert.equal(replyMatcher({ template: TEMPLATE, name: 'Ariadne' })(REPLY_SYSTEM), true);
  assert.equal(replyMatcher({ template: TEMPLATE, name: 'Kassandra' })(REPLY_SYSTEM), false);
  assert.equal(replyMatcher({ prefix: 'You are Ariadne,' })(REPLY_SYSTEM), true);
  assert.equal(replyMatcher({ prefix: 'Summarise' })(REPLY_SYSTEM), false);
});

// ---- matching -------------------------------------------------------------------

test('import-turns similarity: mention and emoji renderings are tolerated, other text is not', () => {
  assert.ok(similarity(`@Ελένη ναι, το είδα :smile:`, `<@${ELENI}> ναι, το είδα <:smile:123456789012345678>`) >= 0.9);
  assert.ok(similarity('Café crème, à demain!', 'café crème à demain') >= 0.95);
  assert.ok(similarity('ναι, το είδα', 'όχι ακόμα, αύριο ίσως') < 0.4);
  // A split part of a long message counts as a match.
  const whole = 'première partie du message assez longue. deuxième partie du message, encore plus longue';
  assert.ok(similarity(whole, 'deuxième partie du message, encore plus longue') >= 0.8);
});

test('import-turns match: the window after the request, one message used once, one channel per turn', () => {
  const t0 = Date.UTC(2026, 8, 25, 10, 0, 0);
  const turns = [
    { id: 'gen-1', createdAt: t0, genMs: 20_000, messages: ['ναι, το είδα', 'και μετά;'] },
    { id: 'gen-2', createdAt: t0 + 60_000, genMs: 20_000, messages: ['ναι, το είδα'] },
    { id: 'gen-3', createdAt: t0 + 3_600_000, genMs: 20_000, messages: ['πολύ αργά'] },
  ];
  const lines = [
    { messageId: 'm1', at: t0 + 25_000, channelId: 'c1', text: 'ναι, το είδα' },
    { messageId: 'm2', at: t0 + 30_000, channelId: 'c1', text: 'και μετά;' },
    { messageId: 'm3', at: t0 + 90_000, channelId: 'c1', text: 'ναι, το είδα' },
    { messageId: 'm9', at: t0 + 26_000, channelId: 'c2', text: 'κάτι άλλο εντελώς' },
    // Posted before the request: never its answer.
    { messageId: 'm4', at: t0 + 3_590_000, channelId: 'c1', text: 'πολύ αργά' },
    // Posted long after the window: never its answer.
    { messageId: 'm5', at: t0 + 3_600_000 + 20_000 + 4 * 60_000, channelId: 'c1', text: 'πολύ αργά' },
  ];
  const result = matchTurns(turns, lines, { slackMs: 3 * 60_000, minSimilarity: 0.6 });
  assert.deepEqual(result.get('gen-1').posted.map((post) => post.messageId), ['m1', 'm2']);
  assert.equal(result.get('gen-1').channelId, 'c1');
  assert.deepEqual(result.get('gen-2').posted.map((post) => post.messageId), ['m3']);
  assert.deepEqual(result.get('gen-3').posted, []);
  assert.ok(result.get('gen-1').scores.every((score) => score >= 0.6));
});

// ---- the tool -------------------------------------------------------------------

const CSV_HEADER = 'generation_id,created_at,tokens_prompt,tokens_completion,model_permaslug,finish_reason_normalized,api_key_name,generation_time\n';
const T1 = Date.UTC(2026, 9, 1, 10, 0, 0);
const T2 = Date.UTC(2026, 9, 1, 11, 0, 0);
const T3 = Date.UTC(2026, 9, 2, 9, 0, 0);
const T_LIVE = Date.UTC(2026, 9, 13, 12, 40, 0);
const csvTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** A bot directory: a record with the persona's own lines, a journal whose first live record is on 10-13, a CSV. */
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-import-turns-'));
  const dataDir = path.join(root, 'data');
  const cache = path.join(root, 'cache');
  const stores = [createAppendStore({ fsyncMs: 0, log: quiet }), createAppendStore({ fsyncMs: 0, log: quiet })];
  const record = createRecord({ appendStore: stores[0], dataDir, log: quiet });
  await record.append(GUILD, [
    { kind: 'seen', messageId: '1001', revision: 1, occurredAt: new Date(T1 - 60_000).toISOString(), scope: { channel: 'c1' }, by: ELENI, text: 'είδες το φεγγάρι;', participants: [ELENI] },
    { kind: 'said', messageId: '1002', revision: 1, occurredAt: new Date(T1 + 15_000).toISOString(), scope: { channel: 'c1' }, replyTo: '1001', text: `<@${ELENI}> ναι, το είδα <:moon:123456789012345678>`, participants: [ELENI] },
    { kind: 'said', messageId: '1003', revision: 1, occurredAt: new Date(T1 + 20_000).toISOString(), scope: { channel: 'c1' }, replyTo: null, text: 'ήταν τεράστιο', participants: [] },
    { kind: 'said', messageId: '1009', revision: 1, occurredAt: new Date(T3 + 30_000).toISOString(), scope: { channel: 'c2' }, replyTo: null, text: 'à demain, café crème', participants: [] },
  ]);
  await Promise.all(stores.map((store) => store.close()));
  // The journal's first live record.
  const journalStore = createAppendStore({ fsyncMs: 0, log: quiet });
  const journal = createJournal({ appendStore: journalStore, dataDir, now: () => T_LIVE, log: quiet });
  await journal.system(GUILD, { event: 'start' });
  await journalStore.close();
  fs.writeFileSync(path.join(dataDir, 'guilds', GUILD, 'record', 'backfill.json'), JSON.stringify({ selfId: SELF, selfName: 'Ariadne' }));
  const input = (system) => ({ messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text: '<task>\nAnswer #3.\n</task>' }] }] });
  const bodies = {
    'gen-1': { data: { input: input(REPLY_SYSTEM), output: '<think>Η Ελένη ρωτά για το φεγγάρι.</think><msg reply="#3">@Ελένη ναι, το είδα :moon:</msg><msg>ήταν τεράστιο</msg>' } },
    'gen-2': { data: { input: input(REPLY_SYSTEM), output: '<think>τίποτα να πω</think><skip/>' } },
    'gen-3': { data: { input: input(REPLY_SYSTEM), output: '<msg>à demain, café crème</msg>' } },
    'gen-4': { data: { input: input('You maintain the memory of a Discord server.'), output: '{"users":[]}' } },
    'gen-5': { data: { input: input(REPLY_SYSTEM), output: '<msg>κανείς δεν το είδε αυτό</msg>' } },
    'gen-late': { data: { input: input(REPLY_SYSTEM), output: '<msg>μετά</msg>' } },
  };
  const csv = path.join(root, 'gens.csv');
  fs.writeFileSync(csv, CSV_HEADER + [
    `gen-1,${csvTime(T1)},1000,50,vendor/voice,stop,persona,9000`,
    `gen-2,${csvTime(T2)},1000,10,vendor/voice,stop,persona,4000`,
    `gen-3,${csvTime(T3)},1000,10,vendor/voice,stop,persona,4000`,
    `gen-4,${csvTime(T3 + 5000)},1000,10,vendor/voice,stop,persona,4000`,
    `gen-5,${csvTime(T3 + 7_200_000)},1000,10,vendor/voice,stop,persona,4000`,
    `gen-late,${csvTime(T_LIVE + 60_000)},1000,10,vendor/voice,stop,persona,4000`,
  ].join('\n'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    const id = new URL(url).searchParams.get('id');
    calls.push({ id, auth: options?.headers?.Authorization });
    const body = bodies[id];
    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body ?? { error: 'not found' } };
  };
  const hot = {
    config: { bot: {}, journal: { thinkChars: 10 }, image: { maxPromptChars: 1600 } },
    prompts: { 'system-prompt': TEMPLATE },
  };
  const run = (argv) => main(['--csv', csv, '--cache', cache, ...argv], {
    cwd: root, rootDir: root, now: () => NOW, hot, fetchImpl, apiKey: 'test-key', log: quiet, sleep: async () => {},
  });
  const journalFiles = () => fs.readdirSync(path.join(dataDir, 'guilds', GUILD, 'journal')).filter((name) => name.endsWith('.jsonl')).sort();
  const readDay = (day) => fs.readFileSync(path.join(dataDir, 'guilds', GUILD, 'journal', `${day}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { root, dataDir, cache, calls, run, journalFiles, readDay };
}

test('import-turns dry run: counts only, no journal write, no message text; a rerun fetches nothing again', async () => {
  const kit = await fixture();
  const out = await kit.run([]);
  assert.deepEqual(kit.journalFiles(), ['2026-10-13.jsonl']);
  // The generation at or after the first live record is never fetched.
  assert.deepEqual(kit.calls.map((call) => call.id).sort(), ['gen-1', 'gen-2', 'gen-3', 'gen-4', 'gen-5']);
  assert.ok(kit.calls.every((call) => call.auth === 'Bearer test-key'));
  assert.match(out, /dry run/);
  assert.match(out, /fetched: 5/);
  assert.match(out, /reply turns: 4/);
  assert.match(out, /matched: 2/);
  assert.match(out, /unmatched: 1/);
  assert.match(out, /skip: 1/);
  assert.match(out, /^ {2}key persona: 5$/m);
  // A skip has no posted message to prove it was live: left out with the unmatched turn.
  assert.match(out, /unmatched left out: 2/);
  assert.match(out, /would write: 2/);
  assert.match(out, /^2026-10-01 /m);
  assert.match(out, /gen-1 -> 1002, 1003/);
  for (const text of ['φεγγάρι', 'είδα', 'café', 'τεράστιο', 'κανείς']) assert.equal(out.includes(text), false, text);
  // The cache keeps the output and the start of the system prompt, never the whole input.
  const cached = JSON.parse(fs.readFileSync(path.join(kit.cache, 'gen-1.json'), 'utf8'));
  assert.equal(cached.output.includes('<msg'), true);
  assert.ok(cached.system.length <= 200);
  assert.equal(JSON.stringify(cached).includes('<chat>'), false);
  kit.calls.length = 0;
  const again = await kit.run([]);
  assert.equal(kit.calls.length, 0);
  assert.match(again, /fetched: 0/);
  assert.match(again, /cached: 5/);
});

test('import-turns write: imported turn records the message lookup finds; unmatched only on request; nothing twice', async () => {
  const kit = await fixture();
  const out = await kit.run(['--write']);
  assert.match(out, /written: 2/);
  assert.match(out, /unmatched left out: 2/);
  assert.equal(kit.readDay('2026-10-02').some((record) => record.sourceGenerationId === 'gen-5'), false);
  assert.deepEqual(kit.journalFiles(), ['2026-10-01.jsonl', '2026-10-02.jsonl', '2026-10-13.jsonl']);
  const day1 = kit.readDay('2026-10-01');
  assert.equal(day1.length, 1);
  const spoke = day1.find((record) => record.sourceGenerationId === 'gen-1');
  assert.equal(spoke.kind, 'turn');
  assert.equal(spoke.origin, 'imported');
  assert.equal(spoke.mode, 'reply');
  assert.equal(spoke.outcome, 'spoke');
  assert.equal(spoke.occurredAt, new Date(T1).toISOString());
  assert.deepEqual(spoke.scope, { channel: 'c1' });
  assert.deepEqual(spoke.posted.map((post) => post.messageId), ['1002', '1003']);
  assert.ok(spoke.participants.includes(ELENI));
  // Capped like a live record (journal.thinkChars).
  assert.equal(spoke.thinkTruncated, true);
  assert.ok(Array.from(spoke.think).length <= 11);
  assert.equal(day1.some((record) => record.sourceGenerationId === 'gen-2'), false);

  // The owner's lookup by message reads them.
  const store = createAppendStore({ fsyncMs: 0, log: quiet });
  const journal = createJournal({ appendStore: store, dataDir: kit.dataDir, log: quiet });
  const found = await journal.findTurn(GUILD, { messageId: '1003', at: T1 + 20_000 });
  assert.equal(found.turn.sourceGenerationId, 'gen-1');
  assert.deepEqual(found.posted, ['1002', '1003']);
  const other = await journal.findTurn(GUILD, { messageId: '1009', at: T3 + 30_000 });
  assert.equal(other.turn.sourceGenerationId, 'gen-3');
  await store.close();

  const again = await kit.run(['--write']);
  assert.match(again, /written: 0/);
  assert.match(again, /already imported: 2/);
  assert.equal(kit.readDay('2026-10-01').length, 1);

  const withUnmatched = await kit.run(['--write', '--include-unmatched']);
  assert.match(withUnmatched, /written: 2/);
  const skipped = kit.readDay('2026-10-01').find((record) => record.sourceGenerationId === 'gen-2');
  assert.equal(skipped.outcome, 'skip');
  assert.deepEqual(skipped.posted, []);
  const unmatched = kit.readDay('2026-10-02').find((record) => record.sourceGenerationId === 'gen-5');
  assert.equal(unmatched.outcome, 'spoke');
  assert.deepEqual(unmatched.posted, []);
  assert.equal(unmatched.importMatch.unmatched, true);
  assert.equal(kit.readDay('2026-10-02').length, 2);
});

test('import-turns write: refused while the bot runs; the cache never under data/', async () => {
  const kit = await fixture();
  const running = path.join(kit.dataDir, 'guilds', GUILD, 'journal', '.running');
  fs.writeFileSync(running, '{}\n');
  await assert.rejects(kit.run(['--write']), (err) => err instanceof CliError && /running/.test(err.message));
  fs.rmSync(running);
  await assert.rejects(
    main(['--csv', path.join(kit.root, 'gens.csv'), '--cache', path.join(kit.dataDir, 'cache')], { cwd: kit.root, rootDir: kit.root, hot: { config: {}, prompts: {} }, fetchImpl: async () => { throw new Error('no'); }, apiKey: 'k', log: quiet }),
    (err) => err instanceof CliError && /data/.test(err.message),
  );
  assert.deepEqual(kit.journalFiles(), ['2026-10-13.jsonl']);
});
