// The description review (src/memory/db/describe.ts): two calls on the memory role, the draft written without the old
// text, the check against it and a claim-level diff, the result stored as a shadow version and never made current.
// A fake llm and synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { fillAudiences } from './fixtures/memory-db/audiences.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import {
  claimDiff,
  fieldCap,
  parseDescriptionAnswer,
  reviewDescription,
  showsClaim,
} from '../src/memory/db/describe.ts';
import { messageSourceId, shortHash } from '../src/memory/db/ids.ts';
import { personId } from './fixtures/memory-db/spelled-ids.ts';
import { dmContext } from '../src/memory/db/scope.ts';
import { labels } from './fixtures/labels.ts';
import type { Untyped } from '../src/tools/types.ts';
import type { KeyRing } from '../src/keys/ring.ts';
import { memoryRing } from './fixtures/memory-db/session-rig.ts';
import { sqlOf, wrongly } from './fixtures/loose-types.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ADA = 'u-ada';
const OLD = 'Ada likes café mornings and quiet talk. She plays chess privately.';

const prompts = {
  'system-prompt': 'SYSTEM {{name}}',
  'character-card': 'CARD {{name}}',
  // The rules text holds a list item: a rules file with an empty list reaches no system text (src/rules-list.ts).
  rules: '- RULES',
  format: 'FORMAT',
  'description-draft': 'DRAFT PROMPT',
  'description-check': 'CHECK PROMPT',
  'memory-session': 'SESSION',
  labels,
};
// PR 7d: the field lengths are MEMORY_LIMITS.fieldChars (1000) and RELATIONSHIP_LIMITS.textChars (800).
const config = (session = {}) => ({
  bot: { timezone: 'UTC' },
  models: { base: { memory: 'x/memory' } },
  memoryDb: { session: { mode: 'shadow', ...session } },
});

function fixture() {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  const group = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
  const person = personId('discord', ADA);
  const src = (native: Untyped, at: Untyped, text: Untyped) => {
    db.prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, text, direct, scope_kind, scope_iface)
      VALUES (?, 'seen', 'discord', ?, 1, 'discord:channel:c1', ?, ?, ?, 0, 'group', 'discord')`
    ).run(messageSourceId('discord', native, 1, 'seen'), native, `discord:${ADA}`, at, text);
    return messageSourceId('discord', native, 1, 'seen');
  };
  const claim = (
    id: Untyped,
    kind: Untyped,
    text: Untyped,
    { truth = 'current', shown = 1, first = '2026-08-01', last = '2026-10-01', validTo = null } = {}
  ) =>
    db
      .prepare(
        `INSERT INTO claims (id, subject_kind, subject_id, kind, text, how, author, truth, shown, valid_to, scope_kind, scope_iface, first_seen_at, last_seen_at)
     VALUES (?, 'person', ?, ?, ?, 'said', 'her', ?, ?, ?, 'group', 'discord', ?, ?)`
      )
      .run(id, person, kind, text, truth, shown, validTo, first, last);
  const link = (claimId: Untyped, sourceId: Untyped, position = 0) =>
    db
      .prepare('INSERT INTO claim_sources (claim_id, source_id, position) VALUES (?, ?, ?)')
      .run(claimId, sourceId, position);
  const version = (claimId: Untyped, event: Untyped, text: Untyped, at: Untyped) =>
    db
      .prepare(
        `INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES (?, ?, ?, ?, ?, 'her', 'session')`
      )
      .run(`cv:${claimId}:${event}:${at}`, claimId, text, at, event);

  db.prepare("INSERT INTO people (id, kind) VALUES (?, 'member')").run(person);
  db.prepare(
    "INSERT INTO descriptions (id, subject_kind, subject_id, field, scope_kind, scope_iface, current_version) VALUES (?, 'person', ?, 'character', 'group', 'discord', 'dv:old')"
  ).run(`desc:${person}:character`, person);
  db.prepare(
    "INSERT INTO description_versions (id, description_id, text, author, written_at, origin) VALUES ('dv:old', ?, ?, 'import', '2026-09-01T00:00:00.000Z', 'legacy')"
  ).run(`desc:${person}:character`, OLD);

  claim('k-cafe', 'interest', 'likes café mornings', { last: '2026-08-30' });
  claim('k-chess', 'detail', 'plays chess privately', {
    truth: 'historical',
    shown: 0,
    validTo: wrongly('2026-09-15'),
    last: '2026-08-20',
  });
  claim('k-move', 'detail', 'moved to Thessaloniki', { first: '2026-10-20', last: '2026-10-20' });
  link('k-cafe', src('s1', '2026-08-02T08:00:00.000Z', 'I love a café morning'));
  link('k-chess', src('s2', '2026-08-10T08:00:00.000Z', 'chess is my secret hobby'));
  link('k-move', src('s3', '2026-10-20T08:00:00.000Z', 'I moved to Thessaloniki last week'));
  version('k-cafe', 'add', 'likes café mornings', '2026-08-02T08:00:00.000Z');
  version('k-move', 'add', 'moved to Thessaloniki', '2026-10-20T08:00:00.000Z');
  // PR 7d: the review reads through `audience_id`, so the rows written here carry it.
  fillAudiences(wrongly(db));
  return { handle, db, person, done: () => handle.close() };
}

function fakeLlm(...answers: Array<Untyped>) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    async complete(messages: Record<string, Untyped>, options: Record<string, Untyped>) {
      calls.push({ messages, options });
      const next = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (next instanceof Error) throw next;
      return { text: next, usage: { prompt_tokens: 500, completion_tokens: 40 } };
    },
  };
}

const ctxOf = (
  env: Record<string, Untyped>,
  {
    llm,
    cfg = config(),
    ring = memoryRing(),
    promptSet = prompts,
  }: { llm?: Untyped; cfg?: Untyped; ring?: KeyRing | null; promptSet?: Untyped } = {}
) => ({
  llm,
  hot: { config: cfg, prompts: promptSet },
  env: {},
  ring,
  now: () => NOW,
  log: {},
  selfName: 'Nep',
  write: async (update: Record<string, Untyped>) => applyMemoryWrite(env.handle, update),
});

const answer = (description: Untyped, reason: Untyped) =>
  `<think>looking</think>\n<description>${description}</description>\n<reason>${reason}</reason>`;
const subjectOf = (env: Record<string, Untyped>) => ({ kind: 'person', id: env.person, name: 'Ada' });

test('two calls on the memory role: the draft sees claims and evidence but not the old text; the check sees draft, old text and the diff', async () => {
  const env = fixture();
  try {
    const llm = fakeLlm(
      answer('Ada likes café mornings. She moved to Thessaloniki.', 'new move'),
      answer('Ada likes café mornings and quiet talk. She moved to Thessaloniki.', 'restored the quiet talk')
    );
    const result = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm }))),
    });
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
    assert.equal(first.messages[0].content, 'SYSTEM Nep\n\nCARD Nep\n\n- RULES\n\nFORMAT\n\nDRAFT PROMPT');
    assert.equal(second.messages[0].content, 'SYSTEM Nep\n\nCARD Nep\n\n- RULES\n\nFORMAT\n\nCHECK PROMPT');
    // call 1
    const draftUser = first.messages[1].content;
    const order = ['<subject>', '<claims>', '<evidence>', '<samples>'].map((tag) => draftUser.indexOf(tag));
    assert.ok(
      order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
      `blocks in order: ${order}`
    );
    assert.match(draftUser, /subject: Ada\nkind: person\nfield: character\ncap: 1000 characters/);
    assert.match(draftUser, /\[k-cafe\] interest: likes café mornings \(2026-08-01 to 2026-08-30; shown, current\)/);
    assert.match(draftUser, /\[k-chess\] detail: plays chess privately .*historical since 2026-09-15/);
    assert.doesNotMatch(draftUser, /quiet talk/, 'the old description text is not sent');
    assert.match(
      draftUser,
      /<samples>\n2026-08-02 08:00: I love a café morning\n2026-08-10 08:00: chess is my secret hobby\n<\/samples>/
    );
    assert.match(
      draftUser,
      /add \[k-move\] moved to Thessaloniki\n  source 2026-10-20 08:00: I moved to Thessaloniki last week/
    );
    // call 2
    const checkUser = second.messages[1].content;
    assert.match(checkUser, /<draft>\nAda likes café mornings\. She moved to Thessaloniki\.\n<\/draft>/);
    assert.match(checkUser, new RegExp(`<current>\\n${OLD.replace('.', '\\.')}`));
    assert.match(checkUser, /the old text showed, the draft does not:\n\[k-chess\]/);
    assert.match(checkUser, /the draft shows, the old text did not:\n\[k-move\]/);
    assert.ok(
      checkUser.indexOf('<draft>') < checkUser.indexOf('<current>') &&
        checkUser.indexOf('<current>') < checkUser.indexOf('<diff>')
    );
  } finally {
    env.done();
  }
});

test('in shadow the draft and the final are one description_versions row of origin shadow; the current version stays', async () => {
  const env = fixture();
  try {
    const llm = fakeLlm(answer('A draft.', 'because'), answer('The final text of Ada.', 'kept the draft but longer'));
    const result = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm }))),
    });
    assert.equal(result.status, 'ok');
    const rows = sqlOf(env).prepare("SELECT * FROM description_versions WHERE origin = 'shadow'").all();
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
    assert.equal(
      sqlOf(env).prepare('SELECT current_version FROM descriptions WHERE subject_id = ?').get(env.person)
        .current_version,
      'dv:old',
      'a shadow version is never current'
    );
    // the next review counts what came after this one as new
    const again = fakeLlm(answer('x', 'y'), answer('z', 'w'));
    sqlOf(env)
      .prepare(
        "INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES ('cv-new', 'k-cafe', 'likes café mornings', '2026-10-24T13:00:00.000Z', 'confirm', 'her', 'session')"
      )
      .run();
    await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly({ ...ctxOf(env, wrongly({ llm: again })), now: () => NOW + 2 * 3600_000 }),
    });
    const evidence = again.calls[0].messages[1].content.split('<evidence>')[1].split('</evidence>')[0];
    assert.match(evidence, /confirm \[k-cafe\]/);
    assert.match(
      evidence,
      /moved to Thessaloniki/,
      'a shadow review does not move the last-reviewed mark: the accepted version of September is still the last one'
    );
  } finally {
    env.done();
  }
});

test('a final over the display cap is stored as it came, flagged, never cut', async () => {
  const env = fixture();
  try {
    const long = 'x'.repeat(1020);
    const llm = fakeLlm(answer('short', 'r'), answer(long, 'r'));
    const result = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm }))),
    });
    assert.equal(result.final, long);
    const row = sqlOf(env).prepare("SELECT text, extra FROM description_versions WHERE origin = 'shadow'").get();
    assert.equal(row.text, long);
    assert.equal(JSON.parse(row.extra).overCap, 1020);
    assert.equal(fieldCap(config(), 'character'), 1000);
    assert.equal(fieldCap(config(), 'relationship'), 800);
    assert.equal(fieldCap(config(), 'patterns'), 2000);
  } finally {
    env.done();
  }
});

test('refusals and failures write nothing: off, no key of its own, no prompt, an unreadable or failed call, a field that does not exist', async () => {
  const env = fixture();
  try {
    const llm = fakeLlm(answer('a', 'b'), answer('c', 'd'));
    const run = (extra: Record<string, Untyped>, field = 'character', subject = subjectOf(env)) =>
      reviewDescription(wrongly(env.db), subject, field, { ctx: wrongly(ctxOf(env, { llm, ...extra })) });
    assert.deepEqual(await run({ cfg: config({ mode: 'off' }) }), { status: 'off', code: 'off' });
    // No key ring stands where a core variable of `.env` stood: the key comes from the ring alone.
    assert.deepEqual(await run({ ring: null }), {
      status: 'refused',
      code: 'not_configured',
    });
    assert.deepEqual(await run({ promptSet: { ...prompts, 'description-check': '' } }), {
      status: 'refused',
      code: 'no_prompt',
    });
    assert.deepEqual(await run({}, 'height'), { status: 'refused', code: 'bad_subject' });
    assert.deepEqual(await run({}, 'character', wrongly({ kind: 'thing', id: 'x' })), {
      status: 'refused',
      code: 'bad_subject',
    });
    assert.equal(llm.calls.length, 0);
    const broken = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm: fakeLlm('no tags here') }))),
    });
    assert.deepEqual(broken, { status: 'failed', code: 'bad_answer', step: 'draft' });
    const second = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm: fakeLlm(answer('ok', 'r'), '<description></description>') }))),
    });
    assert.deepEqual(second, { status: 'failed', code: 'bad_answer', step: 'check' });
    const down = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm: fakeLlm(Object.assign(new Error('down'), { code: 'ECONNRESET' })) }))),
    });
    assert.deepEqual(down, { status: 'failed', code: 'ECONNRESET', step: 'draft' });
    assert.equal(
      sqlOf(env).prepare("SELECT COUNT(*) AS n FROM description_versions WHERE origin = 'shadow'").get().n,
      0
    );
  } finally {
    env.done();
  }
});

test('answers: the description and the reason after the thinking; an empty or missing description is nothing', () => {
  assert.deepEqual(parseDescriptionAnswer(answer('Text', 'why')), { description: 'Text', reason: 'why' });
  assert.deepEqual(
    parseDescriptionAnswer('<think><description>inside</description></think><description>Outside</description>'),
    { description: 'Outside', reason: '' }
  );
  assert.equal(parseDescriptionAnswer('<description>  </description>'), null);
  assert.equal(parseDescriptionAnswer('plain'), null);
});

test('the claim-level diff is a text match over a claim words: what the old text showed and the draft lost, and the reverse', () => {
  const claims = [
    { id: 'a', text: 'likes café mornings' },
    { id: 'b', text: 'plays chess privately' },
    { id: 'c', text: 'moved to Thessaloniki' },
    { id: 'd', text: 'ok' },
  ];
  assert.equal(showsClaim('She likes quiet café mornings.', claims[0]), true);
  assert.equal(showsClaim('She likes quiet evenings.', claims[0]), false);
  assert.equal(
    showsClaim('anything', claims[3]),
    false,
    'a claim with no word of four letters is never shown by a match'
  );
  const diff = claimDiff(
    claims,
    'Likes café mornings. Plays chess privately.',
    'Likes café mornings. Moved to Thessaloniki.'
  );
  assert.deepEqual([diff.kept, diff.lost.map((c) => c.id), diff.gained.map((c) => c.id)], [1, ['b'], ['c']]);
});

const applyConfig = (extra = {}) => ({
  ...config({ mode: 'apply' }),
  memoryDb: { session: { mode: 'apply' }, ...extra },
});

test('a description is identified by its scope: a private review of the same subject and field is a description of its own', async () => {
  const env = fixture();
  try {
    const dm = dmContext(personId('discord', ADA), 'discord', `discord:dm:${ADA}`);
    const llm = fakeLlm(answer('A private draft.', 'r'), answer('A private final.', 'r'));
    const result: Record<string, Untyped> = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly({ ...ctxOf(env, wrongly({ llm })), readCtx: dm }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.row.descriptionId, `desc:dm.discord.${personId('discord', ADA)}:${env.person}:character`);
    assert.doesNotMatch(llm.calls[1].messages[1].content, /<current>/, 'the group description is not the private one');
    // the stored group description keeps the id it has and is found again
    const group = fakeLlm(answer('g', 'r'), answer('h', 'r'));
    const again: Record<string, Untyped> = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm: group }))),
    });
    assert.equal(again.row.descriptionId, `desc:${env.person}:character`);
    assert.match(group.calls[1].messages[1].content, /<current>\nAda likes café mornings/);
  } finally {
    env.done();
  }
});

test('the version stores its exact evidence: claim and source ids, model, prompt hashes, and both whole answers as internal sources', async () => {
  const env = fixture();
  try {
    // a retired link is not evidence (it would sort first if it counted)
    sqlOf(env)
      .prepare(
        "INSERT INTO claim_sources (claim_id, source_id, position, retired_at) VALUES ('k-cafe', ?, -1, '2026-10-01T00:00:00.000Z')"
      )
      .run(messageSourceId('discord', 's3', 1, 'seen'));
    const llm = fakeLlm(answer('A draft.', 'because'), answer('The final.', 'longer'));
    const result = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm }))),
    });
    assert.equal(result.status, 'ok');
    const extra = JSON.parse(
      sqlOf(env).prepare("SELECT extra FROM description_versions WHERE origin = 'shadow'").get().extra
    );
    assert.deepEqual(extra.claimIds, ['k-cafe', 'k-chess', 'k-move']);
    assert.deepEqual(
      extra.evidenceClaimIds,
      ['k-move'],
      'only the claim that changed since the last accepted review is evidence'
    );
    assert.deepEqual(extra.evidenceSourceIds.sort(), [
      messageSourceId('discord', 's1', 1, 'seen'),
      messageSourceId('discord', 's2', 1, 'seen'),
      messageSourceId('discord', 's3', 1, 'seen'),
    ]);
    assert.ok(extra.evidence.some((line: Record<string, Untyped>) => line.includes('moved to Thessaloniki')));
    assert.equal(extra.model, 'x/memory');
    assert.deepEqual(extra.prompts, { draft: shortHash('DRAFT PROMPT'), check: shortHash('CHECK PROMPT') });
    assert.equal(extra.basedOn, 'dv:old');
    assert.deepEqual(extra.diff.lost.sort(), ['k-cafe', 'k-chess']);
    const kept = sqlOf(env)
      .prepare("SELECT id, kind, text, think, scope_kind FROM sources WHERE kind = 'description_review' ORDER BY id")
      .all();
    assert.equal(kept.length, 2);
    assert.ok(
      kept.every(
        (row) =>
          row.scope_kind === 'internal' && row.text.startsWith('<think>looking</think>') && row.think === 'looking'
      )
    );
    assert.deepEqual(
      extra.answers.map((entry: Record<string, Untyped>) => entry.purpose),
      ['description-draft', 'description-check']
    );
    assert.deepEqual(
      extra.answers.map((entry: Record<string, Untyped>) => entry.source).sort(),
      kept.map((row) => row.id)
    );
    assert.ok(
      extra.samples.some((line: Record<string, Untyped>) => line.includes('I love a café morning')),
      'the live link of the claim is the sample'
    );
    assert.ok(
      !extra.samples.some((line: Record<string, Untyped>) => line.includes('Thessaloniki')),
      'the retired link is not'
    );
  } finally {
    env.done();
  }
});

test('apply: the final becomes the current version in the transaction that stores it; the next review starts from it', async () => {
  const env = fixture();
  try {
    const cfg = applyConfig();
    const llm = fakeLlm(answer('A draft.', 'r'), answer('The accepted text.', 'because'));
    const result = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm, cfg }))),
    });
    assert.equal(result.status, 'ok');
    const row = sqlOf(env).prepare('SELECT id, origin, text FROM description_versions WHERE author = ?').get('her');
    assert.deepEqual([row.origin, row.text], ['review', 'The accepted text.']);
    assert.equal(
      sqlOf(env).prepare('SELECT current_version FROM descriptions WHERE id = ?').get(`desc:${env.person}:character`)
        .current_version,
      row.id
    );
    // the next review reads it as the stored text and counts evidence from its time
    const next = fakeLlm(answer('x', 'y'), answer('z', 'w'));
    await reviewDescription(wrongly(env.db), subjectOf(env), 'character', {
      ctx: wrongly(ctxOf(env, wrongly({ llm: next, cfg }))),
    });
    assert.match(next.calls[1].messages[1].content, /<current>\nThe accepted text\./);
    const evidence = next.calls[0].messages[1].content.split('<evidence>')[1] ?? '';
    assert.doesNotMatch(evidence, /moved to Thessaloniki/, 'the accepted review already had it');
    // a description that did not exist is created with its scope
    const fresh: Record<string, Untyped> = await reviewDescription(wrongly(env.db), subjectOf(env), 'style', {
      ctx: wrongly(ctxOf(env, wrongly({ llm: fakeLlm(answer('a', 'b'), answer('fresh style', 'c')), cfg }))),
    });
    const created = sqlOf(env).prepare("SELECT * FROM descriptions WHERE field = 'style'").get();
    assert.deepEqual(
      [created.id, created.scope_kind, created.scope_iface, created.current_version],
      [fresh.row.descriptionId, 'group', 'discord', fresh.row.id]
    );
  } finally {
    env.done();
  }
});

test('apply: a mode the writer does not know is refused; a version moved meanwhile is not overwritten', async () => {
  const env = fixture();
  try {
    const row = {
      id: 'dv:x',
      descriptionId: `desc:${env.person}:character`,
      text: 'x',
      writtenAt: '2026-10-24T12:00:00.000Z',
      extra: {},
    };
    const update = {
      kind: 'description',
      mode: 'apply',
      row,
      subject: { kind: 'person', id: env.person, field: 'character' },
      scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
      expectCurrent: 'dv:old',
      now: NOW,
    };
    assert.throws(
      () => applyMemoryWrite(env.handle, { ...update, mode: 'other' }),
      (error: Record<string, Untyped>) => error.code === 'BAD_MODE'
    );
    assert.equal(sqlOf(env).prepare("SELECT COUNT(*) AS n FROM description_versions WHERE id = 'dv:x'").get().n, 0);
    // the current version moved after the review began
    const racing = { ...ctxOf(env, wrongly({ llm: fakeLlm(answer('a', 'b'), answer('c', 'd')), cfg: applyConfig() })) };
    const write = racing.write;
    racing.write = async (given) => {
      sqlOf(env)
        .prepare(
          "INSERT INTO description_versions (id, description_id, text, origin) VALUES ('dv:other', ?, 'someone else', 'review')"
        )
        .run(row.descriptionId);
      sqlOf(env).prepare('UPDATE descriptions SET current_version = ? WHERE id = ?').run('dv:other', row.descriptionId);
      return write(given);
    };
    const raced = await reviewDescription(wrongly(env.db), subjectOf(env), 'character', { ctx: wrongly(racing) });
    assert.deepEqual(raced, { status: 'failed', code: 'VERSION_CONFLICT', step: 'write' });
    assert.equal(
      sqlOf(env).prepare('SELECT current_version FROM descriptions WHERE id = ?').get(row.descriptionId)
        .current_version,
      'dv:other'
    );
    assert.equal(
      sqlOf(env).prepare("SELECT COUNT(*) AS n FROM description_versions WHERE author = 'her'").get().n,
      0,
      'the refused version is not stored'
    );
  } finally {
    env.done();
  }
});

/** The user message of the first call a fake llm saw: the draft request. */
function draftUserOf(calls: ReadonlyArray<unknown>): string {
  const [first] = wrongly<Array<{ messages: Array<{ content: string }> }>>(calls);
  const [, user] = first?.messages ?? [];
  return user?.content ?? '';
}

/** A direct chat with no claims about it: its lines, one line of another direct chat and one of a group channel. */
function chatFixture() {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  const meta = 'person:0b6f2c1e-0000-4000-8000-000000000002';
  const line = (place: string, native: string, kind: string, at: string, text: string, audience: string) =>
    db
      .prepare(
        `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, text, direct, audience_id)
        VALUES (?, ?, 'discord', ?, 1, ?, 'discord:n1', ?, ?, 1, ?)`
      )
      .run(messageSourceId('discord', native, 1, kind), kind, native, place, at, text, audience);
  for (const [id, kind] of [
    ['discord:dm:n1', 'dm'],
    ['discord:dm:n2', 'dm'],
    ['discord:channel:c1', 'channel'],
  ])
    db.prepare("INSERT INTO places (id, kind, iface) VALUES (?, ?, 'discord')").run(id, kind);
  db.prepare(
    "INSERT INTO audiences (id, kind, iface, place_id) VALUES ('aud:dm:discord:dm:n1', 'dm', 'discord', 'discord:dm:n1')"
  ).run();
  db.prepare(
    "INSERT INTO audiences (id, kind, iface, place_id) VALUES ('aud:dm:discord:dm:n2', 'dm', 'discord', 'discord:dm:n2')"
  ).run();
  db.prepare("INSERT INTO audiences (id, kind, iface) VALUES ('aud:group:discord', 'group', 'discord')").run();
  line(
    'discord:dm:n1',
    'm1',
    'seen',
    '2026-10-20T08:00:00.000Z',
    'shall we test the drawing again',
    'aud:dm:discord:dm:n1'
  );
  line('discord:dm:n1', 'm2', 'said', '2026-10-20T08:01:00.000Z', 'send me the photo first', 'aud:dm:discord:dm:n1');
  line('discord:dm:n2', 'm3', 'seen', '2026-10-20T09:00:00.000Z', 'a secret of the other chat', 'aud:dm:discord:dm:n2');
  line(
    'discord:channel:c1',
    'm4',
    'seen',
    '2026-10-20T10:00:00.000Z',
    'a line of the public room',
    'aud:group:discord'
  );
  const readCtx = { ...dmContext(meta, 'discord', 'discord:dm:n1'), audienceColumn: true };
  return { handle, db, readCtx, done: () => handle.close() };
}

test('a direct chat with no claims about it is reviewed from its own lines', async () => {
  const env = fixture();
  const chat = chatFixture();
  try {
    const llm = fakeLlm(answer('We test drawings here.', 'from the lines'), answer('We test drawings here.', 'kept'));
    await reviewDescription(wrongly(chat.db), { kind: 'place', id: 'discord:dm:n1' }, 'purpose', {
      ctx: wrongly({ ...ctxOf(env, wrongly({ llm })), readCtx: chat.readCtx }),
    });
    const draftUser = draftUserOf(llm.calls);
    assert.match(draftUser, /2026-10-20 08:00: shall we test the drawing again/);
    assert.match(draftUser, /2026-10-20 08:01: Nep: send me the photo first/);
  } finally {
    chat.done();
    env.done();
  }
});

test('a direct chat review reads no line of another chat', async () => {
  const env = fixture();
  const chat = chatFixture();
  try {
    const llm = fakeLlm(answer('We test drawings here.', 'from the lines'), answer('We test drawings here.', 'kept'));
    await reviewDescription(wrongly(chat.db), { kind: 'place', id: 'discord:dm:n1' }, 'purpose', {
      ctx: wrongly({ ...ctxOf(env, wrongly({ llm })), readCtx: chat.readCtx }),
    });
    const draftUser = draftUserOf(llm.calls);
    assert.doesNotMatch(draftUser, /secret of the other chat|public room/);
  } finally {
    chat.done();
    env.done();
  }
});
