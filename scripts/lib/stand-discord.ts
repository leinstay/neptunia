// The platform of the replay stand (scripts/replay-stand.ts): Discord's REST API answered from a fixture through
// undici's global dispatcher, which discord.js's REST manager and Node's `fetch` both send through. A GET of a route the
// fixture holds answers its JSON, any other Discord request answers 404, and a request to any other host fails as a
// refused connection, so a run of the stand reaches no network.

/** The REST fixture of one server: its bot user, the server, its channels and members, each channel's messages. */
export type StandDiscord = {
  self: Record<string, unknown>;
  guild: Record<string, unknown>;
  channels: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  messages: Record<string, Array<Record<string, unknown>>>;
};

type Answer = { status: number; body: unknown };

/**
 * The keys of the global dispatcher: the first the npm undici of discord.js reads, the second Node's own `fetch`, which
 * puts a wrapper of the second under the first when it starts.
 */
const GLOBAL_DISPATCHERS = [Symbol.for('undici.globalDispatcher.1'), Symbol.for('undici.globalDispatcher.2')];

const API = /^\/api\/v\d+(\/.*)$/;

/** The order of two snowflakes. */
const byId = (a: unknown, b: unknown): number => {
  const x = BigInt(String(a));
  const y = BigInt(String(b));
  return x < y ? -1 : x > y ? 1 : 0;
};

/** A page of a channel's messages as Discord answers `GET /channels/:id/messages`: newest first. */
function messagePage(all: ReadonlyArray<Record<string, unknown>>, query: URLSearchParams): Array<unknown> {
  const limit = Math.min(100, Number(query.get('limit') ?? 50));
  const sorted = [...all].sort((a, b) => byId(a.id, b.id));
  const before = query.get('before');
  const after = query.get('after');
  const around = query.get('around');
  let page: Array<Record<string, unknown>>;
  if (after !== null) page = sorted.filter((m) => byId(m.id, after) > 0).slice(0, limit);
  else if (around !== null) {
    const at = sorted.findIndex((m) => byId(m.id, around) >= 0);
    const start = Math.max(0, (at < 0 ? sorted.length : at) - Math.floor(limit / 2));
    page = sorted.slice(start, start + limit);
  } else {
    const held = before === null ? sorted : sorted.filter((m) => byId(m.id, before) < 0);
    page = held.slice(Math.max(0, held.length - limit));
  }
  return page.reverse();
}

/** The member of the fixture whose user id is `id`, or null. */
const memberOf = (fixture: StandDiscord, id: string | undefined) =>
  fixture.members.find((one) => (one.user as { id: string }).id === id) ?? null;

/** The answer to a route under `users/`. */
function userRoute(fixture: StandDiscord, [id, sub]: Array<string | undefined>): unknown {
  if (id === '@me' && sub === undefined) return fixture.self;
  if (id === '@me' && sub === 'guilds')
    return [
      { id: fixture.guild.id, name: fixture.guild.name, icon: null, owner: false, permissions: '0', features: [] },
    ];
  return sub === undefined ? (memberOf(fixture, id)?.user ?? null) : null;
}

/** The answer to a route under `guilds/<the server>/`. */
function guildRoute(fixture: StandDiscord, [sub, subId]: Array<string | undefined>): unknown {
  if (sub === undefined) return fixture.guild;
  if (sub === 'channels') return fixture.channels;
  if (sub === 'roles') return fixture.guild.roles;
  if (sub === 'emojis' || sub === 'stickers') return [];
  if (sub !== 'members') return null;
  if (subId === undefined) return fixture.members;
  return memberOf(fixture, subId === '@me' ? String(fixture.self.id) : subId);
}

/** The answer to a route under `channels/`: a channel, a page of its messages, or one message. */
function channelRoute(fixture: StandDiscord, rest: Array<string | undefined>, query: URLSearchParams): unknown {
  const [id, sub, subId] = rest;
  const channel = fixture.channels.find((one) => one.id === id);
  if (channel === undefined || (sub !== undefined && sub !== 'messages') || rest.length > 3) return null;
  if (sub === undefined) return channel;
  const all = fixture.messages[String(id)] ?? [];
  return subId === undefined ? messagePage(all, query) : (all.find((one) => one.id === subId) ?? null);
}

/** The answer of the fixture to `GET <route>`, null for a route it does not hold. */
function answerOf(fixture: StandDiscord, route: string, query: URLSearchParams): unknown {
  const [head, ...rest] = route.split('/').filter(Boolean);
  if (head === 'users') return userRoute(fixture, rest);
  if (head === 'guilds' && rest[0] === String(fixture.guild.id)) return guildRoute(fixture, rest.slice(1));
  if (head === 'channels') return channelRoute(fixture, rest, query);
  return null;
}

/** What the fixture answers to one request: a GET it holds, else 404 for Discord's host. */
function respond(fixture: StandDiscord, method: string, url: URL): Answer {
  const route = API.exec(url.pathname)?.[1];
  const found = method === 'GET' && route !== undefined ? answerOf(fixture, route, url.searchParams) : null;
  if (found === null) {
    process.stderr.write(`replay-stand: no fixture for ${method} ${url.pathname}\n`);
    return { status: 404, body: { message: 'Unknown', code: 0 } };
  }
  return { status: 200, body: found };
}

type Handler = {
  onConnect?: (abort: (err?: Error) => void, context?: unknown) => void;
  onHeaders?: (status: number, headers: Array<Buffer>, resume: () => void, text: string) => boolean;
  onData?: (chunk: Buffer) => boolean;
  onComplete?: (trailers: Array<Buffer>) => void;
  onError?: (err: Error) => void;
  onRequestStart?: (controller: unknown, context: unknown) => void;
  onResponseStart?: (controller: unknown, status: number, headers: Record<string, string>, text: string) => void;
  onResponseData?: (controller: unknown, chunk: Buffer) => void;
  onResponseEnd?: (controller: unknown, trailers: Record<string, string>) => void;
  onResponseError?: (controller: unknown, err: Error) => void;
};

/** A request of either handler shape undici passes a dispatcher answered with `answer`, or failed with `error`. */
function deliver(handler: Handler, answer: Answer | null, error: Error | null): void {
  const controller = { abort() {}, pause() {}, resume() {}, aborted: false, paused: false };
  const body = answer === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(answer.body));
  if (typeof handler.onResponseStart === 'function' || typeof handler.onRequestStart === 'function') {
    handler.onRequestStart?.(controller, {});
    if (error !== null || answer === null) {
      handler.onResponseError?.(controller, error ?? new Error('no answer'));
      return;
    }
    handler.onResponseStart?.(controller, answer.status, { 'content-type': 'application/json' }, '');
    handler.onResponseData?.(controller, body);
    handler.onResponseEnd?.(controller, {});
    return;
  }
  handler.onConnect?.(() => {}, {});
  if (error !== null || answer === null) {
    handler.onError?.(error ?? new Error('no answer'));
    return;
  }
  handler.onHeaders?.(
    answer.status,
    [Buffer.from('content-type'), Buffer.from('application/json')],
    () => {},
    answer.status === 200 ? 'OK' : 'Not Found'
  );
  handler.onData?.(body);
  handler.onComplete?.([]);
}

/**
 * Puts the fixture in place of undici's global dispatcher for this process: Discord's REST API answers from
 * `fixture`, every other host refuses the connection.
 */
export function installStandDiscord(fixture: StandDiscord): void {
  const dispatcher = {
    dispatch(options: { origin?: string | URL; path?: string; method?: string }, handler: Handler): boolean {
      const url = new URL(options.path ?? '/', options.origin ?? 'http://offline.invalid');
      const method = (options.method ?? 'GET').toUpperCase();
      queueMicrotask(() => {
        if (url.hostname !== 'discord.com') {
          const refused = Object.assign(new Error(`connect ECONNREFUSED ${url.hostname}`), { code: 'ECONNREFUSED' });
          deliver(handler, null, refused);
          return;
        }
        deliver(handler, respond(fixture, method, url), null);
      });
      return true;
    },
    close: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
    on() {
      return this;
    },
    off() {
      return this;
    },
    once() {
      return this;
    },
    emit: () => false,
  };
  for (const key of GLOBAL_DISPATCHERS) (globalThis as Record<symbol, unknown>)[key] = dispatcher;
}
