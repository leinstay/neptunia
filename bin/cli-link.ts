// The owner client's link to the core: the `cli` interface's hello and adapter on one transport, the chat of the
// chat, and the commands with their answers by `replyRef`. `openLinkOver` serves any transport, so the question bridge is
// tested over the real protocol without a socket. A question a command asks reaches `answers` with its prompt, whether it
// is secret and its choices, and the answer goes back once, as a dialog answer and never as an argument. bin/neptunia.ts
// opens it on the core's socket.

import { randomUUID } from 'node:crypto';
import type { Adapter, Capabilities, ChatInfo, Delivery, HistoryQuery, MessageEvent } from '../src/protocol/adapter.ts';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { CommandResult, Logger } from '../src/protocol/serve.ts';
import { TURN_EVENT_STATUS, readTurnEvent } from '../src/protocol/turn-control.ts';
import type { TurnEvent } from '../src/protocol/turn-control.ts';
import type { Transport } from '../src/protocol/wire.ts';
import { classifyAttachment } from '../src/media/classify.ts';
import type { Attachment } from '../src/protocol/actions.ts';
import { UnansweredQuestion, unansweredText } from './neptunia-request.ts';

/** The owner's command line: its client, its namespace and its one chat. */
export const CLI_CLIENT = 'cli';
/** What the command line is called, for `hello.names`: one place, the owner's chat, and no kinds of place. */
const CLI_NAMES = { interface: 'command line', nouns: {}, dm: 'chat' };

const CLI_IFACE = 'cli';
const OWNER_ID = 'owner';
const CHAT_ID = 'cli:dm:owner';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A parsed command. */
export type Command = { name: string; args: Record<string, unknown> };

/** One answer of a command, from the core or from the command line itself; `code` says why a refused one was refused. */
export type Answer = { text: string; status: string; code?: string };

/** What the core sent for one request: an answer, or a question to put to the owner (`ask`). */
type Reply = Answer & { ask?: CommandResult['ask'] };

/** Who answers a command's questions: a closed question comes with its `choices`, an open one with null. */
export type LinkAnswers = {
  ask(question: string, secret: boolean, choices: ReadonlyArray<string> | null): Promise<string>;
};

/** A staged image going with a line: `reference` is what the core's readers open (src/media/staging.ts). */
export type LineImage = { id: string; name: string; contentType: string; reference: string; size?: number };

/** What the command line declares to the core: it sends text, keeps images and answers who its one chat is. */
const CLI_CAPABILITIES: Capabilities = {
  operations: ['message.send', 'chat.typing'],
  maxChars: 100_000,
  maxFiles: 10,
  // One file of the socket's frame, as src/protocol/wire.ts sizes it.
  maxFileBytes: 10 * 1024 * 1024,
  edit: { ownOnly: true, windowMs: null },
  history: false,
  threads: false,
  reactions: false,
  customEmoji: false,
  presence: false,
  voiceFormats: [],
  publish: [],
  search: false,
  reads: ['chat.info', 'messages.history', 'messages.fetch'],
};

/** Takes her words for the screen, with the message id of the line they reply to, when they reply to one. */
export type Print = (text: string, replyTo?: string | null) => void;

/** How many lines of this session the chat keeps to answer the core's history reads. */
const TRANSCRIPT_LINES = 200;

/** The one chat of the command line: the direct chat between the owner and the persona. */
const CHAT_RECORD = { id: CHAT_ID, kind: 'dm', rootId: null, name: OWNER_ID, partnerId: OWNER_ID } as const;

const CHAT_INFO: ChatInfo = {
  ...CHAT_RECORD,
  iface: CLI_IFACE,
  permissions: { read: true, send: true, attach: true, react: false },
  owner: null,
  lastMessageAt: null,
  voice: false,
  public: false,
  audience: null,
};

const unsupported = (): Promise<{
  status: 'unsupported';
  error: { code: string; retryable: boolean; retryAfterMs: null };
}> => Promise.resolve({ status: 'unsupported', error: { code: 'unsupported', retryable: false, retryAfterMs: null } });

/**
 * The command line's adapter: a send of the chat prints its text with `print` and hands its files to `deliver` (none
 * when the client takes no replies), the chat it answers is the chat, and the chat's history is `transcript`, the
 * lines of this session. Everything else is unsupported.
 */
function cliAdapter(
  print: Print | null,
  deliver: ((file: Attachment) => Promise<void>) | null,
  transcript: Array<MessageEvent>
): Adapter {
  const inChat = (chat: { chatId: string }): boolean => chat.chatId === CHAT_ID;
  const effectRefused = { status: 'unsupported' as const, error: { code: 'unsupported', retryable: false } };
  return {
    iface: CLI_IFACE,
    capabilities: () => CLI_CAPABILITIES,
    async send(chat, content, options = {}): Promise<Delivery> {
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      const files = isObject(content) && Array.isArray(content.attachments) ? content.attachments : [];
      if (print === null || chat.chatId !== CHAT_ID || (files.length > 0 && deliver === null)) {
        const error = { code: 'unsupported', retryable: false, retryAfterMs: null };
        return { status: 'unsupported', ref: null, parts: [], at: null, idempotencyKey, error };
      }
      const text: unknown = isObject(content) ? content.text : null;
      const replyTo =
        isObject(content) && typeof content.replyTo?.messageId === 'string' ? content.replyTo.messageId : null;
      const ref = { iface: CLI_IFACE, chatId: CHAT_ID, messageId: randomUUID() };
      const at = Date.now();
      if (typeof text === 'string' && text !== '') {
        print(text, replyTo);
        keep(transcript, lineEvent(text, at, { id: ref.messageId, self: true, replyTo }));
      }
      for (const file of files) await deliver?.(file);
      return { status: 'ok', ref, parts: [ref], at, idempotencyKey, error: null };
    },
    edit: () => Promise.resolve(effectRefused),
    delete: () => Promise.resolve(effectRefused),
    react: () => Promise.resolve(effectRefused),
    unreact: () => Promise.resolve(effectRefused),
    typing: () => Promise.resolve({ status: 'ok' }),
    fetchMessages: (chat, messageIds) =>
      inChat(chat)
        ? Promise.resolve({
            status: 'ok',
            messages: messageIds.map((messageId) => {
              const event = transcript.find((line) => line.message.id === messageId);
              return event === undefined
                ? { messageId, missing: true }
                : { messageId, text: event.message.content ?? '', event };
            }),
          })
        : unsupported(),
    chatInfo: (chat) => (inChat(chat) ? Promise.resolve({ status: 'ok', chat: CHAT_INFO }) : unsupported()),
    chats: unsupported,
    history: (chat, query) =>
      inChat(chat)
        ? Promise.resolve({ status: 'ok', events: historyOf(transcript, query), complete: true })
        : unsupported(),
    memberInfo: unsupported,
    dmChatOf: unsupported,
    searchMessages: unsupported,
    searchMembers: unsupported,
    emoji: unsupported,
    parseLinks: unsupported,
    reactors: unsupported,
  };
}

/** Keeps `event` in the transcript, the oldest line going first past TRANSCRIPT_LINES. */
function keep(transcript: Array<MessageEvent>, event: MessageEvent): void {
  transcript.push(event);
  if (transcript.length > TRANSCRIPT_LINES) transcript.shift();
}

/** The newest `limit` lines of the transcript before `query.before`, oldest first. */
function historyOf(transcript: ReadonlyArray<MessageEvent>, query: HistoryQuery): Array<MessageEvent> {
  const found = query.before === undefined ? -1 : transcript.findIndex((line) => line.message.id === query.before);
  const upTo = found === -1 ? transcript.length : found;
  return transcript.slice(Math.max(0, upTo - Math.max(0, query.limit)), upTo);
}

/** A line of the chat as a `message.received` event: the owner's, or with `self` the persona's reply. */
function lineEvent(
  text: string,
  at: number,
  options: { id?: string; self?: boolean; images?: ReadonlyArray<LineImage>; replyTo?: string | null } = {}
): MessageEvent {
  const id = options.id ?? randomUUID();
  const self = options.self === true;
  return {
    kind: 'message.received',
    iface: CLI_IFACE,
    at,
    id: `${CLI_IFACE}:message:${id}`,
    chat: CHAT_RECORD,
    message: {
      id,
      author: self
        ? { id: 'self', name: null, self: true, bot: false }
        : { id: OWNER_ID, name: OWNER_ID, self: false, bot: false },
      content: text,
      sourceText: text,
      system: false,
      at,
      replyToId: options.replyTo ?? null,
      replyPingAccountId: null,
      forwardedFrom: null,
      // The fields the media collectors read (src/media/classify.ts), as an interface normalizes a platform's file.
      attachments: (options.images ?? []).map((image) => ({
        id: image.id,
        kind: classifyAttachment({ contentType: image.contentType, name: image.name }),
        url: image.reference,
        name: image.name,
        contentType: image.contentType,
        size: image.size ?? null,
        width: null,
        height: null,
        durationSec: null,
      })),
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

/** One command as the `command.requested` event of the owner, answered by the `command.result` naming `replyRef`. */
function commandEvent(
  command: { name: string; args: Record<string, unknown> },
  replyRef: string,
  dialog: { dialogId: string; answer: string } | null = null
): Record<string, unknown> {
  return {
    // The answer to a question the command asked is a field of its own, never an argument.
    ...(dialog === null ? {} : dialog),
    kind: 'command.requested',
    iface: CLI_IFACE,
    at: Date.now(),
    id: `${CLI_IFACE}:command:${replyRef}`,
    chat: CHAT_RECORD,
    name: command.name,
    args: command.args,
    requester: { id: OWNER_ID, name: OWNER_ID, roles: [], owner: true },
    replyRef,
  };
}

const quiet: Logger = { info() {}, warn() {}, error() {} };

/** The command line's link to the core: its events, and the answers of its commands by their `replyRef`. */
export type CliLink = {
  say(text: string, images?: ReadonlyArray<LineImage>): Promise<string>;
  /** Sends a line and waits for the end of the turn over it. */
  turn(text: string, images?: ReadonlyArray<LineImage>): Promise<Answer>;
  /** Replaces the lines the core's history reads answer from, with those of a resumed or branched chat. */
  showLines(
    lines: ReadonlyArray<{ id: string; at: number; who: string; text: string; nativeId?: string; replyToId?: string }>
  ): void;
  /** Sends a command; a question it asks goes to `answers`, and without them the command is refused. */
  ask(command: Command, answers?: LinkAnswers): Promise<Answer>;
  closed: Promise<void>;
  close(): void;
};

/** A turn event from a result's text to `onEvent`. Anything else in that place is dropped: it names no turn. */
function readEvent(text: string, onEvent: ((event: TurnEvent) => void) | null): void {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  const read = readTurnEvent(value);
  if (read.ok) onEvent?.(read.event);
}

/** The `cli` client on `transport`. `print` takes her replies and `deliver` her files, null or absent for none. */
export function openLinkOver(
  transport: Transport,
  {
    token,
    print,
    deliver = null,
    onTurnEvent = null,
    transcript = [],
  }: {
    token: string;
    print: Print | null;
    deliver?: ((file: Attachment) => Promise<void>) | null;
    /** What the core says of the turns, once this client subscribed with `turn.replay`. */
    onTurnEvent?: ((event: TurnEvent) => void) | null;
    /** The lines the core's history reads answer from. A reconnect hands the same array to the new link. */
    transcript?: Array<MessageEvent>;
  }
): CliLink {
  const waiting = new Map<string, (result: Reply) => void>();
  const closed = new Promise<void>((resolve) =>
    transport.onClose(() => {
      for (const resolveAnswer of waiting.values())
        resolveAnswer({ text: 'The link to the core closed.', status: 'failed' });
      waiting.clear();
      resolve();
    })
  );
  const served = serveAdapter({
    transport,
    hello: {
      iface: CLI_IFACE,
      self: { id: OWNER_ID, name: OWNER_ID },
      root: null,
      names: CLI_NAMES,
      capabilities: CLI_CAPABILITIES,
      resume: null,
    },
    token,
    adapter: cliAdapter(print, deliver, transcript),
    log: quiet,
    onCommandResult: (result: CommandResult) => {
      if (result.status === TURN_EVENT_STATUS) {
        readEvent(result.text, onTurnEvent);
        return;
      }
      const resolveAnswer = waiting.get(result.replyRef);
      waiting.delete(result.replyRef);
      resolveAnswer?.({
        text: result.text,
        status: result.status ?? 'ok',
        ...(result.code == null ? {} : { code: result.code }),
        ask: result.ask ?? null,
      });
    },
  });
  return {
    say(text, images = []) {
      const event = lineEvent(text, Date.now(), { images });
      keep(transcript, event);
      return served.emit(event);
    },
    async turn(text, images = []) {
      const event = lineEvent(text, Date.now(), { images });
      keep(transcript, event);
      const replyRef = event.message.id;
      const ended = new Promise<Reply>((resolve) => waiting.set(replyRef, resolve));
      const acked = await served.emit(event);
      if (acked === 'ok') return ended;
      waiting.delete(replyRef);
      return { text: `the core did not take the line (${acked})`, status: acked };
    },
    showLines(lines) {
      transcript.length = 0;
      for (const line of lines.slice(-TRANSCRIPT_LINES))
        transcript.push(
          lineEvent(line.text, line.at, {
            id: line.nativeId ?? line.id,
            self: line.who === 'her',
            replyTo: line.replyToId ?? null,
          })
        );
    },
    async ask(command, answers) {
      /** One request and the reply to it: a result, or a question. */
      async function send(dialog: { dialogId: string; answer: string } | null): Promise<Reply> {
        const replyRef = randomUUID();
        const reply = new Promise<Reply>((resolve) => waiting.set(replyRef, resolve));
        const acked = await served.emit(commandEvent(command, replyRef, dialog));
        if (acked === 'ok') return reply;
        waiting.delete(replyRef);
        return { text: `The core did not take the command (${acked}).`, status: acked, ask: null };
      }
      let reply = await send(null);
      while (reply.ask != null) {
        const { dialogId, prompt, secret, choices } = reply.ask;
        if (answers === undefined) return { text: unansweredText(prompt, secret), status: 'invalid' };
        let answer: string;
        try {
          answer = await answers.ask(prompt, secret, choices);
        } catch (err) {
          if (err instanceof UnansweredQuestion) return { text: err.message, status: 'invalid' };
          throw err;
        }
        reply = await send({ dialogId, answer });
      }
      return { text: reply.text, status: reply.status, ...(reply.code === undefined ? {} : { code: reply.code }) };
    },
    closed,
    close: () => served.close(),
  };
}
