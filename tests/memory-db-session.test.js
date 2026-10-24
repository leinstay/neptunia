// Her memory session (src/memory/db/session.js, session-write.js): the request, the answer's checks, the id mapping, shadow
// and apply writes, the refusals. A fake llm and synthetic Greek and accented Latin text only; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.js';
import { applyMemoryWrite } from '../src/memory/db/session-write.js';
import {
  CODES, batchOf, buildSessionRequest, cursorKey, memoryKeyState, memorySessionStatusLine, parseSessionAnswer, refusalOf, scopesOf,
  resolveSessionReads, sessionSettings, sessionStatus, sweep, validateAnswer,
} from '../src/memory/db/session.js';
import { channelPlaceId, dmPlaceId, guildPlaceId, messageSourceId, personId, SELF_PERSON } from '../src/memory/db/ids.js';
import { groupContext, whereFor } from '../src/memory/db/scope.js';
import { roleApiKey, STRICT_KEY_ROLES } from '../src/llm/openrouter.js';
import { MEMORY_ROLE, MEMORY_ROLE_DEFAULT, roleConfigKeys, roleModel } from '../src/llm/roles.js';
import { createMemoryDb } from '../src/memory/db/service.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { MEMBER, buildDataDir } from './fixtures/memory-db/datadir.js';
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
  models: { base: { memory: 'x/memory' } },
  llm: { temperature: 1, keyByRole: { memory: 'OPENROUTER_MEMORY_KEY' } },
  relationships: { maxDeltaPerUpdate: 5 },
  memoryDb: { read: true, authority: 'db', session: { mode: 'shadow', minMessages: 1, ...session } },
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
    // The service stamps the authority of the live config into every write; so does this one.
    write: write ?? (async (update) => applyMemoryWrite(env.handle, { ...update, authority: config?.memoryDb?.authority ?? 'json' })),
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
  assert.deepEqual(roleConfigKeys(MEMORY_ROLE), ['models', 'base', 'memory']);
  assert.equal(roleModel({ models: { base: { memory: 'x/m', core: 'x/c' } } }, 'memory'), 'x/m');
  assert.equal(roleModel({ models: { base: { core: 'x/c' } } }, 'memory'), MEMORY_ROLE_DEFAULT, 'unset: its own default, never the core key');
  assert.ok(STRICT_KEY_ROLES.includes('memory'));
  const config = { llm: { keyByRole: { memory: 'OPENROUTER_MEMORY_KEY' } } };
  assert.equal(roleApiKey(config, { OPENROUTER_MEMORY_KEY: 'mine' }, 'memory', 'main'), 'mine');
  const { result } = await withCapturedLogs(() => roleApiKey(config, {}, 'memory', 'main'));
  assert.equal(result, '', 'unset variable: no key, never the main key');
  assert.equal(roleApiKey({ llm: {} }, { OPENROUTER_CORE_KEY: 'x' }, 'memory', 'main'), '', 'unmapped: no key either');
  assert.equal(roleApiKey({ llm: {} }, {}, 'core', 'main'), 'main', 'other roles keep the main key');
});

test('refusals: off, no key, apply while the JSON files write, no prompt; the key state names a variable, never a value', () => {
  const env = { OPENROUTER_MEMORY_KEY: 'secret' };
  assert.equal(refusalOf(baseConfig({ mode: 'off' }), env, prompts), CODES.OFF);
  assert.equal(refusalOf(baseConfig(), {}, prompts), CODES.NOT_CONFIGURED);
  assert.equal(refusalOf(baseConfig(), { OPENROUTER_MEMORY_KEY: '  ' }, prompts), CODES.NOT_CONFIGURED);
  assert.equal(refusalOf(baseConfig({ mode: 'apply' }, { memoryDb: { read: false, authority: 'db', session: { mode: 'apply' } } }), env, prompts), null, 'the read switch is not the authority');
  assert.equal(refusalOf(baseConfig({ mode: 'apply' }, { memoryDb: { read: true, session: { mode: 'apply' } } }), env, prompts), CODES.APPLY_REFUSED, 'reading from the database never unlocks a write');
  assert.equal(refusalOf(baseConfig({ mode: 'apply' }, { memoryDb: { read: true, authority: 'json', session: { mode: 'apply' } } }), env, prompts), CODES.APPLY_REFUSED);
  assert.equal(refusalOf(baseConfig({ mode: 'apply' }, { memoryDb: { read: true, authority: 'bogus', session: { mode: 'apply' } } }), env, prompts), CODES.APPLY_REFUSED, 'any other value is json');
  assert.equal(refusalOf(baseConfig({ mode: 'apply' }), env, prompts), null);
  assert.equal(refusalOf(baseConfig({ mode: 'shadow' }, { memoryDb: { session: { mode: 'shadow' } } }), env, prompts), null, 'shadow needs no authority');
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
    assert.equal(batch[2], '#1 [2026-10-24 10:20] [p1] Ada: Καλημέρα, I like café mornings', 'the account name, not the account id; the place handle of the line');
    assert.equal(batch[3], '#2 [2026-10-24 10:30] [p1] Βασίλης: ναι, σωστά');
    assert.equal(batch[4], '→ #3 [2026-10-24 10:40] [p1] Ada: hey you there?', 'addressed to her: led by an arrow');
    assert.equal(batch[5], '#4 [2026-10-24 10:50] [p1] Nep (you): I am here', 'her own line: her self label');
    assert.equal(batch[6], '#5 [2026-10-24 11:00] [p1] Ada: I moved to Thessaloniki');
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
    assert.match(user.content, /<place>\nscope: group\n\[p1\] channel: general - chat\n\[p2\] guild: Server/);
    assert.deepEqual([...built.maps.places.entries()], [['p1', CHANNEL], ['p2', guildPlaceId(GUILD)]]);
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
    const check = (value) => validateAnswer(value, { maps: built.maps, people: built.people });
    const label = [...built.maps.claims.entries()].find(([, id]) => id === 'cl-ada')[0];
    const selfLabel = [...built.maps.claims.entries()].find(([, id]) => id === 'cl-self')[0];
    const { plan, counts } = check({
      claims: [
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'moved to Thessaloniki', how: 'said', sources: ['#5'], when: '2026-10' },
        { op: 'add', subject: 'ada', kind: 'detail', text: 'same person by a folded name', how: 'saw', sources: [5] },
        { op: 'add', subject: 'place', place: 'p2', kind: 'injoke', text: 'a joke', how: 'saw', sources: ['#1'] },
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
        { op: 'add', subject: 'place', place: 'p1', kind: 'injoke', text: 'x', how: 'saw', sources: ['#1', '#99'] },
        { op: 'add', subject: 'place', kind: 'injoke', text: 'x', how: 'saw', sources: ['#1'] },
        { op: 'add', subject: 'place', place: 'p9', kind: 'injoke', text: 'x', how: 'saw', sources: ['#1'] },
        { op: 'revise', id: label, text: 'x', how: 'said', sources: ['#1'] },
        { op: 'retire', id: label, truth: 'disputed', sources: ['#1'] },
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
    assert.deepEqual(plan.claims[2].sources, [ids.a]);
    assert.equal(plan.claims[2].subjectId, guildPlaceId(GUILD), 'a place is the one the handle names');
    assert.equal(plan.claims[5].id, 'cl-ada', 'cN back to the claim id');
    assert.equal(plan.claims[7].id, 'cl-self');
    assert.deepEqual(plan.episodes, [{ subjectId: personId(ADA), what: 'helped with the move', feeling: 'warm', sources: [ids.e] }]);
    assert.deepEqual(plan.affinity, [{ personId: personId(BOB), delta: 2, reason: 'kind', sources: [ids.b] }], 'a name resolves, the delta is whole');
    assert.deepEqual(plan.descriptions, [{ subjectKind: 'person', subjectId: personId(ADA), field: 'character', why: 'new facts' }]);
    assert.equal(counts.kept, 8 + 1 + 1 + 1);
    assert.deepEqual(counts.dropped, {
      unknown_source: 2, unknown_subject: 1, bad_kind: 1, bad_how: 1, no_sources: 2, no_text: 1, unknown_id: 2, bad_truth: 1, bad_op: 2, bad_delta: 2, bad_field: 1,
      no_place: 1, unknown_place: 1, no_reason: 2,
    });
    // An op with one unknown source among known ones is dropped whole, never kept with part of its evidence.
    assert.equal(check({ claims: [{ op: 'add', subject: 'Ada', kind: 'detail', text: 'x', how: 'said', sources: ['#1', '#99'] }] }).plan.claims.length, 0);
    // A reason is required for a revision, a retirement, an attitude change and a description flag.
    assert.deepEqual(check({ affinity: [{ person: 'Ada', delta: 1, sources: ['#1'] }], descriptions: [{ subject: 'Ada', field: 'character' }] }).counts.dropped, { no_reason: 2 });
    // a part that is not a list; two people with one name
    assert.deepEqual(check({ claims: 'x', episodes: {} }).counts.dropped, { claims_not_list: 1, episodes_not_list: 1 });
    env.db.prepare("UPDATE accounts SET names = ? WHERE id = ?").run(JSON.stringify(['Ada']), `discord:${BOB}`);
    const twin = request(env);
    const result = validateAnswer({ episodes: [{ subject: 'Ada', what: 'x', sources: ['#1'] }] }, { maps: twin.maps, people: twin.people });
    assert.deepEqual(result.counts.dropped, { unknown_subject: 1 }, 'a name two people share names no one');
    assert.equal(validateAnswer({ claims: [{ op: 'add', subject: 'place', kind: 'detail', text: 'x', how: 'said', sources: ['#1'] }] }, { maps: twin.maps, people: twin.people }).counts.dropped.no_place, 1, 'a place proposal names its place; there is no first-place default');
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
    const keyless = await sweep(ctxOf(env, { llm, envVars: { OPENROUTER_CORE_KEY: 'main', OPENROUTER_OTHER_KEY: 'other' } }));
    assert.deepEqual([keyless.status, keyless.code], ['refused', 'not_configured'], 'another key never stands in');
    const jsonWriter = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }, { memoryDb: { read: true, session: { mode: 'apply', minMessages: 1 } } }) }));
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
    env.claim({ id: 'cl-fresh', subjectId: personId(ADA), kind: 'detail', text: 'owns a bicycle' });
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
    // (a claim the first answer touched is newer than the second batch's cutoff and is not in the request; this one is untouched)
    const disputed = [...request(env).maps.claims.entries()].find(([, id]) => id === 'cl-fresh');
    const second = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({ claims: [{ op: 'retire', id: disputed[0], truth: 'disputed', reason: 'contradicted', sources: ['#1'] }] })), config }), { ignoreSweepCap: true });
    assert.equal(second.runs[0].outcome, 'ok');
    assert.deepEqual(Object.values(env.db.prepare("SELECT truth, shown FROM claims WHERE id = 'cl-fresh'").get()), ['disputed', 1]);
  } finally {
    env.done();
  }
});

test('the status of the session and its line', async () => {
  const env = fixture();
  try {
    chat(env);
    // The cap the line shows is the per-scope one (stage W3); the test sets its own value.
    const config = baseConfig({ sweepsPerScopePerDay: 4 });
    const envVars = { OPENROUTER_MEMORY_KEY: 'k' };
    assert.equal(sessionStatus({ db: env.db, config: baseConfig({ mode: 'off' }), env: envVars, prompts, now: NOW }).state, 'off');
    assert.equal(sessionStatus({ db: env.db, config, env: {}, prompts, now: NOW }).state, 'not_configured');
    const refused = sessionStatus({ db: env.db, config: baseConfig({ mode: 'apply' }, { memoryDb: { read: true, session: { mode: 'apply' } } }), env: envVars, prompts, now: NOW });
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
    const scope = scopesOf(handle.db).find((entry) => entry.key === 'group:discord');
    assert.ok(scope, 'the synced record has a group scope');
    const batch = batchOf(handle.db, scope.scope, { cursor: 0, since: null, maxMessages: 50, settleBefore: Date.parse('2027-01-01') });
    assert.ok(batch.length >= 2);
    const built = buildSessionRequest({ db: handle.db, scope, batch, config: baseConfig(), prompts, selfName: 'Nep', now: NOW });
    // A unit that left the disk is a tombstone (`gone_at`): its profile is not rendered.
    handle.db.prepare("UPDATE files SET gone_at = '2026-10-24T00:00:00.000Z' WHERE path LIKE ?").run(`guilds/%/users/${MEMBER}.json`);
    const withoutFile = buildSessionRequest({ db: handle.db, scope, batch, config: baseConfig(), prompts, selfName: 'Nep', now: NOW });
    assert.ok(withoutFile.messages[1].content.length < built.messages[1].content.length, 'the profile of a file that is gone is left out');
    handle.db.prepare("UPDATE files SET gone_at = NULL WHERE path LIKE ?").run(`guilds/%/users/${MEMBER}.json`);
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
  assert.equal(opKinds({ claims: [], people: [{ op: 'add' }, { op: 'add' }] }), 'people:add 2', 'people ops are counted too');
  assert.equal(opKinds(null), 'none');
  assert.deepEqual(parseSubject('person:person:discord:u-ada:character'), { subject: { kind: 'person', id: 'person:discord:u-ada' }, field: 'character' });
  assert.throws(() => parseSubject('character'), /--review wants/);
});

// ---------- before any `apply`: authority, idempotent runs, evidence, batches, stored answers ----------

const GROUP = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
const DM_ADA = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personId(ADA) };
const runOf = (extra = {}) => ({
  id: 'run:t', sweepId: 'sweep:t', scopeKey: 'group:discord', scope: GROUP, batchKey: 'apply|group:discord|0|9|0', startedAt: new Date(NOW).toISOString(),
  finishedAt: new Date(NOW).toISOString(), cursorFrom: 0, cursorTo: 9, sourcesN: 1, outcome: 'ok', counts: {}, errors: [], ...extra,
});
const emptyPlan = (extra = {}) => ({ claims: [], episodes: [], affinity: [], descriptions: [], ...extra });
const applyOf = (env, update) => applyMemoryWrite(env.handle, { kind: 'session', mode: 'apply', authority: 'db', run: runOf(), maxDelta: 5, now: NOW, ...update });

test('authority: the writer itself refuses apply unless the database is the authority, and any mode but shadow and apply', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    const plan = emptyPlan({ claims: [{ op: 'add', subjectKind: 'self', subjectId: SELF_PERSON, kind: 'self_fact', text: 'a fact', how: 'saw', sources: [ids.a], when: null }] });
    for (const authority of [undefined, 'json', 'bogus']) {
      assert.throws(() => applyOf(env, { plan, authority }), (error) => error.code === 'APPLY_JSON_WRITER', `authority ${authority}`);
    }
    for (const mode of ['draft', 'off', undefined]) assert.throws(() => applyOf(env, { plan, mode }), (error) => error.code === 'BAD_MODE', `mode ${mode}`);
    assert.throws(() => applyMemoryWrite(env.handle, { kind: 'other' }), (error) => error.code === 'BAD_UPDATE');
    assert.deepEqual([count(env.db, 'session_runs'), count(env.db, 'claims', "author = 'her'"), count(env.db, 'decisions')], [0, 0, 0], 'a refusal writes nothing');
    assert.equal(applyOf(env, { plan }).added, 1);
    // shadow needs no authority
    assert.equal(applyMemoryWrite(env.handle, { kind: 'session', mode: 'shadow', run: runOf({ id: 'run:s', batchKey: 'shadow|x' }), plan, now: NOW }).proposed, 1);
  } finally {
    env.done();
  }
});

test('a run is applied once: a retried batch returns the first result and changes nothing, affinity above all', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    const plan = emptyPlan({
      episodes: [{ subjectId: personId(ADA), what: 'a kind moment', feeling: '', sources: [ids.a] }],
      affinity: [{ personId: personId(ADA), delta: 3, reason: 'kind', sources: [ids.a] }],
      claims: [{ op: 'add', subjectKind: 'person', subjectId: personId(ADA), kind: 'detail', text: 'new fact', how: 'said', sources: [ids.a], when: null }],
    });
    const cursor = cursorKey('apply', 'group:discord');
    const update = { plan, advance: { key: cursor, value: 9, expect: 0 } };
    const first = applyOf(env, update);
    assert.deepEqual([first.added, first.episodes, first.affinity, first.replayed], [1, 1, 1, undefined]);
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId(ADA)).affinity, 8);
    const again = applyOf(env, update);
    assert.deepEqual([again.replayed, again.added, again.affinity], [true, 1, 1], 'the first result comes back');
    const otherRun = applyOf(env, { ...update, run: runOf({ id: 'run:retry' }) });
    assert.equal(otherRun.replayed, true, 'a retry under another run id is the same batch');
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId(ADA)).affinity, 8, 'the attitude moved once');
    assert.deepEqual([count(env.db, 'affinity_events'), count(env.db, 'episodes'), count(env.db, 'claims', "author = 'her'"), count(env.db, 'session_runs')], [1, 1, 1, 1]);
    assert.equal(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor).value, '9');
    // the same event id never applies twice, whatever the batch key
    const sameEvent = applyOf(env, { run: runOf({ batchKey: 'apply|other' }), plan });
    assert.equal(sameEvent.duplicate, 1);
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId(ADA)).affinity, 8);
  } finally {
    env.done();
  }
});

test('the cursor moves by compare-and-set in the transaction of the write: a stale cursor writes nothing', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    const cursor = cursorKey('apply', 'group:discord');
    const plan = emptyPlan({ episodes: [{ subjectId: personId(ADA), what: 'x', feeling: '', sources: [ids.a] }] });
    env.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(cursor, '4');
    assert.throws(() => applyOf(env, { plan, advance: { key: cursor, value: 9, expect: 0 } }), (error) => error.code === 'CURSOR_CONFLICT');
    assert.deepEqual([count(env.db, 'episodes'), count(env.db, 'session_runs'), count(env.db, 'decisions')], [0, 0, 0], 'the writes rolled back with it');
    assert.equal(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor).value, '4');
    applyOf(env, { plan, advance: { key: cursor, value: 9, expect: 4 } });
    assert.equal(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor).value, '9');
  } finally {
    env.done();
  }
});

test('an all_dropped answer leaves the cursor and the batch pending; after retryLimit tries it is skipped with a recorded decision', async () => {
  const env = fixture();
  try {
    chat(env);
    const config = baseConfig({ retryLimit: 2 });
    const llm = fakeLlm(memoryBlock({ claims: [{ op: 'add', subject: 'Nobody', kind: 'detail', text: 'x', how: 'said', sources: ['#1'] }] }));
    const cursor = cursorKey('shadow', 'group:discord');
    const first = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    assert.equal(first.runs[0].outcome, 'all_dropped');
    assert.equal(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor), undefined, 'the cursor did not move');
    const status = sessionStatus({ db: env.db, config, env: { OPENROUTER_MEMORY_KEY: 'k' }, prompts, now: NOW });
    assert.deepEqual(status.pending.map((batch) => [batch.scope, batch.tries]), [['group:discord', 1]]);
    const text = { status: { memorySession: { line: '{mode}', pending: 'WAITING {n} after {tries} of {limit}' } } };
    assert.equal(memorySessionStatusLine(status, text), 'shadow\nWAITING 1 after 1 of 2');
    assert.equal(memorySessionStatusLine(status, { status: { memorySession: { line: '{mode}' } } }), 'shadow', 'no label, no pending line');
    const second = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    assert.equal(second.runs[0].outcome, 'all_dropped');
    assert.equal(llm.calls.length, 2);
    const third = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    assert.deepEqual(third.runs.map((run) => run.outcome), ['skipped']);
    assert.equal(llm.calls.length, 2, 'a skipped batch costs no request');
    assert.ok(Number(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor).value) > 0, 'the cursor moved past it');
    const decision = env.db.prepare("SELECT by, action, extra FROM decisions WHERE action = 'skipped:all_dropped'").get();
    assert.equal(decision.by, 'engine');
    assert.equal(JSON.parse(decision.extra).tries, 2);
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.pending.%'"), 0);
    assert.equal(sessionStatus({ db: env.db, config, env: { OPENROUTER_MEMORY_KEY: 'k' }, prompts, now: NOW }).pending.length, 0);
  } finally {
    env.done();
  }
});

test('a write that failed is never an ok run: the cursor stays, the error is in the result', async () => {
  const env = fixture();
  try {
    chat(env);
    const down = async () => { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); };
    const result = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})), write: down }));
    assert.equal(result.runs[0].outcome, 'write_failed');
    assert.deepEqual(result.runs[0].errors, ['write:SQLITE_BUSY']);
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 0);
    const retried = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})) }), { ignoreSweepCap: true });
    assert.equal(retried.runs[0].outcome, 'ok', 'the next sweep reads the same lines');
  } finally {
    env.done();
  }
});

test('evidence: an op with a source that does not exist is rejected whole; a revision needs its reason', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personId(ADA), text: 'likes café mornings' });
    const plan = emptyPlan({
      claims: [
        { op: 'add', subjectKind: 'person', subjectId: personId(ADA), kind: 'detail', text: 'half evidence', how: 'said', sources: [ids.a, 'src:missing'], when: null },
        { op: 'revise', id: 'cl-ada', text: 'likes tea', how: 'said', sources: [ids.a], reason: '' },
        { op: 'retire', id: 'cl-ada', truth: 'historical', sources: [ids.a] },
        { op: 'confirm', id: 'cl-ada', sources: [] },
      ],
      affinity: [{ personId: personId(ADA), delta: 2, reason: '', sources: [ids.a] }],
      episodes: [{ subjectId: personId(ADA), what: 'x', feeling: '', sources: ['src:missing'] }],
    });
    const counts = applyOf(env, { plan });
    assert.equal(counts.rejected, 6);
    assert.deepEqual([counts.added, counts.revised, counts.retired, counts.confirmed, counts.episodes, counts.affinity], [0, 0, 0, 0, 0, 0]);
    assert.deepEqual([count(env.db, 'claims', "author = 'her'"), count(env.db, 'claim_sources'), count(env.db, 'episodes'), count(env.db, 'affinity_events')], [0, 0, 0, 0]);
    assert.equal(env.db.prepare("SELECT text FROM claims WHERE id = 'cl-ada'").get().text, 'likes café mornings');
    assert.deepEqual(env.db.prepare("SELECT action FROM decisions ORDER BY id").all().map((row) => row.action), [
      'rejected:unknown_source', 'rejected:no_reason', 'rejected:no_reason', 'rejected:unknown_source', 'rejected:unknown_source', 'rejected:no_reason',
    ]);
  } finally {
    env.done();
  }
});

test('a revised or confirmed claim takes its scope from the evidence of the new version; a private line on a group claim makes a private claim, the group one stays', () => {
  const env = fixture();
  try {
    chat(env);
    const dmLine = env.say({ native: 'd1', minutesAgo: 50, text: 'I moved to Lyon, keep it quiet', scope: DM_ADA, place: dmPlaceId(ADA) });
    const groupLine = messageSourceId('m5', 1, 'seen');
    env.claim({ id: 'cl-home', subjectId: personId(ADA), kind: 'detail', text: 'lives in Athens' });
    env.claim({ id: 'cl-tea', subjectId: personId(ADA), kind: 'interest', text: 'likes tea' });
    env.claim({ id: 'cl-chess', subjectId: personId(ADA), kind: 'interest', text: 'plays chess' });
    const dmRun = runOf({ id: 'run:dm', scope: DM_ADA, scopeKey: `dm:discord:${personId(ADA)}`, batchKey: 'apply|dm' });
    const counts = applyOf(env, {
      run: dmRun,
      plan: emptyPlan({
        claims: [
          { op: 'revise', id: 'cl-home', text: 'lives in Lyon', how: 'said', sources: [dmLine], reason: 'told in private' },
          { op: 'confirm', id: 'cl-tea', sources: [dmLine] },
          { op: 'retire', id: 'cl-chess', truth: 'historical', reason: 'stopped', sources: [dmLine] },
        ],
      }),
    });
    assert.deepEqual([counts.revised, counts.confirmed, counts.retired, counts.derived], [1, 1, 1, 3]);
    for (const [id, text] of [['cl-home', 'lives in Athens'], ['cl-tea', 'likes tea'], ['cl-chess', 'plays chess']]) {
      const old = env.db.prepare('SELECT text, scope_kind, last_seen_at, truth, shown FROM claims WHERE id = ?').get(id);
      assert.deepEqual([old.text, old.scope_kind, old.last_seen_at, old.truth, old.shown], [text, 'group', '2026-10-20', 'current', 1], `the group claim ${id} stays as it was`);
      assert.equal(count(env.db, 'claim_versions', `claim_id = '${id}'`), 0);
    }
    const derived = env.db.prepare("SELECT * FROM claims WHERE author = 'her' ORDER BY text").all();
    assert.deepEqual(derived.map((row) => [row.text, row.scope_kind, row.scope_dm, row.truth]), [
      ['likes tea', 'dm', personId(ADA), 'current'], ['lives in Lyon', 'dm', personId(ADA), 'current'], ['plays chess', 'dm', personId(ADA), 'historical'],
    ]);
    assert.equal(JSON.parse(derived[1].extra).derivedFrom, 'cl-home');
    assert.deepEqual(env.db.prepare('SELECT source_id FROM claim_sources WHERE claim_id = ?').all(derived[1].id).map((row) => row.source_id), [dmLine], 'only the new evidence');
    assert.deepEqual(env.db.prepare('SELECT event FROM claim_versions WHERE claim_id = ?').all(derived[1].id).map((row) => row.event), ['revise']);
    // a group reader never sees the private versions
    const group = whereFor(groupContext('discord'), 'c');
    const seen = env.db.prepare(`SELECT c.text FROM claims c WHERE c.subject_id = ? AND ${group.sql} ORDER BY c.text`).all(personId(ADA), ...group.params).map((row) => row.text);
    assert.deepEqual(seen, ['lives in Athens', 'likes tea', 'plays chess'].sort());
    // a revision from group evidence stays on the group claim
    const inPlace = applyOf(env, { run: runOf({ id: 'run:g', batchKey: 'apply|g' }), plan: emptyPlan({ claims: [{ op: 'revise', id: 'cl-home', text: 'lives in Thessaloniki', how: 'said', sources: [groupLine], reason: 'said so' }] }) });
    assert.deepEqual([inPlace.revised, inPlace.derived], [1, 0]);
    assert.equal(env.db.prepare("SELECT text FROM claims WHERE id = 'cl-home'").get().text, 'lives in Thessaloniki');
    // a group run cannot touch a private claim
    env.claim({ id: 'cl-private', subjectId: personId(ADA), text: 'private thing', scope: DM_ADA });
    const out = applyOf(env, { run: runOf({ id: 'run:o', batchKey: 'apply|o' }), plan: emptyPlan({ claims: [{ op: 'confirm', id: 'cl-private', sources: [groupLine] }] }) });
    assert.deepEqual([out.rejected, out.confirmed], [1, 0]);
  } finally {
    env.done();
  }
});

test('child links: a retired link is not a link; the links the database writes carry no owner file', () => {
  const env = fixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personId(ADA), text: 'likes café mornings' });
    env.db.prepare("INSERT INTO claim_sources (claim_id, source_id, position, retired_at, owner_file) VALUES ('cl-ada', ?, 0, '2026-10-01T00:00:00.000Z', 'guilds/G/users/x.json')").run(ids.a);
    env.db.prepare("INSERT INTO claim_sources (claim_id, source_id, position, owner_file) VALUES ('cl-ada', ?, 1, 'guilds/G/users/x.json')").run(ids.b);
    applyOf(env, { plan: emptyPlan({ claims: [{ op: 'confirm', id: 'cl-ada', sources: [ids.a, ids.b] }] }) });
    const links = env.db.prepare("SELECT source_id, retired_at, owner_file FROM claim_sources WHERE claim_id = 'cl-ada' ORDER BY rowid").all();
    assert.deepEqual(links.map((row) => [row.source_id, row.retired_at === null, row.owner_file]), [
      [ids.a, false, 'guilds/G/users/x.json'], [ids.b, true, 'guilds/G/users/x.json'], [ids.a, true, null],
    ], 'the retired link did not count as existing; the live one was not added twice');
  } finally {
    env.done();
  }
});

test('batches are read in event time and each line names its place; the cursor still follows arrival', async () => {
  const env = fixture();
  try {
    db_second_channel(env);
    env.say({ native: 'm1', minutesAgo: 50, text: 'later line' });
    env.say({ native: 'm2', minutesAgo: 90, text: 'earlier line, stored second', place: SECOND });
    env.say({ native: 'm3', minutesAgo: 70, text: 'middle line' });
    const scope = scopesOf(env.db)[0];
    const batch = batchOf(env.db, scope.scope, { cursor: 0, since: null, maxMessages: 200, settleBefore: NOW });
    assert.deepEqual(batch.map((line) => line.text), ['earlier line, stored second', 'middle line', 'later line'], 'occurred_at first, then arrival');
    // the first `maxMessages` by arrival are the batch (no line is skipped by the cursor), shown in event time
    assert.deepEqual(batchOf(env.db, scope.scope, { cursor: 0, since: null, maxMessages: 2, settleBefore: NOW }).map((line) => line.text), ['earlier line, stored second', 'later line']);
    const built = buildSessionRequest({ db: env.db, scope, batch, config: baseConfig(), prompts, selfName: 'Nep', now: NOW });
    const lines = built.messages[1].content.slice(built.messages[1].content.indexOf('<batch>')).split('\n');
    assert.match(lines[2], /^#1 \[2026-10-24 10:30\] \[p1\] Ada: earlier line/);
    assert.match(lines[3], /^#2 \[2026-10-24 10:50\] \[p2\] Ada: middle line/);
    assert.match(lines[4], /^#3 \[2026-10-24 11:10\] \[p2\] Ada: later line/);
    assert.match(built.messages[1].content, /\[p1\] channel: second\n\[p2\] channel: general - chat\n\[p3\] guild: Server/);
    const result = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})) }));
    assert.equal(result.runs[0].outcome, 'ok');
    const run = env.db.prepare('SELECT cursor_to FROM session_runs').get();
    assert.equal(run.cursor_to, Math.max(...batch.map((line) => line.rowid)), 'the cursor is the newest arrival, not the newest event');
  } finally {
    env.done();
  }
});

const SECOND = channelPlaceId('c2');
function db_second_channel(env) {
  env.db.prepare("INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'channel', 'c2', ?, 'group', 'second', NULL)").run(SECOND, guildPlaceId(GUILD));
}

test('every person of a batch is a subject: the people are paged over requests of the same batch, the cursor moves after the last', async () => {
  const env = fixture();
  try {
    chat(env);
    const config = baseConfig({ maxPeople: 1 });
    const answers = [
      memoryBlock({ claims: [{ op: 'add', subject: 'Ada', kind: 'detail', text: 'first page fact', how: 'said', sources: ['#1'] }, { op: 'add', subject: 'Βασίλης', kind: 'detail', text: 'not on this page', how: 'said', sources: ['#2'] }] }),
      memoryBlock({ claims: [{ op: 'add', subject: 'Βασίλης', kind: 'detail', text: 'second page fact', how: 'said', sources: ['#2'] }] }),
    ];
    const llm = fakeLlm(answers);
    const result = await sweep(ctxOf(env, { llm, config }));
    assert.deepEqual(result.runs.map((run) => [run.outcome, run.page]), [['ok', 0], ['ok', 1]]);
    assert.equal(llm.calls.length, 2);
    const [one, two] = llm.calls.map((call) => call.messages[1].content);
    assert.match(one, /id: <@u-ada>/);
    assert.doesNotMatch(one, /id: <@u-bob>/);
    assert.match(two, /id: <@u-bob>/);
    assert.doesNotMatch(two, /id: <@u-ada>/);
    const batchOf2 = (text) => text.slice(text.indexOf('<batch>'));
    assert.equal(batchOf2(one), batchOf2(two), 'the same lines in each request');
    assert.deepEqual(env.db.prepare("SELECT action FROM decisions ORDER BY id").all().map((row) => row.action), ['proposed:add', 'proposed:add'], 'Ada\'s page keeps her claim; the claim about Bob on her page was dropped; Bob\'s page keeps his');
    assert.equal(count(env.db, 'session_runs'), 2);
    assert.equal(count(env.db, 'meta', "key LIKE 'memory_session.cursor.%'"), 1, 'one cursor for the batch');
  } finally {
    env.done();
  }
});

test('apply over pages: a page applied before is not asked again, and the cursor moves once every page is in', async () => {
  const env = fixture();
  try {
    chat(env);
    const config = baseConfig({ mode: 'apply', maxPeople: 1 });
    const cursor = cursorKey('apply', 'group:discord');
    const page = (subject, text, ref) => memoryBlock({ claims: [{ op: 'add', subject, kind: 'detail', text, how: 'said', sources: [ref] }], affinity: [{ person: subject, delta: 2, reason: 'kind', sources: [ref] }] });
    const broken = fakeLlm([page('Ada', 'ada fact', '#1'), Object.assign(new Error('boom'), { code: 'ECONNRESET' })]);
    const first = await sweep(ctxOf(env, { llm: broken, config }));
    assert.deepEqual(first.runs.map((run) => run.outcome), ['ok', 'llm_error']);
    assert.equal(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor), undefined, 'a page is missing: the cursor stays');
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId(ADA)).affinity, 7);
    const llm = fakeLlm([page('Βασίλης', 'bob fact', '#2')]);
    const second = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    assert.deepEqual(second.runs.map((run) => run.outcome), ['applied_before', 'ok']);
    assert.equal(llm.calls.length, 1, 'only the missing page is asked');
    assert.ok(Number(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor).value) > 0);
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId(ADA)).affinity, 7, 'the first page was not applied again');
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId(BOB)).affinity, 2);
    assert.equal(count(env.db, 'claims', "author = 'her'"), 2);
    // when the last page is the one applied before, the cursor still moves
    const env2 = fixture();
    try {
      chat(env2);
      const lastOnly = fakeLlm([Object.assign(new Error('boom'), { code: 'ECONNRESET' }), page('Βασίλης', 'bob fact', '#2')]);
      const a = await sweep(ctxOf(env2, { llm: lastOnly, config }));
      assert.deepEqual(a.runs.map((run) => run.outcome), ['llm_error', 'ok']);
      assert.equal(env2.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor), undefined);
      const b = await sweep(ctxOf(env2, { llm: fakeLlm([page('Ada', 'ada fact', '#1')]), config }), { ignoreSweepCap: true });
      assert.deepEqual(b.runs.map((run) => run.outcome), ['ok', 'applied_before']);
      assert.ok(Number(env2.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor).value) > 0);
    } finally { env2.done(); }
  } finally {
    env.done();
  }
});

test('the context is as of the batch cutoff: claims and episodes created or seen after it are left out', () => {
  const env = fixture();
  try {
    chat(env);
    env.claim({ id: 'cl-old', subjectId: personId(ADA), text: 'known before the batch ended' });
    env.claim({ id: 'cl-new', subjectId: personId(ADA), text: 'created after the cutoff' });
    env.claim({ id: 'cl-seen', subjectId: personId(ADA), text: 'seen again after the cutoff' });
    env.claim({ id: 'cl-self-new', subjectKind: 'self', subjectId: SELF_PERSON, kind: 'self_fact', text: 'a later self fact' });
    env.db.prepare("UPDATE claims SET created_at = '2026-10-24T11:30:00.000Z', last_seen_at = '2026-10-24T11:30:00.000Z' WHERE id IN ('cl-new', 'cl-self-new')").run();
    env.db.prepare("UPDATE claims SET created_at = '2026-10-01T00:00:00.000Z', last_seen_at = '2026-10-24T11:45:00.000Z' WHERE id = 'cl-seen'").run();
    env.db.prepare("UPDATE claims SET created_at = '2026-10-01T00:00:00.000Z', last_seen_at = '2026-10-24T10:00:00.000Z' WHERE id = 'cl-old'").run();
    env.db.prepare("INSERT INTO episodes (id, kind, subject_id, date, what, status, scope_kind, scope_iface, created_at) VALUES ('ep-old', 'profile', ?, '2026-10-10', 'before', 'open', 'group', 'discord', '2026-10-10T00:00:00.000Z')").run(personId(ADA));
    env.db.prepare("INSERT INTO episodes (id, kind, subject_id, date, what, status, scope_kind, scope_iface, created_at) VALUES ('ep-new', 'profile', ?, '2026-10-24', 'after', 'open', 'group', 'discord', '2026-10-24T11:40:00.000Z')").run(personId(ADA));
    const built = request(env);
    const claimed = [...built.maps.claims.values()];
    assert.ok(claimed.includes('cl-old'));
    for (const id of ['cl-new', 'cl-seen', 'cl-self-new']) assert.ok(!claimed.includes(id), `${id} is after the cutoff`);
    assert.deepEqual([...built.maps.episodes.values()], ['ep-old']);
    assert.equal(built.cutoff, Date.parse('2026-10-24T11:00:00.000Z'));
  } finally {
    env.done();
  }
});

test('her whole answer, thinking included, is a source of kind memory_session, scope internal, that no reader of a group sees', async () => {
  const env = fixture();
  try {
    chat(env);
    await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({ episodes: [] })) }));
    const stored = env.db.prepare("SELECT * FROM sources WHERE kind = 'memory_session'").all();
    assert.equal(stored.length, 1);
    assert.deepEqual([stored[0].scope_kind, stored[0].scope_iface, stored[0].scope_dm], ['internal', null, null]);
    assert.match(stored[0].text, /^<think>reading<\/think>/);
    assert.equal(stored[0].think, 'reading');
    assert.equal(env.db.prepare('SELECT answer_source FROM session_runs').get().answer_source, stored[0].id);
    const group = whereFor(groupContext('discord'), 's');
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM sources s WHERE s.kind = 'memory_session' AND ${group.sql}`).get(...group.params).n, 0);
    // an unreadable answer is kept as well
    await sweep(ctxOf(env, { llm: fakeLlm('<think>hm</think> nothing parseable') }), { ignoreSweepCap: true });
    env.say({ native: 'm9', minutesAgo: 20, text: 'one more line' });
    const bad = await sweep(ctxOf(env, { llm: fakeLlm('<think>hm</think> nothing parseable') }), { ignoreSweepCap: true });
    assert.equal(bad.runs[0].outcome, 'bad_answer');
    assert.equal(count(env.db, 'sources', "kind = 'memory_session'"), 2);
  } finally {
    env.done();
  }
});

test('a batch retried from the same cursor keeps its lines: lines that settled since do not widen it, so an applied page is not applied again', async () => {
  const env = fixture();
  try {
    chat(env);
    const config = baseConfig({ mode: 'apply', maxPeople: 1 });
    const cursor = cursorKey('apply', 'group:discord');
    const page = (subject, text, ref) => memoryBlock({ claims: [{ op: 'add', subject, kind: 'detail', text, how: 'said', sources: [ref] }], affinity: [{ person: subject, delta: 2, reason: 'kind', sources: [ref] }] });
    const first = await sweep(ctxOf(env, { llm: fakeLlm([page('Ada', 'ada fact', '#1'), Object.assign(new Error('boom'), { code: 'ECONNRESET' })]), config }));
    assert.deepEqual(first.runs.map((run) => run.outcome), ['ok', 'llm_error']);
    const firstTo = env.db.prepare("SELECT cursor_to FROM session_runs WHERE applied = 1").get().cursor_to;
    // a line that was still settling during the first sweep is in now
    env.say({ native: 'm6', minutesAgo: 20, text: 'one more thing' });
    const llm = fakeLlm([page('Βασίλης', 'bob fact', '#2')]);
    const second = await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    assert.deepEqual(second.runs.map((run) => run.outcome), ['applied_before', 'ok']);
    assert.equal(llm.calls.length, 1, 'only the missing page is asked, over the old lines');
    assert.equal(Number(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursor).value), firstTo, 'the cursor stops where the old batch ended');
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId(ADA)).affinity, 7, 'the first page was not applied again');
    assert.equal(count(env.db, 'claims', "author = 'her'"), 2);
    assert.ok(env.db.prepare("SELECT rowid FROM sources WHERE native_id = 'm6'").get().rowid > firstTo, 'the new line waits for the next batch');
  } finally {
    env.done();
  }
});

// ---------- schema v9: the run's read-set, the base of a claim edit, lines matched by their native tuple ----------

test('a run records what its request rendered: turn_reads of reader kind session, in the run\'s context, with the versions shown', async () => {
  const env = fixture();
  try {
    const ids = chat(env);
    env.claim({ id: 'cl-ada', subjectId: personId(ADA), text: 'likes café mornings' });
    env.db.prepare("INSERT INTO claim_versions (id, claim_id, text, recorded_at, event) VALUES ('cv-ada-1', 'cl-ada', 'likes café', '2026-10-02T00:00:00.000Z', 'add')").run();
    const result = await sweep(ctxOf(env, { llm: fakeLlm(memoryBlock({})) }));
    assert.equal(result.runs[0].outcome, 'ok');
    const runId = env.db.prepare('SELECT id FROM session_runs').get().id;
    const rows = env.db.prepare('SELECT * FROM turn_reads WHERE turn_id = ? ORDER BY ord').all(runId).map((row) => ({ ...row }));
    assert.ok(rows.length > 5);
    assert.ok(rows.every((row) => row.reader_kind === 'session' && row.step === '0' && row.context_id === `ctx:session:${runId}`));
    const claim = rows.find((row) => row.row_kind === 'claims' && row.row_id === 'cl-ada');
    assert.deepEqual([claim.block, claim.version_id], ['people', 'cv-ada-1'], 'the exact version the request showed');
    const lines = rows.filter((row) => row.block === 'batch').map((row) => row.row_id);
    assert.deepEqual(lines, [ids.a, ids.b, ids.c, ids.d, ids.e], 'the batch lines, in the order the request shows them');
    assert.ok(rows.filter((row) => row.block === 'batch').every((row) => row.row_kind === 'sources' && row.revision === 1));
    assert.ok(rows.some((row) => row.row_kind === 'places' && row.row_id === CHANNEL && row.block === 'place'));
    assert.deepEqual({ ...env.db.prepare('SELECT mode, iface FROM execution_contexts WHERE id = ?').get(`ctx:session:${runId}`) }, { mode: 'outward', iface: 'discord' });
  } finally {
    env.done();
  }
});

test('a claim edit carries the version its request showed: a claim that moved on meanwhile is refused as stale_base; her own base is never read', async () => {
  const env = fixture();
  try {
    chat(env);
    env.claim({ id: 'cl-ada', subjectId: personId(ADA), text: 'likes café mornings' });
    env.db.prepare("INSERT INTO claim_versions (id, claim_id, text, recorded_at, event) VALUES ('cv-ada-1', 'cl-ada', 'likes café', '2026-10-02T00:00:00.000Z', 'add')").run();
    const labelOf = (id) => [...request(env).maps.claims.entries()].find(([, value]) => value === id)[0];
    const label = labelOf('cl-ada');
    // While she answers, another writer gives the claim a newer version.
    const llm = fakeLlm(() => {
      env.db.prepare("INSERT INTO claim_versions (id, claim_id, text, recorded_at, event) VALUES ('cv-ada-2', 'cl-ada', 'likes tea', '2026-10-24T11:59:00.000Z', 'revise')").run();
      return memoryBlock({ claims: [{ op: 'revise', id: label, text: 'likes tea mornings', how: 'said', sources: ['#1'], reason: 'said so', base: 'cv-ada-2' }] });
    });
    const result = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }) }));
    assert.equal(result.runs[0].outcome, 'ok');
    assert.equal(result.runs[0].plan.claims[0].base, 'cv-ada-1', 'the base is the request\'s, not the answer\'s');
    assert.equal(env.db.prepare("SELECT text FROM claims WHERE id = 'cl-ada'").get().text, 'likes café mornings', 'nothing written');
    assert.equal(count(env.db, 'decisions', "action = 'rejected:stale_base'"), 1);

    // validateAnswer alone: the base comes from the request's versions, and only when the request resolved them.
    const built = request(env);
    const ask = { claims: [{ op: 'confirm', id: label, sources: ['#1'], base: 'whatever' }] };
    assert.equal(Object.hasOwn(validateAnswer(ask, { maps: built.maps, people: built.people }).plan.claims[0], 'base'), false);
    resolveSessionReads(env.db, built);
    assert.equal(validateAnswer(ask, { maps: built.maps, people: built.people }).plan.claims[0].base, 'cv-ada-2');
  } finally {
    env.done();
  }
});

test('the batch keeps a line\'s revisions apart from another interface\'s line with the same native id', () => {
  const env = fixture();
  try {
    env.say({ native: 'm1', minutesAgo: 50, text: 'Καλημέρα' });
    // Another interface's line with the same native id and a higher revision: not a revision of the Discord line.
    env.db.prepare(`INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, recorded_at, text, scope_kind, scope_iface, authority_id, native_kind)
      VALUES ('src:other:m1', 'seen', 'other', 'm1', 5, NULL, 'other:x', ?, ?, 'elsewhere', 'group', 'other', 'other/global', 'message')`).run(new Date(NOW - 40 * MINUTE).toISOString(), new Date(NOW - 40 * MINUTE).toISOString());
    const scope = scopesOf(env.db).find((entry) => entry.key === 'group:discord');
    const batch = batchOf(env.db, scope.scope, { cursor: 0, since: null, maxMessages: 200, settleBefore: NOW });
    assert.deepEqual(batch.map((line) => line.text), ['Καλημέρα']);
  } finally {
    env.done();
  }
});

test('a batch line names an author who is not a person yet by the handle people:add takes; a person carries none', () => {
  const env = fixture();
  try {
    chat(env);
    // An account with no person writes one line.
    env.db.prepare("INSERT INTO accounts (id, iface, native_id, names, authority_id, native_key, kind) VALUES ('discord:555', 'discord', '555', '[\"Stranger\"]', 'discord/global', '555', 'user')").run();
    env.say({ native: 'm-stranger', minutesAgo: 50, text: 'hello there', author: '555' });
    const scope = scopesOf(env.db).find((entry) => entry.key === 'group:discord');
    const batch = batchOf(env.db, GROUP, { cursor: 0, since: null, maxMessages: 200, settleBefore: NOW });
    const request = buildSessionRequest({ db: env.db, scope, batch, config: baseConfig(), prompts, selfName: 'Nep', now: NOW });
    const handle = [...request.maps.authors].find(([, entry]) => entry.id === 'discord:555')?.[0];
    assert.ok(handle, 'the stranger has a handle');
    const user = request.messages[1].content;
    assert.match(user, new RegExp(`\\[${handle}\\] Stranger: hello there`));
    assert.ok(![...request.maps.authors].some(([h, entry]) => entry.hasPerson && user.includes(`[${h}]`)), 'a person carries no handle');
  } finally {
    env.done();
  }
});
