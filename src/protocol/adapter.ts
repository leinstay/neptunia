// The contract between the core and one chat platform, as types: what an adapter can do, what it
// reports back, and what it declares it can handle. No platform concept appears here, so an adapter
// for any platform fits. `deliveryOf` folds the results of a split send into one `Delivery`.

import type { Content, PortResult } from './actions.js';

export type ConversationRef = { iface: string; conversationId: string };

export type MessageRef = {
  iface: string;
  conversationId: string;
  messageId: string;
  memberId?: string;
};

// `cause` is the platform's own error, kept for the logs and never shown to the model.
export type PortError = { code: string; retryable: boolean; retryAfterMs: number | null; cause?: unknown };

export type Delivery = {
  status: 'ok' | 'failed' | 'unknown' | 'unsupported' | 'forbidden';
  // The first part, for callers that track one message.
  ref: MessageRef | null;
  // Every platform message posted for this send.
  parts: ReadonlyArray<MessageRef>;
  at: number | null;
  idempotencyKey: string;
  error: PortError | null;
};

export type Capabilities = {
  operations: ReadonlyArray<string>;
  maxChars: number;
  maxFiles: number;
  maxFileBytes: number;
  edit: { ownOnly: boolean; windowMs: number | null };
  history: boolean;
  threads: boolean;
  reactions: boolean;
  customEmoji: boolean;
  presence: boolean;
  voiceFormats: ReadonlyArray<string>;
  publish: ReadonlyArray<string>;
  search: boolean;
};

// What `fetchMessages` returns is settled with the action that reads messages; until then only the
// messages found are named.
export type FetchedMessages = {
  messages: ReadonlyArray<{ ref: MessageRef; text: string; at: number }>;
};

export type Adapter = {
  iface: string;
  send(conversation: ConversationRef, content: Content): Promise<Delivery>;
  edit(message: MessageRef, content: Content): Promise<PortResult>;
  delete(message: MessageRef): Promise<PortResult>;
  react(message: MessageRef, emoji: string): Promise<PortResult>;
  unreact(message: MessageRef, emoji: string): Promise<PortResult>;
  typing(conversation: ConversationRef, lease: { untilMs: number }): Promise<PortResult>;
  fetchMessages(conversation: ConversationRef, messageIds: ReadonlyArray<string>): Promise<FetchedMessages>;
  capabilities(): Capabilities;
};

const portErrorOf = (error: PortResult['error']): PortError | null =>
  error === undefined
    ? null
    : {
        code: error.code,
        retryable: error.retryable,
        retryAfterMs: null,
        ...(error.cause !== undefined ? { cause: error.cause } : {}),
      };

// A first part that fails is the whole send's status and nothing was posted. A later part that
// fails leaves the earlier ones on the platform, so the outcome is `unknown` and the posted parts
// stay in the result for the caller to find.
export function deliveryOf(parts: ReadonlyArray<PortResult>, idempotencyKey: string): Delivery {
  const first = parts[0];
  if (first === undefined) {
    const error = { code: 'no-parts', retryable: false, retryAfterMs: null };
    return { status: 'failed', ref: null, parts: [], at: null, idempotencyKey, error };
  }
  if (first.status !== 'ok') {
    const error = portErrorOf(first.error);
    return { status: first.status, ref: null, parts: [], at: null, idempotencyKey, error };
  }
  const posted: Array<MessageRef> = [];
  for (const part of parts) {
    if (part.status !== 'ok') {
      const error = portErrorOf(part.error);
      const at = first.at ?? null;
      return { status: 'unknown', ref: posted[0] ?? null, parts: posted, at, idempotencyKey, error };
    }
    const ref = part.ref;
    if (ref?.messageId !== undefined) posted.push({ ...ref, messageId: ref.messageId });
  }
  return {
    status: 'ok',
    ref: posted[0] ?? null,
    parts: posted,
    at: first.at ?? null,
    idempotencyKey,
    error: null,
  };
}
