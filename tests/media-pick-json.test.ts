// Tests for the media pick's strict JSON answer (src/behavior/media-pick.ts): the request hands the client
// `mediaPickFormat(offer)` as `responseFormat`, whose `name` holds exactly the GIF handles and emoji names that request
// offered, and parseMediaPick reads the object text `{ "pick": "none" | "gif" | "emoji" | "replace", "name": string |
// null }`. A name that was not offered, an action the interface does not support, and every answer that is not the
// object (the old one-line answer included) are none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaPick, mediaPickFormat, parseMediaPick } from '../src/behavior/media-pick.ts';
import type { MediaPickArgs } from '../src/behavior/media-pick.ts';
import { labels } from './fixtures/labels.ts';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const PLACE = 'place:room-1';
const RENDER = { still: '[[{name}|{id}]]' };
const WAVE = { id: '1', name: 'wave', animated: false };
const CLAP = { id: '2', name: 'clap', animated: false };
const USAGE = { '1': { name: 'wave', count: 3, last: NOW }, '2': { name: 'clap', count: 9, last: NOW } };

/** One GIF the search finds for the reply below. */
const ONE_GIF = {
  k1: {
    id: 'g1',
    kind: 'link',
    url: 'https://tenor.com/view/g1',
    count: 1,
    last: NOW,
    firstSeen: NOW,
    caption: 'ναι φυσικά',
    places: { [PLACE]: { count: 1, last: NOW } },
  },
};

type Capability = MediaPickArgs['capability'];
const BOTH: Capability = { gifForms: ['link'], emoji: { actions: ['append', 'replace'], render: RENDER } };

type Sent = { options: Record<string, unknown> };

/** One pick whose model answers `text`, with what the interface declares, and the options of each request. */
async function pickWith(text: string, capability: Capability = BOTH) {
  const sent: Array<Sent> = [];
  const media = createMediaPick({
    hot: {
      config: {
        bot: { timezone: 'UTC' },
        models: { base: { analyzer: 'cheap/classifier' } },
        media: {
          pick: { maxOutputTokens: 17, candidates: 5, emojiCandidates: 5, emojiPerReplies: 0, emojiCooldownMinutes: 0 },
        },
      },
      prompts: { labels, 'media-pick': 'Pick for {{name}}.' },
    },
    store: {
      getGifs: () => ({ nextId: 9, backfill: null, entries: ONE_GIF }),
      getEmojiRails: () => null,
      setEmojiRails: () => {},
    },
    llm: {
      complete: (_messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    clock: () => NOW,
  });
  const result = await media.pick({
    placeId: PLACE,
    capability,
    messages: [{ text: 'ναι, φυσικά, έλα', replyTo: 2 }],
    history: [],
    selfName: 'Νέα',
    emoji: [WAVE, CLAP],
    emojiUsage: USAGE,
  });
  return { result, sent };
}

const NONE = { kind: 'none' };

/** Every string a schema node allows by `enum` or `const`, anywhere below it. */
function allowedStrings(node: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const entries = Object.entries(value);
    for (const [key, child] of entries) {
      if (key === 'enum' && Array.isArray(child)) {
        for (const item of child) if (typeof item === 'string') found.add(item);
      } else if (key === 'const' && typeof child === 'string') {
        found.add(child);
      } else {
        walk(child);
      }
    }
  };
  walk(node);
  return found;
}

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, unknown>;
};

/** The schema the one request of a pick handed the client. */
function schemaSent(sent: Array<Sent>): Schema {
  assert.equal(sent.length, 1);
  // The lead: the request named first, for the chain rule.
  const [first] = sent;
  const format = first?.options.responseFormat as { schema?: Schema } | undefined;
  return format?.schema ?? {};
}

test('the media-pick request hands the client a closed object that requires pick and name', async () => {
  // Bug: the schema is built and never sent, so the model answers a sentence and the pick is always none.
  const { sent } = await pickWith('{"pick":"none","name":null}');
  const schema = schemaSent(sent);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...(schema.required ?? [])].sort(), ['name', 'pick']);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['name', 'pick']);
  const picks = allowedStrings(schema.properties?.pick);
  assert.ok(picks.has('none'), 'none is always allowed');
  for (const word of picks) assert.ok(['none', 'gif', 'emoji', 'replace'].includes(word), word);
});

test('the name of the schema allows exactly the GIFs and emoji that request offered', async () => {
  // Bug: a fixed schema lets the model name a GIF of another request, which the act then cannot find.
  const namesSent = (sent: Array<Sent>) => [...allowedStrings(schemaSent(sent).properties?.name)].sort();
  const both = await pickWith('{"pick":"none","name":null}');
  assert.deepEqual(namesSent(both.sent), ['clap', 'g1', 'wave']);
  const gifsOnly = await pickWith('{"pick":"none","name":null}', { gifForms: ['link'] });
  assert.deepEqual(namesSent(gifsOnly.sent), ['g1']);
});

test('mediaPickFormat builds its name enum from the offer it is given', () => {
  const format = mediaPickFormat({ gifs: ['g7', 'g8'], emoji: ['nod'], actions: ['append'] });
  const schema = format.schema as Schema;
  assert.deepEqual([...allowedStrings(schema.properties?.name)].sort(), ['g7', 'g8', 'nod']);
});

test('a well-formed object gives what the one-line answer gave for the same pick', async () => {
  const gif = await pickWith('{"pick":"gif","name":"g1"}');
  assert.equal(gif.result.kind, 'gif');
  assert.ok(gif.result.kind === 'gif');
  const { entry } = gif.result;
  assert.equal(entry.id, 'g1');
  assert.equal(gif.result.replyTo, 2);
  const appended = await pickWith('{"pick":"emoji","name":"wave"}');
  assert.deepEqual(appended.result, { kind: 'emoji', action: 'append', emoji: WAVE });
  const replaced = await pickWith('{"pick":"replace","name":"clap"}');
  assert.deepEqual(replaced.result, { kind: 'emoji', action: 'replace', emoji: CLAP });
  const none = await pickWith('{"pick":"none","name":null}');
  assert.deepEqual(none.result, NONE);
});

test('an emoji action the interface does not support is none', async () => {
  const appendOnly: Capability = { gifForms: ['link'], emoji: { actions: ['append'], render: RENDER } };
  const { result } = await pickWith('{"pick":"replace","name":"wave"}', appendOnly);
  assert.deepEqual(result, NONE);
});

/** Answers that are not a usable object for this offer: each is none. */
const UNREADABLE = [
  'gif g1',
  'emoji wave',
  'replace clap',
  'none',
  'The GIF fits the reply.',
  '```json\n{"pick":"gif","name":"g1"}\n```',
  '{"pick":"gif","name":"g1"',
  '{"pick":"gif"}',
  '{"name":"g1"}',
  '{"pick":"sticker","name":"g1"}',
  '{"pick":"gif","name":"g9"}',
  '{"pick":"gif","name":"wave"}',
  '{"pick":"emoji","name":"g1"}',
  '{"pick":"gif","name":null}',
  '{"pick":"emoji","name":null}',
  '{"pick":"gif","name":7}',
  '{"pick":true,"name":"g1"}',
  '[{"pick":"gif","name":"g1"}]',
  '"gif g1"',
  'null',
];

test('every answer that is not a usable object, the old one-line answer included, is none', async () => {
  for (const text of UNREADABLE) {
    const { result } = await pickWith(text);
    assert.deepEqual(result, NONE, JSON.stringify(text));
  }
});

test('parseMediaPick reads the object text against the offer, and an old one-line answer as none', () => {
  const offer = { gifs: ['g1'], emoji: ['wave'], actions: ['append', 'replace'] };
  assert.deepEqual(parseMediaPick('{"pick":"gif","name":"g1"}', offer), { kind: 'gif', handle: 'g1' });
  assert.deepEqual(parseMediaPick('{"pick":"emoji","name":"wave"}', offer), { kind: 'emoji', name: 'wave' });
  assert.deepEqual(parseMediaPick('{"pick":"replace","name":"wave"}', offer), { kind: 'replace', name: 'wave' });
  for (const text of ['gif g1', 'emoji wave', '', null, undefined, 7]) {
    assert.deepEqual(parseMediaPick(text, offer), NONE, JSON.stringify(text));
  }
});
