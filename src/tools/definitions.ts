// The persona's skills, defined by a table of their own: one entry per operation of the ops
// registry (src/tools/impl/registry.ts), in the registry's order (that order drives the skills index,
// the family listing and the expansion of `*` in a grant). An entry holds what she sees (`name`,
// `params`, the JSON Schema of her arguments), how a call reaches the operation (`op`, `body`,
// `toArgs`), and what the operation costs and changes (`effects`, `costClass`, `feature`,
// `result`). Nothing here reads the owner's slash commands; `toArgs` maps her arguments to the
// operation's arguments by hand. Pure: no imports, no state.

const STRING_MAX = 6000;
const API_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const EFFECT_NAMES = Object.freeze(['read', 'write', 'destructive', 'administrative', 'paid']);
const COST_NAMES = Object.freeze(['free', 'paid']);
const RESULT_NAMES = Object.freeze(['effect', 'job', 'data']);
const REF_KINDS = Object.freeze(['channel', 'user', 'role']);

/** An object schema: `properties` in order, `required` names, nothing else allowed. */
export const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
/** A free string, 1 to `max` characters. */
export const str = (max = STRING_MAX) => ({ type: 'string', minLength: 1, maxLength: max });
/** One of `values`, as a string. */
export const oneOf = (values) => ({ type: 'string', minLength: 1, maxLength: STRING_MAX, enum: [...values] });
/** An integer, with the bounds given. */
export const int = (min, max) => ({
  type: 'integer',
  ...(Number.isFinite(min) ? { minimum: min } : {}),
  ...(Number.isFinite(max) ? { maximum: max } : {}),
});
/** A yes/no. */
export const bool = () => ({ type: 'boolean' });
/** An opaque reference (a member, a channel, a role) the server resolves to an id. */
export const ref = () => ({ type: 'string', minLength: 1, maxLength: 100 });

/** Her argument `name`, or null when she did not give it. */
export const val = (given, name) =>
  given && Object.hasOwn(given, name) && given[name] !== undefined ? given[name] : null;
/** Her argument `name` as an id string, or undefined when she did not give it. */
export const idOf = (given, name) => (val(given, name) === null ? undefined : String(val(given, name)));
/** A yes/no value as a boolean (`true`/`false` as a boolean or a string, any case), else null. */
export function flag(value) {
  if (typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'true' ? true : text === 'false' ? false : null;
}
/** Her argument `name`, or undefined when she did not give it. */
const opt = (given, name) => val(given, name) ?? undefined;

/**
 * The arguments of each `intent.*` skill: only the fields its operation reads (src/tools/impl/intent.ts).
 * `set` takes a new intention or attention; `update` the fields of an open one (`reason` goes with
 * `state: dropped`; nothing is required, since the id may also be the bare text, ops/intent.js#idOf);
 * `cancel` the id alone; `list` nothing.
 */
export const INTENT_PARAMS = Object.freeze({
  set: obj({
    text: str(300),
    due: str(40),
    every: str(10),
    expires: str(40),
    task: str(20),
    deadline: str(40),
    chain: str(64),
    condition: str(300),
    channel: ref(),
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
    task: str(20),
    deadline: str(40),
    chain: str(64),
    condition: str(300),
    channel: ref(),
    people: str(500),
    settle: int(0, 86400),
    perday: int(1, 1000),
  }),
  cancel: obj({ id: str(20) }, ['id']),
  list: obj({}),
});

/** The operation's arguments for an `intent.*` call with `action`: what she gave, nothing else. */
export function intentArgs(action) {
  return (a) => {
    const out = { action };
    for (const name of [
      'text',
      'id',
      'due',
      'every',
      'expires',
      'task',
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
    const channelId = idOf(a, 'channel');
    const attend = idOf(a, 'attend');
    return { ...out, ...(channelId ? { channelId } : {}), ...(attend ? { attend } : {}) };
  };
}

/** The name each skill has in a tool-calling API (letters, digits, `_`, `-`; up to 64), one per skill. */
export const API_NAMES = Object.freeze({
  'status.show': 'status_show',
  'config.set': 'config_set',
  'config.unset': 'config_unset',
  'bot.pause': 'bot_pause',
  'bot.resume': 'bot_resume',
  'draw.create': 'draw_create',
  'voice.say': 'voice_say',
  'pings.get': 'pings_get',
  'pings.set': 'pings_set',
  'media.status': 'media_status',
  'media.rescan': 'media_rescan',
  'media.recache': 'media_recache',
  'model.show': 'model_show',
  'model.set': 'model_set',
  'route.list': 'route_list',
  'route.set': 'route_set',
  'route.remove': 'route_remove',
  'rule.add': 'rule_add',
  'rule.list': 'rule_list',
  'rule.remove': 'rule_remove',
  'access.grant': 'access_grant',
  'access.revoke': 'access_revoke',
  'access.list': 'access_list',
  'alias.add': 'alias_add',
  'alias.remove': 'alias_remove',
  'learning.add': 'learning_add',
  'learning.remove': 'learning_remove',
  'lore.add': 'lore_add',
  'lore.list': 'lore_list',
  'lore.show': 'lore_show',
  'lore.remove': 'lore_remove',
  'memory.profile.read': 'memory_profile_read',
  'memory.channel.read': 'memory_channel_read',
  'memory.server.read': 'memory_server_read',
  'memory.recent.read': 'memory_recent_read',
  'memory.affinity.read': 'memory_affinity_read',
  'memory.journal.read': 'memory_journal_read',
  'memory.archive.read': 'memory_archive_read',
  'memory.restore': 'memory_restore',
  'memory.snapshot': 'memory_snapshot',
  'memory.private.read': 'memory_private_read',
  'message.create': 'message_create',
  'message.edit': 'message_edit',
  'message.delete': 'message_delete',
  'message.react.add': 'message_react_add',
  'message.react.remove': 'message_react_remove',
  'task.run': 'task_run',
  'task.status': 'task_status',
  'task.cancel': 'task_cancel',
  'task.list': 'task_list',
  'task.read': 'task_read',
  'task.resolve': 'task_resolve',
  'intent.set': 'intent_set',
  'intent.update': 'intent_update',
  'intent.cancel': 'intent_cancel',
  'intent.list': 'intent_list',
  'places.list': 'places_list',
  'skills.describe': 'skills_describe',
  'inner.stop': 'inner_stop',
  'inner.start': 'inner_start',
  'inner.status': 'inner_status',
  'web.search': 'web_search',
  'web.read': 'web_read',
  'media.look': 'media_look',
  'media.find': 'media_find',
  'memory.search': 'memory_search',
  'conversation.read': 'conversation_read',
});

const NO_REFS = Object.freeze({});
const JOBS = Object.freeze(['task.run', 'media.recache']);
const ROUTE_ROLES = ['core', 'analyzer', 'vision', 'video', 'embedding', 'speech', 'drawing'];
const MEDIA_PARAMS = (kinds) => obj({ kind: oneOf(kinds) }, ['kind']);
const ACCESS_PARAMS = () => obj({ command: str(), role: ref(), user: ref() }, ['command']);
const REACT_PARAMS = () => obj({ message: str(), emoji: str(100), channel: ref() }, ['message', 'emoji']);
const USER_ONLY = () => obj({ user: ref() }, ['user']);
const EMPTY = () => obj({});

/** One entry: the table row with the fields every row shares worked out from `effects` and the name. */
function def(name, { params, refs = NO_REFS, body = null, effects, feature = null, toArgs }) {
  return {
    name,
    api: API_NAMES[name],
    op: name,
    params,
    refs,
    body,
    effects,
    costClass: effects === 'paid' ? 'paid' : 'free',
    feature,
    result: JOBS.includes(name) ? 'job' : effects === 'read' ? 'data' : 'effect',
    toArgs,
  };
}

const mediaArgs = (action) => (a) => ({
  kind: val(a, 'kind'),
  action,
  ...(val(a, 'days') == null ? {} : { days: val(a, 'days') }),
});
const accessArgs = (a) => ({ command: val(a, 'command'), roleId: idOf(a, 'role'), userId: idOf(a, 'user') });
const reactArgs = (action) => (a) => ({
  action,
  messageId: val(a, 'message'),
  emoji: val(a, 'emoji'),
  channelId: idOf(a, 'channel'),
});
const taskStatusArgs = (action) => (a) => ({ id: opt(a, 'id'), action, from: opt(a, 'from') });
// A member the operation needs: no member, no call.
const forMember = (build) => (a) => {
  const userId = idOf(a, 'user');
  return userId === undefined ? null : build(userId, a);
};
const none = () => ({});

const ENTRIES = [
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
      part: oneOf(['overview', 'limits', 'models', 'memory', 'inner', 'errands', 'features', 'all']),
    }),
    effects: 'read',
    toArgs: (a) => ({ field: val(a, 'field') ?? null, ...(val(a, 'part') ? { part: val(a, 'part') } : {}) }),
  }),
  def('config.set', {
    params: obj({ path: str(), value: str() }, ['path', 'value']),
    effects: 'administrative',
    toArgs: (a) => ({ path: val(a, 'path'), value: val(a, 'value') }),
  }),
  def('config.unset', {
    params: obj({ path: str() }, ['path']),
    effects: 'administrative',
    toArgs: (a) => ({ path: val(a, 'path') }),
  }),
  def('bot.pause', { params: EMPTY(), effects: 'administrative', toArgs: none }),
  def('bot.resume', { params: EMPTY(), effects: 'administrative', toArgs: none }),
  def('draw.create', {
    params: obj({ text: str(), self: bool(), reply: ref(), channel: ref() }, ['text']),
    refs: { channel: 'channel' },
    body: 'text',
    effects: 'paid',
    toArgs: (a) => {
      const channelId = idOf(a, 'channel');
      const replyTo = opt(a, 'reply');
      return {
        text: val(a, 'text'),
        self: flag(val(a, 'self')) ?? false,
        ...(channelId ? { channelId } : {}),
        ...(replyTo === undefined ? {} : { replyTo }),
      };
    },
  }),
  def('voice.say', {
    params: obj({ text: str(1500), channel: ref(), reply: str() }, ['text']),
    refs: { channel: 'channel' },
    body: 'text',
    effects: 'paid',
    feature: 'speech',
    toArgs: (a) => {
      const channelId = idOf(a, 'channel');
      const replyTo = opt(a, 'reply');
      return {
        text: val(a, 'text'),
        ...(channelId ? { channelId } : {}),
        ...(replyTo === undefined ? {} : { replyTo }),
      };
    },
  }),
  def('pings.get', { params: EMPTY(), effects: 'read', toArgs: () => ({ mode: undefined }) }),
  def('pings.set', {
    params: obj({ mode: oneOf(['on', 'off']) }, ['mode']),
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
    params: obj({ number: int(1) }, ['number']),
    effects: 'destructive',
    toArgs: (a) => ({ number: val(a, 'number') }),
  }),
  def('access.grant', {
    params: ACCESS_PARAMS(),
    refs: { 'role': 'role', user: 'user' },
    effects: 'administrative',
    toArgs: accessArgs,
  }),
  def('access.revoke', {
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
    toArgs: forMember((userId, a) => ({ userId, name: val(a, 'name') })),
  }),
  def('alias.remove', {
    params: obj({ user: ref(), name: str() }, ['user', 'name']),
    refs: { user: 'user' },
    effects: 'destructive',
    toArgs: forMember((userId, a) => ({ userId, name: val(a, 'name') })),
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
    toArgs: forMember((userId, a) => ({
      userId,
      section: opt(a, 'section'),
      limit: opt(a, 'limit'),
      order: opt(a, 'order'),
    })),
  }),
  def('memory.channel.read', {
    params: obj({ channel: ref() }),
    refs: { channel: 'channel' },
    effects: 'read',
    toArgs: (a) => ({ channelId: idOf(a, 'channel') }),
  }),
  def('memory.server.read', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('memory.recent.read', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('memory.affinity.read', {
    params: USER_ONLY(),
    refs: { user: 'user' },
    effects: 'read',
    toArgs: forMember((userId) => ({ userId })),
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
    toArgs: (a) => ({ userId: idOf(a, 'user'), kind: opt(a, 'kind'), n: opt(a, 'n') }),
  }),
  def('memory.restore', {
    params: obj({ id: str() }, ['id']),
    effects: 'destructive',
    toArgs: (a) => ({ itemId: val(a, 'id') }),
  }),
  def('memory.snapshot', { params: EMPTY(), effects: 'write', toArgs: none }),
  def('memory.private.read', {
    params: USER_ONLY(),
    refs: { user: 'user' },
    effects: 'read',
    toArgs: forMember((userId) => ({ userId })),
  }),
  def('message.create', {
    params: obj(
      {
        channel: ref(),
        reply: str(),
        text: str(2000),
        file: str(300),
        gif: str(40),
        media: str(300),
        item: int(1, 20),
      },
      []
    ),
    refs: { channel: 'channel' },
    body: 'text',
    effects: 'write',
    toArgs: (a) => ({
      channelId: idOf(a, 'channel'),
      replyTo: opt(a, 'reply'),
      text: opt(a, 'text'),
      file: opt(a, 'file'),
      gif: opt(a, 'gif'),
      media: opt(a, 'media'),
      item: opt(a, 'item'),
    }),
  }),
  def('message.edit', {
    params: obj({ message: str(), text: str(2000), channel: ref() }, ['message', 'text']),
    refs: { channel: 'channel' },
    body: 'text',
    effects: 'write',
    toArgs: (a) => ({ messageId: val(a, 'message'), text: val(a, 'text'), channelId: idOf(a, 'channel') }),
  }),
  def('message.delete', {
    params: obj({ message: str(), channel: ref() }, ['message']),
    refs: { channel: 'channel' },
    effects: 'destructive',
    toArgs: (a) => ({ messageId: val(a, 'message'), channelId: idOf(a, 'channel') }),
  }),
  def('message.react.add', {
    params: REACT_PARAMS(),
    refs: { channel: 'channel' },
    effects: 'write',
    toArgs: reactArgs('add'),
  }),
  def('message.react.remove', {
    params: REACT_PARAMS(),
    refs: { channel: 'channel' },
    effects: 'write',
    toArgs: reactArgs('remove'),
  }),
  def('task.run', {
    params: obj({ agent: oneOf(['scout', 'server']), goal: str(2000) }, ['agent', 'goal']),
    body: 'goal',
    effects: 'paid',
    toArgs: (a) => ({ agent: val(a, 'agent'), goal: val(a, 'goal') }),
  }),
  def('task.status', { params: obj({ id: str() }), effects: 'read', toArgs: taskStatusArgs(undefined) }),
  def('task.cancel', {
    params: obj({ id: str() }, ['id']),
    effects: 'write',
    toArgs: (a) => ({ id: val(a, 'id') }),
  }),
  def('task.list', { params: EMPTY(), effects: 'read', toArgs: none }),
  def('task.read', {
    params: obj({ id: str(), from: int(0, 10000000) }, ['id']),
    effects: 'read',
    toArgs: taskStatusArgs('read'),
  }),
  def('task.resolve', { params: obj({ id: str() }, ['id']), effects: 'write', toArgs: taskStatusArgs('resolve') }),
  def('intent.set', {
    params: INTENT_PARAMS.set,
    refs: { channel: 'channel', attend: 'channel' },
    body: 'text',
    effects: 'write',
    feature: 'intentions',
    toArgs: intentArgs('add'),
  }),
  def('intent.update', {
    params: INTENT_PARAMS.update,
    refs: { channel: 'channel' },
    body: 'text',
    effects: 'write',
    feature: 'intentions',
    toArgs: intentArgs('update'),
  }),
  def('intent.cancel', {
    params: INTENT_PARAMS.cancel,
    body: 'id',
    effects: 'write',
    feature: 'intentions',
    toArgs: intentArgs('cancel'),
  }),
  def('intent.list', {
    params: INTENT_PARAMS.list,
    effects: 'read',
    feature: 'intentions',
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
  def('skills.describe', {
    params: obj({ name: str(60) }, ['name']),
    body: 'name',
    effects: 'read',
    toArgs: (a) => ({ name: val(a, 'name') }),
  }),
  def('inner.stop', {
    params: EMPTY(),
    effects: 'administrative',
    feature: 'innerLife',
    toArgs: () => ({ action: 'stop' }),
  }),
  def('inner.start', {
    params: EMPTY(),
    effects: 'administrative',
    feature: 'innerLife',
    toArgs: () => ({ action: 'start' }),
  }),
  def('inner.status', { params: EMPTY(), effects: 'read', feature: 'innerLife', toArgs: () => ({ action: 'status' }) }),
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
    feature: 'coreTools',
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
    feature: 'coreTools',
    toArgs: (a) => ({ query: val(a, 'query'), ...(val(a, 'n') == null ? {} : { n: val(a, 'n') }) }),
  }),
  def('memory.search', {
    params: obj({
      question: str(500),
      people: str(200),
      channel: ref(),
      when: str(40),
      terms: str(300),
      anchor: str(200),
      move: oneOf(['up', 'down']),
      messages: int(1, 60),
      minutes: int(1, 1440),
    }),
    refs: { channel: 'channel' },
    body: 'question',
    effects: 'read',
    toArgs: (a) => ({
      question: opt(a, 'question'),
      people: opt(a, 'people'),
      channelId: idOf(a, 'channel'),
      when: opt(a, 'when'),
      terms: opt(a, 'terms'),
      // The window read's arguments ride along only when she gave them.
      ...Object.fromEntries(
        ['anchor', 'move', 'messages', 'minutes']
          .filter((name) => val(a, name) !== null)
          .map((name) => [name, val(a, name)])
      ),
    }),
  }),
  def('conversation.read', {
    params: obj({
      channel: ref(),
      around: str(200),
      before: str(200),
      after: str(200),
      since: str(40),
      last: int(1, 60),
    }),
    refs: { channel: 'channel' },
    effects: 'read',
    toArgs: (a) => {
      const out = {};
      for (const name of ['around', 'before', 'after', 'since']) {
        const value = val(a, name);
        if (value !== null) out[name] = value;
      }
      const channelId = idOf(a, 'channel');
      return {
        ...out,
        ...(channelId ? { channelId } : {}),
        ...(val(a, 'last') == null ? {} : { last: val(a, 'last') }),
      };
    },
  }),
];

/**
 * Checks a list of definitions; throws on the first problem (a programming error, found at
 * start): a missing or repeated name, a missing or repeated or ill-formed API name, an unknown
 * effect, cost class or result, a body that is not a string argument, a reference that is not
 * an argument or has an unknown kind, a feature that is not a name, a missing `params` or `toArgs`.
 * @param {object[]} [definitions]
 * @returns {object[]} the same list
 */
export function validateDefinitions(definitions = SKILL_DEFINITIONS) {
  if (!Array.isArray(definitions)) throw new Error('skill definitions must be a list');
  const names = new Set();
  const apis = new Set();
  for (const definition of definitions) {
    const name = definition?.name;
    if (typeof name !== 'string' || !name) throw new Error('a skill definition needs a name');
    if (names.has(name)) throw new Error(`skill defined twice: ${name}`);
    names.add(name);
    const { api, params } = definition;
    if (typeof api !== 'string' || !API_NAME.test(api))
      throw new Error(`skill ${name}: api name must match ${API_NAME}`);
    if (apis.has(api)) throw new Error(`skill ${name}: api name ${api} is used twice`);
    apis.add(api);
    if (typeof definition.op !== 'string' || !definition.op) throw new Error(`skill ${name}: op is required`);
    if (!params || params.type !== 'object' || typeof params.properties !== 'object' || !Array.isArray(params.required))
      throw new Error(`skill ${name}: params must be an object schema`);
    if (!EFFECT_NAMES.includes(definition.effects))
      throw new Error(`skill ${name}: effects must be one of ${EFFECT_NAMES.join(', ')}`);
    if (!COST_NAMES.includes(definition.costClass)) throw new Error(`skill ${name}: costClass must be free or paid`);
    if (!RESULT_NAMES.includes(definition.result))
      throw new Error(`skill ${name}: result must be one of ${RESULT_NAMES.join(', ')}`);
    if (definition.body !== null && params.properties[definition.body]?.type !== 'string')
      throw new Error(`skill ${name}: body must be null or a string argument`);
    for (const [argument, kind] of Object.entries(definition.refs ?? {})) {
      if (!Object.hasOwn(params.properties, argument))
        throw new Error(`skill ${name}: ref ${argument} is not an argument`);
      if (!REF_KINDS.includes(kind)) throw new Error(`skill ${name}: ref ${argument} has an unknown kind ${kind}`);
    }
    for (const required of params.required)
      if (!Object.hasOwn(params.properties, required))
        throw new Error(`skill ${name}: required ${required} is not an argument`);
    if (definition.feature !== null && (typeof definition.feature !== 'string' || !definition.feature))
      throw new Error(`skill ${name}: feature must be null or a name`);
    if (typeof definition.toArgs !== 'function') throw new Error(`skill ${name}: toArgs is required`);
  }
  return definitions;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** Every skill, one per operation, in the operations registry's order. */
export const SKILL_DEFINITIONS = deepFreeze(validateDefinitions(ENTRIES));

/** The API name of skill `name`, or null. */
export function apiNameOf(name) {
  return Object.hasOwn(API_NAMES, name) ? API_NAMES[name] : null;
}

/** The skill whose API name is `api`, or null. */
export function skillNameOfApi(api) {
  for (const [name, candidate] of Object.entries(API_NAMES)) if (candidate === api) return name;
  return null;
}

/** The arguments of a definition as `{ name, kind }` in order: `string`, `integer`, `boolean`, or the kind of reference. */
export function optionsOfDefinition(definition) {
  return Object.entries(definition.params.properties).map(([name, schema]) => ({
    name,
    kind: definition.refs?.[name] ?? schema.type,
  }));
}
