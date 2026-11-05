// What an observed line stores: one `source_media` row per attachment (src/memory/db/source-media.ts), written once, and what
// her own voice message stores (src/memory/record.ts, src/memory/db/unit-write.ts). Then the path a voice message, an audio
// file and a text file take to a text form: the existing `video` role through the describer (src/memory/describe.ts), from
// the media prefill (src/pipeline/media-prefill.ts). A fake model and a fake fetcher; synthetic content; no provider is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayMedia } from '../src/behavior/sandbox.ts';
import { isDescribable } from '../src/media/classify.ts';
import { createDescriber } from '../src/memory/describe.ts';
import { topPlaceSpelled } from '../src/memory/db/ids.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { sourceMedia } from '../src/memory/db/source-media.ts';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import { createStore } from '../src/memory/store.ts';
import { createMediaPrefill } from '../src/pipeline/media-prefill.ts';
import { fakeLlm, fakeState, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { HER, eventOf, fixture, kindNamed, observeLine } from './fixtures/media-memory.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Rec } from './fixtures/describe-fakes.ts';
import type { Db, Row } from '../src/memory/db/types.ts';

// ---------- the observed line ----------

const stored = (kindName: string, told: 'full' | 'absent' = 'full') => {
  const env = fixture();
  try {
    const source = observeLine(env, kindNamed(kindName), told);
    return sourceMedia(env.db, [source], internalContext()).get(source) ?? [];
  } finally {
    env.done();
  }
};

test('an observed attachment is one row per position, with its kind, reference, name and length, never a file address', () => {
  const items = stored('video', 'absent');
  assert.deepEqual(
    items.map(({ position, kind, nativeRef, name, durationSec, availability }) => ({
      position,
      kind,
      nativeRef,
      name,
      durationSec,
      availability,
    })),
    [
      { position: 0, kind: 'video', nativeRef: 'pic-a', name: 'v.mp4', durationSec: 12, availability: 'unread' },
      { position: 1, kind: 'video', nativeRef: 'pic-b', name: 'v.mp4', durationSec: 12, availability: 'unread' },
    ]
  );
  assert.ok(!JSON.stringify(items).includes('cdn.example.invalid'));
});

test('an observed sticker with a picture can be read, one with none cannot', () => {
  assert.deepEqual(
    stored('sticker', 'absent').map(({ kind, nativeRef, name, availability }) => ({
      kind,
      nativeRef,
      name,
      availability,
    })),
    [
      { kind: 'sticker', nativeRef: 'pic-a', name: 'wave', availability: 'unread' },
      { kind: 'sticker', nativeRef: 'pic-b', name: 'wave', availability: 'unread' },
    ]
  );
});

test("an observed link embed's title and text are its text form, origin embed, told at once", () => {
  const [first, second] = stored('link');
  assert.deepEqual(
    {
      kind: first.kind,
      nativeRef: first.nativeRef,
      site: first.site,
      title: first.title,
      url: first.url,
      text: first.text,
      textOrigin: first.textOrigin,
      availability: first.availability,
    },
    {
      kind: 'link',
      nativeRef: 'pic-a',
      site: 'site.example.invalid',
      title: 'page 0',
      url: 'https://site.example.invalid/pic-a',
      text: 'a retelling with a observatory in it',
      textOrigin: 'embed',
      availability: 'told',
    }
  );
  assert.equal(second.position, 1);
});

test('an observed text attachment is kind file, waiting for its preview; a binary file can never be read', () => {
  assert.deepEqual(
    stored('text file', 'absent').map(({ kind, availability }) => ({ kind, availability })),
    [
      { kind: 'file', availability: 'unread' },
      { kind: 'file', availability: 'unread' },
    ]
  );
  const env = fixture();
  try {
    const zip = {
      ...kindNamed('text file'),
      message: () => ({ attachments: [{ id: 'z1', kind: 'file', name: 'notes.zip', url: 'https://x.invalid/z' }] }),
    };
    const source = observeLine(env, zip, 'absent');
    assert.equal(sourceMedia(env.db, [source], internalContext()).get(source)?.[0].availability, 'unreadable');
  } finally {
    env.done();
  }
});

test('a kind the closed list does not hold is stored as a file no model can read', () => {
  const env = fixture();
  try {
    const odd = {
      ...kindNamed('image'),
      message: () => ({ attachments: [{ id: 'x1', kind: 'hologram', name: 'x.holo', url: 'https://x.invalid/x' }] }),
    };
    const source = observeLine(env, odd, 'absent');
    const [item] = sourceMedia(env.db, [source], internalContext()).get(source) ?? [];
    assert.deepEqual([item.kind, item.availability], ['file', 'unreadable']);
  } finally {
    env.done();
  }
});

test('an observed custom emoji is a row of its own, after what the message carries', () => {
  assert.deepEqual(
    stored('emoji', 'absent').map(({ kind, nativeRef, name }) => ({ kind, nativeRef, name })),
    [
      { kind: 'emoji', nativeRef: 'pic-a', name: 'blob' },
      { kind: 'emoji', nativeRef: 'pic-b', name: 'wave' },
    ]
  );
});

test('nothing is written twice: the line itself holds no kinds and no ids', () => {
  const env = fixture();
  try {
    observeLine(env, kindNamed('image'), 'full');
    const row = env.db.prepare('SELECT * FROM sources WHERE native_id = ?').get('pic') as Row;
    assert.equal('media' in row, false, 'no kinds on the line');
    assert.ok(!String(row.extra).includes('attachmentIds'));
    assert.ok(!String(row.extra).includes('pic-a'));
  } finally {
    env.done();
  }
});

test('a text message with no media has no media rows', () => {
  const env = fixture();
  try {
    const envelope = observationOf(
      {
        iface: 'discord',
        at: 1,
        conversation: { id: 'c1', kind: 'channel', rootId: 'g1' },
        message: { id: 'm1', at: 1, content: 'hello', author: { id: 'u1' }, attachments: [], links: [], stickers: [] },
      },
      { selfId: HER }
    );
    assert.deepEqual(envelope?.media ?? [], []);
  } finally {
    env.done();
  }
});

// ---------- her own voice message ----------

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = NOW - 60_000;
const IFACE = 'synthetic';
const TOP = topPlaceSpelled(IFACE, 'community');
const VOICED = '[sighs] a cathedral at dusk';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

async function echoVoice(memory: Memory) {
  const event = eventOf(kindNamed('voice said'), 'sent-1', [true, false], {
    at: SENT,
    iface: IFACE,
    conversation: { id: 'room-a', kind: 'channel', chatType: 'channel', rootId: 'community' },
    author: { id: HER, self: true },
  });
  (event.message as Row).attachments = [{ id: 'v1', kind: 'voice', name: 'v.ogg', durationSec: 9 }];
  const envelope = observationOf(event, { selfId: HER });
  assert.ok(envelope);
  await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
}

async function recordVoice(memory: Memory) {
  const line = toRecordLine(
    {
      id: 'sent-1',
      placeId: 'room-a',
      content: '',
      ts: SENT,
      replyToId: null,
      mentionedAccountIds: [],
      attachments: [{ id: 'v1', kind: 'voice' }],
      voiced: VOICED,
    },
    { kind: 'said', now: () => NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => NOW }).append(TOP, [line], {});
}

const database = (memory: Memory): Db => {
  const db = memory.memoryDb.database();
  assert.ok(db);
  return db;
};

for (const [order, steps] of [
  ['the echo before the record line', [echoVoice, recordVoice]],
  ['the record line before the echo', [recordVoice, echoVoice]],
] as const) {
  test(`her voice message, ${order}: one line, its text empty as sent, its voiced text the row's text form`, async () => {
    const memory = await openTestMemory({ now: () => NOW, iface: () => IFACE });
    try {
      for (const step of steps) await step(memory);
      const db = database(memory);
      const rows = db.prepare("SELECT * FROM sources WHERE kind = 'said'").all();
      assert.equal(rows.length, 1, 'one line');
      assert.equal(rows[0].text, '', 'sources.text stays what the message holds');
      assert.equal(rows[0].turn_id, 't-1');
      const media = sourceMedia(db, [String(rows[0].id)], internalContext()).get(String(rows[0].id)) ?? [];
      assert.deepEqual(
        media.map(({ kind, text, textOrigin, availability }) => ({ kind, text, textOrigin, availability })),
        [{ kind: 'voice', text: VOICED, textOrigin: 'voiced', availability: 'told' }]
      );
    } finally {
      await memory.close();
    }
  });
}

// ---------- the role of a voice message and an audio file ----------

const AUDIO_CLIP = 'data:video/mp4;base64,YXVkaW8=';
const VIDEO_PROVIDER = { order: ['test-host'], allow_fallbacks: false };
const HEARD = 'she says the mushrooms are early this year';

function audioRig({
  video = 'x/flash',
  fetched = { ok: true, dataUrl: AUDIO_CLIP, seconds: 9, bytes: 4 } as Rec,
} = {}) {
  const store = createStore({ dataDir: tempDir('nep-media-memory-') });
  const llm = fakeLlm({ text: HEARD, model: video });
  const fetchedUrls: Array<string> = [];
  const videoFetcher = {
    ...fakeVideoFetcher(),
    fetchAudio: (url: string) => {
      fetchedUrls.push(url);
      return Promise.resolve(fetched);
    },
  };
  const hot = {
    config: {
      models: { base: { vision: 'x/vision', video } },
      media: { maxOutputTokens: 120, video: { provider: VIDEO_PROVIDER } },
      context: { vision: { fetchTimeoutMs: 10_000 } },
    },
    prompts: { describe: 'Describe.', 'describe-audio': 'Retell what is heard in up to {{maxChars}} characters.' },
  };
  const describer = createDescriber({ hot, store, llm, videoFetcher, state: fakeState() } as unknown as Parameters<
    typeof createDescriber
  >[0]);
  return { describer, llm, fetchedUrls };
}

const voiceItem = (kind: string) => ({
  source: 'attachment',
  messageId: 'm1',
  itemId: `${kind}-1`,
  kind,
  url: `https://cdn.example.invalid/${kind}-1.ogg`,
  name: 'x.ogg',
  durationSec: 9,
});

for (const kind of ['voice', 'audio']) {
  test(`a ${kind} reaches the describer on the video role, with the role's provider, and is kept as its text form`, async () => {
    const { describer, llm, fetchedUrls } = audioRig();
    const { descriptions } = await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(descriptions.get(`${kind}-1`), HEARD);
    assert.deepEqual(fetchedUrls, [`https://cdn.example.invalid/${kind}-1.ogg`]);
    assert.equal(llm.calls.length, 1);
    const { options, messages } = llm.calls[0];
    assert.equal(options.role, 'video');
    assert.equal(options.model, 'x/flash');
    assert.deepEqual(options.provider, VIDEO_PROVIDER);
    assert.ok(JSON.stringify(messages).includes(AUDIO_CLIP), 'the clip goes in the request');
    assert.equal(describer.cachedDescriptions('g1', [voiceItem(kind)]).get(`${kind}-1`), HEARD);
  });

  test(`a ${kind} already told makes no second request`, async () => {
    const { describer, llm } = audioRig();
    await describer.describeMany('g1', [voiceItem(kind)]);
    await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(llm.calls.length, 1);
  });

  test(`a ${kind} makes no request when the video role is off`, async () => {
    const { describer, llm, fetchedUrls } = audioRig({ video: '' });
    const { descriptions } = await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(descriptions.size, 0);
    assert.deepEqual([llm.calls.length, fetchedUrls.length], [0, 0]);
  });

  test(`a ${kind} whose file cannot be fetched has no text form and costs no request`, async () => {
    const { describer, llm } = audioRig({ fetched: { ok: false, reason: 'download' } });
    const { descriptions } = await describer.describeMany('g1', [voiceItem(kind)]);
    assert.equal(descriptions.size, 0);
    assert.equal(llm.calls.length, 0);
  });

  test(`${kind} is a kind the describer can tell`, () => {
    assert.equal(isDescribable({ kind }), true);
  });
}

test('a binary file is no kind a model can tell', () => {
  assert.equal(isDescribable({ kind: 'file' }), false);
});

test('a text file is kept as its text form from its own words, with no model', async () => {
  const store = createStore({ dataDir: tempDir('nep-media-memory-') });
  const llm = fakeLlm({ text: 'never asked' });
  const describer = createDescriber({
    hot: { config: { models: { base: { vision: 'x/vision' } } }, prompts: { describe: 'Describe.' } },
    store,
    llm,
    fetchText: () => Promise.resolve({ ok: true, text: 'marzipan recipes' }),
  } as unknown as Parameters<typeof createDescriber>[0]);
  const item = { ...voiceItem('text'), itemId: 't1', url: 'https://x.invalid/notes.txt' };
  const { descriptions } = await describer.describeMany('g1', [item]);
  assert.equal(descriptions.get('t1'), 'marzipan recipes');
  assert.equal(llm.calls.length, 0);
});

test('the prefill hands an observed voice message and audio file to the describer, as it does a picture', async () => {
  const asked: Array<Row> = [];
  const prefill = createMediaPrefill({
    hot: { config: {}, prompts: {} },
    describer: {
      describeMany: (_place: string, items: Array<unknown>) => {
        asked.push(...(items as Array<Row>));
        return Promise.resolve();
      },
    },
    lookup: null,
    now: () => NOW,
  } as unknown as Parameters<typeof createMediaPrefill>[0]);
  await prefill.warmMediaCache('g1', {
    id: 'm1',
    authorId: 'u1',
    attachments: [
      { id: 'v1', kind: 'voice', url: 'https://x.invalid/v.ogg', name: 'v.ogg' },
      { id: 'a1', kind: 'audio', url: 'https://x.invalid/a.mp3', name: 'a.mp3' },
      { id: 'p1', kind: 'image', url: 'https://x.invalid/p.png', name: 'p.png' },
    ],
  } as Parameters<ReturnType<typeof createMediaPrefill>['warmMediaCache']>[1]);
  assert.deepEqual(asked.map((item) => item.itemId).sort(), ['a1', 'p1', 'v1']);
});

test('a replayed moment shows a voice message with the text form the cache held then', () => {
  const history = [
    { id: 'm1', attachments: [{ id: 'v1', kind: 'voice', url: 'https://x.invalid/v.ogg', name: 'v.ogg' }] },
  ];
  const { descriptions } = replayMedia(history, { cache: { v1: { text: 'told', ts: 1 } } });
  assert.equal(descriptions.get('v1'), 'told');
});
