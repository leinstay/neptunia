// She sees any attachment the same way in recent messages and in memory: the kind marker and the text form. The memory
// prefetch (src/behavior/recall-run.ts#prefetch), window reads (#window), the memory session's source batch
// (src/memory/db/session.ts#buildSessionRequest), the turn's chat rendering (src/format.ts#formatTranscript), the stored
// lines a task and a conversation read (src/memory/db/conversation-lines.ts) and the owner's browser
// (src/memory/db/domain-read.ts#domainDetail). Audience holds in each. Synthetic content; no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTranscript } from '../src/format.ts';
import { conversationLines, recentGroupLines } from '../src/memory/db/conversation-lines.ts';
import { domainDetail } from '../src/memory/db/domain-read.ts';
import { search } from '../src/memory/db/recall.ts';
import { dmContext, internalContext } from '../src/memory/db/scope.ts';
import { batchOf, buildSessionRequest, scopesOf } from '../src/memory/db/session.ts';
import { fillStems } from '../src/memory/db/stems.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { baseConfig, prompts as sessionPrompts, textOf } from './fixtures/memory-db/session-rig.ts';
import {
  AT,
  BOB_PERSON,
  BOB_SCOPE,
  GENERAL,
  HER,
  KINDS,
  LABELS,
  NOW,
  PRESENCES,
  SETTINGS,
  UNREADABLE,
  assertForms as checkForms,
  fixture,
  group,
  itemsOf,
  kindNamed,
  observeDmLine,
  observeLine,
  recallRig,
  tell,
} from './fixtures/media-memory.ts';
import type { Env, Kind, Presence } from './fixtures/media-memory.ts';
import type { Row } from '../src/memory/db/types.ts';

async function withLine(kind: Kind, presence: Presence, body: (env: Env, source: string) => void | Promise<void>) {
  const env = fixture();
  try {
    const source = observeLine(env, kind, presence);
    fillStems(env.db);
    await body(env, source);
  } finally {
    env.done();
  }
}

function assertForms(text: string, kind: Kind, presence: Presence) {
  checkForms(text, kind, presence);
}

/** The `<batch>` of a memory session request over the fixture's group lines. */
function sessionBatch(env: Env): string {
  fillEnvAudiences(env);
  const scope = scopesOf(env.db).find((one) => one.scope.scope_kind === 'group');
  assert.ok(scope, 'a group scope');
  const batch = batchOf(env.db, scope.scope, { cursor: 0, since: null, maxMessages: 200, settleBefore: NOW });
  const built = buildSessionRequest({
    db: env.db,
    scope,
    batch,
    config: baseConfig(),
    prompts: { ...sessionPrompts, labels: LABELS },
    selfName: 'Self',
    now: NOW,
  });
  const text = textOf(built.messages[1].content);
  return text.slice(text.indexOf('<batch>'));
}

/** A window read that holds the line: a window starts after its anchor. */
async function windowLines(env: Env): Promise<string> {
  env.say({ native: 'before', at: AT - 60_000, text: 'first', place: GENERAL });
  const rig = recallRig(env);
  const found = await rig.recall.window({ ...rig.args, anchor: 'before', move: 'down', messages: 1 });
  return (found.quotes ?? []).map((quote) => quote.lines).join('\n');
}

for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    test(`session batch: a ${kind.name} is a numbered line with its marker and its text form ${presence}`, () =>
      withLine(kind, presence, (env) => {
        const batch = sessionBatch(env);
        assert.match(batch, /#1 \[/, 'a line with no text still has a number she can cite');
        assertForms(batch, kind, presence);
      }));

    test(`window read: a ${kind.name} shows its marker and its text form ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        const lines = await windowLines(env);
        assertForms(lines, kind, presence);
      }));

    test(`owner browser: a ${kind.name} opens with its media and its text form ${presence}`, () =>
      withLine(kind, presence, (env, source) => {
        const detail = domainDetail(env.db, { family: 'sources', id: source, context: internalContext() }) as Row;
        assert.equal(detail.found, true);
        const media = detail.sourceMedia as Array<{ kind: string; text: string | null; availability: string }>;
        assert.ok(Array.isArray(media) && media.length >= 1, 'the record lists its media');
        assert.equal(media[0].kind, kind.stored);
        assert.equal(media[0].availability, presence === 'absent' ? 'unread' : 'told');
        assert.equal((media[0].text ?? '').includes(kind.first.word), presence !== 'absent');
      }));

    test(`stored lines: a task's recent lines show a ${kind.name}, with its text form ${presence}`, () =>
      withLine(kind, presence, (env) => {
        fillEnvAudiences(env);
        const lines = recentGroupLines(env.db, GENERAL, 5) as Array<{ media?: Array<{ text: string | null }> }>;
        assert.equal(lines.length >= 1, true, 'a line with no text is not dropped');
        assert.equal(JSON.stringify(lines[0].media ?? []).includes(kind.first.word), presence !== 'absent');
      }));
  }

  // A prefetch hit needs two terms of the lane (src/behavior/prefetch.ts#lexicalKeep): the word and the retelling's own.
  for (const presence of ['full', 'part'] as const) {
    test(`prefetch: a ${kind.name} found by words of its text form shows its marker and its text form ${presence}`, () =>
      withLine(kind, presence, async (env) => {
        const rig = recallRig(env);
        const words = `retelling ${kind.first.word}`;
        const found = await rig.recall.prefetch({ ...rig.args, lanes: [{ kind: 'message', text: words, words }] });
        assertForms(JSON.stringify(found?.excerpts ?? []), kind, presence);
      }));
  }

  // ---------- audience ----------

  test(`audience: a DM's ${kind.name} is read in its DM and never by a group, on any read`, async () => {
    const env = fixture();
    try {
      const source = observeDmLine(env, kind);
      fillStems(env.db);
      const rig = recallRig(env);
      const inDm = search(env.db, {
        ctx: dmContext(BOB_PERSON, 'discord'),
        plan: { forms: [kind.first.word], who: [], from: null, to: null },
        now: NOW,
        settings: SETTINGS,
      });
      assert.deepEqual(
        inDm.hits.map((hit) => hit.messageId),
        ['secret'],
        'its own DM finds the text form'
      );

      const word = kind.first.word;
      assert.ok(!(await rig.ask({ terms: word })).includes(word), 'memory.search by a word');
      assert.ok(!(await rig.ask({ terms: kind.first.fragment })).includes(word), 'by a fragment');
      assert.ok(!(await rig.ask({ when: '2026-11-01' })).includes(word), 'a sample of the day');
      assert.ok(!(await rig.ask({ people: 'Bob' })).includes(word), 'the people stream');
      const expanded = await rig.recall.window({ ...rig.args, anchor: 'secret', move: 'up', messages: 1 });
      assert.ok(!JSON.stringify(expanded).includes(word), 'a window read');
      const words = `retelling ${word}`;
      const found = await rig.recall.prefetch({ ...rig.args, lanes: [{ kind: 'message', text: words, words }] });
      assert.ok(!JSON.stringify(found).includes(word), 'the prefetch');
      const denied = domainDetail(env.db, { family: 'sources', id: source, context: group });
      assert.equal(denied.found, false, 'the browser in a group context');
      assert.ok(!JSON.stringify(recentGroupLines(env.db, GENERAL, 5)).includes(word), 'a task reading a group');
    } finally {
      env.done();
    }
  });

  test(`audience: a group's session batch holds nothing of a DM's ${kind.name}`, () => {
    const env = fixture();
    try {
      observeDmLine(env, kind);
      observeLine(env, KINDS[0], 'absent', { native: 'public' });
      fillStems(env.db);
      assert.ok(!sessionBatch(env).includes(kind.first.word));
    } finally {
      env.done();
    }
  });
}

test("audience: a group line whose text form only a DM may read stays bare in the group's reads", () => {
  const env = fixture();
  try {
    const kind = KINDS[0];
    const source = observeLine(env, kind, 'absent');
    tell(env, kind, itemsOf(kind, 'pic')[0], { scope: BOB_SCOPE });
    fillStems(env.db);
    assert.ok(!sessionBatch(env).includes(kind.first.word));
    const opened = domainDetail(env.db, { family: 'sources', id: source, context: group }) as Row;
    assert.ok(!JSON.stringify(opened.sourceMedia ?? []).includes(kind.first.word));
  } finally {
    env.done();
  }
});

// ---------- a kind no model can read ----------

const zipFile = {
  name: 'file',
  stored: 'file',
  marker: '<file notes.zip',
  origin: null,
  first: { word: 'zzz', fragment: 'zzz', query: 'zzz' },
  second: { word: 'zzz' },
  message: () => ({ attachments: [{ id: 'z1', kind: 'file', name: 'notes.zip', url: 'https://x.invalid/notes.zip' }] }),
} satisfies Kind;

const lottie = {
  ...zipFile,
  name: 'sticker with no picture',
  stored: 'sticker',
  marker: '<sticker wave',
  message: () => ({ stickers: [{ id: 's1', name: 'wave', format: 'lottie', url: null }] }),
} satisfies Kind;

for (const kind of [zipFile, lottie]) {
  test(`a ${kind.name} says plainly that no model can read it, in the session batch and in a search`, () =>
    withLine(kind, 'absent', async (env, source) => {
      const batch = sessionBatch(env);
      assert.ok(batch.includes(kind.marker), `its marker: ${batch}`);
      assert.ok(batch.includes(UNREADABLE), 'the plain words in the batch');
      const text = await recallRig(env).ask({ when: '2026-11-01' });
      assert.ok(text.includes(UNREADABLE), `the plain words in a quote: ${text}`);
      const detail = domainDetail(env.db, { family: 'sources', id: source, context: internalContext() }) as Row;
      assert.equal((detail.sourceMedia as Array<Row>)[0].availability, 'unreadable');
    }));
}

test('a file found by its name: a word of the name finds a line that holds nothing else', () =>
  withLine(zipFile, 'absent', async (env) => {
    const text = await recallRig(env).ask({ terms: 'notes' });
    assert.ok(text.includes('notes.zip'), text);
  }));

// ---------- the turn's chat, and one rendering everywhere ----------

const chatLine = (message: Row) => ({
  id: 'm1',
  ts: AT,
  authorId: 'u1',
  authorName: 'Alice',
  content: '',
  placeId: 'c1',
  channelName: 'general',
  attachments: [],
  links: [],
  stickers: [],
  ...message,
});
const chatOf = (message: Row, options: Row = {}) =>
  formatTranscript([chatLine(message)], { timezone: 'UTC', selfName: 'Self', labels: LABELS, ...options })
    .map((line) => line.text)
    .join('\n');

for (const [kind, attachment, expected] of [
  ['voice', { id: 'a1', kind: 'voice', name: 'v.ogg', durationSec: 9 }, '<voice: told>'],
  ['audio', { id: 'a1', kind: 'audio', name: 'song.mp3', durationSec: 180 }, '<audio song.mp3: told>'],
  ['image', { id: 'a1', kind: 'image', name: 'p.png' }, '<image: told>'],
  ['gif', { id: 'a1', kind: 'gif', name: 'g.gif' }, '<gif: told>'],
] as const) {
  test(`chat: a ${kind} shows its marker and the text form the describer holds`, () => {
    const text = chatOf({ attachments: [attachment] }, { descriptions: new Map([['a1', 'told']]) });
    assert.ok(text.includes(expected), text);
  });
}

test('chat: a voice message with no text form yet shows only its marker', () => {
  const text = chatOf({ attachments: [{ id: 'a1', kind: 'voice', name: 'v.ogg', durationSec: 9 }] });
  assert.ok(text.includes('<voice>'), text);
});

test('chat: a file no model can read says so plainly', () => {
  const text = chatOf({ attachments: [{ id: 'a1', kind: 'file', name: 'notes.zip' }] });
  assert.ok(text.includes(`<file notes.zip: ${UNREADABLE}>`), text);
});

test('chat: a sticker with no picture says so plainly', () => {
  const text = chatOf({ stickers: [{ id: 's1', name: 'wave', url: null }] });
  assert.ok(text.includes(`<sticker wave: ${UNREADABLE}>`), text);
});

for (const [name, message, options] of [
  [
    'image',
    {
      attachments: [
        { id: 'pic-a', kind: 'image', name: 'p.png' },
        { id: 'pic-b', kind: 'image', name: 'p.png' },
      ],
    },
    {},
  ],
  [
    'voice received',
    {
      attachments: [
        { id: 'pic-a', kind: 'voice', name: 'voice-message.ogg', durationSec: 9 },
        { id: 'pic-b', kind: 'voice', name: 'voice-message.ogg', durationSec: 9 },
      ],
    },
    {},
  ],
  [
    'audio',
    {
      attachments: [
        { id: 'pic-a', kind: 'audio', name: 'song.mp3', durationSec: 180 },
        { id: 'pic-b', kind: 'audio', name: 'song.mp3', durationSec: 180 },
      ],
    },
    {},
  ],
] as const) {
  test(`one rendering: a ${name} reads the same in the chat and in a stored window`, () =>
    withLine(kindNamed(name), 'full', async (env) => {
      const kind = kindNamed(name);
      const [first, second] = itemsOf(kind, 'pic');
      const descriptions = new Map([
        ['pic-a', first.told],
        ['pic-b', second.told],
      ]);
      const live = chatOf(message, { ...options, descriptions });
      const tag = /<[^>]+>/.exec(live)?.[0];
      assert.ok(tag, live);
      assert.ok((await windowLines(env)).includes(tag), 'the same tag from the stored line');
    }));
}

test('conversation lines keep a line with no text, with its text form', () =>
  withLine(KINDS[0], 'full', (env) => {
    const lines = conversationLines(env.db, GENERAL) as Array<{ media?: Array<{ text: string | null }> }>;
    assert.equal(lines.length, 1);
    assert.ok(JSON.stringify(lines[0].media).includes(KINDS[0].first.word));
  }));

test('her own line in the session batch is under her self label, the voice with what she voiced', () =>
  withLine(kindNamed('voice said'), 'full', (env) => {
    const batch = sessionBatch(env);
    assert.ok(batch.includes(kindNamed('voice said').first.word), batch);
    assert.ok(!batch.includes(HER), 'by her name, never her id');
  }));
