// The alias gate of the door: a line that names the persona by one of the card's aliases, with no ping, goes to the
// address classifier, and only its verdict starts a turn. The engine holds no name list.
// Contract, the owner's amendment to plan 2026-11-04-cli-and-memory B1:
//   a third gate beside the flags and attention: the line's text holds one of her aliases, the names the owner gave her
//   person record (`selfNames`, read at the moment of use)
//   a word matches when its stem equals an alias's stem under `stemmer()` (createMessageHandler's dependency, the
//   memory's learned stemmer, read at the moment of use), else by a case-folded whole-word match
//   the gate that sent a line is logged as `gate: 'alias'`, with no text of the line
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/behavior/pipeline.ts';
import { createTagHistory } from '../src/behavior/mention.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createReads } from '../src/interface/reads.ts';
import type { MessageReceived } from '../src/protocol/events.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { baseConfig } from './fixtures/events-rig.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { channel as channelOf } from './fixtures/reads-rig.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const SELF = 'self-id';
// The owner moved aliases to her person record: they come from `selfNames`, the names he gave `person:self`.
const NAMES = ['Ζεφύρα', 'Zefira', 'Ilo'];
/** A stemmer that drops a few Greek endings, as a learned one would. */
const GREEK_STEMS = { stem: (word: string) => word.toLowerCase().replace(/(ας|ου|α|ς)$/u, '') };

type Spot = { iface: string; place: Record<string, unknown> & { id: string } };
const GROUP: Spot = { iface: 'alpha', place: { id: 'c1', kind: 'channel', rootId: 'g1' } };
const DM: Spot = { iface: 'alpha', place: { id: 'd1', kind: 'dm', chatType: 'dm', rootId: null, partnerId: 'u1' } };

function door(
  options: {
    answer?: string;
    names?: Array<string>;
    stemmer?: { stem: (word: string) => string } | null;
    maxTurnsPerAuthor?: number;
  } = {}
) {
  const fake = createFakeAdapter({ iface: 'alpha', selfId: SELF });
  for (const spot of [GROUP, DM]) fake.seedConversation(channelOf(spot.place.id, { iface: spot.iface, ...spot.place }));
  const reads = createReads(fake, { info() {}, warn() {}, error() {} });
  const calls: Array<{ purpose?: string }> = [];
  const started: Array<{ triggerKind: string | null }> = [];
  const handler = createMessageHandler(
    wrongly<Parameters<typeof createMessageHandler>[0]>({
      hot: {
        config: baseConfig({
          bot: { timezone: 'UTC', nameTriggers: [] },
          private: { enabled: true, minAffinity: 0 },
          address: { attentionMinutes: 30, maxTurnsPerAuthor: options.maxTurnsPerAuthor ?? 100 },
        }),
        prompts: { address: 'Is it said to {{name}}?', labels },
      },
      store: { state: { data: {}, markDirty() {} }, getUser: () => ({ names: ['Member'], affinity: { score: 0 } }) },
      reads,
      selfId: () => SELF,
      getSelfName: () => 'Nova',
      turns: {
        notePost() {},
        isBusy: () => false,
        isAnyBusy: () => false,
        spokeAfterSeeing: () => false,
        lastPostAt: () => 0,
        runTurn: (asked: { triggerKind: string | null }) => {
          started.push(asked);
          return Promise.resolve({ outcome: 'spoke' });
        },
      },
      memory: { observe() {} },
      tagHistory: createTagHistory(),
      isServedCommunity: () => true,
      communitiesOf: () => [],
      llm: {
        complete: (_messages: unknown, request: { purpose?: string }) => {
          calls.push(request);
          // The lead: the address classifier answers in strict JSON (owner, 2026-11-06); a scene's verdict word is sent as the object.
          return Promise.resolve({
            text: JSON.stringify({ answer: options.answer ?? 'yes' }),
            usage: {},
            estimated: 1,
          });
        },
      },
      stemmer: () => (options.stemmer === undefined ? GREEK_STEMS : options.stemmer),
      selfNames: () => options.names ?? NAMES,
      rng: () => {
        throw new Error('the door rolls no chance');
      },
      now: () => NOW,
      missed: { noteFact() {}, noteActivity() {}, noteNotAddressed() {} },
      port: fake,
    })
  );
  let serial = 0;
  async function say(spot: Spot, text: string): Promise<void> {
    serial += 1;
    const id = `m${serial}`;
    const event = {
      kind: 'message.received',
      iface: spot.iface,
      at: NOW,
      id: `${spot.iface}:message:${id}`,
      // Type fix (plan B1 amendment, approved): the place carries its own `id`, so it is not written twice.
      conversation: { kind: 'channel', name: spot.place.id, ...spot.place },
      message: {
        id,
        author: { id: 'u1', name: 'Eleni', self: false, bot: false },
        content: text,
        sourceText: text,
        system: false,
        at: NOW,
        replyToId: null,
        replyPingAccountId: null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions: [],
      },
      addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedConversationIds: [] },
    };
    await handler(wrongly<MessageReceived>(event));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  return { say, calls, started };
}

test('a line that names her by an alias, with no ping and no recent post, reaches the classifier once', async () => {
  // Bug: without the old trigger list, a call by name never reaches her unless she wrote there recently.
  const scene = door();
  await scene.say(GROUP, 'Zefira, are you there?');
  assert.deepEqual(
    scene.calls.map((call) => call.purpose),
    ['address']
  );
});

test('a yes to an alias line starts a turn', async () => {
  // Bug: the alias gate asks the classifier and drops its answer.
  const scene = door({ answer: 'yes' });
  await scene.say(GROUP, 'Zefira, are you there?');
  assert.equal(scene.started.length, 1);
});

test('a no to an alias line starts nothing', async () => {
  // Bug: the alias fires the turn by itself, as the old name trigger did, whatever the classifier says.
  const scene = door({ answer: 'no' });
  await scene.say(GROUP, 'Zefira is a nice name for a cat');
  assert.equal(scene.calls.length, 1);
  assert.equal(scene.started.length, 0);
});

test('a declined form of an alias reaches the classifier through the stemmer', async () => {
  // Bug: only the base form matches, so "της Ζεφύρας" never reaches her.
  const scene = door();
  await scene.say(GROUP, 'τι λέει η γνώμη της Ζεφύρας;');
  assert.equal(scene.calls.length, 1);
});

test('without a stemmer an alias still matches as a whole word in any case', async () => {
  // Bug: a missing stemmer turns the gate off altogether.
  const scene = door({ stemmer: null });
  await scene.say(GROUP, 'zefira, hello?');
  assert.equal(scene.calls.length, 1);
});

test('a line with no alias, no flag and no recent post of hers never reaches the classifier', async () => {
  // Bug: the gate fires on any line, so every quiet message pays for a classifier call.
  const scene = door();
  await scene.say(GROUP, 'καλημέρα σε όλους');
  assert.equal(scene.calls.length, 0);
});

for (const stemmer of [GREEK_STEMS, null]) {
  test(`a short alias inside a longer word does not open the gate${stemmer ? '' : ' without a stemmer'}`, async () => {
    // Bug: a substring match makes "Ilona" a call to her.
    const scene = door({ stemmer });
    await scene.say(GROUP, 'Ilona brought the cake');
    assert.equal(scene.calls.length, 0);
  });
}

test('a person record with no names adds no gate', async () => {
  // Bug: a fallback name list stands in when the card has none.
  const scene = door({ names: [] });
  await scene.say(GROUP, 'Zefira, are you there?');
  assert.equal(scene.calls.length, 0);
});

test('an alias in a DM never calls the classifier', async () => {
  // Bug: the gate runs before the DM branch and pays for a line that is already addressed.
  const scene = door();
  await scene.say(DM, 'Zefira, are you there?');
  assert.equal(scene.calls.length, 0);
  assert.equal(scene.started.length, 1);
});

test('the per-author rail still bounds the turns an alias line starts', async () => {
  // Bug: the alias path starts its turn beside the rail.
  const scene = door({ maxTurnsPerAuthor: 1 });
  await scene.say(GROUP, 'Zefira, one');
  await scene.say(GROUP, 'Zefira, two');
  assert.equal(scene.calls.length, 2);
  assert.equal(scene.started.length, 1);
});

test('the alias gate is logged by its name, without the line', async () => {
  // Bug: nobody can tell which gate pays for the classifier, or the log carries what she was called.
  const scene = door({ answer: 'no' });
  const { logs } = await withCapturedLogs(() => scene.say(GROUP, 'Zefira, το μυστικό μας'));
  const gated = logs.filter((entry) => entry.gate === 'alias');
  assert.equal(gated.length, 1);
  assert.equal(JSON.stringify(logs).includes('μυστικό'), false);
});
