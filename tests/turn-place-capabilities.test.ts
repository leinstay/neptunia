// A turn's place belongs to one interface, and what the turn says and offers about the platform is that interface's:
// the core serves one interface and routes the others (src/interface/link.ts#createIfaceRouter), and a command line turn
// once carried the served interface's emoji text, media pick and tools. Each scene runs a turn through a router over two
// fake interfaces, the place's and the other one. Synthetic texts, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { userText } from '../src/behavior/prompt.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createIfaceRouter } from '../src/interface/link.ts';
import type { Capabilities, MediaPickCapability } from '../src/protocol/adapter.ts';
import { labels } from './fixtures/labels.ts';
import { personaGrants } from './fixtures/turn-harness.ts';
import { freshWorld, useIface, world } from './fixtures/turn-world.ts';
import {
  NOW,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from './fixtures/turn-kit.ts';
import { chainsOf } from './fixtures/chains.ts';

const SERVED_TEXT = 'SERVED-EMOJI-TEXT';
const CLI_TEXT = 'CLI-EMOJI-TEXT';

/** The served interface's media pick: GIFs, custom emoji and its own line about them. */
const SERVED_PICK: MediaPickCapability = {
  gifForms: ['file', 'link'],
  emoji: { actions: ['append', 'replace'], render: { still: '<:{name}:{id}>' } },
  text: SERVED_TEXT,
};

/** What the command line declares in the scenes: it sends and types, and has no message address. */
const CLI_OPERATIONS: ReadonlyArray<string> = ['message.send', 'chat.typing'];

const WAVE = { id: '7', name: 'wave', animated: false };

/** The tools her grants would give her on an interface that can do everything. */
const MESSAGE_TOOLS = ['message.edit', 'message.delete', 'message.react.add', 'message.react.remove'];

type Port = { capabilities: () => Capabilities };

/** Replaces what `port` declares with `change` of it. */
function declare(port: Port, change: (own: Capabilities) => Capabilities): void {
  const own = port.capabilities.bind(port);
  port.capabilities = () => change(own());
}

type Scene = {
  place: 'cli' | 'discord';
  cliPick?: MediaPickCapability | null;
  reply?: string;
};

type Seen = { request: string; tools: Array<string>; picks: number; sent: Array<unknown> };

/**
 * One reply turn in a place of `place`'s interface. The world's adapter is the place's; the other interface is a second
 * fake. The router serves the `discord` one and routes `cli`, as the core does.
 */
async function runScene({ place, cliPick = null, reply = '<msg>ναι, έλα</msg>' }: Scene): Promise<Seen> {
  useIface(place);
  freshWorld();
  const own = world().port;
  const other = createFakeAdapter({ iface: place === 'cli' ? 'discord' : 'cli', selfId: world().selfId });
  const served = place === 'discord' ? own : other;
  const cli = place === 'cli' ? own : other;
  declare(served, (caps) => ({ ...caps, mediaPick: SERVED_PICK }));
  declare(cli, (caps) => ({
    ...caps,
    operations: [...CLI_OPERATIONS],
    messageUrl: null,
    ...(cliPick ? { mediaPick: cliPick } : {}),
  }));
  const router = createIfaceRouter(
    served,
    (iface) => (iface === 'cli' ? cli : null),
    () => [cli]
  );
  const raws = [
    rawMessage({ id: 'm0', ts: NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel(
    place === 'cli'
      ? { id: 'cli:dm:owner', dm: true, partnerId: 'u1', historyMessages: raws }
      : { historyMessages: raws }
  );
  const calls: Array<{ messages: Array<{ content: unknown }>; options: Record<string, unknown> }> = [];
  const hot = fakeHot(
    {},
    { access: personaGrants(MESSAGE_TOOLS) },
    {
      media: {
        maxPerTurn: 6,
        filePreviewChars: 500,
        pick: { maxOutputTokens: 17, candidates: 5, emojiCandidates: 5, emojiPerReplies: 0, emojiCooldownMinutes: 0 },
      },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
    }
  );
  Object.assign(hot.prompts, { 'media-pick': 'Pick for {{name}}.', labels });
  const store = Object.assign(fakeStore(), {
    getGifs: () => null,
    getEmojiRails: () => null,
    setEmojiRails: () => {},
  });
  const emoji = {
    refresh: () => Promise.resolve(),
    byName: (name: string) => (name === WAVE.name ? WAVE : null),
    list: () => [WAVE],
    urlOf: () => null,
  };
  world().renormalize(hot.config);
  world().useClock(() => NOW);
  const options = {
    ...world().deps(),
    getSelfName: () => 'Bot',
    port: router,
    hot,
    store,
    emoji,
    llm: {
      complete: (messages: Array<{ content: unknown }>, given: Record<string, unknown>) => {
        calls.push({ messages, options: given });
        const text = given?.purpose === 'media-pick' ? '{"pick":"none","name":null}' : reply;
        return Promise.resolve({ text, usage: {}, estimated: 10 });
      },
    },
    calibrator: identityCalibrator(),
    now: () => NOW,
  };
  const turns = createRealTurnRunner(options);
  await turns.runTurn({
    chat: { iface: place, chatId: channel.id },
    mode: 'reply',
    trigger: normalizedTrigger(raws[1]),
    triggerKind: 'mention',
  } as unknown as Parameters<typeof turns.runTurn>[0]);
  const answered = calls.find((call) => call.options?.purpose !== 'media-pick');
  assert.ok(answered, 'her reply request was made');
  const tools = Array.isArray(answered.options.tools)
    ? (answered.options.tools as Array<{ function?: { name?: string } }>).map((tool) => tool.function?.name ?? '')
    : [];
  return {
    request: answered.messages.map((message) => userText(message.content) || String(message.content)).join('\n'),
    tools,
    picks: calls.filter((call) => call.options?.purpose === 'media-pick').length,
    sent: channel.sent.map((payload: { content: unknown }) => payload.content),
  };
}

test('a command line turn carries no emoji text of the served interface and runs no media pick', async () => {
  // Bug: her request in the owner's chat told her about the server's custom emoji and stickers.
  const seen = await runScene({ place: 'cli' });
  assert.equal(seen.request.includes(SERVED_TEXT), false, seen.request);
  assert.equal(seen.picks, 0);
});

test("a command line turn carries the command line's own emoji text when it declares one", async () => {
  const cliPick: MediaPickCapability = {
    gifForms: [],
    emoji: { actions: ['append'], render: { still: ':{name}:' } },
    text: CLI_TEXT,
  };
  const seen = await runScene({ place: 'cli', cliPick });
  assert.ok(seen.request.includes(CLI_TEXT), seen.request);
  assert.equal(seen.request.includes(SERVED_TEXT), false);
});

test('a command line turn offers no reaction, edit or delete tool when the command line declares none', async () => {
  // Bug: she reacted and edited in the owner's chat, and the chat client refused every one.
  const seen = await runScene({ place: 'cli' });
  for (const name of ['message_edit', 'message_delete', 'message_react_add', 'message_react_remove'])
    assert.equal(seen.tools.includes(name), false, `${name} offered: ${seen.tools.join(', ')}`);
  assert.ok(seen.tools.includes('message_create'), 'sending stays offered');
});

test('a numbered line in a command line reply is not turned into a link of the served interface', async () => {
  // Bug: `#2` in her reply became a discord.com jump link built on the command line's ids.
  const seen = await runScene({ place: 'cli', reply: '<msg>όπως είπες στο #2</msg>' });
  assert.equal(seen.sent.length, 1);
  assert.equal(String(seen.sent[0]).includes('https://'), false, String(seen.sent[0]));
});

test('a turn of the served interface keeps its emoji text, its media pick and every message tool', async () => {
  const seen = await runScene({ place: 'discord' });
  assert.ok(seen.request.includes(SERVED_TEXT), seen.request);
  assert.equal(seen.picks, 1);
  for (const name of ['message_edit', 'message_delete', 'message_react_add', 'message_react_remove'])
    assert.ok(seen.tools.includes(name), `${name} missing: ${seen.tools.join(', ')}`);
});
