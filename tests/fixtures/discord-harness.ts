// A fake discord.js client for the Discord adapter (interfaces/discord/port.ts), shared by the contract of the port
// and the tests of the adapter: one text channel whose messages keep their author and reactions.
import { createDiscordAdapter } from '../../interfaces/discord/port.ts';
import type { Untyped } from '../../src/tools/types.ts';

export const SELF = 'self-id';
export const OTHER = 'other-id';
export const ROOM = 'c1';

/** A fake discord.js client with one text channel; messages keep their author and reactions. */
/** What a test reads of the harness: the port, what reached the client and a neutral view of the channel. */
export type DiscordHarness = {
  port: ReturnType<typeof createDiscordAdapter>;
  payloads: Array<Untyped>;
  client: Untyped;
  foreign(): { iface: string; chatId: string; messageId: Untyped };
  view(ref: Record<string, Untyped>): { text: Untyped; authorId: Untyped; reactions: Array<Untyped> } | null;
  lastSent(): { text: Untyped; replyToId: Untyped; attachments: Array<Untyped> };
  timeoutNextSend(): void;
  effects(): number;
};

export function discordHarness({ operations = null }: { operations?: Untyped } = {}): DiscordHarness {
  const store = new Map();
  const payloads: Array<Untyped> = [];
  let failSend: Untyped = null;
  let next = 0;
  const notFound = () => Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
  const makeMessage = (authorId: string, content: Untyped) => {
    next += 1;
    const id = `d${next}`;
    const message: Untyped = {
      id,
      author: { id: authorId },
      content,
      createdTimestamp: 5000 + next,
      reacted: new Set(),
      deleted: false,
      async edit(payload: Record<string, Untyped>) {
        this.content = payload.content;
        return this;
      },
      async delete() {
        this.deleted = true;
      },
      async react(emoji: string) {
        this.reacted.add(emoji);
      },
    };
    message.reactions = {
      resolve: (key: string) =>
        message.reacted.has(key) ? { users: { remove: async () => message.reacted.delete(key) } } : null,
    };
    store.set(id, message);
    return message;
  };
  const channel = {
    id: ROOM,
    async send(payload: Record<string, Untyped>) {
      payloads.push(payload);
      if (failSend) {
        const err = failSend;
        failSend = null;
        throw err;
      }
      return makeMessage(SELF, payload.content ?? '');
    },
    async sendTyping() {},
    messages: {
      fetch: async (id: string) => {
        const message = store.get(id);
        if (!message || message.deleted) throw notFound();
        return message;
      },
    },
  };
  const client = {
    user: { id: SELF },
    channels: {
      cache: new Map([[ROOM, channel]]),
      fetch: async () => {
        throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 });
      },
    },
  };
  const port = createDiscordAdapter({ client, operations });
  return {
    port,
    payloads,
    client,
    foreign: () => ({ iface: 'discord', chatId: ROOM, messageId: makeMessage(OTHER, 'καλημέρα').id }),
    view(ref: Record<string, Untyped>) {
      const message = store.get(ref.messageId);
      if (!message || message.deleted) return null;
      return { text: message.content, authorId: message.author.id, reactions: [...message.reacted] };
    },
    lastSent() {
      const payload = payloads.at(-1);
      return {
        text: payload.content ?? '',
        replyToId: payload.reply?.messageReference ?? null,
        attachments: (payload.files ?? []).map((file: Record<string, Untyped>) => file.name),
      };
    },
    timeoutNextSend() {
      failSend = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    },
    effects: () => [...store.values()].filter((message) => !message.deleted).length,
  };
}
