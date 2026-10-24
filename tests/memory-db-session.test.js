// Her memory session (src/memory/db/session.js, session-write.js): the request, the answer's checks, the id mapping, shadow
// and apply writes, the refusals. A fake llm and synthetic Greek and accented Latin text only; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.js';
import { applyMemoryWrite } from '../src/memory/db/session-write.js';
import {
  CODES, batchOf, buildSessionRequest, cursorKey, memoryKeyState, memorySessionStatusLine, parseSessionAnswer, refusalOf, scopesOf,
  sessionSettings, sessionStatus, sweep, validateAnswer,
} from '../src/memory/db/session.js';
import { channelPlaceId, dmPlaceId, guildPlaceId, messageSourceId, personId, SELF_PERSON } from '../src/memory/db/ids.js';
import { roleApiKey, STRICT_KEY_ROLES } from '../src/llm/openrouter.js';
import { MEMORY_ROLE, MEMORY_ROLE_DEFAULT, roleConfigKeys, roleModel } from '../src/llm/roles.js';
import { createMemoryDb } from '../src/memory/db/service.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { buildDataDir } from './fixtures/memory-db/datadir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ADA = 'u-ada';
const BOB = 'u-bob';
const GUILD = 'G1';
const CHANNEL = channelPlaceId('c1');
const SELF_ACCOUNT = 'discord:u-self';

const prompts = {
  'system-prompt': 'SYSTEM {{name}}',
  'character-card': 'CARD {{name}}',
  rules: 'RULES',
  format: 'FORMAT',
  'memory-session': 'SESSION {{name}}',
  labels,
};
const baseConfig = (session = {}, extra = {}) => ({
  bot: { timezone: 'UTC' },
  models: { memory: 'x/memory' },
  llm: { temperature: 1, keyByRole: { memory: 'OPENROUTER_MEMORY_KEY' } },
  relationships: { maxDeltaPerUpdate: 5 },
  memoryDb: { read: true, session: { mode: 'shadow', minMessages: 1, ...session } },
  ...extra,
});

/** A fake llm: answers from a script (a string, an Error, or a function of the messages and options), records the calls. */
function fakeLlm(given) {
  const script = typeof given === 'function' || Array.isArray(given) ? given : [given];
  const calls = [];
  return {
    calls,
    async complete(messages, options) {
      calls.push({ messages, options });
      const next = typeof script === 'function' ? script(messages, options, calls.length) : script[Math.min(calls.length - 1, script.length - 1)];
      if (next instanceof Error) throw next;
      return { text: next, usage: { prompt_tokens: 1000, completion_tokens: 50 } };
    },
  };
}

function fixture() {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  const group = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
  const api = {
    handle,
    db,
    group,
    say({ native, minutesAgo, text, author = ADA, kind = 'seen', direct = 0, place = CHANNEL, scope = group, revision = 1 }) {
      const at = new Date(NOW - minutesAgo * MINUTE).toISOString();
      db.prepare(`INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, recorded_at, text, direct,
        scope_kind, scope_iface, scope_dm) VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(messageSourceId(native, revision, kind), kind, String(native), revision, place, kind === 'said' ? SELF_ACCOUNT : `discord:${author}`, at, at, text, direct, scope.scope_kind, scope.scope_iface, scope.scope_dm);
      return messageSourceId(native, revision, kind);
    },
    claim({ id, subjectKind = 'person', subjectId, kind = 'interest', text, scope = group, truth = 'current', shown = 1 }) {
      db.prepare(`INSERT INTO claims (id, subject_kind, subject_id, kind, text, how, author, truth, shown, scope_kind, scope_iface, scope_dm, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, 'legacy', 'import', ?, ?, ?, ?, ?, '2026-10-01', '2026-10-20')`).run(id, subjectKind, subjectId, kind, text, truth, shown, scope.scope_kind, scope.scope_iface, scope.scope_dm);
    },
    done() { handle.close(); },
  };
  db.prepare("INSERT INTO people (id, kind, affinity) VALUES (?, 'member', 5)").run(personId(ADA));
  db.prepare("INSERT INTO people (id, kind, affinity) VALUES (?, 'member', 0)").run(personId(BOB));
  db.prepare("INSERT INTO accounts (id, iface, native_id, person_id, names) VALUES (?, 'discord', ?, ?, ?)").run(`discord:${ADA}`, ADA, personId(ADA), JSON.stringify(['Ada', 'Old Ada']));
  db.prepare("INSERT INTO accounts (id, iface, native_id, person_id, names) VALUES (?, 'discord', ?, ?, ?)").run(`discord:${BOB}`, BOB, personId(BOB), JSON.stringify(['Βασίλης']));
  db.prepare("INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'guild', ?, NULL, 'group', 'Server', NULL)").run(guildPlaceId(GUILD), GUILD);
  db.prepare("INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'channel', 'c1', ?, 'group', 'general', 'chat')").run(CHANNEL, guildPlaceId(GUILD));
  return api;
}

/** Five lines in the group scope: Ada greets, Bob answers, one line is addressed to her, one is hers. */
function chat(env) {
  return {
    a: env.say({ native: 'm1', minutesAgo: 100, text: 'Καλημέρα, I like café mornings' }),
    b: env.say({ native: 'm2', minutesAgo: 90, text: 'ναι, σωστά', author: BOB }),
    c: env.say({ native: 'm3', minutesAgo: 80, text: 'hey you there?', direct: 1 }),
    d: env.say({ native: 'm4', minutesAgo: 70, text: 'I am here', kind: 'said' }),
    e: env.say({ native: 'm5', minutesAgo: 60, text: 'I moved to Thessaloniki' }),
  };
}

let clock = 0;

function ctxOf(env, { llm, config = baseConfig(), promptSet = prompts, envVars = { OPENROUTER_MEMORY_KEY: 'k' }, write } = {}) {
  return {
    db: env.db,
    write: write ?? (async (update) => applyMemoryWrite(env.handle, update)),
    llm,
    hot: { config, prompts: promptSet },
    env: envVars,
    now: () => NOW + (clock += 1000),
    log: {},
    selfName: 'Nep',
  };
}

const memoryBlock = (value) => `<think>reading</think>\n<memory>\n${JSON.stringify(value)}\n</memory>`;
const count = (db, table, where = '1 = 1') => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const request = (env, config = baseConfig()) => {
  const scope = scopesOf(env.db)[0];
  const batch = batchOf(env.db, scope.scope, { cursor: 0, since: null, maxMessages: 200, settleBefore: NOW - 10 * MINUTE });
  return { scope, batch, ...buildSessionRequest({ db: env.db, scope, batch, config, prompts, selfName: 'Nep', now: NOW }) };
};

test('the memory role: its own model key, its own key variable, no other key stands in', async () => {
  assert.deepEqual(roleConfigKeys(MEMORY_ROLE), ['models', 'memory']);
  assert.equal(roleModel({ models: { memory: 'x/m', core: 'x/c' } }, 'memory'), 'x/m');
  assert.equal(roleModel({ models: { core: 'x/c' } }, 'memory'), MEMORY_ROLE_DEFAULT, 'unset: its own default, never the core key');
  assert.ok(STRICT_KEY_ROLES.includes('memory'));
  const config = { llm: { keyByRole: { memory: 'OPENROUTER_MEMORY_KEY' } } };
  assert.equal(roleApiKey(config, { OPENROUTER_MEMORY_KEY: 'mine' }, 'memory', 'main'), 'mine');
  const { result } = await withCapturedLogs(() => roleApiKey(config, {}, 'memory', 'main'));
  assert.equal(result, '', 'unset variable: no key, never the main key');
  assert.equal(roleApiKey({ llm: {} }, { OPENROUTER_API_KEY: 'x' }, 'memory', 'main'), '', 'unmapped: no key either');
  assert.equal(roleApiKey({ llm: {} }, {}, 'core', 'main'), 'main', 'other roles keep the main key');
});

test('refusals: off, no key, apply while the JSON files write, no prompt; the key state names a variable, never a value', () => {
  const env = { OPENROUTER_MEMORY_KEY: 'secret' };
  assert.equal(refusalOf(baseConfig({ mode: 'off' }), env, prompts), CODES.OFF);
  assert.equal(refusalOf(baseConfig(), {}, prompts), CODES.NOT_CONFIGURED);
  assert.equal(refusalOf(baseConfig(), { OPENROUTER_MEMORY_KEY: '  ' }, prompts), CODES.NOT_CONFIGURED);
  assert.equal(refusalOf(baseConfig({ mode: 'apply' }, { memoryDb: { read: false, session: { mode: 'apply' } } }), env, prompts), CODES.APPLY_REFUSED);
  assert.equal(refusalOf(baseConfig({ mode: 'apply' }), env, prompts), null);
  assert.equal(refusalOf(baseConfig(), env, { ...prompts, 'memory-session': '' }), CODES.NO_PROMPT);
  assert.deepEqual(memoryKeyState(baseConfig(), env), { ok: true, name: 'OPENROUTER_MEMORY_KEY' });
  assert.deepEqual(memoryKeyState({ llm: { keyByRole: { memory: 'sk-or-pasted-key' } } }, env), { ok: false, name: null });
  assert.equal(sessionSettings({}).mode, 'off');
  assert.equal(sessionSettings({ memoryDb: { session: { mode: 'bogus' } } }).mode, 'off');
});

test('the request: the her-turn system text then the session prompt; blocks in the contract order; lines numbered, addressed and own lines marked', () => {
  const env = fixture();
  try {
    chat(env);
    env.claim({ id: 'cl-ada', subjectId: personId(ADA), kind: 'interest', text: 'likes café mornings' });
    env.claim({ id: 'cl-self', subjectKind: 'self', subjectId: SELF_PERSON, kind: 'self_fact', text: 'keeps a small garden', scope: { scope_kind: 'none', scope_iface: null, scope_dm: null } });
    env.claim({ id: 'cl-place', subjectKind: 'place', subjectId: guildPlaceId(GUILD), kind: 'injoke', text: 'the soup incident' });
    env.claim({ id: 'cl-gone', subjectId: personId(ADA), text: 'hidden one', shown: 0 });
    env.db.prepare("INSERT INTO episodes (id, kind, subject_id, date, what, feeling, status, scope_kind, scope_iface) VALUES ('ep-1', 'profile', ?, '2026-10-10', 'Ada helped with the move', 'warm', 'open', 'group', 'discord')").run(personId(ADA));
    env.db.prepare("INSERT INTO intentions (id, record, status, scope_kind, scope_iface, archived) VALUES ('i1', ?, 'pending', 'group', 'discord', 0)")
      .run(JSON.stringify({ id: 'i1', status: 'pending', purpose: 'ask Ada about the move', provenance: { participants: [ADA] } }));
    const built = request(env);
    const [system, user] = built.messages;
    assert.equal(system.role, 'system');
    assert.equal(system.content, 'SYSTEM Nep\n\nCARD Nep\n\nRULES\n\nFORMAT\n\nSESSION Nep');
    assert.equal(user.role, 'user');
    const order = ['<self>', '<place>', '<people>', '<episodes>', '<intentions>', '<batch>'].map((tag) => user.content.indexOf(tag));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `blocks in order: ${order}`);
    const batch = user.content.slice(user.content.indexOf('<batch>')).split('\n');
    assert.equal(batch[1], 'cutoff: 2026-10-24 11:00', 'the cutoff is stated at the top');
    assert.equal(batch[2], '#1 [2026-10-24 10:20] Ada: Καλημέρα, I like café mornings', 'the account name, not the account id');
    assert.equal(batch[3], '#2 [2026-10-24 10:30] Βασίλης: ναι, σωστά');
    assert.equal(batch[4], '→ #3 [2026-10-24 10:40] Ada: hey you there?', 'addressed to her: led by an arrow');
    assert.equal(batch[5], '#4 [2026-10-24 10:50] Nep (you): I am here', 'her own line: her self label');
    assert.equal(batch[6], '#5 [2026-10-24 11:00] Ada: I moved to Thessaloniki');
    // The ids the answer may use stand for database ids.
    assert.equal(built.maps.sources.get('#1'), chat_ids(env).a);
    assert.equal(built.maps.sources.size, 5);
    const claimIds = [...built.maps.claims.entries()];
    assert.ok(claimIds.some(([label, id]) => label.startsWith('s') && id === 'cl-self'), 'her own claim is s1');
    assert.ok(claimIds.some(([label, id]) => label.startsWith('c') && id === 'cl-ada'));
    assert.ok(claimIds.some(([label, id]) => label.startsWith('c') && id === 'cl-place'));
    assert.ok(!claimIds.some(([, id]) => id === 'cl-gone'), 'a claim that is not shown has no id in the request');
    assert.deepEqual([...built.maps.episodes.entries()], [['e1', 'ep-1']]);
    const people = user.content.slice(user.content.indexOf('<people>'), user.content.indexOf('</people>'));
    assert.match(people, /## Ada/);
    assert.match(people, /id: <@u-ada>/);
    assert.match(people, /affinity: 5/);
    assert.match(people, /\[c\d+\] interest: likes café mornings/);
    assert.match(user.content, /\[e1\] 2026-10-10 Ada: Ada helped with the move \(warm\)/);
    assert.match(user.content, /open|pending: ask Ada about the move|pending: ask Ada/);
    assert.match(user.content, /<place>\nscope: group\nchannel: general - chat/);
  } finally {
    env.done();
  }
});

const chat_ids = (env) => ({ a: messageSourceId('m1', 1, 'seen') });

test('the answer: a block after the thinking; a fence around it, a missing close tag and a thinking block with braces are read; the rest is refused by code', () => {
  assert.deepEqual(parseSessionAnswer(memoryBlock({ claims: [] })), { ok: true, value: { claims: [] } });
  assert.deepEqual(parseSessionAnswer('<think>{"claims": [1]} <memory>{}</memory></think><memory>```json\n{"claims": []}\n```</memory>'), { ok: true, value: { claims: [] } });
  assert.equal(parseSessionAnswer('<memory>{"episodes": []}').ok, true, 'cut off before the close tag, still whole JSON');
  assert.deepEqual(parseSessionAnswer('<think>only thinking</think>'), { ok: false, code: 'no_block' });
  assert.deepEqual(parseSessionAnswer('<memory>{"claims": [</memory>'), { ok: false, code: 'bad_json' });
  assert.deepEqual(parseSessionAnswer('<memory>[1, 2]</memory>'), { ok: false, code: 'not_object' });
  assert.deepEqual(parseSessionAnswer(undefined), { ok: false, code: 'no_block' });
});

test('validation: ids map back to the database; what the request did not carry is dropped and counted, never guessed', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personId(ADA), text: 'likes café mornings' });
    env.claim({ id: 'cl-self', subjectKind: 'self', subjectId: SELF_PERSON, kind: 'self_fact', text: 'keeps a small garden' });
    const built = request(env);
    const check = (value) => validateAnswer(value, { maps: built.maps, people: built.people, placeId: guildPlaceId(GUILD), scopeKey: 'group:discord' });
    const label = [...built.maps.claims.entries()].find(([, id]) => id === 'cl-ada')[0];
    const selfLabel = [...built.maps.claims.entries()].find(([, id]) => id === 'cl-self')[0];
    const { plan, counts } = check({
      claims: [
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'moved to Thessaloniki', how: 'said', sources: ['#5'], when: '2026-10' },
        { op: 'add', subject: 'ada', kind: 'detail', text: 'same person by a folded name', how: 'saw', sources: [5] },
        { op: 'add', subject: 'place', kind: 'injoke', text: 'a joke', how: 'saw', sources: ['#1', '#99'] },
        { op: 'add', subject: 'self', kind: 'self_fact', text: 'I answered a greeting', how: 'saw', sources: ['#4'] },
        { op: 'add', subject: personId(BOB), kind: 'interest', text: 'Greek texts', how: 'inferred', sources: ['#2'] },
        { op: 'confirm', id: label, sources: ['#1'] },
        { op: 'revise', id: label, text: 'likes tea mornings', how: 'said', sources: ['#5'], reason: 'said so' },
        { op: 'retire', id: selfLabel, truth: 'disputed', reason: 'contradicted', sources: ['#3'] },
        // dropped
        { op: 'add', subject: 'Nobody', kind: 'detail', text: 'x', how: 'said', sources: ['#1'] },
        { op: 'add', subject: 'Ada', kind: 'mood', text: 'x', how: 'said', sources: ['#1'] },
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'x', how: 'dreamed', sources: ['#1'] },
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'x', how: 'said', sources: ['#42'] },
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'x', how: 'said', sources: [] },
        { op: 'add', subject: 'Ada', kind: 'detail', text: '  ', how: 'said', sources: ['#1'] },
        { op: 'confirm', id: 'c999', sources: ['#1'] },
        { op: 'confirm', id: 'cl-ada', sources: ['#1'] },
        { op: 'retire', id: label, truth: 'gone', sources: ['#1'] },
        { op: 'forget', id: label, sources: ['#1'] },
        'text',
      ],
      episodes: [{ subject: 'Ada', what: 'helped with the move', feeling: 'warm', sources: ['#5'] }, { subject: 'Ada', what: 'no source', sources: [] }],
      affinity: [{ person: 'Βασίλης', delta: 2.4, reason: 'kind', sources: ['#2'] }, { person: 'Ada', delta: 0, sources: ['#1'] }, { person: 'Ada', delta: 'up', sources: ['#1'] }],
      descriptions: [{ subject: 'Ada', field: 'character', why: 'new facts' }, { subject: 'Ada', field: 'height', why: 'x' }],
    });
    assert.deepEqual(plan.claims.map((claim) => [claim.op, claim.subjectKind, claim.subjectId]), [
      ['add', 'person', personId(ADA)], ['add', 'person', personId(ADA)], ['add', 'place', guildPlaceId(GUILD)], ['add', 'self', SELF_PERSON], ['add', 'person', personId(BOB)],
      ['confirm', undefined, undefined], ['revise', undefined, undefined], ['retire', undefined, undefined],
    ]);
    assert.deepEqual(plan.claims[0].sources, [ids.e], 'a #n is the line it numbered');
    assert.equal(plan.claims[0].when, '2026-10');
    assert.deepEqual(plan.claims[2].sources, [ids.a], 'an unknown source is dropped, the other holds the claim');
    assert.equal(plan.claims[5].id, 'cl-ada', 'cN back to the claim id');
    assert.equal(plan.claims[7].id, 'cl-self');
    assert.deepEqual(plan.episodes, [{ subjectId: personId(ADA), what: 'helped with the move', feeling: 'warm', sources: [ids.e] }]);
    assert.deepEqual(plan.affinity, [{ personId: personId(BOB), delta: 2, reason: 'kind', sources: [ids.b] }], 'a name resolves, the delta is whole');
    assert.deepEqual(plan.descriptions, [{ subjectKind: 'person', subjectId: personId(ADA), field: 'character', why: 'new facts' }]);
    assert.equal(counts.kept, 8 + 1 + 1 + 1);
    assert.deepEqual(counts.dropped, {
      unknown_source: 2, unknown_subject: 1, bad_kind: 1, bad_how: 1, no_sources: 3, no_text: 1, unknown_id: 2, bad_truth: 1, bad_op: 2, bad_delta: 2, bad_field: 1,
    });
    // a part that is not a list; two people with one name
    assert.deepEqual(check({ claims: 'x', episodes: {} }).counts.dropped, { claims_not_list: 1, episodes_not_list: 1 });
    env.db.prepare("UPDATE accounts SET names = ? WHERE id = ?").run(JSON.stringify(['Ada']), `discord:${BOB}`);
    const twin = request(env);
    const result = validateAnswer({ episodes: [{ subject: 'Ada', what: 'x', sources: ['#1'] }] }, { maps: twin.maps, people: twin.people, placeId: null });
    assert.deepEqual(result.counts.dropped, { unknown_subject: 1 }, 'a name two people share names no one');
    assert.equal(validateAnswer({ claims: [{ op: 'add', subject: 'place', kind: 'detail', text: 'x', how: 'said', sources: ['#1'] }] }, { maps: twin.maps, people: twin.people, placeId: null }).counts.dropped.unknown_subject, 1);
  } finally {
    env.done();
  }
});

test('a shadow sweep: one request on the memory role, every proposal a decisions row, one session_runs row, the cursor moved, nothing else touched', async () => {
  const env = fixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personId(ADA), text: 'likes café mornings' });
    const label = () => [...request(env).maps.claims.entries()].find(([, id]) => id === 'cl-ada')[0];
    const llm = fakeLlm(() => memoryBlock({
      claims: [{ op: 'add', subject: 'Ada', kind: 'detail', text: 'moved to Thessaloniki', how: 'said', sources: ['#5'] }, { op: 'confirm', id: label(), sources: ['#1'] }, { op: 'confirm', id: 'c77', sources: ['#1'] }],
      episodes: [{ subject: 'Ada', what: 'greeted me', feeling: 'glad', sources: ['#1'] }],
      affinity: [{ person: 'Ada', delta: 2, reason: 'friendly', sources: ['#3'] }],
      descriptions: [{ subject: 'Ada', field: 'character', why: 'new facts' }],
    }));
    const before = { claims: count(env.db, 'claims'), versions: count(env.db, 'claim_versions'), episodes: count(env.db, 'episodes'), events: count(env.db, 'affinity_events') };
    const result = await sweep(ctxOf(env, { llm }));
    assert.equal(result.status, 'ok');
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].outcome, 'ok');
    // the request
    assert.equal(llm.calls.length, 1);
    const { options, messages } = llm.calls[0];
    assert.equal(options.role, 'memory');
    assert.equal(options.purpose, 'memory-session');
    assert.equal(options.model, 'x/memory');
    assert.equal(Object.hasOwn(options, 'reasoning'), false, 'provider reasoning stays off');
    assert.equal(messages.length, 2);
    // the writes
    const decisions = env.db.prepare('SELECT by, action, target_kind, target_id, extra FROM decisions ORDER BY id').all();
    assert.equal(decisions.length, 5);
    assert.ok(decisions.every((row) => row.by === 'her'));
    assert.deepEqual(decisions.map((row) => row.action).sort(), ['proposed:add', 'proposed:affinity', 'proposed:confirm', 'proposed:description', 'proposed:episode']);
    const add = decisions.find((row) => row.action === 'proposed:add');
    assert.equal(JSON.parse(add.extra).op.text, 'moved to Thessaloniki', 'the whole op rides in extra');
    assert.deepEqual(JSON.parse(add.extra).op.sources, [ids.e]);
    assert.equal(decisions.find((row) => row.action === 'proposed:confirm').target_id, 'cl-ada');
    assert.deepEqual({ claims: count(env.db, 'claims'), versions: count(env.db, 'claim_versions'), episodes: count(env.db, 'episodes'), events: count(env.db, 'affinity_events') }, before, 'shadow touches no claim, episode or attitude');
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId(ADA)).affinity, 5);
    const run = env.db.prepare('SELECT * FROM session_runs').get();
    assert.equal(run.mode, 'shadow');
    assert.equal(run.scope_key, 'group:discord');
    assert.equal(run.scope_kind, 'group');
    assert.equal(run.sources_n, 5);
    assert.equal(run.tokens_prompt, 1000);
    assert.equal(run.tokens_completion, 50);
    assert.equal(run.model, 'x/memory');
    assert.equal(run.outcome, 'ok');
    assert.equal(run.cursor_from, 0);
    assert.ok(run.cursor_to > 0);
    const counts = JSON.parse(run.counts);
    assert.equal(counts.claims, 2);
    assert.deepEqual(counts.dropped, { unknown_id: 1 });
    assert.equal(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('shadow', 'group:discord')).value, String(run.cursor_to));
    // a second sweep finds nothing new: no request
    const again = await sweep(ctxOf(env, { llm }), { ignoreSweepCap: true });
    assert.deepEqual(again.runs.map((entry) => entry.outcome), ['quiet']);
    assert.equal(llm.calls.length, 1);
    // new lines are read from the cursor on, and only them
    env.say({ native: 'm6', minutesAgo: 30, text: 'a later line' });
    const third = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})) }), { ignoreSweepCap: true });
    assert.equal(third.runs[0].lines, 1);
  } finally {
    env.done();
  }
});

test('an answer that cannot be read leaves the cursor and writes only its run; a failed request the same; a partial answer keeps what holds', async () => {
  const env = fixture();
  try {
    chat(env);
    const bad = await sweep(ctxOf(env, { llm: fakeLlm('I think nothing') }));
    assert.equal(bad.runs[0].outcome, 'bad_answer');
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 0, 'the lines stay for the next sweep');
    assert.equal(env.db.prepare('SELECT outcome, errors FROM session_runs').get().outcome, 'bad_answer');
    assert.deepEqual(JSON.parse(env.db.prepare('SELECT errors FROM session_runs').get().errors), ['no_block']);
    const down = await sweep(ctxOf(env, { llm: fakeLlm(Object.assign(new Error('boom'), { code: 'ECONNRESET' })) }), { ignoreSweepCap: true });
    assert.equal(down.runs[0].outcome, 'llm_error');
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 0);
    const partial = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({ claims: [{ op: 'add', subject: 'Ada', kind: 'detail', text: 'ok', how: 'said', sources: ['#1'] }, { nonsense: true }], episodes: 'no' })) }), { ignoreSweepCap: true });
    assert.equal(partial.runs[0].outcome, 'ok');
    assert.equal(count(env.db, 'decisions'), 1);
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 1);
    assert.deepEqual(JSON.parse(env.db.prepare("SELECT counts FROM session_runs WHERE outcome = 'ok'").get().counts).dropped, { bad_op: 1, episodes_not_list: 1 });
  } finally {
    env.done();
  }
});

test('refused before any request: off, no key of its own, apply while the JSON files write, the daily sweep cap', async () => {
  const env = fixture();
  try {
    chat(env);
    const llm = fakeLlm(memoryBlock({}));
    const off = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'off' }) }));
    assert.deepEqual([off.status, off.code], ['off', 'off']);
    const keyless = await sweep(ctxOf(env, { llm, envVars: { OPENROUTER_API_KEY: 'main', OPENROUTER_CORE_KEY: 'core' } }));
    assert.deepEqual([keyless.status, keyless.code], ['refused', 'not_configured'], 'another key never stands in');
    const jsonWriter = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }, { memoryDb: { read: false, session: { mode: 'apply', minMessages: 1 } } }) }));
    assert.deepEqual([jsonWriter.status, jsonWriter.code], ['refused', 'APPLY_JSON_WRITER']);
    assert.equal(llm.calls.length, 0);
    assert.equal(count(env.db, 'session_runs'), 0);
    const config = baseConfig({ sweepsPerDay: 1 });
    await sweep(ctxOf(env, { llm, config }));
    env.say({ native: 'm9', minutesAgo: 20, text: 'more' });
    const capped = await sweep(ctxOf(env, { llm, config }));
    assert.deepEqual([capped.status, capped.code], ['refused', 'sweep_cap']);
    assert.equal(llm.calls.length, 1);
    // a request refused by the client for want of the key is the same state, and writes its run
    const noKey = fakeLlm(Object.assign(new Error('no key'), { code: 'ROLE_KEY_MISSING' }));
    const env2 = fixture();
    try {
      chat(env2);
      const refused = await sweep(ctxOf(env2, { llm: noKey }));
      assert.equal(refused.runs[0].outcome, 'not_configured');
    } finally { env2.done(); }
  } finally {
    env.done();
  }
});

test('a scope with too few lines waits; lines still settling are left; a deleted or edited line is read once, as it stands', async () => {
  const env = fixture();
  try {
    env.say({ native: 'm1', minutesAgo: 100, text: 'first' });
    env.say({ native: 'm2', minutesAgo: 90, text: 'second', revision: 1 });
    env.say({ native: 'm2', minutesAgo: 89, text: 'second, edited', revision: 2 });
    env.say({ native: 'm3', minutesAgo: 80, text: 'to be deleted' });
    env.db.prepare("INSERT INTO sources (id, kind, iface, native_id, place_id, occurred_at, scope_kind, scope_iface) VALUES ('src:discord:m3:none:deleted:x', 'deleted', 'discord', 'm3', ?, ?, 'group', 'discord')").run(CHANNEL, new Date(NOW - 70 * MINUTE).toISOString());
    env.say({ native: 'm4', minutesAgo: 5, text: 'still settling' });
    const scope = scopesOf(env.db)[0];
    const batch = batchOf(env.db, scope.scope, { cursor: 0, since: null, maxMessages: 200, settleBefore: NOW - 10 * MINUTE });
    assert.deepEqual(batch.map((line) => line.text), ['first', 'second, edited']);
    assert.deepEqual(batchOf(env.db, scope.scope, { cursor: 0, since: null, maxMessages: 1, settleBefore: NOW }).map((line) => line.text), ['first']);
    assert.deepEqual(batchOf(env.db, scope.scope, { cursor: 0, since: new Date(NOW - 95 * MINUTE).toISOString(), maxMessages: 200, settleBefore: NOW }).map((line) => line.text), ['second, edited', 'still settling']);
    const llm = fakeLlm(memoryBlock({}));
    const quiet = await sweep(ctxOf(env, { llm, config: baseConfig({ minMessages: 3 }) }));
    assert.deepEqual(quiet.runs.map((entry) => [entry.outcome, entry.lines]), [['quiet', 2]]);
    assert.equal(llm.calls.length, 0);
  } finally {
    env.done();
  }
});

test('private conversations are scopes of their own: one request each, the partner only, its cursor apart from the group', async () => {
  const env = fixture();
  try {
    chat(env);
    const dm = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personId(ADA) };
    env.say({ native: 'd1', minutesAgo: 50, text: 'a private word', scope: dm, place: dmPlaceId(ADA), direct: 1 });
    env.say({ native: 'd2', minutesAgo: 45, text: 'private reply', scope: dm, place: dmPlaceId(ADA), kind: 'said' });
    env.claim({ id: 'cl-dm', subjectId: personId(ADA), text: 'only in private', scope: dm });
    env.claim({ id: 'cl-pub', subjectId: personId(ADA), text: 'public one' });
    assert.deepEqual(scopesOf(env.db).map((scope) => scope.key), ['dm:discord:person:discord:u-ada', 'group:discord']);
    const llm = fakeLlm(memoryBlock({}));
    const result = await sweep(ctxOf(env, { llm }));
    assert.equal(result.runs.length, 2);
    assert.equal(llm.calls.length, 2);
    const [dmCall, groupCall] = llm.calls.map((call) => call.messages[1].content);
    assert.match(dmCall, /private word/);
    assert.doesNotMatch(dmCall, /Thessaloniki/, 'the group lines are not in the private request');
    assert.match(dmCall, /only in private/);
    assert.match(dmCall, /public one/, 'a private request may read the public claims');
    assert.doesNotMatch(groupCall, /private word|only in private/, 'the group request never carries a private line or claim');
    assert.match(groupCall, /public one/);
    const keys = env.db.prepare("SELECT key FROM meta WHERE key LIKE 'memory_session.cursor.%' ORDER BY key").all().map((row) => row.key);
    assert.deepEqual(keys, [cursorKey('shadow', 'dm:discord:person:discord:u-ada'), cursorKey('shadow', 'group:discord')]);
    assert.equal(llm.calls.length, 2);
    const only = await sweep(ctxOf(env, { llm }), { scope: 'group:discord', ignoreSweepCap: true });
    assert.equal(only.runs.length, 1);
  } finally {
    env.done();
  }
});

test('apply on a database that is the writer: claims with versions and sources, episodes, attitude, decisions; disputed stays shown, retired leaves', async () => {
  const env = fixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personId(ADA), text: 'likes café mornings' });
    env.claim({ id: 'cl-old', subjectId: personId(ADA), kind: 'detail', text: 'lives in Athens' });
    env.claim({ id: 'cl-gone', subjectId: personId(ADA), kind: 'detail', text: 'plays chess' });
    const labelOf = (id) => [...request(env).maps.claims.entries()].find(([, value]) => value === id)[0];
    const llm = fakeLlm(() => memoryBlock({
      claims: [
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'lives in Thessaloniki', how: 'said', sources: ['#5'], when: '2026-10' },
        { op: 'confirm', id: labelOf('cl-ada'), sources: ['#1'] },
        { op: 'revise', id: labelOf('cl-old'), text: 'moved from Athens', how: 'said', sources: ['#5'], reason: 'she said so' },
        { op: 'retire', id: labelOf('cl-gone'), truth: 'historical', reason: 'stopped', sources: ['#3'] },
      ],
      episodes: [{ subject: 'Ada', what: 'told me about the move', feeling: 'glad', sources: ['#5'] }],
      affinity: [{ person: 'Ada', delta: 40, reason: 'a warm talk', sources: ['#1'] }],
      descriptions: [{ subject: 'Ada', field: 'character', why: 'new facts' }],
    }));
    const config = baseConfig({ mode: 'apply' });
    const result = await sweep(ctxOf(env, { llm, config }));
    assert.equal(result.runs[0].outcome, 'ok');
    const added = env.db.prepare("SELECT * FROM claims WHERE author = 'her'").get();
    assert.equal(added.text, 'lives in Thessaloniki');
    assert.equal(added.subject_kind, 'person');
    assert.equal(added.subject_id, personId(ADA));
    assert.deepEqual([added.how, added.truth, added.shown, added.scope_kind, added.scope_iface], ['said', 'current', 1, 'group', 'discord']);
    assert.deepEqual(env.db.prepare('SELECT source_id FROM claim_sources WHERE claim_id = ?').all(added.id).map((row) => row.source_id), [ids.e]);
    assert.deepEqual(env.db.prepare('SELECT event, by, origin FROM claim_versions WHERE claim_id = ?').all(added.id).map((row) => [row.event, row.by, row.origin]), [['add', 'her', 'session']]);
    const confirmed = env.db.prepare("SELECT last_seen_at FROM claims WHERE id = 'cl-ada'").get();
    assert.match(confirmed.last_seen_at, /^2026-10-24T12:\d\d:\d\d\.000Z$/);
    assert.deepEqual(env.db.prepare("SELECT source_id FROM claim_sources WHERE claim_id = 'cl-ada'").all().map((row) => row.source_id), [ids.a]);
    const revised = env.db.prepare("SELECT text, how FROM claims WHERE id = 'cl-old'").get();
    assert.deepEqual([revised.text, revised.how], ['moved from Athens', 'said']);
    assert.equal(JSON.parse(env.db.prepare("SELECT extra FROM claim_versions WHERE claim_id = 'cl-old'").get().extra).before, 'lives in Athens');
    const retired = env.db.prepare("SELECT truth, shown, valid_to FROM claims WHERE id = 'cl-gone'").get();
    assert.deepEqual([retired.truth, retired.shown], ['historical', 0]);
    assert.ok(retired.valid_to);
    const episode = env.db.prepare('SELECT * FROM episodes').get();
    assert.deepEqual([episode.subject_id, episode.what, episode.feeling, episode.kind, episode.scope_kind], [personId(ADA), 'told me about the move', 'glad', 'session', 'group']);
    assert.deepEqual(env.db.prepare('SELECT source_id FROM episode_sources WHERE episode_id = ?').all(episode.id).map((row) => row.source_id), [ids.e]);
    const event = env.db.prepare('SELECT delta, applied, score FROM affinity_events').get();
    assert.deepEqual([event.delta, event.applied, event.score], [40, 5, 10], 'the step is capped by relationships.maxDeltaPerUpdate');
    assert.equal(env.db.prepare('SELECT affinity, affinity_reason FROM people WHERE id = ?').get(personId(ADA)).affinity, 10);
    const actions = env.db.prepare('SELECT action FROM decisions ORDER BY id').all().map((row) => row.action).sort();
    assert.deepEqual(actions, ['add', 'affinity', 'confirm', 'episode', 'flag:description', 'retire', 'revise']);
    assert.equal(count(env.db, 'decisions', "action LIKE 'proposed:%'"), 0);
    // a second answer: dispute keeps the claim shown; an id that has since left is counted, not written
    env.say({ native: 'm7', minutesAgo: 20, text: 'no, I never played chess' });
    const disputed = [...request(env).maps.claims.entries()].find(([, id]) => id === 'cl-old');
    const second = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({ claims: [{ op: 'retire', id: disputed[0], truth: 'disputed', reason: 'contradicted', sources: ['#1'] }] })), config }), { ignoreSweepCap: true });
    assert.equal(second.runs[0].outcome, 'ok');
    assert.deepEqual(Object.values(env.db.prepare("SELECT truth, shown FROM claims WHERE id = 'cl-old'").get()), ['disputed', 1]);
  } finally {
    env.done();
  }
});

test('the status of the session and its line', async () => {
  const env = fixture();
  try {
    chat(env);
    const config = baseConfig();
    const envVars = { OPENROUTER_MEMORY_KEY: 'k' };
    assert.equal(sessionStatus({ db: env.db, config: baseConfig({ mode: 'off' }), env: envVars, prompts, now: NOW }).state, 'off');
    assert.equal(sessionStatus({ db: env.db, config, env: {}, prompts, now: NOW }).state, 'not_configured');
    const refused = sessionStatus({ db: env.db, config: baseConfig({ mode: 'apply' }, { memoryDb: { read: false, session: { mode: 'apply' } } }), env: envVars, prompts, now: NOW });
    assert.deepEqual([refused.state, refused.code], ['refused', 'APPLY_JSON_WRITER']);
    await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})) }));
    const ready = sessionStatus({ db: env.db, config, env: envVars, prompts, now: NOW });
    assert.deepEqual([ready.state, ready.sweepsToday, ready.sweepsPerDay, ready.last.outcome], ['ready', 1, 4, 'ok']);
    const text = { status: { memorySession: { off: 'OFF', notConfigured: 'NOKEY', refused: 'NO {code}', line: '{mode} {sweeps}/{cap} {outcome}' } } };
    assert.equal(memorySessionStatusLine(ready, text), 'shadow 1/4 ok');
    assert.equal(memorySessionStatusLine(refused, text), 'NO APPLY_JSON_WRITER');
    assert.equal(memorySessionStatusLine({ state: 'off' }, text), 'OFF');
    assert.equal(memorySessionStatusLine({ state: 'not_configured' }, text), 'NOKEY');
    assert.equal(memorySessionStatusLine(ready, {}), '');
  } finally {
    env.done();
  }
});

test('the people block renders a stored profile the way her turns do, from the database alone', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-session-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const { syncOnce } = await import('../src/memory/db/sync.js');
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  try {
    assert.equal(syncOnce(handle, data).errors, 0);
    const { MEMBER } = await import('./fixtures/memory-db/datadir.js');
    const scope = scopesOf(handle.db).find((entry) => entry.key === 'group:discord');
    assert.ok(scope, 'the synced record has a group scope');
    const batch = batchOf(handle.db, scope.scope, { cursor: 0, since: null, maxMessages: 50, settleBefore: Date.parse('2027-01-01') });
    assert.ok(batch.length >= 2);
    const built = buildSessionRequest({ db: handle.db, scope, batch, config: baseConfig(), prompts, selfName: 'Nep', now: NOW });
    const people = built.messages[1].content;
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'guilds', '300000000000000001', 'users', `${MEMBER}.json`), 'utf8'));
    assert.ok(built.people.some((person) => person.native === MEMBER));
    assert.match(people, new RegExp(`## ${stored.names[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(people, new RegExp(`id: <@${MEMBER}>`));
  } finally {
    handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writes from the main thread go through the worker: a session write lands in the database the worker owns', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-session-worker-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const hot = { config: { features: { memoryDb: true }, memoryDb: { syncSeconds: 60 } } };
  const service = createMemoryDb({ hot, dataDir: data, log: { info() {}, warn() {}, error() {}, debug() {} }, now: () => NOW });
  try {
    await service.tick();
    assert.ok(service.database(), 'opened and synced once');
    const run = { id: 'run:w', sweepId: 'sweep:w', scopeKey: 'group:discord', scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }, startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString(), cursorFrom: 0, cursorTo: 7, sourcesN: 3, outcome: 'ok', counts: { claims: 1 }, errors: [] };
    const plan = { claims: [{ op: 'add', subjectKind: 'self', subjectId: SELF_PERSON, kind: 'self_fact', text: 'a fact', how: 'saw', sources: [], when: null }], episodes: [], affinity: [], descriptions: [] };
    const counts = await service.memoryWrite({ kind: 'session', mode: 'shadow', run, plan, advance: { key: cursorKey('shadow', 'group:discord'), value: 7 }, now: NOW });
    assert.equal(counts.proposed, 1);
    const db = service.database();
    assert.equal(db.prepare("SELECT outcome FROM session_runs WHERE id = 'run:w'").get().outcome, 'ok');
    assert.equal(db.prepare("SELECT action FROM decisions WHERE id = 'dec:run:w:1'").get().action, 'proposed:add');
    assert.equal(db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('shadow', 'group:discord')).value, '7');
    await service.close();
    await assert.rejects(() => service.memoryWrite({ kind: 'description', row: {} }), (error) => error.code === 'DB_CLOSED');
  } finally {
    await service.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the tool: a 429 is waited out (Retry-After first) and tried again, three tries at most; other errors are thrown at once', async () => {
  const { backoffMs, opKinds, parseSubject, withBackoff } = await import('../tools/memory-session.mjs');
  const limited = (extra = {}) => Object.assign(new Error('slow down'), { statusCode: 429, ...extra });
  assert.equal(backoffMs(limited({ headers: new Map([['retry-after', '7']]) }), 1), 7000);
  assert.equal(backoffMs(limited({ headers: { 'retry-after': new Date(NOW + 9000).toUTCString() } }), 1, NOW), 9000);
  assert.equal(backoffMs(limited({ retryAfterMs: 1234 }), 1), 1234);
  assert.equal(backoffMs(limited({ retryAfterMs: 10 * 60_000 }), 1), 120_000, 'a wait is bounded');
  assert.equal(backoffMs(limited(), 2), 30_000, 'without a header, longer each time');

  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let calls = 0;
  const flaky = withBackoff(async () => { calls += 1; if (calls < 3) throw limited({ retryAfterMs: 500 * calls }); return 'done'; }, { sleep });
  assert.equal(await flaky([], {}), 'done');
  assert.deepEqual(waits, [500, 1000]);

  calls = 0;
  const stuck = withBackoff(async () => { calls += 1; throw limited({ retryAfterMs: 1 }); }, { sleep });
  await assert.rejects(() => stuck([], {}), (error) => error.statusCode === 429);
  assert.equal(calls, 3, 'at most three tries');

  calls = 0;
  const broken = withBackoff(async () => { calls += 1; throw Object.assign(new Error('bad'), { statusCode: 500 }); }, { sleep });
  await assert.rejects(() => broken([], {}), /bad/);
  assert.equal(calls, 1);

  assert.equal(opKinds({ claims: [{ op: 'add', subjectKind: 'person' }, { op: 'add', subjectKind: 'person' }, { op: 'confirm' }], episodes: [{}], affinity: [], descriptions: [] }), 'claims:add(person) 2, claims:confirm 1, episodes 1');
  assert.equal(opKinds(null), 'none');
  assert.deepEqual(parseSubject('person:person:discord:u-ada:character'), { subject: { kind: 'person', id: 'person:discord:u-ada' }, field: 'character' });
  assert.throws(() => parseSubject('character'), /--review wants/);
});
