// The scene of the mirror publication tests: a real memory service over a temporary directory (every write through its
// one writer), a clock the test moves, fake interface transports the test scripts send by send, and as many publishers
// (`createMirrors`) over them as the test wants, each new one standing for a restart or a second writer. A transport
// wraps the fake adapter, so `posted` reads what reached the platform, whatever the publisher was told. Synthetic data
// only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { parseRequest } from '../../bin/neptunia-request.ts';
import { createMirrors } from '../../src/behavior/mirror.ts';
import { createConsole } from '../../src/interface/commands/console.ts';
import type { Answer, ConsoleDeps } from '../../src/interface/commands/console.ts';
import { createFakeAdapter } from '../../src/interface/fake.ts';
import { channelPlaceId, guildPlaceId } from '../../src/memory/db/ids.ts';
import { insertRows } from '../../src/memory/db/rows.ts';
import type { Content } from '../../src/protocol/actions.ts';
import type { ConversationRef, Delivery, SendOptions } from '../../src/protocol/adapter.ts';
import { dbOf } from './diary-mirror.ts';
import { openTestMemory } from './memory-db/service.ts';

export const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
export const HOUR = 3_600_000;
export const FOUR_HOURS = 4 * HOUR;
/** How long a claim stands before its publisher counts as gone (`mirrors.claimLeaseMs`, set by every scene). */
export const LEASE = 10 * 60_000;
/** The requester of the owner's commands. */
export const OWNER = 'owner-1';

/** What a scripted send does: reach the platform or not, and what the publisher hears. */
export type Behaviour =
  | 'deliver'
  /** Reaches the platform; the publisher hears `unknown`. */
  | 'lost-answer'
  /** Reaches nothing; the publisher hears `unknown`. */
  | 'never-sent'
  /** Reaches the platform; the answer never comes, as when the process dies during the send. */
  | 'hang-after-delivery'
  /** Reaches nothing; the send rejects. */
  | 'throw'
  | { refuse: string; retryable?: boolean };

/** One send the publisher asked for, whatever came of it. */
export type Attempt = { conversationId: string; text: string; files: number; key: string | undefined };

const delivery = (status: Delivery['status'], code: string, retryable = false): Delivery => ({
  status,
  ref: null,
  parts: [],
  at: null,
  idempotencyKey: '',
  error: { code, retryable, retryAfterMs: null },
});

/** A fake interface transport: the port the publisher holds and the script of its sends. */
// The transport's type is what it returns; a test file reads it through `Transport`.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createTransport(iface: string, { now, reconcile = false }: { now: () => number; reconcile?: boolean }) {
  const fake = createFakeAdapter({ iface, selfId: 'self', now, capabilities: { reconcile } });
  const attempts: Array<Attempt> = [];
  let made = 0;
  let held: Promise<void> | null = null;
  const transport = {
    iface,
    fake,
    attempts,
    /** Which behaviour each attempt gets, by the attempt itself and its number since the scene began. */
    behave: (() => 'deliver') as (attempt: Attempt, index: number) => Behaviour,
    /** Called once a send reached the platform, before the publisher hears of it. */
    onDelivered: () => {},
    /** Called as a send starts, before anything reaches the platform. */
    onSend: (() => {}) as (attempt: Attempt) => void,
    /** What reached the platform in `conversationId`, in order. */
    posted: (conversationId: string): Array<string> => fake.messagesIn(conversationId).map((message) => message.text),
    /** Makes every send wait until the answered function is called. */
    hold(): () => void {
      const gate = Promise.withResolvers<void>();
      held = gate.promise;
      return () => {
        held = null;
        gate.resolve();
      };
    },
    capabilities: () => fake.capabilities(),
    fetchMessages: fake.fetchMessages.bind(fake),
    async send(conversation: ConversationRef, content: Content, options?: SendOptions): Promise<Delivery> {
      const attempt: Attempt = {
        conversationId: conversation.conversationId,
        text: content.text ?? '',
        files: content.attachments?.length ?? 0,
        key: options?.idempotencyKey,
      };
      const index = attempts.length;
      attempts.push(attempt);
      transport.onSend(attempt);
      if (held) await held;
      const behaviour = transport.behave(attempt, index);
      if (behaviour === 'throw') throw Object.assign(new Error('link dropped'), { code: 'LINK_DROPPED' });
      if (behaviour === 'never-sent') return delivery('unknown', 'timeout');
      if (typeof behaviour === 'object') return delivery('failed', behaviour.refuse, behaviour.retryable ?? false);
      const sent = await fake.send(conversation, content, options);
      transport.onDelivered();
      if (behaviour === 'lost-answer') return delivery('unknown', 'timeout');
      if (behaviour === 'hang-after-delivery') return new Promise<Delivery>(() => {});
      const messageId = sent.ref?.messageId ?? '';
      const attachments = (content.attachments ?? []).map(() => ({ messageId, attachmentId: `att-${(made += 1)}` }));
      return { ...sent, attachments };
    },
  };
  return transport;
}

export type Transport = ReturnType<typeof createTransport>;

/** A place of the scene: a channel or a guild of an interface, under a parent place when it has one. */
export type PlaceSpec = { iface: string; native: string; kind?: 'channel' | 'guild' | 'dm'; parent?: string | null };

/** A diary row of the scene. `legacy` leaves the audience out, as a row from before the audience has none. */
export type EntrySpec = {
  id: string;
  at?: number;
  text?: string;
  position?: number;
  audience?: unknown;
  boundary?: unknown;
  legacy?: boolean;
  scope?: { scope_kind: string; scope_iface: string | null; scope_dm: string | null };
  messages?: ReadonlyArray<string>;
};

/** The memory databases the scenes opened, closed when the test file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

/** The scene: see the head of this file. Every interface of `ifaces` is connected at the start. */
// The scene's type is what it returns; a test file reads it through `Scene`.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function mirrorScene({
  ifaces = ['fake'],
  reconcile = false,
  start = T0,
}: { ifaces?: ReadonlyArray<string>; reconcile?: boolean; start?: number } = {}) {
  let at = start;
  const now = (): number => at;
  const memory = await openTestMemory({ now });
  OPEN.push(memory);
  const transports = new Map(ifaces.map((iface) => [iface, createTransport(iface, { now, reconcile })]));
  const connected = new Set(ifaces);
  const writes: Array<Record<string, unknown>> = [];
  let writesFail = false;
  const db = dbOf(memory.memoryDb);
  const stamp = (): string => new Date(at).toISOString();

  /** The memory service as a publisher holds it: every write recorded, and refused while `writesFail` is on. */
  const recording = {
    readHandle: () => memory.memoryDb.readHandle(),
    memoryWrite: async (update: Record<string, unknown>): Promise<unknown> => {
      if (writesFail) throw Object.assign(new Error('the process is gone'), { code: 'GONE' });
      writes.push(update);
      return memory.memoryDb.memoryWrite(update);
    },
  };

  /**
   * A new publisher over the same memory: a restart, or a second writer next to the first. A caller that names no
   * interface gets the scene's first one, as the core's one link answers today. The tests with two interfaces need the
   * name, since the port of the first interface is not the port of the second.
   */
  const publisher = () =>
    createMirrors({
      memoryDb: recording,
      port: (iface?: string) => {
        const name = iface ?? ifaces[0] ?? '';
        return connected.has(name) ? (transports.get(name) ?? null) : null;
      },
      now,
      dataDir: memory.dataDir,
      config: () => ({ mirrors: { claimLeaseMs: LEASE } }),
    });

  /** One place row; answers its id. */
  function place({ iface, native, kind = 'channel', parent = null }: PlaceSpec): string {
    const id = kind === 'guild' ? guildPlaceId(iface, native) : kind === 'dm' ? `${iface}:dm:${native}` : channelPlaceId(iface, native);
    const scope_kind = kind === 'dm' ? 'dm' : 'group';
    insertRows(
      db,
      { places: [{ id, iface, kind, native_id: native, parent_id: parent, scope_kind, name: native }] },
      { at: stamp() }
    );
    return id;
  }

  /** One diary row. An entry that is not `legacy` carries the explicit audience a new entry is recorded with. */
  function entry({ id, at: when = at, text = `text of ${id}`, position = 0, audience, boundary, legacy, scope, messages }: EntrySpec): string {
    const extra: Record<string, unknown> = {};
    if (legacy !== true) extra.publicationAudience = audience ?? { kind: 'unrestricted' };
    if (boundary !== undefined) extra.publicationBoundary = boundary;
    if (messages) extra.send = { messages, mentions: messages.map(() => []), maxMessageBytes: 8_000_000 };
    insertRows(
      db,
      {
        diary: [
          {
            id,
            at_ms: when,
            kind: 'status',
            gist: text,
            text,
            ...(scope ?? { scope_kind: 'group', scope_iface: 'fake', scope_dm: null }),
            extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
            position,
          },
        ],
      },
      { at: stamp() }
    );
    return id;
  }

  /** A receipt from before this model: a `diary_mirrors` row, which derives its `sent` publication. */
  function receipt(entryId: string, placeId: string, iface: string, messageIds: ReadonlyArray<string>): void {
    insertRows(
      db,
      {
        diary_mirrors: [
          {
            id: `mirror:${entryId}:${placeId}`,
            diary_id: entryId,
            iface,
            place_id: placeId,
            native_ids: JSON.stringify(messageIds),
            posted_at: stamp(),
          },
        ],
      },
      { at: stamp() }
    );
  }

  /** The files memory keeps of an entry, full paths, in their order. */
  const mediaFiles = (entryId: string): Array<string> =>
    db
      .prepare("SELECT path FROM media WHERE kind = 'diary' AND owner = ? ORDER BY id")
      .all(entryId)
      .map((row) => path.join(memory.dataDir, String(row.path)));

  /** The owner's console with this scene's publisher. */
  function desk(mirrors = publisher()) {
    const deps: ConsoleDeps = {
      runOp: () => Promise.resolve({ status: 'failed', code: 'no-op', summary: '', data: null }),
      ownerReads: { lessons: () => '', aliases: () => '' },
      guildId: () => 'g1',
      selfId: () => 'self-1',
      hot: { config: { bot: { owners: [] } } },
      privateDir: memory.dataDir,
      dataDir: memory.dataDir,
      memoryDb: memory.memoryDb,
      usage: null,
      metrics: null,
      conversationLines: () => [],
      now,
      mirrors,
    };
    const console = createConsole(deps);
    /** One command as argv words, through the parse of `neptunia <words...>`. */
    return async (...words: ReadonlyArray<string>): Promise<Answer> => {
      const { parsed } = parseRequest(['mirror', ...words]);
      assert.ok(parsed.ok, JSON.stringify(parsed));
      return console.run(parsed.name, parsed.args, { id: OWNER });
    };
  }

  return {
    memory,
    db,
    writes,
    now,
    publisher,
    desk,
    place,
    entry,
    receipt,
    mediaFiles,
    transport(iface = 'fake'): Transport {
      const found = transports.get(iface);
      assert.ok(found, `the scene has the interface ${iface}`);
      return found;
    },
    setTime(ms: number): void {
      at = ms;
    },
    advance(ms: number): void {
      at += ms;
    },
    connect(iface = 'fake'): void {
      connected.add(iface);
    },
    disconnect(iface = 'fake'): void {
      connected.delete(iface);
    },
    /** Every write from now on throws: the crash between a remote success and its local receipt. */
    failWrites(on = true): void {
      writesFail = on;
    },
  };
}

export type Scene = Awaited<ReturnType<typeof mirrorScene>>;

/** A few turns of the event loop, for overlapping work to reach the point it would race at. */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The file back in place with the bytes it had: a lost media file found again. */
export function restoreFile(file: string, bytes: Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
