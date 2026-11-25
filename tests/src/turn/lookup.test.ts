import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLookup, type Lookup, SPLIT_FORMAT } from '../../../src/turn/lookup.ts';
import { type Context, issueContext, issueContext as issuedContext } from '../../../src/memory/db/scope.ts';
import { channel as channelInfo, privateChannel, rig } from '../../fixtures/reads-rig.ts';
import { config, NOW } from '../../fixtures/recall-run-kit.ts';
import { labels } from '../../fixtures/labels.ts';
import fs, { rmSync } from 'node:fs';
import { fillPromptTemplate, userText as textOf } from '../../../src/behavior/prompt.ts';
import { createRecall } from '../../../src/behavior/recall-run.ts';
import { snapshotOf } from '../../../src/behavior/snapshot.ts';
import { SPLIT_DEFAULTS } from '../../../src/behavior/split.ts';
import { channelPlaceId, dmPlaceId } from '../../../src/memory/db/ids.ts';
import { observationOf } from '../../../src/memory/db/observe-event.ts';
import { observe } from '../../../src/memory/db/observe.ts';
import { insertRows } from '../../../src/memory/db/rows.ts';
import '../../../src/tools/operations/index.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { lineEvent } from '../../fixtures/core-over-fake.ts';
import { noMediaNames } from '../../fixtures/media-namer.ts';
import { fixture } from '../../fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from '../../fixtures/memory-db/audiences.ts';
import { personId } from '../../fixtures/memory-db/spelled-ids.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import { runSplitTurn, SPLIT_SYSTEM, SPLIT_TEXT, splitLlm } from '../../fixtures/turn-split.ts';

for (const direction of ['ordinary-first', 'internal-first'] as const) {
  test(`prefetch separates the same trigger by issued context when ${direction}`, async () => {
    const ordinary = issueContext({ kind: 'group', iface: 'fake', newId: () => 'ctx:ordinary', now: () => NOW });
    const internal = issueContext({ kind: 'internal', newId: () => 'ctx:owner', now: () => NOW });
    const contexts: Array<unknown> = [];
    const lookup = createLookup({
      hot: { prompts: { labels } },
      store: { listUserProfiles: () => [] },
      llm: {
        complete: () => Promise.reject(new Error('prefetch does not classify')),
      },
      clock: () => NOW,
      recall: {
        prefetch: (args) => {
          contexts.push(args.memoryContext);
          return Promise.resolve({
            status: 'ok',
            excerpts: [args.memoryContext === internal ? 'private-evidence' : 'public-evidence'],
          });
        },
      },
      membersOf: null,
      selfIdOf: () => 'self',
      ifaceReads: rig().reads,
      classifierContext: () => {
        throw new Error('prefetch does not classify');
      },
      linkCalls: () => {
        throw new Error('the recording recall does not decorate');
      },
    });
    const start = (memoryContext: Context) => {
      const input: Parameters<Lookup['startPrefetch']>[0] = {
        config: config(),
        // The channel by its id; its tree is `placeId`.
        channel: { id: 'same-room' },
        placeId: 'g1',
        place: { id: 'g1' },
        trigger: { id: 'same-trigger', authorId: 'asker' },
        candidate: { content: 'θυμάσαι το κουνέλι στον κήπο', authorId: 'asker' },
        triggerKind: 'mention',
        mode: 'reply',
        history: [],
        selfId: 'self',
        selfName: 'Nova',
        memoryContext,
      };
      const started = lookup.startPrefetch(input);
      assert.ok(started);
      return started.pending;
    };
    const first = direction === 'ordinary-first' ? ordinary : internal;
    const second = direction === 'ordinary-first' ? internal : ordinary;
    assert.deepEqual(await start(first), {
      status: 'ok',
      excerpts: [first === internal ? 'private-evidence' : 'public-evidence'],
    });
    assert.deepEqual(await start(second), {
      status: 'ok',
      excerpts: [second === internal ? 'private-evidence' : 'public-evidence'],
    });
    assert.deepEqual(await start(second), {
      status: 'ok',
      excerpts: [second === internal ? 'private-evidence' : 'public-evidence'],
    });
    assert.deepEqual(contexts, [first, second]);
  });
}

test('prefetch memoization retains qualified history identity as well as the issued context', async () => {
  const context = issueContext({ kind: 'internal', newId: () => 'ctx:qualified-history', now: () => NOW });
  const loaded: Array<unknown> = [];
  const lookup = createLookup({
    hot: { prompts: { labels } },
    store: { listUserProfiles: () => [] },
    llm: { complete: () => Promise.reject(new Error('prefetch does not classify')) },
    clock: () => NOW,
    recall: {
      prefetch: (args) => {
        loaded.push(args.historyRef);
        return Promise.resolve({ status: 'ok', excerpts: [`load-${loaded.length}`] });
      },
    },
    membersOf: null,
    selfIdOf: () => 'self',
    ifaceReads: rig().reads,
    classifierContext: () => {
      throw new Error('prefetch does not classify');
    },
    linkCalls: () => {
      throw new Error('the recording loader does not decorate');
    },
  });
  const start = (historyRef: { iface: string; chatId: string }) => {
    const started = lookup.startPrefetch({
      config: config(),
      channel: { id: 'same-room' },
      placeId: 'g1',
      place: { id: 'g1' },
      trigger: { id: 'same-trigger', authorId: 'asker' },
      candidate: { content: 'θυμάσαι το κουνέλι στον κήπο', authorId: 'asker' },
      triggerKind: 'mention',
      mode: 'reply',
      history: [],
      selfId: 'self',
      selfName: 'Synthetic persona',
      memoryContext: context,
      historyRef,
    });
    if (!started) throw new Error('valid prefetch did not start');
    return started.pending;
  };
  const first = { iface: 'first', chatId: 'same-room' };
  const otherInterface = { iface: 'second', chatId: 'same-room' };
  const otherChat = { iface: 'second', chatId: 'different-room' };
  assert.deepEqual(await start(first), { status: 'ok', excerpts: ['load-1'] });
  assert.deepEqual(await start(first), { status: 'ok', excerpts: ['load-1'] });
  assert.deepEqual(await start(otherInterface), { status: 'ok', excerpts: ['load-2'] });
  assert.deepEqual(await start(otherChat), { status: 'ok', excerpts: ['load-3'] });
  assert.deepEqual(await start(otherChat), { status: 'ok', excerpts: ['load-3'] });
  assert.deepEqual(loaded, [first, otherInterface, otherChat]);
});

test('the command line chat fetches no partner from the root', async () => {
  // Bug: a chat turn asked the platform for the member of the command line's account id, which got an http-400 and a
  // warning on every line.
  const asked: Array<unknown> = [];
  const lookup = createLookup({
    hot: { prompts: { labels } },
    store: { listUserProfiles: () => [] },
    llm: { complete: () => Promise.reject(new Error('no model here')) },
    clock: () => NOW,
    recall: null,
    membersOf: null,
    selfIdOf: () => 'self',
    ifaceReads: {
      ...rig().reads,
      memberInfo: (member: unknown) => {
        asked.push(member);
        return Promise.resolve(null);
      },
    },
    classifierContext: () => {
      throw new Error('no classifier here');
    },
    linkCalls: () => {
      throw new Error('no links here');
    },
  });
  const partner = await lookup.privatePartner({ iface: 'cli', placeId: 'g1', accountId: 'owner', config: {} });
  assert.equal(partner, null);
  assert.deepEqual(asked, []);
  await lookup.privatePartner({ iface: 'discord', placeId: 'g1', accountId: 'u1', config: {} });
  assert.equal(asked.length, 1);
});

const DAY = 86400000;

const MEMORY_DB_RECALL_EXCLUSIONS_NOW = Date.parse('2026-10-24T12:00:00.000Z');

const BOB = 'u-bob';

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('tracked settings require an object');
  // The guard establishes an object whose settings are read by string keys.
  return value as Record<string, unknown>;
}

function runner(env: ReturnType<typeof fixture>) {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        {
          id: channelPlaceId('discord', 'c1'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c1',
          scope_kind: 'group',
          name: 'general',
        },
        {
          id: channelPlaceId('discord', 'c4'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c4',
          scope_kind: 'group',
          name: 'secret',
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: personId('discord', BOB),
        },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const parsed: unknown = JSON.parse(fs.readFileSync(new URL('../../../config/config.json', import.meta.url), 'utf8'));
  const config = objectOf(parsed);
  config.bot = { ...objectOf(config.bot ?? {}), timezone: 'UTC' };
  config.features = { ...objectOf(config.features ?? {}), meaningSearch: false, recall: true };
  const models = objectOf(config.models ?? {});
  // Changed: a role's model is its chain's (spec 2026-11-09-model-routes, slice 4).
  config.models = {
    ...models,
    routes: { ...objectOf(models.routes ?? {}), ...chainsOf({ embedding: 'test/embedder' }) },
  };
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const toolsLabels = labels.tools;
  const hot = {
    config,
    prompts: {
      labels: {
        ...labels,
        tools: {
          ...labels.tools,
          tools: { ...toolsLabels.tools, memory: { ...toolsLabels.tools.memory, hidden: 'ΚΡΥΦΟ-ΣΗΜΑ' } },
        },
      },
    },
  };
  const recaller = createRecall({
    mediaNameOf: noMediaNames,
    iface: 'discord',
    hot,
    // The DM partner `owner-42` has a stored person, which the store answers; no person is spelled from a member id.
    store: {
      state: { data: {}, markDirty() {} },
      listUserProfiles: () => [],
      personOfAccount: (account: string) => (account === 'owner-42' ? personId('discord', 'owner-42') : null),
    },
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('quoted SQLite reads need no model')) },
    now: () => MEMORY_DB_RECALL_EXCLUSIONS_NOW,
    embed: null,
    memoryDb: { database: () => env.db },
  });
  return {
    recaller,
    hot,
    args: {
      placeId: 'g1',
      snapshot,
      channel,
      partnerId: null,
      selfId: 'self',
      selfName: 'Ζωή',
      history: [],
      candidate: { id: 'q', content: 'το σπιτι' },
    },
  };
}

function exclusionSource(
  env: ReturnType<typeof fixture>,
  {
    iface = 'fake',
    room,
    id = 'shared-visible',
    marker,
    dm = false,
    offset = 60_000,
    authority = `${iface}/${room}`,
  }: { iface?: string; room: string; id?: string; marker: string; dm?: boolean; offset?: number; authority?: string }
) {
  const event = lineEvent({
    id,
    chatId: room,
    authorId: 'owner-42',
    text: `το κουνέλι ${marker}`,
    at: MEMORY_DB_RECALL_EXCLUSIONS_NOW - DAY - offset,
  });
  event.iface = iface;
  event.chat = dm
    ? { id: room, kind: 'dm', rootId: null, partnerId: 'owner-42' }
    : { id: room, kind: 'channel', rootId: 'g1', name: room };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid exclusion fixture was refused');
  envelope.authority = authority;
  envelope.place.authority = authority;
  const result = observe(env.handle, envelope, { now: () => MEMORY_DB_RECALL_EXCLUSIONS_NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string' || typeof result.placeId !== 'string')
    throw new Error('exclusion source identity missing');
  return {
    sourceId: result.sourceId,
    placeId: result.placeId,
    iface,
    native: { iface, chatId: room, messageId: id },
  };
}

test('lookup prefetch forwards trusted CLI history identity into the real SQLite reader', async () => {
  const env = fixture();
  try {
    const { createLookup } = await import('../../../src/turn/lookup.ts');
    const { rig } = await import('../../fixtures/reads-rig.ts');
    exclusionSource(env, { iface: 'cli', room: 'cli:dm:owner', marker: 'lookup-own-731', dm: true });
    exclusionSource(env, { iface: 'other', room: 'foreign-dm', marker: 'lookup-foreign-842', dm: true });
    env.stem();
    const s = runner(env);
    const memoryContext = issuedContext({
      kind: 'internal',
      newId: () => 'ctx:lookup-exclusion',
      now: () => MEMORY_DB_RECALL_EXCLUSIONS_NOW,
    });
    const lookup = createLookup({
      hot: s.hot,
      store: { listUserProfiles: () => [] },
      llm: { complete: () => Promise.reject(new Error('prefetch does not classify')) },
      clock: () => MEMORY_DB_RECALL_EXCLUSIONS_NOW,
      recall: { prefetch: (args) => s.recaller.prefetch(args) },
      membersOf: null,
      selfIdOf: () => 'self',
      ifaceReads: rig().reads,
      classifierContext: () => {
        throw new Error('prefetch does not classify');
      },
      linkCalls: (lines) => lines,
    });
    const { config: prefetchConfig } = await import('../../fixtures/recall-run-kit.ts');
    const pending = lookup.startPrefetch({
      config: prefetchConfig(),
      channel: channelInfo('cli:dm:owner', { kind: 'dm', rootId: null, partnerId: 'owner-42', audience: null }),
      placeId: 'g1',
      place: null,
      trigger: { id: 'current-cli-trigger', authorId: 'owner-42' },
      candidate: { content: 'θυμάσαι το "το κουνέλι" από την παλιά συζήτηση;', authorId: 'owner-42' },
      triggerKind: 'private',
      mode: 'reply',
      history: [{ id: 'shared-visible', placeId: 'cli:dm:owner', content: 'το κουνέλι lookup-own-731' }],
      selfId: 'self',
      selfName: 'Synthetic persona',
      memoryContext,
      historyRef: { iface: 'cli', chatId: 'cli:dm:owner' },
    });
    if (!pending) throw new Error('valid internal CLI prefetch did not start');
    const { pending: prefetched } = pending;
    const found = await prefetched;
    assert.equal(JSON.stringify(found).includes('lookup-own-731'), false);
    assert.ok(JSON.stringify(found).includes('lookup-foreign-842'));
  } finally {
    env.done();
  }
});

const SPLIT_JSON_NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

const CONFIG = {
  bot: { timezone: 'UTC' },
  models: { routes: chainsOf({ analyzer: 'small/analyzer' }) },
  llm: { analyzerTimeoutMs: 1000 },
  split: { maxOutputTokens: 50 },
};

// Four parts, each past split.minPartChars (20 code points), so none folds into another.
const PARTS = [
  'ποιος είναι ο Νίκος ακριβώς',
  'κοίτα το κανάλι της Ελένης',
  'πες μου αν το μιμίδιο είναι αστείο',
  'και ζωγράφισε έναν γάτο με καπέλο',
];

const FIFTH = 'και ένα τελευταίο ακόμα θέμα εδώ';

type Sent = { options: { responseFormat?: unknown; purpose?: unknown } };

/** One maybeSplit whose model answers `text` (or throws it), with the request options and the split log lines. */
async function split(text: string) {
  const sent: Array<Sent> = [];
  const lookup = createLookup({
    hot: { prompts: { labels } },
    store: { listUserProfiles: () => [] },
    llm: {
      complete: (_messages, options) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    clock: () => SPLIT_JSON_NOW,
    recall: null,
    membersOf: null,
    selfIdOf: () => 'self',
    ifaceReads: rig().reads,
    classifierContext: ({ trigger }) => ({ triggerText: String(trigger.content ?? ''), transcriptBlock: '' }),
    linkCalls: () => {
      throw new Error('the splitter does not decorate');
    },
  });
  const { result, logs } = await withCapturedLogs(() =>
    lookup.maybeSplit({
      config: CONFIG,
      placeId: 'c1',
      selfName: 'Nova',
      history: [],
      trigger: { id: 'm1', authorName: 'Léa', content: PARTS.join('; ') },
      prompt: 'Split for {{name}} into at most {{maxTasks}} parts.',
      isLate: () => false,
    })
  );
  const failed = logs.filter((entry) => entry.msg === 'split: failed');
  const verdicts = logs.filter((entry) => entry.msg === 'split: verdict');
  return { parts: result, sent, failed, verdicts };
}

/** Answers that are not the object, or whose `parts` is not a list of texts: each is an unreadable answer. */
const UNREADABLE = [
  'one',
  'One.',
  `- ${PARTS[0]}\n- ${PARTS[1]}`,
  'The message holds two requests.',
  '{}',
  JSON.stringify({ part: [PARTS[0], PARTS[1]] }),
  JSON.stringify({ parts: PARTS[0] }),
  JSON.stringify({ parts: null }),
  JSON.stringify({ parts: [1, 2] }),
  JSON.stringify({ parts: [PARTS[0], 2] }),
  JSON.stringify({ parts: [PARTS[0], null] }),
  JSON.stringify({ parts: [PARTS[0], '   '] }),
  JSON.stringify([PARTS[0], PARTS[1]]),
  '"one"',
  'null',
  '2',
  `{"parts":["${PARTS[0]}","${PARTS[1]}"]`,
  `\`\`\`json\n${JSON.stringify({ parts: [PARTS[0], PARTS[1]] })}\n\`\`\``,
];

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, { type?: unknown; items?: { type?: unknown } }>;
};

test('the split request hands the client SPLIT_FORMAT as its responseFormat', async () => {
  const { sent } = await split(JSON.stringify({ parts: [] }));
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.options.purpose, 'split');
  assert.deepEqual(request.options.responseFormat, SPLIT_FORMAT);
});

test('SPLIT_FORMAT is a closed object whose one required field parts is a list of texts', () => {
  assert.match(SPLIT_FORMAT.name, /^[A-Za-z0-9_-]{1,64}$/);
  const schema = SPLIT_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['parts']);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['parts']);
  const parts = schema.properties?.parts;
  assert.equal(parts?.type, 'array');
  assert.equal(parts?.items?.type, 'string');
});

test('two to four parts are the split, in their order, logged as a verdict', async () => {
  for (const count of [2, 3, 4]) {
    const { parts, failed, verdicts } = await split(JSON.stringify({ parts: PARTS.slice(0, count) }));
    assert.deepEqual(parts, PARTS.slice(0, count), `${count} parts`);
    assert.deepEqual(failed, [], `${count} parts: no failed call`);
    assert.deepEqual(
      verdicts.map((entry): unknown => entry.parts),
      [count],
      `${count} parts`
    );
  }
});

test('an empty list or one part is one request, logged as a verdict of one part like the word one', async () => {
  for (const list of [[], [PARTS[0]]]) {
    const { parts, failed, verdicts } = await split(JSON.stringify({ parts: list }));
    const label = JSON.stringify(list);
    assert.equal(parts, null, label);
    assert.deepEqual(failed, [], label);
    assert.deepEqual(
      verdicts.map((entry): unknown => entry.parts),
      [1],
      label
    );
  }
});

test('more parts than split.maxTasks are cut to the first maxTasks', async () => {
  assert.equal(SPLIT_DEFAULTS.maxTasks, PARTS.length, 'the fixture holds exactly maxTasks parts');
  const { parts, verdicts } = await split(JSON.stringify({ parts: [...PARTS, FIFTH] }));
  assert.deepEqual(parts, PARTS);
  assert.deepEqual(
    verdicts.map((entry): unknown => entry.parts),
    [PARTS.length]
  );
});

test('an unreadable answer, the old word and dash lines included, is one request logged as unparsed', async () => {
  for (const text of UNREADABLE) {
    const { parts, failed, verdicts } = await split(text);
    const label = JSON.stringify(text);
    assert.equal(parts, null, label);
    assert.deepEqual(verdicts, [], `${label}: no verdict`);
    assert.deepEqual(
      failed.map((entry): unknown => entry.reason),
      ['unparsed'],
      label
    );
  }
});

test('a blank answer is one request logged as empty', async () => {
  const { parts, failed } = await split('  \n');
  assert.equal(parts, null);
  assert.deepEqual(
    failed.map((entry): unknown => entry.reason),
    ['empty']
  );
});

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<{ close: () => Promise<void> }> = [];

after(async () => {
  for (const mem of OPENED_MEMORY) await mem.close();
});

const DRAW_FOLDERS: Array<string> = [];

after(() => {
  for (const folder of DRAW_FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A message that holds several requests: the splitter (prompts/classify/split.md) and the chain of parts.

/** The `<candidate>` text a classifier request carried. */
function candidateOf(call: Untyped) {
  const secondMessage = call.messages[1];
  return /<candidate>\n[^:]*: ([\s\S]*?)\n<\/candidate>/.exec(textOf(secondMessage.content))?.[1] ?? null;
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

describe('a whole turn', () => {
  // Split, merge and missed answer in strict JSON.
  test('runTurn: the splitter request fills classify/split.md and carries the transcript and the candidate', async () => {
    const { llm } = await runSplitTurn({ llm: splitLlm({ split: '{"parts":[]}' }) });
    const [call] = llm.calls.split;
    const firstMessage = call.messages[0];
    assert.equal(firstMessage.content, fillPromptTemplate(SPLIT_SYSTEM, { name: 'Bot', maxTasks: 4 }));
    const secondMessage = call.messages[1];
    assert.ok(textOf(secondMessage.content).startsWith('<transcript>\n'));
    assert.equal(candidateOf(call), SPLIT_TEXT);
    assert.deepEqual(
      [call.options.role, call.options.purpose, call.options.maxOutputTokens, call.options.isRoleRequest],
      ['analyzer', 'split', 50, true]
    );
  });
});
