// The description review (src/memory/db/describe.js): two calls on the memory role, the draft written without the old
// text, the check against it and a claim-level diff, the result stored as a shadow version and never made current.
// A fake llm and synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.js';
import { applyMemoryWrite } from '../src/memory/db/session-write.js';
import { claimDiff, fieldCap, parseDescriptionAnswer, reviewDescription, showsClaim } from '../src/memory/db/describe.js';
import { messageSourceId, personId } from '../src/memory/db/ids.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ADA = 'u-ada';
const OLD = 'Ada likes café mornings and quiet talk. She plays chess privately.';

const prompts = {
  'system-prompt': 'SYSTEM {{name}}',
  'character-card': 'CARD {{name}}',
  rules: 'RULES',
  format: 'FORMAT',
  'description-draft': 'DRAFT PROMPT',
  'description-check': 'CHECK PROMPT',
  'memory-session': 'SESSION',
  labels,
};
const config = (session = {}, memory = {}) => ({
  bot: { timezone: 'UTC' },
  models: { memory: 'x/memory' },
  llm: { temperature: 1, keyByRole: { memory: 'OPENROUTER_MEMORY_KEY' } },
  memory: { fieldChars: 300, ...memory },
  relationships: { textChars: 500 },
  memoryDb: { session: { mode: 'shadow', ...session } },
});

function fixture() {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  const group = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
  const person = personId(ADA);
  const src = (native, at, text) => {
    db.prepare(`INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, text, direct, scope_kind, scope_iface)
      VALUES (?, 'seen', 'discord', ?, 1, 'discord:channel:c1', ?, ?, ?, 0, 'group', 'discord')`).run(messageSourceId(native, 1, 'seen'), native, `discord:${ADA}`, at, text);
    return messageSourceId(native, 1, 'seen');
  };
  const claim = (id, kind, text, { truth = 'current', shown = 1, first = '2026-08-01', last = '2026-10-01', validTo = null } = {}) => db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, how, author, truth, shown, valid_to, scope_kind, scope_iface, first_seen_at, last_seen_at)
     VALUES (?, 'person', ?, ?, ?, 'said', 'her', ?, ?, ?, 'group', 'discord', ?, ?)`,
  ).run(id, person, kind, text, truth, shown, validTo, first, last);
  const link = (claimId, sourceId, position = 0) => db.prepare('INSERT INTO claim_sources (claim_id, source_id, position) VALUES (?, ?, ?)').run(claimId, sourceId, position);
  const version = (claimId, event, text, at) => db.prepare(
    `INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES (?, ?, ?, ?, ?, 'her', 'session')`,
  ).run(`cv:${claimId}:${event}:${at}`, claimId, text, at, event);

  db.prepare("INSERT INTO people (id, kind) VALUES (?, 'member')").run(person);
  db.prepare("INSERT INTO descriptions (id, subject_kind, subject_id, field, scope_kind, scope_iface, current_version) VALUES (?, 'person', ?, 'character', 'group', 'discord', 'dv:old')").run(`desc:${person}:character`, person);
  db.prepare("INSERT INTO description_versions (id, description_id, text, author, written_at, origin) VALUES ('dv:old', ?, ?, 'import', '2026-09-01T00:00:00.000Z', 'legacy')").run(`desc:${person}:character`, OLD);

  claim('k-cafe', 'interest', 'likes café mornings', { last: '2026-08-30' });
  claim('k-chess', 'detail', 'plays chess privately', { truth: 'historical', shown: 0, validTo: '2026-09-15', last: '2026-08-20' });
  claim('k-move', 'detail', 'moved to Thessaloniki', { first: '2026-10-20', last: '2026-10-20' });
  link('k-cafe', src('s1', '2026-08-02T08:00:00.000Z', 'I love a café morning'));
  link('k-chess', src('s2', '2026-08-10T08:00:00.000Z', 'chess is my secret hobby'));
  link('k-move', src('s3', '2026-10-20T08:00:00.000Z', 'I moved to Thessaloniki last week'));
  version('k-cafe', 'add', 'likes café mornings', '2026-08-02T08:00:00.000Z');
  version('k-move', 'add', 'moved to Thessaloniki', '2026-10-20T08:00:00.000Z');
  return { handle, db, person, done: () => handle.close() };
}

function fakeLlm(...answers) {
  const calls = [];
  return {
    calls,
    async complete(messages, options) {
      calls.push({ messages, options });
      const next = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (next instanceof Error) throw next;
      return { text: next, usage: { prompt_tokens: 500, completion_tokens: 40 } };
    },
  };
}

const ctxOf = (env, { llm, cfg = config(), envVars = { OPENROUTER_MEMORY_KEY: 'k' }, promptSet = prompts } = {}) => ({
  llm,
  hot: { config: cfg, prompts: promptSet },
  env: envVars,
  now: () => NOW,
  log: {},
  selfName: 'Nep',
  write: async (update) => applyMemoryWrite(env.handle, update),
});

const answer = (description, reason) => `<think>looking</think>\n<description>${description}</description>\n<reason>${reason}</reason>`;
const subjectOf = (env) => ({ kind: 'person', id: env.person, name: 'Ada' });

test('two calls on the memory role: the draft sees claims and evidence but not the old text; the check sees draft, old text and the diff', async () => {
  const env = fixture();
  try {
    const llm = fakeLlm(
      answer('Ada likes café mornings. She moved to Thessaloniki.', 'new move'),
      answer('Ada likes café mornings and quiet talk. She moved to Thessaloniki.', 'restored the quiet talk'),
    );
    const result = await reviewDescription(env.db, subjectOf(env), 'character', { ctx: ctxOf(env, { llm }) });
    assert.equal(result.status, 'ok');
    assert.equal(result.draft, 'Ada likes café mornings. She moved to Thessaloniki.');
    assert.equal(result.final, 'Ada likes café mornings and quiet talk. She moved to Thessaloniki.');
    assert.equal(llm.calls.length, 2);
    const [first, second] = llm.calls;
    for (const call of llm.calls) {
      assert.equal(call.options.role, 'memory');
      assert.equal(call.options.model, 'x/memory');
      assert.equal(Object.hasOwn(call.options, 'reasoning'), false);
      assert.equal(call.messages[0].role, 'system');
      assert.equal(call.messages[1].role, 'user');
    }
    assert.equal(first.options.purpose, 'description-draft');
    assert.equal(second.options.purpose, 'description-check');
    assert.equal(first.messages[0].content, 'SYSTEM Nep\n\nCARD Nep\n\nRULES\n\nFORMAT\n\nDRAFT PROMPT');
    assert.equal(second.messages[0].content, 'SYSTEM Nep\n\nCARD Nep\n\nRULES\n\nFORMAT\n\nCHECK PROMPT');
    // call 1
    const draftUser = first.messages[1].content;
    const order = ['<subject>', '<claims>', '<evidence>', '<samples>'].map((tag) => draftUser.indexOf(tag));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `blocks in order: ${order}`);
    assert.match(draftUser, /subject: Ada\nkind: person\nfield: character\ncap: 300 characters/);
    assert.match(draftUser, /\[k-cafe\] interest: likes café mornings \(2026-08-01 to 2026-08-30; shown, current\)/);
    assert.match(draftUser, /\[k-chess\] detail: plays chess privately .*historical since 2026-09-15/);
    assert.doesNotMatch(draftUser, /quiet talk/, 'the old description text is not sent');
    assert.match(draftUser, /<samples>\n2026-08-02 08:00: I love a café morning\n2026-08-10 08:00: chess is my secret hobby\n<\/samples>/);
    assert.match(draftUser, /add \[k-move\] moved to Thessaloniki\n  source 2026-10-20 08:00: I moved to Thessaloniki last week/);
    // call 2
    const checkUser = second.messages[1].content;
    assert.match(checkUser, /<draft>\nAda likes café mornings\. She moved to Thessaloniki\.\n<\/draft>/);
    assert.match(checkUser, new RegExp(`<current>\\n${OLD.replace('.', '\\.')}`));
    assert.match(checkUser, /the old text showed, the draft does not:\n\[k-chess\]/);
    assert.match(checkUser, /the draft shows, the old text did not:\n\[k-move\]/);
    assert.ok(checkUser.indexOf('<draft>') < checkUser.indexOf('<current>') && checkUser.indexOf('<current>') < checkUser.indexOf('<diff>'));
  } finally {
    env.done();
  }
});

test('in shadow the draft and the final are one description_versions row of origin shadow; the current version stays', async () => {
  const env = fixture();
  try {
    const llm = fakeLlm(answer('A draft.', 'because'), answer('The final text of Ada.', 'kept the draft but longer'));
    const result = await reviewDescription(env.db, subjectOf(env), 'character', { ctx: ctxOf(env, { llm }) });
    assert.equal(result.status, 'ok');
    const rows = env.db.prepare("SELECT * FROM description_versions WHERE origin = 'shadow'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description_id, `desc:${env.person}:character`);
    assert.equal(rows[0].text, 'The final text of Ada.');
    assert.equal(rows[0].reason, 'kept the draft but longer');
    assert.equal(rows[0].author, 'her');
    assert.equal(rows[0].written_at, '2026-10-24T12:00:00.000Z');
    assert.equal(rows[0].chars, 22);
    const extra = JSON.parse(rows[0].extra);
    assert.equal(extra.draft, 'A draft.');
    assert.equal(extra.draftReason, 'because');
    assert.equal(extra.model, 'x/memory');
    assert.deepEqual(extra.tokens, { prompt: 1000, completion: 80 });
    assert.equal(extra.overCap, undefined);
    assert.equal(env.db.prepare('SELECT current_version FROM descriptions WHERE subject_id = ?').get(env.person).current_version, 'dv:old', 'a shadow version is never current');
    // the next review counts what came after this one as new
    const again = fakeLlm(answer('x', 'y'), answer('z', 'w'));
    env.db.prepare("INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES ('cv-new', 'k-cafe', 'likes café mornings', '2026-10-24T13:00:00.000Z', 'confirm', 'her', 'session')").run();
    await reviewDescription(env.db, subjectOf(env), 'character', { ctx: { ...ctxOf(env, { llm: again }), now: () => NOW + 2 * 3600_000 } });
    const evidence = again.calls[0].messages[1].content.split('<evidence>')[1].split('</evidence>')[0];
    assert.match(evidence, /confirm \[k-cafe\]/);
    assert.doesNotMatch(evidence, /moved to Thessaloniki/, 'what the last review already had is not new evidence');
  } finally {
    env.done();
  }
});

test('a final over the display cap is stored as it came, flagged, never cut', async () => {
  const env = fixture();
  try {
    const long = 'x'.repeat(320);
    const llm = fakeLlm(answer('short', 'r'), answer(long, 'r'));
    const result = await reviewDescription(env.db, subjectOf(env), 'character', { ctx: ctxOf(env, { llm }) });
    assert.equal(result.final, long);
    const row = env.db.prepare("SELECT text, extra FROM description_versions WHERE origin = 'shadow'").get();
    assert.equal(row.text, long);
    assert.equal(JSON.parse(row.extra).overCap, 320);
    assert.equal(fieldCap(config(), 'character'), 300);
    assert.equal(fieldCap(config(), 'relationship'), 500);
    assert.equal(fieldCap(config(), 'patterns'), 600);
  } finally {
    env.done();
  }
});

test('refusals and failures write nothing: off, no key of its own, no prompt, an unreadable or failed call, a field that does not exist', async () => {
  const env = fixture();
  try {
    const llm = fakeLlm(answer('a', 'b'), answer('c', 'd'));
    const run = (extra, field = 'character', subject = subjectOf(env)) => reviewDescription(env.db, subject, field, { ctx: ctxOf(env, { llm, ...extra }) });
    assert.deepEqual(await run({ cfg: config({ mode: 'off' }) }), { status: 'off', code: 'off' });
    assert.deepEqual(await run({ envVars: { OPENROUTER_API_KEY: 'main' } }), { status: 'refused', code: 'not_configured' });
    assert.deepEqual(await run({ promptSet: { ...prompts, 'description-check': '' } }), { status: 'refused', code: 'no_prompt' });
    assert.deepEqual(await run({}, 'height'), { status: 'refused', code: 'bad_subject' });
    assert.deepEqual(await run({}, 'character', { kind: 'thing', id: 'x' }), { status: 'refused', code: 'bad_subject' });
    assert.equal(llm.calls.length, 0);
    const broken = await reviewDescription(env.db, subjectOf(env), 'character', { ctx: ctxOf(env, { llm: fakeLlm('no tags here') }) });
    assert.deepEqual(broken, { status: 'failed', code: 'bad_answer', step: 'draft' });
    const second = await reviewDescription(env.db, subjectOf(env), 'character', { ctx: ctxOf(env, { llm: fakeLlm(answer('ok', 'r'), '<description></description>') }) });
    assert.deepEqual(second, { status: 'failed', code: 'bad_answer', step: 'check' });
    const down = await reviewDescription(env.db, subjectOf(env), 'character', { ctx: ctxOf(env, { llm: fakeLlm(Object.assign(new Error('down'), { code: 'ECONNRESET' })) }) });
    assert.deepEqual(down, { status: 'failed', code: 'ECONNRESET', step: 'draft' });
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM description_versions WHERE origin = 'shadow'").get().n, 0);
  } finally {
    env.done();
  }
});

test('answers: the description and the reason after the thinking; an empty or missing description is nothing', () => {
  assert.deepEqual(parseDescriptionAnswer(answer('Text', 'why')), { description: 'Text', reason: 'why' });
  assert.deepEqual(parseDescriptionAnswer('<think><description>inside</description></think><description>Outside</description>'), { description: 'Outside', reason: '' });
  assert.equal(parseDescriptionAnswer('<description>  </description>'), null);
  assert.equal(parseDescriptionAnswer('plain'), null);
});

test('the claim-level diff is a text match over a claim words: what the old text showed and the draft lost, and the reverse', () => {
  const claims = [{ id: 'a', text: 'likes café mornings' }, { id: 'b', text: 'plays chess privately' }, { id: 'c', text: 'moved to Thessaloniki' }, { id: 'd', text: 'ok' }];
  assert.equal(showsClaim('She likes quiet café mornings.', claims[0]), true);
  assert.equal(showsClaim('She likes quiet evenings.', claims[0]), false);
  assert.equal(showsClaim('anything', claims[3]), false, 'a claim with no word of four letters is never shown by a match');
  const diff = claimDiff(claims, 'Likes café mornings. Plays chess privately.', 'Likes café mornings. Moved to Thessaloniki.');
  assert.deepEqual([diff.kept, diff.lost.map((c) => c.id), diff.gained.map((c) => c.id)], [1, ['b'], ['c']]);
});
