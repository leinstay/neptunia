// The persona's skills, defined by a table of their own: one entry per operation of the ops
// registry (src/tools/operations/registry.ts), in the registry's order (that order drives the skills index,
// the family listing and the expansion of `*` in a grant). An entry holds what she sees (`name`,
// `params`, the JSON Schema of her arguments), how a call reaches the operation (`op`, `body`,
// `toArgs`), and what the operation costs and changes (`effects`, `costClass`, `result`). Nothing here reads the owner's slash commands; `toArgs` maps her arguments to the
// operation's arguments by hand. A row also declares the tool's traits once (`traits`), and every list
// of tools a module reads is derived from them (`toolsWith`, `hasTrait`); its API name is its name with `_` for `.`.
// Pure: no state.

import { idText, isObj, objOf } from './types.ts';
import type { Obj } from './types.ts';

const STRING_MAX = 6000;
const API_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * What a tool does to the world, from the mildest: `read` (changes nothing), `write` (adds or changes something that
 * can be changed back), `destructive` (deletes or overwrites what cannot simply be put back), `administrative` (changes
 * how the bot is run or who may do what), `paid` (spends balance). A paid tool needs its budget, a destructive one has
 * a cooldown per channel (src/tools/gateway.ts).
 */
export const EFFECT_CLASSES = Object.freeze(['read', 'write', 'destructive', 'administrative', 'paid'] as const);

/** One of the effect classes. */
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/**
 * What a tool is besides its effect, each trait read by the modules named:
 * `self`, one of her own expressive operations or her own state, run on her grant alone whoever asked
 * (src/tools/gateway.ts, src/tools/executors.ts, src/admin.ts);
 * `carried`, behind one of her reply tags, allowed in the current chat without a grant (src/tools/access.ts);
 * `ungrantable`, irreversible or administrative, opened to her by no grant (src/tools/access.ts);
 * `posts`, leaves a line of hers where people read (src/turn/skill-calls.ts, src/behavior/sandbox.ts);
 * `attaches`, posts a file, so it reaches `message.create` inside its operation (src/tools/access.ts);
 * `here`, acts in the turn's own chat when its `place` is left out (src/turn/skill-calls.ts);
 * `written`, its `text` is her own writing, rendered as a `<msg>` of hers is (src/tools/executors.ts);
 * `publishes`, refused where the turn's publication boundary forbids posting (src/tools/executors.ts).
 */
export const TRAITS = Object.freeze([
  'self',
  'carried',
  'ungrantable',
  'posts',
  'attaches',
  'here',
  'written',
  'publishes',
] as const);

/** One of the traits. */
export type Trait = (typeof TRAITS)[number];

const COST_NAMES: ReadonlyArray<string> = Object.freeze(['free', 'paid']);
const RESULT_NAMES: ReadonlyArray<string> = Object.freeze(['effect', 'job', 'data']);
const REF_KINDS: ReadonlyArray<string> = Object.freeze(['place', 'user', 'role']);

/** The JSON Schema of an argument, in the few keywords src/tools/schema.ts reads. */
export type Schema = {
  type: string;
  properties?: Record<string, Schema>;
  required?: ReadonlyArray<string>;
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: ReadonlyArray<string>;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
};

/** Her arguments by name, as the model sent them. */
export type Given = Record<string, unknown> | null | undefined;

/** The operation's arguments for her `given`, or null when they map to nothing. */
export type ToArgs = (given: Given) => Obj | null;

/** What a reference argument names: a place, a member or a role the interface resolves to an id. */
export type RefKind = 'place' | 'user' | 'role';

/** One skill as the table defines it. */
export type Definition = {
  name: string;
  /** Its name in a tool-calling API. */
  api: string;
  op: string;
  params: Schema;
  refs: Readonly<Record<string, RefKind>>;
  /** The string argument her call may carry as its text, or null. */
  body: string | null;
  effects: EffectClass;
  costClass: 'free' | 'paid';
  result: 'effect' | 'job' | 'data';
  traits: ReadonlyArray<Trait>;
  toArgs: ToArgs;
};

/** An object schema: `properties` in order, `required` names, nothing else allowed. */
export const obj = (properties: Record<string, Schema>, required: ReadonlyArray<string> = []): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
/** A free string, 1 to `max` characters. */
export const str = (max: number = STRING_MAX): Schema => ({ type: 'string', minLength: 1, maxLength: max });
/** One of `values`, as a string. */
export const oneOf = (values: ReadonlyArray<string>): Schema => ({
  type: 'string',
  minLength: 1,
  maxLength: STRING_MAX,
  enum: [...values],
});
/** A list of free strings, each 1 to `itemMax` characters, at most `maxItems` of them. */
export const strings = (itemMax: number, maxItems: number): Schema => ({
  type: 'array',
  items: str(itemMax),
  maxItems,
});
/** An integer, with the bounds given. */
export const int = (min?: number, max?: number): Schema => ({
  type: 'integer',
  ...(Number.isFinite(min) ? { minimum: min } : {}),
  ...(Number.isFinite(max) ? { maximum: max } : {}),
});
/** A yes/no. */
export const bool = (): Schema => ({ type: 'boolean' });
/** An opaque reference (a member, a place, a role) the interface resolves to an id. */
export const ref = (): Schema => ({ type: 'string', minLength: 1, maxLength: 100 });

/** Her argument `name`, or null when she did not give it. */
export const val = (given: Given, name: string): unknown =>
  given && Object.hasOwn(given, name) && given[name] !== undefined ? given[name] : null;
/** Her argument `name` as an id string, or undefined when she did not give it. */
export const idOf = (given: Given, name: string): string | undefined =>
  val(given, name) === null ? undefined : idText(val(given, name));
/** A yes/no value as a boolean (`true`/`false` as a boolean or a string, any case), else null. */
export function flag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'true' ? true : text === 'false' ? false : null;
}
/** Her argument `name`, or undefined when she did not give it. */
const opt = (given: Given, name: string): unknown => val(given, name) ?? undefined;

/**
 * The arguments of each `intention.*` skill: only the fields its operation reads (src/tools/operations/intention.ts).
 * `set` takes a new intention or attention; `update` the fields of an open one (`reason` goes with
 * `state: dropped`; nothing is required, since the id may also be the bare text, src/tools/operations/intention.ts#idOf);
 * `cancel` the id alone; `list` nothing.
 */
export const INTENT_PARAMS = Object.freeze({
  set: obj({
    text: str(300),
    due: str(40),
    every: str(10),
    standing: str(5),
    expires: str(40),
    errand: str(20),
    deadline: str(40),
    chain: str(64),
    condition: str(300),
    place: ref(),
    attend: ref(),
    people: str(500),
    settle: int(0, 86400),
    perday: int(1, 1000),
    // A desire she considered and let go, recorded as born dropped (the handler takes only `dropped` here).
    state: oneOf(['dropped']),
    reason: str(300),
  }),
  update: obj({
    id: str(20),
    text: str(300),
    state: oneOf(['pending', 'done', 'dropped']),
    reason: str(300),
    due: str(40),
    every: str(10),
    expires: str(40),
    errand: str(20),
    deadline: str(40),
    chain: str(64),
    condition: str(300),
    place: ref(),
    people: str(500),
    settle: int(0, 86400),
    perday: int(1, 1000),
  }),
  cancel: obj({ id: str(20) }, ['id']),
  list: obj({}),
});

/** The operation's arguments for an `intention.*` call with `action`: what she gave, nothing else. */
export function intentArgs(action: string): ToArgs {
  return (a) => {
    const out: Obj = { action };
    for (const name of [
      'text',
      'id',
      'due',
      'every',
      'expires',
      'errand',
      'deadline',
      'state',
      'chain',
      'condition',
      'people',
      'reason',
    ]) {
      const value = val(a, name);
      if (value !== null) out[name] = value;
    }
    for (const name of ['settle', 'perday']) {
      const value = val(a, name);
      if (value !== null) out[name] = value;
    }
    const placeId = idOf(a, 'place');
    const attend = idOf(a, 'attend');
    return { ...out, ...(placeId ? { placeId } : {}), ...(attend ? { attend } : {}) };
  };
}

const NO_REFS: Readonly<Record<string, RefKind>> = Object.freeze({});
const JOBS: ReadonlyArray<string> = Object.freeze(['errand.run', 'media.recache']);
const ROUTE_ROLES = ['core', 'analyzer', 'vision', 'video', 'embedding', 'speech', 'drawing'];
const MEDIA_PARAMS = (kinds: ReadonlyArray<string>): Schema => obj({ kind: oneOf(kinds) }, ['kind']);
const ACCESS_PARAMS = () => obj({ command: str(), role: ref(), user: ref() }, ['command']);
const REACT_PARAMS = () => obj({ message: str(), emoji: str(100), place: ref() }, ['message', 'emoji']);
const USER_ONLY = () => obj({ user: ref() }, ['user']);
const EMPTY = () => obj({});

/** What a row of the table says; `def` works out the rest. */
type Row = {
  params: Schema;
  refs?: Readonly<Record<string, RefKind>>;
  body?: string | null;
  effects: EffectClass;
  traits?: ReadonlyArray<Trait>;
  toArgs: ToArgs;
};

/** One entry: the table row with the fields every row shares worked out from `effects` and the name. */
function def(name: string, { params, refs = NO_REFS, body = null, effects, traits = [], toArgs }: Row): Definition {
  return {
    name,
    api: name.replaceAll('.', '_'),
    op: name,
    params,
    refs,
    body,
    effects,
    costClass: effects === 'paid' ? 'paid' : 'free',
    result: JOBS.includes(name) ? 'job' : effects === 'read' ? 'data' : 'effect',
    traits,
    toArgs,
  };
}

const mediaArgs =
  (action: string): ToArgs =>
  (a) => ({
    kind: val(a, 'kind'),
    action,
    ...(val(a, 'days') == null ? {} : { days: val(a, 'days') }),
  });
const accessArgs: ToArgs = (a) => ({ command: val(a, 'command'), roleId: idOf(a, 'role'), accountId: idOf(a, 'user') });
const reactArgs =
  (action: string): ToArgs =>
  (a) => ({
    action,
    messageId: val(a, 'message'),
    emoji: val(a, 'emoji'),
    placeId: idOf(a, 'place'),
  });
const taskStatusArgs =
  (action: string | undefined): ToArgs =>
  (a) => ({ id: opt(a, 'id'), action, from: opt(a, 'from') });
// A member the operation needs: no member, no call.
const forMember =
  (build: (accountId: string, given: Given) => Obj): ToArgs =>
  (a) => {
    const accountId = idOf(a, 'user');
    return accountId === undefined ? null : build(accountId, a);
  };
const none = () => ({});

const ENTRIES: Array<Definition> = [
  def('status.show', {
    params: obj({
      field: oneOf([
        'state',
        'tasks',
        'models.base',
        'keys.base',
        'costs.base',
        'models.errands',
        'costs.errands',
        'models.development',
        'costs.development',
        'inner',
        'limits',
        'memory',
        'speed',
      ]),
      part: oneOf(['overview', 'limits', 'models', 'memory', 'inner', 'errands', 'all']),
    }),
    effects: 'read',
    toArgs: (a) => ({ field: val(a, 'field') ?? null, ...(val(a, 'part') ? { part: val(a, 'part') } : {}) }),
  }),
  def('config.set', {
    traits: ['ungrantable'],
    params: obj({ path: str(), value: str() }, ['path', 'value']),
    effects: 'administrative',
    toArgs: (a) => ({ path: val(a, 'path'), value: val(a, 'value') }),
  }),
  def('config.unset', {
    traits: ['ungrantable'],
    params: obj({ path: str() }, ['path']),
    effects: 'administrative',
    toArgs: (a) => ({ path: val(a, 'path') }),
  }),
  def('bot.pause', { traits: ['ungrantable'], params: EMPTY(), effects: 'administrative', toArgs: none }),
  def('bot.resume', { traits: ['ungrantable'], params: EMPTY(), effects: 'administrative', toArgs: none }),
  def('draw.create', {
    traits: ['self', 'carried', 'posts', 'attaches', 'here', 'publishes'],
    params: obj({ text: str(), self: bool(), reply: ref(), place: ref() }, ['text']),
    refs: { place: 'place' },
    body: 'text',
    effects: 'paid',
    toArgs: (a) => {
      const placeId = idOf(a, 'place');
      const replyTo = opt(a, 'reply');
      return {
        text: val(a, 'text'),
        self: flag(val(a, 'self')) ?? false,
        ...(placeId ? { placeId } : {}),
        ...(replyTo === undefined ? {} : { replyTo }),
      };
    },
  }),
  def('voice.say', {
    traits: ['self', 'carried', 'posts', 'attaches', 'here', 'publishes'],
    params: obj({ text: str(1500), place: ref(), reply: str() }, ['text']),
    refs: { place: 'place' },
    body: 'text',
    effects: 'paid',
    toArgs: (a) => {
      const placeId = idOf(a, 'place');
      const replyTo = opt(a, 'reply');
      return {
        text: val(a, 'text'),
        ...(placeId ? { placeId } : {}),
        ...(replyTo === undefined ? {} : { replyTo }),
      };
    },
  }),
  def('pings.get', { params: EMPTY(), effects: 'read', toArgs: () => ({ mode: undefined }) }),
  def('pings.set', {
    params: obj({ mode: oneOf(['on', 'off', 'clear']) }, ['mode']),
    effects: 'write',
    toArgs: (a) => ({ mode: opt(a, 'mode') }),
  }),
  def('media.status', { params: MEDIA_PARAMS(['emoji', 'gifs']), effects: 'read', toArgs: mediaArgs('status') }),
  def('media.rescan', { params: MEDIA_PARAMS(['emoji', 'gifs']), effects: 'write', toArgs: mediaArgs('rescan') }),
  def('media.recache', {
    params: obj({ kind: oneOf(['gifs', 'pictures']), days: int(1, 60) }, ['kind']),
    effects: 'write',
    toArgs: mediaArgs('recache'),
  }),
  def('model.show', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('model.set', {
    traits: ['ungrantable'],
    params: obj(
      {
        role: oneOf([
          'core',
          'analyzer',
          'vision',
          'video',
          'embedding',
          'speech',
          'drawing',
          'scout',
          'server',
          'thinker',
          'dev',
        ]),
        id: str(),
      },
      ['role', 'id']
    ),
    effects: 'administrative',
    toArgs: (a) => ({ role: val(a, 'role'), id: val(a, 'id') }),
  }),
  def('route.list', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('route.set', {
    traits: ['ungrantable'],
    params: obj({ model: str(), providers: str(), role: oneOf(ROUTE_ROLES), fallbacks: bool(), byok: bool() }, [
      'model',
      'providers',
    ]),
    effects: 'administrative',
    toArgs: (a) => ({
      model: val(a, 'model'),
      providers: val(a, 'providers'),
      role: opt(a, 'role'),
      fallbacks: flag(val(a, 'fallbacks')) ?? undefined,
      byok: flag(val(a, 'byok')) ?? undefined,
    }),
  }),
  def('route.remove', {
    traits: ['ungrantable'],
    params: obj({ model: str(), role: oneOf(ROUTE_ROLES) }, ['model']),
    effects: 'administrative',
    toArgs: (a) => ({ model: val(a, 'model'), role: opt(a, 'role') }),
  }),
  def('rule.add', {
    params: obj({ text: str() }, ['text']),
    body: 'text',
    effects: 'write',
    toArgs: (a) => ({ text: val(a, 'text') }),
  }),
  def('rule.list', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('rule.remove', {
    traits: ['ungrantable'],
    params: obj({ number: int(1) }, ['number']),
    effects: 'destructive',
    toArgs: (a) => ({ number: val(a, 'number') }),
  }),
  def('access.grant', {
    traits: ['ungrantable'],
    params: ACCESS_PARAMS(),
    refs: { 'role': 'role', user: 'user' },
    effects: 'administrative',
    toArgs: accessArgs,
  }),
  def('access.revoke', {
    traits: ['ungrantable'],
    params: ACCESS_PARAMS(),
    refs: { 'role': 'role', user: 'user' },
    effects: 'administrative',
    toArgs: accessArgs,
  }),
  def('access.list', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('alias.add', {
    params: obj({ user: ref(), name: str() }, ['user', 'name']),
    refs: { user: 'user' },
    effects: 'write',
    toArgs: forMember((accountId, a) => ({ accountId, name: val(a, 'name') })),
  }),
  def('alias.remove', {
    params: obj({ user: ref(), name: str() }, ['user', 'name']),
    refs: { user: 'user' },
    effects: 'destructive',
    toArgs: forMember((accountId, a) => ({ accountId, name: val(a, 'name') })),
  }),
  def('learning.add', {
    params: obj({ text: str() }, ['text']),
    body: 'text',
    effects: 'write',
    toArgs: (a) => ({ text: val(a, 'text') }),
  }),
  def('learning.remove', {
    params: obj({ number: int(1) }, ['number']),
    effects: 'destructive',
    toArgs: (a) => ({ id: val(a, 'number') }),
  }),
  def('lore.add', {
    params: obj({ title: str(), keys: str(), text: str(), always: bool() }, ['title', 'keys', 'text']),
    body: 'text',
    effects: 'write',
    toArgs: (a) => ({
      title: val(a, 'title'),
      keys: val(a, 'keys'),
      text: val(a, 'text'),
      always: flag(val(a, 'always')) ?? false,
    }),
  }),
  def('lore.list', {
    params: obj({ query: str() }),
    effects: 'read',
    toArgs: (a) => ({ query: opt(a, 'query') }),
  }),
  def('lore.show', {
    params: obj({ id: str() }, ['id']),
    effects: 'read',
    toArgs: (a) => ({ id: val(a, 'id') }),
  }),
  def('lore.remove', {
    params: obj({ id: str() }, ['id']),
    effects: 'destructive',
    toArgs: (a) => ({ id: val(a, 'id') }),
  }),
  def('memory.profile.read', {
    params: obj(
      {
        user: ref(),
        section: oneOf([
          'summary',
          'character',
          'style',
          'relationship',
          'affinity',
          'aliases',
          'interests',
          'details',
          'episodes',
          'raw',
        ]),
        limit: int(1, 100),
        order: oneOf(['rank', 'recent']),
      },
      ['user']
    ),
    refs: { user: 'user' },
    effects: 'read',
    toArgs: forMember((accountId, a) => ({
      accountId,
      section: opt(a, 'section'),
      limit: opt(a, 'limit'),
      order: opt(a, 'order'),
    })),
  }),
  def('memory.channel.read', {
    traits: ['here'],
    params: obj({ place: ref() }),
    refs: { place: 'place' },
    effects: 'read',
    toArgs: (a) => ({ placeId: idOf(a, 'place') }),
  }),
  def('memory.server.read', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('memory.recent.read', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('memory.affinity.read', {
    params: USER_ONLY(),
    refs: { user: 'user' },
    effects: 'read',
    toArgs: forMember((accountId) => ({ accountId })),
  }),
  def('memory.journal.read', {
    params: obj({
      day: str(),
      kind: oneOf(['turn', 'action', 'memory', 'system', 'answer', 'inner', 'all']),
      n: int(1, 50),
      message: str(),
    }),
    effects: 'read',
    toArgs: (a) => ({ day: opt(a, 'day'), kind: opt(a, 'kind'), n: opt(a, 'n'), messageId: opt(a, 'message') }),
  }),
  def('memory.archive.read', {
    params: obj({ user: ref(), kind: str(), n: int(1, 100) }),
    refs: { user: 'user' },
    effects: 'read',
    toArgs: (a) => ({ accountId: idOf(a, 'user'), kind: opt(a, 'kind'), n: opt(a, 'n') }),
  }),
  def('memory.restore', {
    traits: ['ungrantable'],
    params: obj({ id: str() }, ['id']),
    effects: 'destructive',
    toArgs: (a) => ({ itemId: val(a, 'id') }),
  }),
  def('memory.snapshot', { params: EMPTY(), effects: 'write', toArgs: none }),
  def('memory.private.read', {
    params: USER_ONLY(),
    refs: { user: 'user' },
    effects: 'read',
    toArgs: forMember((accountId) => ({ accountId })),
  }),
  def('message.create', {
    traits: ['self', 'carried', 'posts', 'here', 'written', 'publishes'],
    params: obj(
      {
        place: ref(),
        reply: str(),
        text: str(2000),
        file: str(300),
        gif: str(40),
        media: str(300),
        item: int(1, 20),
      },
      []
    ),
    refs: { place: 'place' },
    body: 'text',
    effects: 'write',
    toArgs: (a) => ({
      placeId: idOf(a, 'place'),
      replyTo: opt(a, 'reply'),
      text: opt(a, 'text'),
      file: opt(a, 'file'),
      gif: opt(a, 'gif'),
      media: opt(a, 'media'),
      item: opt(a, 'item'),
    }),
  }),
  def('message.edit', {
    traits: ['self', 'here', 'written', 'publishes'],
    params: obj({ message: str(), text: str(2000), place: ref() }, ['message', 'text']),
    refs: { place: 'place' },
    body: 'text',
    effects: 'write',
    toArgs: (a) => ({ messageId: val(a, 'message'), text: val(a, 'text'), placeId: idOf(a, 'place') }),
  }),
  def('message.delete', {
    traits: ['self', 'here'],
    params: obj({ message: str(), place: ref() }, ['message']),
    refs: { place: 'place' },
    effects: 'destructive',
    toArgs: (a) => ({ messageId: val(a, 'message'), placeId: idOf(a, 'place') }),
  }),
  def('message.react.add', {
    traits: ['self', 'carried', 'here', 'publishes'],
    params: REACT_PARAMS(),
    refs: { place: 'place' },
    effects: 'write',
    toArgs: reactArgs('add'),
  }),
  def('message.react.remove', {
    traits: ['self', 'here'],
    params: REACT_PARAMS(),
    refs: { place: 'place' },
    effects: 'write',
    toArgs: reactArgs('remove'),
  }),
  def('errand.run', {
    params: obj({ agent: oneOf(['scout', 'server']), goal: str(2000) }, ['agent', 'goal']),
    body: 'goal',
    effects: 'paid',
    toArgs: (a) => ({ agent: val(a, 'agent'), goal: val(a, 'goal') }),
  }),
  def('errand.status', { params: obj({ id: str() }), effects: 'read', toArgs: taskStatusArgs(undefined) }),
  def('errand.cancel', {
    params: obj({ id: str() }, ['id']),
    effects: 'write',
    toArgs: (a) => ({ id: val(a, 'id') }),
  }),
  def('errand.list', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('errand.read', {
    params: obj({ id: str(), from: int(0, 10000000) }, ['id']),
    effects: 'read',
    toArgs: taskStatusArgs('read'),
  }),
  def('errand.resolve', { params: obj({ id: str() }, ['id']), effects: 'write', toArgs: taskStatusArgs('resolve') }),
  def('task.propose', {
    params: obj(
      {
        title: str(200),
        evidence: str(4000),
        acceptance: str(2000),
        kind: oneOf(['skill', 'fix']),
        examples: strings(300, 8),
        counterexamples: strings(300, 8),
        benefit: str(600),
        evaluation: str(600),
      },
      ['title', 'evidence']
    ),
    body: 'evidence',
    effects: 'write',
    toArgs: (a) => ({
      title: val(a, 'title'),
      evidence: val(a, 'evidence'),
      acceptance: val(a, 'acceptance'),
      // The proposal's kind and the fields that go with it ride along only when she gave them.
      ...Object.fromEntries(
        ['kind', 'examples', 'counterexamples', 'benefit', 'evaluation']
          .filter((name) => val(a, name) !== null)
          .map((name) => [name, val(a, name)])
      ),
    }),
  }),
  def('task.status', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('task.cancel', {
    params: obj({ id: str(), reason: str(600) }, ['id', 'reason']),
    effects: 'write',
    toArgs: (a) => ({ id: val(a, 'id'), reason: val(a, 'reason') }),
  }),
  def('task.comment', {
    params: obj({ id: str(), text: str(2000) }, ['id', 'text']),
    body: 'text',
    effects: 'write',
    toArgs: (a) => ({ id: val(a, 'id'), text: val(a, 'text') }),
  }),
  def('task.answer', {
    params: obj({ id: str(), text: str(2000) }, ['id', 'text']),
    body: 'text',
    effects: 'write',
    toArgs: (a) => ({ id: val(a, 'id'), text: val(a, 'text') }),
  }),
  def('task.unblock', {
    params: obj({ id: str(), note: str(2000) }, ['id', 'note']),
    body: 'note',
    effects: 'write',
    toArgs: (a) => ({ id: val(a, 'id'), note: val(a, 'note') }),
  }),
  def('skill.read', {
    traits: ['self'],
    params: obj({ name: str(60) }, ['name']),
    body: 'name',
    effects: 'read',
    toArgs: (a) => ({ name: val(a, 'name') }),
  }),
  def('skill.run', {
    traits: ['self'],
    params: obj({ name: str(60), script: str(60), args: str(8000) }, ['name', 'script']),
    effects: 'write',
    toArgs: (a) => ({ name: val(a, 'name'), script: val(a, 'script'), args: opt(a, 'args') }),
  }),
  def('skill.disable', {
    traits: ['self'],
    params: obj({ name: str(60) }, ['name']),
    body: 'name',
    effects: 'write',
    toArgs: (a) => ({ name: val(a, 'name') }),
  }),
  def('watcher.read', {
    params: obj({ day: str(10), run: str(80) }),
    effects: 'read',
    toArgs: (a) => ({ day: opt(a, 'day'), run: opt(a, 'run') }),
  }),
  def('intention.set', {
    traits: ['self'],
    params: INTENT_PARAMS.set,
    refs: { place: 'place', attend: 'place' },
    body: 'text',
    effects: 'write',
    toArgs: intentArgs('add'),
  }),
  def('intention.update', {
    traits: ['self'],
    params: INTENT_PARAMS.update,
    refs: { place: 'place' },
    body: 'text',
    effects: 'write',
    toArgs: intentArgs('update'),
  }),
  def('intention.cancel', {
    traits: ['self'],
    params: INTENT_PARAMS.cancel,
    body: 'id',
    effects: 'write',
    toArgs: intentArgs('cancel'),
  }),
  def('intention.list', {
    traits: ['self'],
    params: INTENT_PARAMS.list,
    effects: 'read',
    toArgs: intentArgs('list'),
  }),
  def('places.list', {
    params: obj({ filter: str(100), sort: str(10), page: int(1, 1000) }),
    body: 'filter',
    effects: 'read',
    toArgs: (a) => ({
      filter: opt(a, 'filter'),
      sort: opt(a, 'sort'),
      ...(val(a, 'page') == null ? {} : { page: val(a, 'page') }),
    }),
  }),
  def('tools.describe', {
    params: obj({ name: str(60) }, ['name']),
    body: 'name',
    effects: 'read',
    toArgs: (a) => ({ name: val(a, 'name') }),
  }),
  def('inner.status', { params: EMPTY(), effects: 'read', toArgs: () => ({ action: 'status' }) }),
  def('web.search', {
    params: obj({ query: str(200), goal: str(300) }, ['query']),
    body: 'query',
    effects: 'read',
    toArgs: (a) => ({ query: val(a, 'query'), goal: opt(a, 'goal') }),
  }),
  def('web.read', {
    params: obj({ url: str(2000), message: str(100) }),
    body: 'url',
    effects: 'read',
    toArgs: (a) => ({ url: opt(a, 'url'), message: opt(a, 'message') }),
  }),
  def('media.look', {
    params: obj({ message: str(200), url: str(2000), question: str(500), item: int(1, 20) }, ['question']),
    body: 'question',
    effects: 'read',
    toArgs: (a) => ({
      message: opt(a, 'message'),
      url: opt(a, 'url'),
      question: val(a, 'question'),
      ...(val(a, 'item') == null ? {} : { item: val(a, 'item') }),
    }),
  }),
  def('media.find', {
    params: obj({ query: str(200), n: int(1, 10) }, ['query']),
    body: 'query',
    effects: 'read',
    toArgs: (a) => ({ query: val(a, 'query'), ...(val(a, 'n') == null ? {} : { n: val(a, 'n') }) }),
  }),
  def('memory.search', {
    params: obj({
      question: str(500),
      people: str(200),
      place: ref(),
      when: str(40),
      terms: str(300),
      anchor: str(200),
      move: oneOf(['up', 'down']),
      messages: int(1, 60),
      minutes: int(1, 1440),
      entity: str(200),
      predicate: str(100),
      as_of: str(40),
      historical: bool(),
    }),
    refs: { place: 'place' },
    body: 'question',
    effects: 'read',
    toArgs: (a) => ({
      question: opt(a, 'question'),
      people: opt(a, 'people'),
      placeId: idOf(a, 'place'),
      when: opt(a, 'when'),
      terms: opt(a, 'terms'),
      // The window read's arguments ride along only when she gave them.
      ...Object.fromEntries(
        ['anchor', 'move', 'messages', 'minutes']
          .filter((name) => val(a, name) !== null)
          .map((name) => [name, val(a, name)])
      ),
      // The filters of the stored facts, the same way.
      ...(val(a, 'entity') === null ? {} : { entity: val(a, 'entity') }),
      ...(val(a, 'predicate') === null ? {} : { predicate: val(a, 'predicate') }),
      ...(val(a, 'as_of') === null ? {} : { asOf: val(a, 'as_of') }),
      ...(val(a, 'historical') === null ? {} : { historical: val(a, 'historical') }),
    }),
  }),
  def('conversation.read', {
    traits: ['here'],
    params: obj({
      place: ref(),
      around: str(200),
      before: str(200),
      after: str(200),
      since: str(40),
      last: int(1, 60),
      person: str(200),
    }),
    refs: { place: 'place' },
    effects: 'read',
    toArgs: (a) => {
      const out: Obj = {};
      for (const name of ['around', 'before', 'after', 'since', 'person']) {
        const value = val(a, name);
        if (value !== null) out[name] = value;
      }
      const placeId = idOf(a, 'place');
      return {
        ...out,
        ...(placeId ? { placeId } : {}),
        ...(val(a, 'last') == null ? {} : { last: val(a, 'last') }),
      };
    },
  }),
  def('person.link', {
    params: obj({ person: str(200) }, ['person']),
    effects: 'write',
    toArgs: (a) => ({ person: val(a, 'person') }),
  }),
];

function checkIdentity(definition: Obj, names: Set<string>, apis: Set<string>): string {
  const name = definition.name;
  if (typeof name !== 'string' || !name) throw new Error('a skill definition needs a name');
  if (names.has(name)) throw new Error(`skill defined twice: ${name}`);
  names.add(name);
  const { api } = definition;
  if (typeof api !== 'string' || !API_NAME.test(api))
    throw new Error(`skill ${name}: api name must match ${String(API_NAME)}`);
  if (apis.has(api)) throw new Error(`skill ${name}: api name ${api} is used twice`);
  apis.add(api);
  if (typeof definition.op !== 'string' || !definition.op) throw new Error(`skill ${name}: op is required`);
  return name;
}

/** The arguments a definition's `params` schema holds, and which of them are required. */
function checkSchema(name: string, definition: Obj): { properties: Obj; required: Array<unknown> } {
  const schema = objOf(definition.params);
  const properties = objOf(schema.properties);
  const required = Array.isArray(schema.required) ? (schema.required as Array<unknown>) : null;
  if (!isObj(definition.params) || schema.type !== 'object' || !isObj(schema.properties) || required === null)
    throw new Error(`skill ${name}: params must be an object schema`);
  return { properties, required };
}

function checkKinds(name: string, definition: Obj): void {
  if (!(EFFECT_CLASSES as ReadonlyArray<unknown>).includes(definition.effects))
    throw new Error(`skill ${name}: effects must be one of ${EFFECT_CLASSES.join(', ')}`);
  if (typeof definition.costClass !== 'string' || !COST_NAMES.includes(definition.costClass))
    throw new Error(`skill ${name}: costClass must be free or paid`);
  if (typeof definition.result !== 'string' || !RESULT_NAMES.includes(definition.result))
    throw new Error(`skill ${name}: result must be one of ${RESULT_NAMES.join(', ')}`);
  const traits: unknown = definition.traits;
  if (!Array.isArray(traits)) throw new Error(`skill ${name}: traits must be a list`);
  for (const [i, trait] of (traits as Array<unknown>).entries()) {
    if (!(TRAITS as ReadonlyArray<unknown>).includes(trait))
      throw new Error(`skill ${name}: unknown trait ${String(trait)}`);
    if ((traits as Array<unknown>).indexOf(trait) !== i) throw new Error(`skill ${name}: trait ${String(trait)} twice`);
  }
}

function checkArguments(name: string, definition: Obj, properties: Obj, required: ReadonlyArray<unknown>): void {
  if (
    definition.body !== null &&
    objOf(typeof definition.body === 'string' ? properties[definition.body] : null).type !== 'string'
  )
    throw new Error(`skill ${name}: body must be null or a string argument`);
  for (const [argument, kind] of Object.entries(objOf(definition.refs))) {
    if (!Object.hasOwn(properties, argument)) throw new Error(`skill ${name}: ref ${argument} is not an argument`);
    if (typeof kind !== 'string' || !REF_KINDS.includes(kind))
      throw new Error(`skill ${name}: ref ${argument} has an unknown kind ${String(kind)}`);
  }
  for (const entry of required)
    if (typeof entry !== 'string' || !Object.hasOwn(properties, entry))
      throw new Error(`skill ${name}: required ${String(entry)} is not an argument`);
}

/**
 * Checks a list of definitions; throws on the first problem (a programming error, found at
 * start): a missing or repeated name, a missing or repeated or ill-formed API name, an unknown
 * effect, cost class or result, a trait list that is not one or holds an unknown or repeated trait, a body that is not a string argument, a reference that is not
 * an argument or has an unknown kind, a missing `params` or `toArgs`.
 */
export function validateDefinitions(
  definitions: ReadonlyArray<unknown> = SKILL_DEFINITIONS
): ReadonlyArray<Definition> {
  if (!Array.isArray(definitions)) throw new Error('skill definitions must be a list');
  const names = new Set<string>();
  const apis = new Set<string>();
  for (const candidate of definitions) {
    const definition = objOf(candidate);
    const name = checkIdentity(definition, names, apis);
    const { properties, required } = checkSchema(name, definition);
    checkKinds(name, definition);
    checkArguments(name, definition, properties, required);
    if (typeof definition.toArgs !== 'function') throw new Error(`skill ${name}: toArgs is required`);
  }
  // Every entry passed the checks above, which are the whole of the `Definition` type.
  return definitions as ReadonlyArray<Definition>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** Every skill, one per operation, in the operations registry's order. */
export const SKILL_DEFINITIONS: ReadonlyArray<Definition> = deepFreeze(validateDefinitions(ENTRIES));

const BY_NAME: ReadonlyMap<string, Definition> = new Map(
  SKILL_DEFINITIONS.map((definition) => [definition.name, definition])
);
const BY_API: ReadonlyMap<string, string> = new Map(
  SKILL_DEFINITIONS.map((definition) => [definition.api, definition.name])
);

/** The API name of skill `name`, or null. */
export function apiNameOf(name: string): string | null {
  return BY_NAME.get(name)?.api ?? null;
}

/** The effect class skill `name` declares, or null. */
export function effectsOf(name: string): EffectClass | null {
  return BY_NAME.get(name)?.effects ?? null;
}

/** The names of the tools with `trait`, in the table's order. */
export function toolsWith(trait: Trait): ReadonlyArray<string> {
  return Object.freeze(
    SKILL_DEFINITIONS.filter((definition) => definition.traits.includes(trait)).map((definition) => definition.name)
  );
}

/** Whether tool `name` has `trait`; false for a name no tool has. */
export function hasTrait(name: string, trait: Trait): boolean {
  return BY_NAME.get(name)?.traits.includes(trait) ?? false;
}

/** The tools whose names changed, old to new: a journal written before the rename names them by the old one. The call path never reads it: a tool written under an old name is `unknown-skill`. */
export const RENAMED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  'skills.describe': 'tools.describe',
  'task.run': 'errand.run',
  'task.status': 'errand.status',
  'task.read': 'errand.read',
  'task.resolve': 'errand.resolve',
  'task.cancel': 'errand.cancel',
  'task.list': 'errand.list',
  'intent.set': 'intention.set',
  'intent.update': 'intention.update',
  'intent.cancel': 'intention.cancel',
  'intent.list': 'intention.list',
});

/** `name` as the tool is called now: a renamed tool's old name gives the new one, anything else comes back as it is. */
export function currentToolName<T>(name: T): T | string {
  return typeof name === 'string' && Object.hasOwn(RENAMED_TOOLS, name) ? (RENAMED_TOOLS[name] ?? name) : name;
}

/** The skill whose API name is `api`, or null. */
export function skillNameOfApi(api: unknown): string | null {
  return typeof api === 'string' ? (BY_API.get(api) ?? null) : null;
}

/** The arguments of a definition as `{ name, kind }` in order: `string`, `integer`, `boolean`, or the kind of reference. */
export function optionsOfDefinition(definition: Definition): Array<{ name: string; kind: string }> {
  return Object.entries(definition.params.properties ?? {}).map(([name, schema]) => ({
    name,
    kind: definition.refs[name] ?? schema.type,
  }));
}
