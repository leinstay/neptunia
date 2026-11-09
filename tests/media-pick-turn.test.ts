// The media pick inside a turn (src/behavior/turn.ts over the fake interface): whether it runs is what the adapter
// declares, a picked GIF takes the place of the first message, a refused post leaves the text, and the persona's turn
// carries no GIF library and acts on no `<gif>`. Plan 2026-11-04-cli-and-memory, stage B7.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { userText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';
import { freshWorld, world } from './fixtures/turn-world.ts';
import {
  NOW,
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from './fixtures/turn-kit.ts';
import type { Untyped } from '../src/tools/types.ts';
import { chainsOf } from './fixtures/chains.ts';

const URL_G1 = 'https://tenor.com/view/g1';

beforeEach(() => {
  freshWorld();
});

/** One captioned link GIF in the shared library. */
function sharedLibrary() {
  return {
    nextId: 2,
    backfill: null,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: URL_G1,
        itemId: 'item-1',
        messageId: 'm-1',
        placeId: 'c1',
        count: 3,
        last: NOW - 3_600_000,
        firstSeen: NOW - 7_200_000,
        caption: 'ναι φυσικά γνέφει',
        nativeIds: ['item-1'],
        links: [URL_G1],
        places: { c1: { count: 3, last: NOW - 3_600_000 } },
      },
    },
  };
}

/** The adapter of this turn's world declares `mediaPick` beside what it already declares. */
function declare(mediaPick: unknown): void {
  const port = world().port as unknown as { capabilities: () => object };
  const declared = port.capabilities.bind(port);
  port.capabilities = () => ({ ...declared(), mediaPick });
}

async function runScene({
  reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>',
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  pick = '{"pick":"none","name":null}',
  mediaPick = null,
  failLink = false,
}: { reply?: string; pick?: string; mediaPick?: object | null; failLink?: boolean } = {}) {
  if (mediaPick) declare(mediaPick);
  if (failLink) world().failSends((text) => String(text).startsWith('https://tenor.com/'));
  const raws = [
    rawMessage({ id: 'm0', ts: NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: raws });
  const calls: Array<{ messages: Array<{ content: unknown }>; options: Record<string, Untyped> }> = [];
  const hot = fakeHot(
    {},
    {},
    {
      media: { maxPerTurn: 6, filePreviewChars: 500, pick: { maxOutputTokens: 17, candidates: 5 } },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
    }
  );
  // The old prompt stays beside the new one: a picker that still reads it, or that runs on an interface without the
  // capability, shows up as a pick request.
  Object.assign(hot.prompts, { 'media-pick': 'Pick for {{name}}.', 'gif-pick': 'Pick for {{name}}.', labels });
  const library = sharedLibrary();
  const known = { key: 'k1', ...library.entries.k1 };
  const store = Object.assign(fakeStore({ mediaCache: { 'item-1': { text: 'ναι φυσικά γνέφει' } } }), {
    getGifs: () => library,
    // Whatever arguments it is called with, the last one is the handle.
    findGif: (...given: Array<string>) => (given.at(-1) === 'g1' ? known : null),
    getEmojiRails: () => null,
    setEmojiRails: () => {},
    recordOwnGif: () => {},
  });
  const turns = createTurnRunner({
    hot,
    store,
    llm: {
      complete: (messages: Array<{ content: unknown }>, options: Record<string, Untyped>) => {
        calls.push({ messages, options });
        const text = options?.purpose === 'media-pick' ? pick : reply;
        return Promise.resolve({ text, usage: {}, estimated: 10 });
      },
    },
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => NOW,
  });
  const trigger = normalizedTrigger(raws[1]);
  const result = await turns.runTurn(wrongly({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));
  const isPick = (call: (typeof calls)[number]): boolean => /^(?:media|gif)-pick$/.test(String(call.options?.purpose));
  const picks = calls.filter(isPick);
  const reply0 = calls.find((call) => !isPick(call));
  return { result, picks, reply0, sent: channel.sent.map((payload: { content: unknown }) => payload.content) };
}

test('an interface without the capability sends the reply as written with no classifier call', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { picks, sent } = await runScene({ pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(picks.length, 0);
  assert.deepEqual(sent, ['ναι, φυσικά, έλα']);
});

test('a picked GIF is posted in place of the first message and the rest follow', async () => {
  const { picks, sent } = await runScene({
    reply: '<msg>ναι, φυσικά, έλα</msg><msg>στις οκτώ</msg>',
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    pick: '{"pick":"gif","name":"g1"}',
    mediaPick: { gifForms: ['file', 'link'] },
  });
  assert.equal(picks.length, 1);
  assert.deepEqual(sent, [URL_G1, 'στις οκτώ']);
});

test('a `none` from the classifier posts the reply as written', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { picks, sent } = await runScene({
    pick: '{"pick":"none","name":null}',
    mediaPick: { gifForms: ['file', 'link'] },
  });
  assert.equal(picks[0]?.options.purpose, 'media-pick');
  assert.deepEqual(sent, ['ναι, φυσικά, έλα']);
});

test('a refused post leaves the text message in place', async () => {
  const { picks, sent } = await runScene({
    // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
    pick: '{"pick":"gif","name":"g1"}',
    mediaPick: { gifForms: ['file', 'link'] },
    failLink: true,
  });
  assert.equal(picks[0]?.options.purpose, 'media-pick');
  assert.ok(sent.includes('ναι, φυσικά, έλα'), JSON.stringify(sent));
});

test('a <gif> in her answer posts nothing', async () => {
  const { sent } = await runScene({ reply: '<msg>κοίτα</msg><gif>g1</gif>' });
  assert.deepEqual(sent, ['κοίτα']);
});

test('her request carries no GIF library, and no recent GIF lines, with a library present', async () => {
  const { reply0 } = await runScene({ mediaPick: { gifForms: ['file', 'link'] } });
  assert.ok(reply0);
  const text = reply0.messages.map((message) => userText(message.content) || String(message.content)).join('\n');
  assert.ok(!text.includes('<gifs>'), 'no <gifs>');
  assert.ok(!text.includes('<gifs_recent>'), 'no <gifs_recent>');
  assert.ok(!text.includes('ναι φυσικά γνέφει'), 'no caption of the library');
});
