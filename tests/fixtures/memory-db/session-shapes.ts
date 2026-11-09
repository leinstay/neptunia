// The shapes the memory session tests write their fixtures with: a scope, the arguments of a stored line and claim, the
// script and the recorded calls of the fake llm, and the options of the context a sweep takes.

export type Scope = { scope_kind: string; scope_iface: string | null; scope_dm: string | null };
import type { KeyRing } from '../../../src/keys/ring.ts';
import type { Db, MemoryHandle } from '../../../src/memory/db/types.ts';

export type Rec = Record<string, unknown>;

export type LlmCall = {
  messages: Array<{ role?: string; content: unknown }>;
  options: { role: string; purpose: string; model: string };
};
export type LlmScript =
  | string
  | Error
  | Array<string | Error>
  | ((messages: LlmCall['messages'], options: unknown, n: number) => string | Error);

export type SayArgs = {
  native: string;
  minutesAgo: number;
  text: string;
  author?: string;
  kind?: string;
  direct?: number;
  place?: string;
  scope?: Scope;
  revision?: number;
};
export type ClaimArgs = {
  id: string;
  subjectKind?: string;
  subjectId: string;
  kind?: string;
  text: string;
  scope?: Scope;
  truth?: string;
  shown?: number;
};
export type CtxOptions = {
  llm?: { calls: Array<LlmCall>; complete(messages: LlmCall['messages'], options: LlmCall['options']): Promise<unknown> };
  config?: Rec;
  promptSet?: Rec;
  /** The key ring the session checks its key on; null for none. */
  ring?: KeyRing | null;
  write?: (update: unknown) => Promise<unknown>;
};

export type Fixture = {
  handle: MemoryHandle;
  db: Db;
  group: Scope;
  say(args: SayArgs): string;
  claim(args: ClaimArgs): void;
  storeDmPlace(member: string): void;
  done(): void;
};
export type FakeLlm = {
  calls: Array<LlmCall>;
  complete(messages: LlmCall['messages'], options: LlmCall['options']): Promise<{ text: unknown; usage: Rec }>;
};
