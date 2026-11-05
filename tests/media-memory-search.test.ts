// Her memory searches over every media kind as over text (src/memory/db/recall.ts#search and memory.search): the word, part
// of a word, people and place-and-time streams, on a line whose text forms are fully present, partly present or absent. The
// rendered line shows its kind marker and its text form. Meaning is tests/media-memory-meaning.test.ts. Synthetic content;
// no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/memory/db/recall.ts';
import {
  AT,
  KINDS,
  PRESENCES,
  SETTINGS,
  NOW,
  assertForms as checkForms,
  countOf,
  fixture,
  group,
  itemsOf,
  observeLine,
  recallRig,
  tell,
} from './fixtures/media-memory.ts';
import type { Env, Kind, Presence } from './fixtures/media-memory.ts';

const PLAN = { forms: [] as Array<string>, who: [] as Array<string>, from: null, to: null };
const hitsFor = (env: Env, form: string) =>
  search(env.db, { ctx: group, plan: { ...PLAN, forms: [form] }, now: NOW, settings: SETTINGS }).hits;
const hitOf = (hits: ReadonlyArray<{ messageId: unknown }>) => hits.some((hit) => hit.messageId === 'pic');
function assertForms(text: string, kind: Kind, presence: Presence) {
  checkForms(text, kind, presence);
}

async function withLine(kind: Kind, presence: Presence, body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  try {
    observeLine(env, kind, presence);
    env.stem();
    await body(env);
  } finally {
    env.done();
  }
}

for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    const told = presence !== 'absent';

    test(`word search: a word of a ${kind.name}'s text form ${told ? 'finds' : 'finds nothing on'} a line with it ${presence}`, () =>
      withLine(kind, presence, (env) => {
        assert.equal(hitOf(hitsFor(env, kind.first.word)), told);
        if (presence === 'part') assert.equal(hitOf(hitsFor(env, kind.second.word)), false);
      }));

    test(`part of a word: a fragment of a ${kind.name}'s text form ${told ? 'finds' : 'finds nothing on'} a line with it ${presence}`, () =>
      withLine(kind, presence, (env) => {
        const hits = hitsFor(env, kind.first.fragment).filter((hit) => hit.messageId === 'pic');
        assert.equal(hits.length > 0, told);
        if (told) assert.ok(hits[0].streams.includes('trigram'));
      }));

    test(`people: the author's lines show a ${kind.name} with its marker and its text form ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        const text = await recallRig(env).ask({ people: kind.self ? 'Self' : 'Alice' });
        assertForms(text, kind, presence);
      }));

    test(`place and time: a sample of the day shows a ${kind.name} with its marker and its text form ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        const text = await recallRig(env).ask({ when: '2026-11-01', channel: 'c1' });
        assertForms(text, kind, presence);
      }));

    test(`memory.search quotes: a ${kind.name} shows its marker and its text form ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        // An absent text form has no word to be found by: the time stream shows the same bare line.
        const question = told ? { terms: kind.first.word } : { when: '2026-11-01' };
        const text = await recallRig(env).ask(question);
        assertForms(text, kind, presence);
      }));
  }

  if (kind.name !== 'voice said') {
    test(`a line with two of a ${kind.name} shows two markers and one text form when one is told`, () =>
      withLine(kind, 'part', async (env) => {
        const text = await recallRig(env).ask({ when: '2026-11-01' });
        assert.equal(countOf(text, kind.marker), 2, text);
        assert.equal(countOf(text, itemsOf(kind, 'pic')[0].told), 1, text);
      }));
  }
}

test('a text form told after the line was stamped is found at once, by a word and by a fragment', () => {
  const env = fixture();
  try {
    const kind = KINDS[0];
    observeLine(env, kind, 'absent', { at: AT });
    env.stem();
    assert.equal(hitOf(hitsFor(env, kind.first.word)), false);
    tell(env, kind, itemsOf(kind, 'pic')[0]);
    assert.equal(hitOf(hitsFor(env, kind.first.word)), true, 'by a word');
    assert.equal(hitOf(hitsFor(env, kind.first.fragment)), true, 'by a fragment');
  } finally {
    env.done();
  }
});
