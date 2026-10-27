// The shapes the tools share: a record read from a config, a result or a model's arguments, and the small functions that
// narrow an `unknown` to one without a cast. Every module of src/tools/ reads untrusted data (the persona's arguments, the
// owner's config, a label file) through these, so a wrong shape is an empty value and never an exception.

import type { Env } from './impl/env.ts';
import type { EffectClass } from './impl/effects.ts';
import type { Given, Schema } from './definitions.ts';

/**
 * A subsystem that is still JavaScript (the store, the journal, the language model client and the like): its shape is not
 * written down until its module moves to TypeScript, so the operations read it without a type.
 */
export type Untyped = ReturnType<typeof JSON.parse>;

/** A record of unknown values: what a config section, a result or the model's arguments are before they are read. */
export type Obj = Record<string, unknown>;

/** Whether `value` is a plain record: an object that is not null and not an array. */
export function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` as a record, or an empty one when it is not a record. */
export function objOf(value: unknown): Obj {
  return isObj(value) ? value : {};
}

/** `value` as a list, or an empty one when it is not a list. */
export function listOf(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : [];
}

/** `value` when it is a string, else the empty string. */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** What an operation declares about who may run it (src/tools/impl/registry.ts#defineOp). */
export type Rights = {
  kind: 'read' | 'write';
  /** No grant ever opens it: only an owner runs it. */
  ownerOnly?: boolean;
  /** `false`: only an owner runs it, unless `member` opens it to every member. */
  grantable?: boolean;
  /** Open to every member while `features.memberCommands` is on. */
  member?: boolean;
};

/** An operation as a rights check and a grant see it: its name and its rights. */
export type OpInfo = { name: string; rights: Rights };

/** A grant of one operation: who it opens it for, and (`via`) the group or `*` each target came from. */
export type GrantEntry = {
  everyone: boolean;
  roles: Array<unknown>;
  users: Array<unknown>;
  via: Record<string, unknown>;
};

/** The one thing a grant adds or takes away: everyone, one role or one user. */
export type GrantTarget = { everyone?: boolean; roleId?: string | number; userId?: string | number };

/** The stored grants (`bot.access`): an operation name to its grant, as the config file holds them. */
export type Access = Record<string, unknown>;

/** Whether `value` is a finite number (a number that is not NaN or infinite). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Whether `value` is a finite number above zero. */
export function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The `code` of a thrown value when it is a string (a system error, an error of ours), else null. */
export function errorCode(error: unknown): string | null {
  const code = objOf(error).code;
  return typeof code === 'string' ? code : null;
}

/** An id as text: a string or a number, nothing else (an object or a missing value is the empty string). */
export function idText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/**
 * The context an operation runs in, as `runOp` hands it: the environment, who asked and where, and what the persona's own
 * calls add (`actor`, `ownInitiative`, the lines of her turn). Every field is optional but `env`; a caller may carry more
 * than these.
 */
export type OpContext = {
  env: Env;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  roleIds?: ReadonlyArray<string>;
  /** `persona` for her own call, else the kind of caller (`owner`, `member`). */
  actor?: string;
  privateChat?: boolean;
  mentionUserIds?: ReadonlyArray<string>;
  ownInitiative?: boolean;
  wakeKind?: string;
  [key: string]: unknown;
};

/** The skills' own check of a call before its arguments are looked at, and the refusal a wake envelope gives. */
export type SkillVerdict = { allowed: boolean; reason: string; detail?: string };

/** How her call reaches the operation of a skill: the options her arguments are read by, and `toOp`, which maps them. */
export type Dispatch = Readonly<{
  op: string;
  body: string | null;
  options: ReadonlyArray<Readonly<{ name: string; kind: string }>>;
  toOp(given: Given): { op: string; args: Obj | null };
}>;

/** One skill of the registry (src/tools/registry.ts): a definition with the `kind` and `ownerOnly` of its operation. */
export type Skill = Readonly<{
  name: string;
  family: string;
  op: string | null;
  kind: 'read' | 'write';
  ownerOnly: boolean;
  argsSchema: Schema;
  effects: EffectClass;
  sharedState: boolean;
  costClass: 'free' | 'paid';
  targets: string | null;
  interfaceCapability: string | null;
  api?: string;
  feature?: string | null;
  result?: 'effect' | 'job' | 'data';
  opBacked?: true;
  dispatch?: Dispatch;
}>;

/** The skills by name. */
export type SkillMap = Map<string, Skill>;

/** A skill with the wording the owner's tool texts give it (`title`, `whenToUse`, `whenNotToUse`), each empty when missing. */
export type DescribedSkill = Skill & { title: string; whenToUse: string; whenNotToUse: string };
