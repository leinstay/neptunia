// Real core producers preserve accepted receipts and native message identity through storage, recall and adapter calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { startCore } from '../src/core.ts';
import { start } from '../src/interface/fake-interface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { window } from '../src/memory/db/recall.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import type { MessageEvent } from '../src/protocol/adapter.ts';
import { SELF, channelInfo, lineEvent, until } from './fixtures/core-over-fake.ts';
import { addClient, CLI_CLIENT, FAKE_CLIENT, folders, query, runCli } from './fixtures/core-units.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import type { Completion } from './fixtures/tool-answers.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const NATIVE = 'same-native-message';
type Running = Awaited<ReturnType<typeof start>>;

function event(eventId: string, room: string, text: string, edit = false): MessageEvent {
  const input = lineEvent({ id: NATIVE, conversationId: room, text, at: NOW - 60_000 });
  return { ...input, id: eventId, at: NOW, edit };
}

async function boot(complete?: (messages: unknown, options?: unknown) => Promise<Completion>) {
  const dirs = folders({
    bot: { timezone: 'UTC', placeId: 'g1', owners: ['u1'] },
    models: { base: { video: false } },
    gifs: { backfillMessages: 0 },
    features: {
      spontaneous: false,
      eavesdrop: false,
      followUp: false,
      participation: false,
      offlineCatchUp: false,
      selfreflection: false,
      mediaDescriptions: false,
      channelRoute: false,
      memoryPrefetch: false,
      channelPull: false,
      elsewhere: false,
      speech: false,
      pauseNotice: false,
    },
    tools: { loop: { maxSteps: 4, timeBudgetMs: 15_000, maxCallsPerStep: 2 } },
  });
  addClient(dirs.privateDir, CLI_CLIENT);
  addClient(dirs.privateDir, FAKE_CLIENT);
  let running: Running | null = null;
  const core = await startCore({
    paths: dirs.paths,
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    now: () => NOW,
    llm: { complete: complete ?? (() => Promise.reject(new Error('this producer scenario asks no model'))) },
    embedder: { embed: () => Promise.resolve([]) },
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(
            { ...host, token: readFileSync(`${dirs.privateDir}/clients/fake.token`, 'utf8').trim() },
            { self: SELF, community: { id: 'g1', name: 'Synthetic community' } }
          );
          return running;
        },
      },
    ],
  });
  if (running === null) throw new Error('the core did not start the fake interface');
  const live: Running = running;
  for (const room of ['room-a', 'room-b']) live.adapter.seedConversation(channelInfo(room));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await core.stop();
  };
  return {
    dirs,
    live,
    stop,
    async send(input: MessageEvent) {
      live.adapter.seedEvent(input);
      return live.emit(input);
    },
    async close() {
      try {
        await stop();
      } finally {
        rmSync(dirs.root, { recursive: true, force: true });
      }
    },
  };
}

test('real received, edit and authorless delete events retain their own accepted source in colliding conversations', async () => {
  await withCapturedLogs(async () => {
    const rig = await boot();
    try {
      assert.deepEqual(
        await Promise.all([
          rig.send(event('create-a', 'room-a', 'Alpha original')),
          rig.send(event('create-b', 'room-b', 'Beta original')),
        ]),
        ['ok', 'ok']
      );
      assert.equal(await rig.send(event('edit-a', 'room-a', 'Alpha edited', true)), 'ok');
      const deletion: MessageEvent = { ...event('delete-a', 'room-a', ''), deleted: true, message: { id: NATIVE } };
      assert.equal(await rig.live.emit(deletion), 'ok');
      const sources = query(rig.dirs, 'SELECT * FROM sources');
      const receipts = query(rig.dirs, 'SELECT * FROM ingest ORDER BY seq');
      assert.deepEqual(
        receipts.map((receipt) => {
          const source = sources.find((row) => row.id === receipt.source_id);
          return [receipt.event_id, receipt.conversation, source?.kind, source?.text ?? null];
        }),
        [
          ['create-a', 'room-a', 'seen', 'Alpha original'],
          ['create-b', 'room-b', 'seen', 'Beta original'],
          ['edit-a', 'room-a', 'seen', 'Alpha edited'],
          ['delete-a', 'room-a', 'deleted', null],
        ]
      );
      assert.deepEqual(
        receipts.map((receipt) => receipt.principal),
        ['fake', 'fake', 'fake', 'fake']
      );
      assert.deepEqual(
        query(rig.dirs, 'SELECT conversation_id, message_id FROM message_families ORDER BY conversation_id'),
        [
          { conversation_id: 'room-a', message_id: NATIVE },
          { conversation_id: 'room-b', message_id: NATIVE },
        ]
      );
      const handle = openMemoryDb(`${rig.dirs.dataDir}/memory.db`, { readOnly: true });
      try {
        for (const room of ['room-a', 'room-b']) {
          const recalled = window(dbOf(handle), {
            ctx: internalContext(),
            resolvedAnchor: { kind: 'native', locator: { iface: 'fake', conversationId: room, messageId: NATIVE } },
            messages: 1,
          });
          assert.equal(recalled.unknown, room === 'room-a');
        }
      } finally {
        handle.close();
      }
    } finally {
      await rig.close();
    }
  });
});

test('the real edit handler records each observed revision once within its qualified message family', async () => {
  await withCapturedLogs(async () => {
    const rig = await boot();
    try {
      for (const input of [
        event('original-a', 'room-a', 'Alpha original'),
        event('original-b', 'room-b', 'Beta original'),
        event('first-edit', 'room-a', 'Alpha first edit', true),
        event('second-edit', 'room-a', 'Alpha second edit', true),
      ])
        assert.equal(await rig.send(input), 'ok');
      await rig.stop();
      assert.deepEqual(
        query(
          rig.dirs,
          `SELECT f.conversation_id, s.revision, s.text FROM message_families f
        JOIN sources s ON s.iface = f.iface AND s.native_id = f.native_key
        WHERE s.kind = 'seen' ORDER BY f.conversation_id, s.revision`
        ),
        [
          { conversation_id: 'room-a', revision: 1, text: 'Alpha original' },
          { conversation_id: 'room-a', revision: 2, text: 'Alpha first edit' },
          { conversation_id: 'room-a', revision: 3, text: 'Alpha second edit' },
          { conversation_id: 'room-b', revision: 1, text: 'Beta original' },
        ]
      );
      assert.equal(query(rig.dirs, "SELECT COUNT(*) AS n FROM sources WHERE kind = 'seen'")[0]?.n, 4);
    } finally {
      await rig.close();
    }
  });
});

function toolText(messages: unknown): string {
  if (!Array.isArray(messages)) throw new Error('the scripted model requires a message array');
  return messages
    .filter(
      (message: unknown) =>
        message !== null && typeof message === 'object' && 'role' in message && message.role === 'tool'
    )
    .map((message: unknown) =>
      message !== null && typeof message === 'object' && 'content' in message && typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message)
    )
    .join('\n');
}

// The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
test('a handle recalled from a real received event reads and replies with its native conversation and message IDs', async () => {
  await withCapturedLogs(async () => {
    let step = 0;
    let recalledText = '';
    const rig = await boot((messages, options) => {
      const purpose = options !== null && typeof options === 'object' && 'purpose' in options ? options.purpose : null;
      if (purpose === 'address') return Promise.resolve(toolAnswer('yes'));
      if (purpose === 'lookup' || purpose === 'elsewhere-pick') return Promise.resolve(toolAnswer('none'));
      if (purpose === 'split') return Promise.resolve(toolAnswer('{"parts":[]}'));
      step += 1;
      if (step === 1) return Promise.resolve(toolAnswer('', [call('memory.search', { question: 'gardenrabbit731' })]));
      if (step === 2) {
        recalledText = toolText(messages);
        const handle = recalledText.match(/^#(\d+) .*gardenrabbit731/m)?.[1];
        if (!handle) return Promise.resolve(toolAnswer('<skip/>'));
        return Promise.resolve(
          toolAnswer('', [
            call('conversation.read', { channel: '#room-room-b', around: `#${handle}`, last: 1 }),
            call('message.create', { reply: `#${handle}`, text: 'native reply 842' }),
          ])
        );
      }
      return Promise.resolve(toolAnswer('<skip/>'));
    });
    try {
      for (const skill of ['memory.search', 'conversation.read', 'message.create']) {
        const granted = await runCli(rig.dirs, ['-p', `/tools grant ${skill}`]);
        assert.equal(granted.code, 0, granted.stderr);
      }
      assert.equal(await rig.send(event('decoy', 'room-a', 'Other conversation evidence')), 'ok');
      assert.equal(await rig.send(event('target', 'room-b', 'gardenrabbit731 target evidence')), 'ok');
      const trigger = lineEvent({
        id: 'question',
        conversationId: 'room-a',
        text: 'Please find the stored gardenrabbit731 message.',
        at: NOW,
        mention: true,
      });
      assert.equal(await rig.send(trigger), 'ok');
      await until(() => step >= 2, 5000);
      assert.ok(recalledText.includes('gardenrabbit731 target evidence'), recalledText);
      await until(() => step >= 3, 5000);
      // The adapter contract permits history anchors and direct fetches. The native route is independent of page size.
      const reads = rig.live.adapter.calls.filter((entry) => entry.op === 'history' || entry.op === 'fetchMessages');
      assert.ok(
        reads.some(({ op, args }) => {
          if (!isDeepStrictEqual(args[0], { iface: 'fake', conversationId: 'room-b' })) {
            return false;
          }
          if (op === 'fetchMessages') {
            return isDeepStrictEqual(args[1], [NATIVE]);
          }
          const query = args[1];
          return query !== null && typeof query === 'object' && 'around' in query && query.around === NATIVE;
        })
      );
      const replies = rig.live.adapter.messagesIn('room-b').filter((message) => message.text === 'native reply 842');
      assert.deepEqual(
        replies.map((message) => message.replyTo),
        [{ iface: 'fake', conversationId: 'room-b', messageId: NATIVE }]
      );
      const storageKeys = query(
        rig.dirs,
        'SELECT id, native_id FROM sources WHERE text = ?',
        'gardenrabbit731 target evidence'
      );
      assert.equal(storageKeys.length, 1);
      const adapterCalls = JSON.stringify(rig.live.adapter.calls);
      for (const source of storageKeys) {
        assert.equal(adapterCalls.includes(String(source.id)), false);
        assert.notEqual(source.native_id, NATIVE);
        assert.equal(adapterCalls.includes(String(source.native_id)), false);
      }
    } finally {
      await rig.close();
    }
  });
});

test('an unavailable partial edit preserves archived text and author without inventing an empty revision', async () => {
  await withCapturedLogs(async () => {
    const rig = await boot();
    try {
      assert.equal(await rig.send(event('original-before-partial', 'room-a', 'Preserved original text')), 'ok');
      const select = "SELECT id, revision, text, author_account FROM sources WHERE kind = 'seen' ORDER BY id";
      const before = query(rig.dirs, select);
      assert.ok(before.some((row) => row.text === 'Preserved original text'));
      const author = query(
        rig.dirs,
        `SELECT a.native_id FROM sources s JOIN accounts a ON a.id = s.author_account
        WHERE s.text = ?`,
        'Preserved original text'
      );
      assert.ok(author.some((row) => row.native_id === 'u1'));
      rig.live.adapter.failNext('fetchMessages', {
        status: 'failed',
        error: { code: 'unavailable', retryable: false, retryAfterMs: null },
      });
      const calls = rig.live.adapter.calls.length;
      const partial: MessageEvent = {
        ...event('unavailable-partial-edit', 'room-a', '', true),
        partial: true,
        message: { id: NATIVE },
      };
      assert.equal(await rig.live.emit(partial), 'ok');
      await rig.stop();
      assert.deepEqual(query(rig.dirs, select), before);
      for (const call of rig.live.adapter.calls.slice(calls).filter((entry) => entry.op === 'fetchMessages')) {
        assert.deepEqual(call.args, [{ iface: 'fake', conversationId: 'room-a' }, [NATIVE]]);
      }
    } finally {
      await rig.close();
    }
  });
});

test('an edit and a deletion reach the record and log no refused append', async () => {
  // Bug: the record's descriptor named the message id, the line carries its own id, and each was refused BAD_NATIVE.
  const { logs } = await withCapturedLogs(async () => {
    const rig = await boot();
    try {
      assert.equal(await rig.send(event('original', 'room-a', 'Alpha original')), 'ok');
      assert.equal(await rig.send(event('edit', 'room-a', 'Alpha edited', true)), 'ok');
      const deletion: MessageEvent = { ...event('gone', 'room-a', ''), deleted: true, message: { id: NATIVE } };
      assert.equal(await rig.send(deletion), 'ok');
      await rig.stop();
    } finally {
      await rig.close();
    }
  });
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'events: record failed'),
    []
  );
});
