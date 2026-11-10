// The fixtures of the memory session tests (tests/memory-db-session.test.ts): the ids of the Discord namespace, the
// prompts and the config of a session, the fake llm, a database with its lines and claims, the context of a sweep and the
// request a scope gets. Synthetic Greek and accented Latin text only.
import { legacyServerPlaceId } from './legacy-paths.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { fillEnvAudiences } from './audiences.ts';
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import { batchOf, buildSessionRequest, scopesOf, type sweep } from '../../../src/memory/db/session.ts';
import * as memoryIds from '../../../src/memory/db/ids.ts';
import { personId } from './spelled-ids.ts';
import { labels } from '../labels.ts';
import { dbOf, type Db } from '../../../src/memory/db/types.ts';
import type { KeyRing } from '../../../src/keys/ring.ts';
import type { ClaimArgs, CtxOptions, FakeLlm, Fixture, LlmCall, LlmScript, Rec, SayArgs, Scope } from './session-shapes.ts';
import { chainsOf } from '../chains.ts';
// The ids of the Discord namespace the fixtures of this file write.
export const personOf = (id: string): string => personId('discord', id);
export const dmPlaceOf = (id: string): string => memoryIds.dmPlaceId('discord', id);
export const guildPlaceOf = (id: string): string => legacyServerPlaceId('discord', id);
export const channelPlaceOf = (id: string): string => memoryIds.channelPlaceId('discord', id);
export const messageSourceOf = (id: string, revision: number, kind: string): string => memoryIds.messageSourceId('discord', id, revision, kind);

export const NOW = Date.parse('2026-10-24T12:00:00.000Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const ADA = 'u-ada';
export const BOB = 'u-bob';
export const GUILD = 'G1';
export const CHANNEL = channelPlaceOf('c1');
export const SELF_ACCOUNT = 'discord:u-self';

export const prompts = {
  'system-prompt': 'SYSTEM {{name}}',
  'character-card': 'CARD {{name}}',
  // The rules text holds a list item: a rules file with an empty list reaches no system text (src/rules-list.ts).
  rules: '- RULES',
  format: 'FORMAT',
  'memory-session': 'SESSION {{name}}',
  labels,
};
export const baseConfig = (session: Rec = {}, extra: Rec = {}): Rec => ({
  bot: { timezone: 'UTC' },
  models: { routes: chainsOf({ memory: 'x/memory' }) },
  memoryDb: { session: { mode: 'shadow', minMessages: 1, minLines: 0, ...session } },
  ...extra,
});

/** The text of a message's content: a string as it is, a list of text parts joined in order (the session's user message is parts). */
export const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join('')
      : '';

/** A fake llm: answers from a script (a string, an Error, or a function of the messages and options), records the calls. */
export function fakeLlm(given: LlmScript): FakeLlm {
  const script = typeof given === 'function' || Array.isArray(given) ? given : [given];
  const calls: Array<LlmCall> = [];
  return {
    calls,
    complete(messages: LlmCall['messages'], options: LlmCall['options']) {
      calls.push({ messages, options });
      return new Promise((resolve, reject) => {
        const next =
          typeof script === 'function'
            ? script(messages, options, calls.length)
            : script[Math.min(calls.length - 1, script.length - 1)];
        if (next instanceof Error) reject(next);
        else resolve({ text: next, usage: { prompt_tokens: 1000, completion_tokens: 50 } });
      });
    },
  };
}

export function fixture(): Fixture {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  const group: Scope = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
  const api = {
    handle,
    db,
    group,
    say({
      native,
      minutesAgo,
      text,
      author = ADA,
      kind = 'seen',
      direct = 0,
      place = CHANNEL,
      scope = group,
      revision = 1,
    }: SayArgs) {
      const at = new Date(NOW - minutesAgo * MINUTE).toISOString();
      db.prepare(
        `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, recorded_at, text, direct,
        scope_kind, scope_iface, scope_dm) VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageSourceOf(native, revision, kind),
        kind,
        String(native),
        revision,
        place,
        kind === 'said' ? SELF_ACCOUNT : `discord:${author}`,
        at,
        at,
        text,
        direct,
        scope.scope_kind,
        scope.scope_iface,
        scope.scope_dm
      );
      return messageSourceOf(native, revision, kind);
    },
    claim({
      id,
      subjectKind = 'person',
      subjectId,
      kind = 'interest',
      text,
      scope = group,
      truth = 'current',
      shown = 1,
    }: ClaimArgs) {
      db.prepare(
        `INSERT INTO claims (id, subject_kind, subject_id, kind, text, how, author, truth, shown, scope_kind, scope_iface, scope_dm, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, 'legacy', 'import', ?, ?, ?, ?, ?, '2026-10-01', '2026-10-20')`
      ).run(id, subjectKind, subjectId, kind, text, truth, shown, scope.scope_kind, scope.scope_iface, scope.scope_dm);
    },
    /** A member's stored DM place, as an observed DM leaves it: a DM row's audience is the place naming its partner. */
    storeDmPlace(member: string) {
      db.prepare(
        `INSERT INTO places (id, iface, kind, native_id, chat, scope_kind, partner_account, partner_person)
         VALUES (?, 'discord', 'dm', NULL, 'dm', 'dm', ?, ?)`
      ).run(dmPlaceOf(member), `discord:${member}`, personOf(member));
    },
    done() {
      handle.close();
    },
  };
  db.prepare("INSERT INTO people (id, kind, affinity) VALUES (?, 'member', 5)").run(personOf(ADA));
  db.prepare("INSERT INTO people (id, kind, affinity) VALUES (?, 'member', 0)").run(personOf(BOB));
  db.prepare("INSERT INTO accounts (id, iface, native_id, person_id, names) VALUES (?, 'discord', ?, ?, ?)").run(
    `discord:${ADA}`,
    ADA,
    personOf(ADA),
    JSON.stringify(['Ada', 'Old Ada'])
  );
  db.prepare("INSERT INTO accounts (id, iface, native_id, person_id, names) VALUES (?, 'discord', ?, ?, ?)").run(
    `discord:${BOB}`,
    BOB,
    personOf(BOB),
    JSON.stringify(['Βασίλης'])
  );
  db.prepare(
    "INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'guild', ?, NULL, 'group', 'Server', NULL)"
  ).run(guildPlaceOf(GUILD), GUILD);
  db.prepare(
    "INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'channel', 'c1', ?, 'group', 'general', 'chat')"
  ).run(CHANNEL, guildPlaceOf(GUILD));
  return api;
}

/** Five lines in the group scope: Ada greets, Bob answers, one line is addressed to her, one is hers. */
export function chat(env: Fixture): Record<string, string> {
  return {
    a: env.say({ native: 'm1', minutesAgo: 100, text: 'Καλημέρα, I like café mornings' }),
    b: env.say({ native: 'm2', minutesAgo: 90, text: 'ναι, σωστά', author: BOB }),
    c: env.say({ native: 'm3', minutesAgo: 80, text: 'hey you there?', direct: 1 }),
    d: env.say({ native: 'm4', minutesAgo: 70, text: 'I am here', kind: 'said' }),
    e: env.say({ native: 'm5', minutesAgo: 60, text: 'I moved to Thessaloniki' }),
  };
}

let clock = 0;

/** A key ring that routes every role to one memory key, as the core's ring does for a bound `memory`. */
export function memoryRing(): KeyRing {
  const route = { name: 'memory-key', value: 'k' };
  return {
    route: () => route,
    names: () => [route.name],
    states: () => [],
    bound: () => [{ name: route.name, roles: ['memory'] }],
  };
}

export function ctxOf(
  env: Fixture,
  { llm, config = baseConfig(), promptSet = prompts, ring = memoryRing(), write }: CtxOptions = {}
): Parameters<typeof sweep>[0] {
  fillEnvAudiences(env); // PR 7d: the session reads through `audience_id`, so the fixture's rows carry it.
  return {
    db: env.db,
    write: write ?? ((update: unknown) => new Promise((resolve) => resolve(applyMemoryWrite(env.handle, update)))),
    llm,
    hot: { config, prompts: promptSet },
    env: {},
    ring,
    now: () => NOW + (clock += 1000),
    log: {},
    selfName: 'Nep',
    // The interface a review reads in when it is given no read context, as the service names it.
    iface: 'discord',
  } as unknown as Parameters<typeof sweep>[0]; // the context names the parts a sweep reads, and the llm may be absent
}

export const memoryBlock = (value: unknown): string => `<think>reading</think>\n<memory>\n${JSON.stringify(value)}\n</memory>`;
export const count = (db: Db, table: string, where = '1 = 1'): unknown => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get()!.n;
export const request = (
  env: Fixture,
  config = baseConfig()
): { scope: ReturnType<typeof scopesOf>[number]; batch: ReturnType<typeof batchOf> } & ReturnType<typeof buildSessionRequest> => {
  const scope = scopesOf(env.db)[0];
  const batch = batchOf(env.db, scope.scope, {
    cursor: 0,
    since: null,
    maxMessages: 200,
    settleBefore: NOW - 10 * MINUTE,
  });
  return {
    scope,
    batch,
    ...buildSessionRequest({ db: env.db, scope, batch, config, prompts, selfName: 'Nep', now: NOW }),
  };
};
