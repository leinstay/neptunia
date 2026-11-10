// The size of one memory session request (src/memory/db/session.ts): a page is bounded by
// `memoryDb.session.maxPageTokens` as well as by the request cap, so a batch of long lines cannot send a request the
// model does not answer within the session's timeout. A batch pinned by an applied page cannot be cut by lines, so its
// page that is too large goes out in parts of fewer people. Synthetic people and Greek and accented Latin text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchOf, buildSessionRequest, cursorKey, fitBatch, scopesOf, sweep } from '../src/memory/db/session.ts';
import { estimateMessages } from '../src/llm/tokens.ts';
import {
  ADA,
  BOB,
  NOW,
  baseConfig,
  ctxOf,
  fakeLlm,
  fixture,
  memoryBlock,
  personOf,
  prompts,
  textOf,
} from './fixtures/memory-db/session-rig.ts';
import type { Fixture } from './fixtures/memory-db/session-shapes.ts';

const CY = 'u-cy';
const DORA = 'u-dora';
const SCOPE = 'group:discord';

/** Four people with long claims, two lines each: with `maxPeople` 2 the batch takes two pages of two people. */
function crowd(env: Fixture): void {
  for (const [native, name] of [
    [CY, 'Κύρος'],
    [DORA, 'Dóra'],
  ]) {
    env.db.prepare("INSERT INTO people (id, kind, affinity) VALUES (?, 'member', 1)").run(personOf(native));
    env.db
      .prepare("INSERT INTO accounts (id, iface, native_id, person_id, names) VALUES (?, 'discord', ?, ?, ?)")
      .run(`discord:${native}`, native, personOf(native), JSON.stringify([name]));
  }
  let minutes = 120;
  for (const native of [ADA, BOB, CY, DORA]) {
    for (let i = 0; i < 6; i += 1)
      env.claim({
        id: `claim-${native}-${i}`,
        subjectId: personOf(native),
        text: `${native} κρατά μια μακριά σημείωση ${i}: ${'café στη Θεσσαλονίκη, '.repeat(12)}`,
      });
    for (let i = 0; i < 2; i += 1) {
      env.say({
        native: `m-${native}-${i}`,
        minutesAgo: minutes,
        text: `γεια από ${native}, γραμμή ${i}`,
        author: native,
      });
      minutes -= 5;
    }
  }
}

const apply = (session: Record<string, unknown> = {}) =>
  baseConfig({ mode: 'apply', maxPeople: 2, ...session }, { llm: { temperature: 1, maxRequestTokens: 1_000_000 } });

/** The natives of the people a request shows in `<people>` (each person's `id: <@native>` line). */
const shownPeople = (messages: unknown): Array<string> => {
  const user = textOf((messages as Array<{ content: unknown }>)[1].content);
  return [...user.matchAll(/^id: <@([^>]+)>$/gm)].map((match) => match[1]);
};

const cursorOf = (env: Fixture): number =>
  Number(env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('apply', SCOPE))?.value ?? 0);

/** The batch at cursor 0, and the estimate and people of each of its two pages under `config`. */
function pagesNow(env: Fixture, config: Record<string, unknown>) {
  const scope = scopesOf(env.db).find((entry) => entry.key === SCOPE)!;
  const batch = batchOf(env.db, scope.scope, { cursor: 0, since: null, maxMessages: 200, settleBefore: NOW });
  const page = (n: number) => {
    const built = buildSessionRequest({
      db: env.db,
      scope,
      batch,
      config,
      prompts,
      selfName: 'Nep',
      now: NOW,
      page: n,
    });
    return { estimate: estimateMessages(built.messages), people: built.people.map((person) => person.native) };
  };
  return { scope, batch, pages: [page(0), page(1)] };
}

/** A first sweep whose page 0 fails and page 1 is applied: the batch is pinned from then on. */
async function pinWithPageOneApplied(env: Fixture) {
  const llm = fakeLlm((_messages, _options, n) => (n === 1 ? new Error('timeout') : memoryBlock({})));
  await sweep(ctxOf(env, { llm, config: apply() }));
  assert.equal(llm.calls.length, 2, 'the batch took two pages');
  assert.equal(cursorOf(env), 0, 'the cursor waits for page 0');
}

test('a batch whose largest page fits the request cap but not maxPageTokens is cut by lines until it fits the page budget', () => {
  // Catches: fitBatch measured pages against 0.85 of llm.maxRequestTokens only, so a media pass of 200 long lines sent
  // an 84k-token page that timed out at 300 s every hour.
  const env = fixture();
  try {
    crowd(env);
    const { scope, batch, pages } = pagesNow(env, apply());
    const largest = Math.max(...pages.map((page) => page.estimate));
    const config = apply({ maxPageTokens: largest - 1 });
    const fitted = fitBatch(env.db, scope, batch, { config, prompts, selfName: 'Nep', now: NOW, min: 1 });
    assert.ok(fitted.length < batch.length, 'the batch is cut');
    const firstByArrival = [...batch]
      .sort((a, b) => a.rowid - b.rowid)
      .slice(0, fitted.length)
      .map((line) => line.rowid);
    assert.deepEqual(
      fitted.map((line) => line.rowid).sort((a, b) => a - b),
      firstByArrival,
      'the first lines by arrival, so none is skipped'
    );
  } finally {
    env.done();
  }
});

test('a pinned batch whose open page passes maxPageTokens sends that page in parts of fewer people and then moves the cursor', async () => {
  // Catches: the media pass at cursor 24043 stuck for good. Page 1 was applied, so the batch kept its lines (no cut), and
  // page 0 went out whole every hour at the same size and timed out every time.
  const env = fixture();
  try {
    crowd(env);
    await pinWithPageOneApplied(env);
    const { batch, pages } = pagesNow(env, apply());
    const budget = pages[0].estimate - 1;
    const llm = fakeLlm(memoryBlock({}));
    await sweep(ctxOf(env, { llm, config: apply({ maxPageTokens: budget }) }));
    assert.ok(llm.calls.length >= 2, 'page 0 went out in parts');
    for (const call of llm.calls)
      assert.ok(estimateMessages(call.messages) <= budget, 'every part fits the page budget');
    const sent = llm.calls.flatMap((call) => shownPeople(call.messages));
    assert.deepEqual([...sent].sort(), [...pages[0].people].sort(), 'each person of page 0 once, nobody of page 1');
    assert.equal(cursorOf(env), Math.max(...batch.map((line) => line.rowid)), 'the cursor moves past the batch');
  } finally {
    env.done();
  }
});

test('a page sent in parts keeps its parts on the next try: an applied part is not sent again, even when the page would now fit whole', async () => {
  // Catches: a retry that rebuilt the page whole (or split it another way) and wrote the notes of an applied part a
  // second time, from lines whose notes it no longer saw (the context is as of the batch's newest line).
  const env = fixture();
  try {
    crowd(env);
    await pinWithPageOneApplied(env);
    const { batch, pages } = pagesNow(env, apply());
    const split = fakeLlm((_messages, _options, n) => (n === 1 ? memoryBlock({}) : new Error('timeout')));
    await sweep(ctxOf(env, { llm: split, config: apply({ maxPageTokens: pages[0].estimate - 1 }) }));
    assert.ok(split.calls.length >= 2, 'page 0 went out in parts');
    const appliedPart = shownPeople(split.calls[0].messages);
    assert.equal(cursorOf(env), 0, 'a failed part holds the cursor');

    const retry = fakeLlm(memoryBlock({}));
    await sweep(ctxOf(env, { llm: retry, config: apply() }));
    const resent = retry.calls.flatMap((call) => shownPeople(call.messages));
    assert.deepEqual(
      [...resent].sort(),
      pages[0].people.filter((native) => !appliedPart.includes(native)).sort(),
      'only the people of the parts not applied'
    );
    assert.equal(cursorOf(env), Math.max(...batch.map((line) => line.rowid)), 'the cursor moves past the batch');
  } finally {
    env.done();
  }
});
