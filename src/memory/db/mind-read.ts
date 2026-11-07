// The graph reader: what comes to her mind on a turn (docs/memory.md, "How a turn remembers"). Code walks listed paths
// over the memory graph from the seeds of a turn, reads under the turn's context, ranks by evidence and cuts to a budget
// in tokens. No model takes part.
//
//   mindOf(db, ctx, seeds, settings, now) -> Mind
//
// Seeds, by evidence class, strongest first: a native mention in the trigger (`native`), the trigger's reply parent
// (`reply`), the person she answers (`counterpart`), the authors of the window (`author`), the current place and the
// places of the window (`place`), what an edge ties to an entry, the previous turns' seeds, the finds of the prefetch
// and the query and her own recent places (`edge`), a word of the window that matches a name of the index (`word`,
// names.ts), and a name found in the claims of an entry rendered whole (`prose`). A word is matched exact, then by stems, then by trigrams. A
// word naming more than `commonWordEntries` entries raises none; several are first narrowed to the people present and
// the places under the current root, and what stays ambiguous, or matched by stem or trigram only, is raised as a
// candidate. An interface's noun for a kind of place raises the places of that kind on that interface instead.
//
// The listed paths, each one query that orders before it limits, over live edges whose audience the context reads, to
// nodes the context may see (`node_access`, a place by its own audience): an account to its person and back to the
// person's other accounts (`account_of`, free), a person's accounts to the places of their memberships, a place up to
// its parent (`contained_in`, free), a named root down to its rooms by her own line count and to its members by her
// affinity, an interface down to its top places, a line along `replies_to` both ways, and a person or a place back
// along `about` to its claims and episodes. A free hop costs nothing; any other counts against `maxHops`. The walk stops
// expanding once it has read `maxNodesRead` rows.
//
// Every entry has its node, its strongest evidence, its detail (`whole` for native, reply and counterpart, `compact`,
// `name` for a candidate and for prose), its newest anchor message and the stored rows behind it. The budget
// (`budgetTokens`, split by `shares`, an unused share lent to a full one) keeps entries by rank: evidence, hops, the
// newest anchor, her affinity, the id; an entry that does not fit drops to a lower detail, else it is left out and
// counted in `leftOut`. The counterpart, the authors of the window, the current place and what the trigger names
// natively or by an exact name are kept whatever the budget, at the detail that fits or as a name.

import { estimateTokens } from '../../llm/tokens.ts';
import { indexWords } from '../record-index.ts';
import { SELF_PERSON } from './ids.ts';
import { loadStemmer } from './stems.ts';
import { interfaceNouns, matchName, normalName, phrasesOf, namesIn } from './names.ts';
import type { NameHitRow, NameMatch } from './names.ts';
import { placeChainInDb } from './place-tree.ts';
import { allowedAudience, audienceWhere, dmAudienceId, groupAudienceId, AUD_INTERNAL } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

export type Evidence = 'native' | 'reply' | 'counterpart' | 'author' | 'place' | 'edge' | 'word' | 'prose';
export type Detail = 'whole' | 'compact' | 'name';
/** A stored row behind an entry: its table, its id and the version rendered, when the row has versions. */
export type EntrySource = { table: string; id: string; version: string | null };
type EntryBase = {
  nodeId: string;
  evidence: Evidence;
  detail: Detail;
  candidate: boolean;
  anchorMessageId: string | null;
  sources: Array<EntrySource>;
};
export type PersonEntry = EntryBase & {
  personId: string;
  name: string | null;
  realName: string | null;
  affinity: number | null;
  /** The account row ids she knows the person through. */
  accounts: Array<string>;
  relation: string | null;
  character: string | null;
  style: string | null;
  claims: Array<{ id: string; kind: string; text: string }>;
};
export type PlaceEntry = EntryBase & {
  placeId: string;
  iface: string | null;
  kind: string | null;
  name: string | null;
  /** The place by names from its interface down: a direct chat's ends in the interface's word and the native id. */
  path: Array<string>;
  purpose: string | null;
  tone: string | null;
  topics: string | null;
  ownLines: number;
  ownLastAt: string | null;
};
export type InterfaceEntry = EntryBase & { iface: string; name: string | null };
export type ClaimEntry = EntryBase & { claimId: string; subjectId: string; kind: string; text: string };
export type EpisodeEntry = EntryBase & { episodeId: string; placeId: string | null; date: string | null; what: string };
export type ExcerptEntry = EntryBase & {
  sourceId: string;
  placeId: string | null;
  at: string | null;
  text: string;
  from: 'prefetch' | 'query' | 'reply';
};
/** One listed path the walk read, and how many rows it gave. */
export type MemoryRead = { path: string; rows: number };
export type Mind = {
  people: Array<PersonEntry>;
  places: Array<PlaceEntry>;
  interfaces: Array<InterfaceEntry>;
  lore: Array<ClaimEntry>;
  recent: Array<EpisodeEntry>;
  found: Array<ExcerptEntry>;
  leftOut: Record<string, number>;
  reads: Array<MemoryRead>;
};
/** A line of the window: stored row ids, `at` an ISO time, mentions as account row ids. */
export type SeedMessage = {
  id: string;
  at: string;
  authorAccount: string | null;
  placeId: string | null;
  replyTo: string | null;
  mentions: Array<string>;
  text: string;
  trigger: boolean;
};
/** A seed of an earlier turn of this chat, by its graph node. */
export type EntryRef = { nodeId: string };
export type Seeds = {
  messages: Array<SeedMessage>;
  counterpart: { personId: string; accountId: string } | null;
  place: string | null;
  previous: Array<EntryRef>;
  candidates: Array<{ nodeId: string; sourceIds: Array<string>; from: 'prefetch' | 'query' }>;
};
export type MindSettings = {
  windowMessages: number;
  maxHops: number;
  maxNodesRead: number;
  budgetTokens: number;
  shares: { people: number; places: number; lore: number; recent: number; found: number };
  counterpartTokens: number;
  candidatesMax: number;
  commonWordEntries: number;
  fanOut: { accounts: number; memberships: number; rooms: number; members: number; replies: number; about: number };
};

/** The shipped values of `context.memory` in config/config.json, for a key the live settings lack. */
export const MIND_DEFAULTS: Readonly<MindSettings> = Object.freeze({
  windowMessages: 100,
  maxHops: 2,
  maxNodesRead: 2000,
  budgetTokens: 10000,
  shares: { people: 0.5, places: 0.15, lore: 0.15, recent: 0.1, found: 0.1 },
  counterpartTokens: 1500,
  candidatesMax: 3,
  commonWordEntries: 3,
  fanOut: { accounts: 10, memberships: 20, rooms: 10, members: 8, replies: 5, about: 30 },
});

const isObj = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
function numbers<T extends Record<string, number>>(given: unknown, fallback: T): T {
  const source = isObj(given) ? given : {};
  return Object.fromEntries(Object.entries(fallback).map(([key, value]) => [key, count(source[key], value)])) as T;
}

/** The reader's settings from the live config (`context.memory`), each missing or broken key at its shipped value. */
export function mindSettingsOf(config: unknown): MindSettings {
  const context = isObj(config) && isObj(config.context) ? config.context : {};
  const memory = isObj(context.memory) ? context.memory : {};
  const { shares, fanOut, ...plain } = MIND_DEFAULTS;
  return {
    ...numbers(memory, plain),
    shares: numbers(memory.shares, shares),
    fanOut: numbers(memory.fanOut, fanOut),
  };
}

const EVIDENCE_ORDER: ReadonlyArray<Evidence> = [
  'native',
  'reply',
  'counterpart',
  'author',
  'place',
  'edge',
  'word',
  'prose',
];
const WHOLE: ReadonlySet<Evidence> = new Set(['native', 'reply', 'counterpart']);
const DETAILS: ReadonlyArray<Detail> = ['whole', 'compact', 'name'];
const SUBTAGS = ['people', 'places', 'lore', 'recent', 'found'] as const;
type Subtag = (typeof SUBTAGS)[number];
const rankOf = (evidence: Evidence): number => EVIDENCE_ORDER.indexOf(evidence);

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const rowIdOf = (nodeId: string, kind: string): string => nodeId.slice(kind.length + 1);
const nodeKindOf = (nodeId: string): string => nodeId.slice(0, nodeId.indexOf(':'));
const node = (kind: string, id: string): string => `${kind}:${id}`;
const tokensOf = (rendered: string): number => (rendered === '' ? 0 : estimateTokens(rendered) + 2);

/** A raised node before its rows are read. */
type Raised = {
  nodeId: string;
  kind: 'person' | 'place' | 'interface';
  evidence: Evidence;
  hop: number;
  anchor: string | null;
  anchorAt: string;
  candidate: boolean;
  named: boolean;
  keep: boolean;
  own: boolean;
  sources: Array<EntrySource>;
};
type Raise = Omit<Raised, 'kind' | 'sources' | 'own'> & { sources?: Array<EntrySource>; own?: boolean };
type Sql = { sql: string; params: Array<string | number> };
const RAISED_KINDS = new Set(['person', 'place', 'interface']);

/** The state of one read: what is raised, what was read, and the access checks of its context. */
function walkerOf(db: Db, ctx: Context, settings: MindSettings, seeds: Seeds) {
  const raised = new Map<string, Raised>();
  const reads = new Map<string, number>();
  let nodesRead = 0;
  const aud = (alias: string): Sql => audienceWhere(ctx, alias);
  const nodeOk = (expr: string, alias: string): Sql => {
    if (ctx.internal === true) return { sql: '1 = 1', params: [] };
    const where = audienceWhere(ctx, alias);
    return {
      sql: `EXISTS (SELECT 1 FROM node_access ${alias} WHERE ${alias}.node_id = ${expr} AND ${where.sql})`,
      params: where.params,
    };
  };
  const live = (alias: string): string => `${alias}.retired_at IS NULL AND ${alias}.valid_to_at IS NULL`;
  const all = (path: string, sql: string, params: Array<string | number>): Array<Row> => {
    const rows = db.prepare(sql).all(...params);
    nodesRead += rows.length;
    reads.set(path, (reads.get(path) ?? 0) + rows.length);
    return rows;
  };
  const counterpartPerson = seeds.counterpart?.personId ?? null;

  /** Whether a node may be shown: a place by its own audience, an interface always, anything else by `node_access`. */
  function visible(nodeId: string): boolean {
    const kind = nodeKindOf(nodeId);
    if (kind === 'interface' || ctx.internal === true) return true;
    if (kind === 'place') {
      const place = db
        .prepare('SELECT id, iface, kind, conversation, retired_at FROM places WHERE id = ?')
        .get(rowIdOf(nodeId, 'place'));
      if (!place || place.retired_at !== null) return false;
      const own =
        place.conversation === 'dm' || place.kind === 'dm'
          ? dmAudienceId(place.id)
          : text(place.iface) === null
            ? AUD_INTERNAL
            : groupAudienceId(place.iface);
      return allowedAudience({ audience_id: own }, ctx);
    }
    const ok = nodeOk('?', 'a');
    return db.prepare(`SELECT 1 AS ok FROM (SELECT 1) WHERE ${ok.sql}`).get(nodeId, ...ok.params) !== undefined;
  }

  function raise(given: Raise): void {
    const kind = nodeKindOf(given.nodeId);
    if (!RAISED_KINDS.has(kind) || given.nodeId === node('person', SELF_PERSON)) return;
    const found = raised.get(given.nodeId);
    if (found === undefined) {
      if (!visible(given.nodeId)) return;
      raised.set(given.nodeId, {
        ...given,
        kind: kind as Raised['kind'],
        own: given.own ?? false,
        sources: [...(given.sources ?? [])],
      });
      return;
    }
    if (rankOf(given.evidence) < rankOf(found.evidence)) found.evidence = given.evidence;
    found.hop = Math.min(found.hop, given.hop);
    found.candidate = found.candidate && given.candidate;
    found.named = found.named || given.named;
    found.keep = found.keep || given.keep;
    found.own = found.own && (given.own ?? false);
    if (given.anchorAt > found.anchorAt) {
      found.anchor = given.anchor;
      found.anchorAt = given.anchorAt;
    }
    found.sources.push(...(given.sources ?? []));
  }

  /** The person an account belongs to, through its live verified link. */
  function personOfAccount(accountId: string): string | null {
    const edge = aud('e');
    const from = nodeOk('e.src', 'a1');
    const to = nodeOk('e.dst', 'a2');
    const rows = all(
      'account_of',
      `SELECT e.dst AS node FROM graph_edges e
       WHERE e.src = ? AND e.predicate = 'account_of' AND ${live('e')} AND ${edge.sql} AND ${from.sql} AND ${to.sql}
       ORDER BY e.recorded_at DESC, e.dst LIMIT 1`,
      [node('account', accountId), ...edge.params, ...from.params, ...to.params]
    );
    return text(rows[0]?.node);
  }

  /** The account row ids of a person, through live links the context reads. */
  function accountsOf(personNode: string): Array<string> {
    const edge = aud('e');
    const from = nodeOk('e.src', 'a1');
    return all(
      'accounts',
      `SELECT n.row_id FROM graph_edges e JOIN graph_nodes n ON n.id = e.src
       WHERE e.dst = ? AND e.predicate = 'account_of' AND ${live('e')} AND ${edge.sql} AND ${from.sql}
       ORDER BY n.row_id LIMIT ?`,
      [personNode, ...edge.params, ...from.params, settings.fanOut.accounts]
    ).map((row) => String(row.row_id));
  }

  /** The places of a person's memberships, over all of the person's accounts, newest first. */
  function membershipPlaces(personNode: string): Array<string> {
    const [ao, hm, mi] = [aud('ao'), aud('hm'), aud('mi')];
    const [account, membership] = [nodeOk('ao.src', 'a1'), nodeOk('hm.dst', 'a2')];
    return all(
      'memberships',
      `SELECT mi.dst AS node, MAX(mi.recorded_at) AS at FROM graph_edges ao
       JOIN graph_edges hm ON hm.src = ao.src AND hm.predicate = 'has_membership' AND ${live('hm')} AND ${hm.sql}
       JOIN graph_edges mi ON mi.src = hm.dst AND mi.predicate = 'membership_in' AND ${live('mi')} AND ${mi.sql}
       WHERE ao.dst = ? AND ao.predicate = 'account_of' AND ${live('ao')} AND ${ao.sql} AND ${account.sql} AND ${membership.sql}
       GROUP BY mi.dst ORDER BY at DESC, mi.dst LIMIT ?`,
      [
        ...hm.params,
        ...mi.params,
        personNode,
        ...ao.params,
        ...account.params,
        ...membership.params,
        settings.fanOut.memberships,
      ]
    ).map((row) => String(row.node));
  }

  /** The rooms of a root, by her own line count in each, then by id. */
  function roomsOf(rootId: string): Array<string> {
    const lines = aud('s');
    return all(
      'rooms',
      `SELECT p.id, (SELECT COUNT(*) FROM sources s WHERE s.place_id = p.id AND s.author_kind = 'self'
         AND s.retired_at IS NULL AND ${lines.sql}) AS mine
       FROM places p WHERE p.parent_id = ? AND p.retired_at IS NULL ORDER BY mine DESC, p.id LIMIT ?`,
      [...lines.params, rootId, settings.fanOut.rooms]
    ).map((row) => node('place', String(row.id)));
  }

  /** The members of a root, by her affinity to each (none last), then by id; she and the counterpart are not listed. */
  function membersOf(rootNode: string): Array<string> {
    const [mi, hm, ao] = [aud('mi'), aud('hm'), aud('ao')];
    const [membership, person] = [nodeOk('mi.src', 'a1'), nodeOk('ao.dst', 'a2')];
    const skip = [SELF_PERSON, counterpartPerson ?? SELF_PERSON];
    return all(
      'members',
      `SELECT ao.dst AS node, MAX(pe.affinity) AS affinity FROM graph_edges mi
       JOIN graph_edges hm ON hm.dst = mi.src AND hm.predicate = 'has_membership' AND ${live('hm')} AND ${hm.sql}
       JOIN graph_edges ao ON ao.src = hm.src AND ao.predicate = 'account_of' AND ${live('ao')} AND ${ao.sql}
       JOIN graph_nodes pn ON pn.id = ao.dst JOIN people pe ON pe.id = pn.row_id AND pe.retired_at IS NULL
       WHERE mi.dst = ? AND mi.predicate = 'membership_in' AND ${live('mi')} AND ${mi.sql} AND ${membership.sql}
         AND ${person.sql} AND pn.row_id NOT IN (?, ?)
       GROUP BY ao.dst ORDER BY affinity IS NULL, affinity DESC, ao.dst LIMIT ?`,
      [
        ...hm.params,
        ...ao.params,
        rootNode,
        ...mi.params,
        ...membership.params,
        ...person.params,
        ...skip,
        settings.fanOut.members,
      ]
    ).map((row) => String(row.node));
  }

  /** The top places of an interface, a direct chat excepted. */
  function rootsOf(iface: string): Array<string> {
    return all(
      'roots',
      `SELECT id FROM places WHERE iface = ? AND parent_id IS NULL AND retired_at IS NULL
         AND COALESCE(conversation, '') <> 'dm' AND kind <> 'dm' ORDER BY id LIMIT ?`,
      [iface, settings.maxNodesRead]
    ).map((row) => node('place', String(row.id)));
  }

  /** The places of one kind on an interface, by her own line count. */
  function placesOfKind(iface: string, kind: string): Array<string> {
    const lines = aud('s');
    return all(
      'kind',
      `SELECT p.id, (SELECT COUNT(*) FROM sources s WHERE s.place_id = p.id AND s.author_kind = 'self'
         AND s.retired_at IS NULL AND ${lines.sql}) AS mine
       FROM places p WHERE p.iface = ? AND p.kind = ? AND p.retired_at IS NULL ORDER BY mine DESC, p.id LIMIT ?`,
      [...lines.params, iface, kind, settings.fanOut.rooms]
    ).map((row) => node('place', String(row.id)));
  }

  /** The places she wrote in lately, newest first. */
  function ownPlaces(): Array<string> {
    const lines = aud('s');
    return all(
      'own',
      `SELECT s.place_id, MAX(s.occurred_at) AS last FROM sources s
       WHERE s.author_kind = 'self' AND s.retired_at IS NULL AND s.place_id IS NOT NULL AND ${lines.sql}
       GROUP BY s.place_id ORDER BY last DESC, s.place_id LIMIT ?`,
      [...lines.params, settings.fanOut.rooms]
    ).map((row) => node('place', String(row.place_id)));
  }

  /** A stored line the context reads: its author, place, time and text. */
  function line(sourceId: string): Row | undefined {
    const where = aud('s');
    return all(
      'line',
      `SELECT s.id, s.author_account, s.author_kind, s.place_id, s.occurred_at, s.text FROM sources s
       WHERE s.id = ? AND s.retired_at IS NULL AND ${where.sql}`,
      [sourceId, ...where.params]
    )[0];
  }

  /** The lines that answer a line, along `replies_to` into it. */
  function repliesInto(sourceId: string): Array<string> {
    const edge = aud('e');
    const from = nodeOk('e.src', 'a1');
    return all(
      'replies',
      `SELECT n.row_id FROM graph_edges e JOIN graph_nodes n ON n.id = e.src
       WHERE e.dst = ? AND e.predicate = 'replies_to' AND e.retired_at IS NULL AND ${edge.sql} AND ${from.sql}
       ORDER BY e.recorded_at DESC, e.src LIMIT ?`,
      [node('source', sourceId), ...edge.params, ...from.params, settings.fanOut.replies]
    ).map((row) => String(row.row_id));
  }

  /** What is said `about` a node: claims and episodes, newest first. */
  function about(target: string): Array<{ kind: string; id: string }> {
    const edge = aud('e');
    const from = nodeOk('e.src', 'a1');
    return all(
      'about',
      `SELECT n.kind, n.row_id FROM graph_edges e JOIN graph_nodes n ON n.id = e.src
       WHERE e.dst = ? AND e.predicate = 'about' AND e.retired_at IS NULL AND ${edge.sql} AND ${from.sql}
       ORDER BY e.recorded_at DESC, e.src LIMIT ?`,
      [target, ...edge.params, ...from.params, settings.fanOut.about]
    ).map((row) => ({ kind: String(row.kind), id: String(row.row_id) }));
  }

  const { stem } = loadStemmer(db);
  return {
    stem,
    raised,
    raise,
    visible,
    personOfAccount,
    accountsOf,
    membershipPlaces,
    roomsOf,
    membersOf,
    rootsOf,
    placesOfKind,
    ownPlaces,
    line,
    repliesInto,
    about,
    aud,
    exhausted: (): boolean => nodesRead >= settings.maxNodesRead,
    reads: (): Array<MemoryRead> => [...reads].map(([path, rows]) => ({ path, rows })),
  };
}
type Walker = ReturnType<typeof walkerOf>;

/** The last `windowMessages` lines of the window, oldest first. */
function windowOf(messages: ReadonlyArray<SeedMessage>, size: number): Array<SeedMessage> {
  const sorted = [...messages].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return size <= 0 ? [] : sorted.slice(-size);
}

/** What one word of the window names, after the narrowing and the common-word rule. */
function wordHits(
  db: Db,
  ctx: Context,
  walker: Walker,
  settings: MindSettings,
  phrase: string,
  present: (nodeId: string) => boolean,
  only?: ReadonlyArray<NameMatch>
): { nouns: Array<NameHitRow>; nodes: Array<{ nodeId: string; match: NameMatch }>; candidate: boolean } {
  const hits = matchName(db, ctx, phrase, only, walker.stem);
  const nouns = hits.filter((hit) => hit.kind === 'interface_noun');
  const byNode = new Map<string, NameMatch>();
  for (const hit of hits) {
    if (hit.kind === 'interface_noun') continue;
    const target =
      nodeKindOf(hit.nodeId) === 'account' ? walker.personOfAccount(rowIdOf(hit.nodeId, 'account')) : hit.nodeId;
    if (target === null || target === node('person', SELF_PERSON) || byNode.has(target)) continue;
    byNode.set(target, hit.match);
  }
  let nodes = [...byNode].map(([nodeId, match]) => ({ nodeId, match }));
  if (nodes.length > 1) {
    const near = nodes.filter((one) => present(one.nodeId));
    if (near.length > 0) nodes = near;
  }
  if (nodes.length > settings.commonWordEntries) return { nouns, nodes: [], candidate: false };
  const candidate = nodes.length > 1 || nodes.some((one) => one.match !== 'exact');
  return { nouns, nodes: nodes.slice(0, Math.max(1, settings.candidatesMax)), candidate };
}

/** The places of the current root and the people already raised as present: what narrows an ambiguous word. */
function presenceOf(db: Db, walker: Walker, place: string | null): (nodeId: string) => boolean {
  const root = place === null ? null : (placeChainInDb(db, place).at(-1)?.id ?? null);
  return (nodeId) => {
    const found = walker.raised.get(nodeId);
    if (found !== undefined && ['counterpart', 'author', 'native', 'reply'].includes(found.evidence)) return true;
    if (root === null || nodeKindOf(nodeId) !== 'place') return false;
    return placeChainInDb(db, rowIdOf(nodeId, 'place')).some((one) => one.id === root);
  };
}

/** The seeds of the window's words: names, and nouns of kinds of place. */
function seedWords(
  db: Db,
  ctx: Context,
  walker: Walker,
  settings: MindSettings,
  window: Array<SeedMessage>,
  place: string | null
): void {
  const present = presenceOf(db, walker, place);
  const cache = new Map<string, ReturnType<typeof wordHits>>();
  for (const message of window) {
    for (const phrase of new Set(phrasesOf(message.text))) {
      let found = cache.get(phrase);
      if (found === undefined) {
        found = wordHits(db, ctx, walker, settings, phrase, present);
        cache.set(phrase, found);
      }
      const base = { evidence: 'word' as const, hop: 0, anchor: message.id, anchorAt: message.at, own: false };
      for (const one of found.nodes)
        walker.raise({
          ...base,
          nodeId: one.nodeId,
          candidate: found.candidate,
          named: !found.candidate,
          keep: message.trigger && !found.candidate,
        });
      for (const noun of found.nouns) raiseKind(db, walker, noun, base);
    }
  }
}

/** The places of the kind an interface's noun names. */
function raiseKind(
  db: Db,
  walker: Walker,
  noun: NameHitRow,
  base: { evidence: Evidence; hop: number; anchor: string; anchorAt: string }
): void {
  const iface = rowIdOf(noun.nodeId, 'interface');
  const extra = db.prepare('SELECT extra FROM interfaces WHERE id = ?').get(iface)?.extra;
  const kind = Object.entries(interfaceNouns(extra)).find(([, word]) => normalName(word) === noun.normalized)?.[0];
  if (kind === undefined) return;
  for (const placeNode of walker.placesOfKind(iface, kind))
    walker.raise({ ...base, nodeId: placeNode, candidate: false, named: false, keep: false });
}

/** The seeds that are no words: the counterpart, the place, the authors, mentions and replies, earlier seeds, finds. */
function seedTies(walker: Walker, seeds: Seeds, window: Array<SeedMessage>, found: Map<string, ExcerptSeed>): void {
  const trigger = window.findLast((message) => message.trigger) ?? window.at(-1) ?? null;
  const at = trigger?.at ?? '';
  const windowIds = new Set(window.map((message) => message.id));
  const quiet = { hop: 0, candidate: false, named: false };
  if (seeds.counterpart !== null)
    walker.raise({
      ...quiet,
      nodeId: node('person', seeds.counterpart.personId),
      evidence: 'counterpart',
      anchor: trigger?.id ?? null,
      anchorAt: at,
      keep: true,
    });
  if (seeds.place !== null)
    walker.raise({
      ...quiet,
      nodeId: node('place', seeds.place),
      evidence: 'place',
      anchor: null,
      anchorAt: '',
      keep: true,
    });
  for (const message of window) seedMessageTies(walker, message, windowIds, found);
  for (const ref of seeds.previous)
    walker.raise({ ...quiet, nodeId: ref.nodeId, evidence: 'edge', anchor: null, anchorAt: '', keep: false });
  seedCandidates(walker, seeds.candidates, found);
  for (const placeNode of walker.ownPlaces())
    walker.raise({ ...quiet, nodeId: placeNode, evidence: 'edge', anchor: null, anchorAt: '', keep: false, own: true });
}

/** The ties of one line of the window: its author, its place, its mentions and the replies around it. */
function seedMessageTies(
  walker: Walker,
  message: SeedMessage,
  windowIds: Set<string>,
  found: Map<string, ExcerptSeed>
): void {
  const quiet = { hop: 0, candidate: false, named: false };
  const anchor = { anchor: message.id, anchorAt: message.at };
  const person = (account: string | null, evidence: Evidence, keep: boolean): void => {
    const target = account === null ? null : walker.personOfAccount(account);
    if (target !== null) walker.raise({ ...quiet, ...anchor, nodeId: target, evidence, keep });
  };
  person(message.authorAccount, 'author', true);
  if (message.placeId !== null)
    walker.raise({ ...quiet, ...anchor, nodeId: node('place', message.placeId), evidence: 'place', keep: false });
  for (const mention of message.mentions) person(mention, message.trigger ? 'native' : 'edge', message.trigger);
  const replies =
    message.replyTo === null ? [] : [{ id: message.replyTo, evidence: message.trigger ? 'reply' : 'edge' }];
  if (message.trigger) for (const id of walker.repliesInto(message.id)) replies.push({ id, evidence: 'edge' });
  for (const reply of replies) {
    const parent = walker.line(reply.id);
    if (parent === undefined) continue;
    if (parent.author_kind !== 'self') person(text(parent.author_account), reply.evidence as Evidence, false);
    if (!windowIds.has(reply.id))
      found.set(reply.id, {
        sourceId: reply.id,
        evidence: reply.evidence as Evidence,
        ...anchor,
        from: 'reply',
        sources: [],
      });
  }
}

/** The finds a prefetch or a query handed over: a line goes to the excerpts, any other node is raised with its sources. */
function seedCandidates(walker: Walker, candidates: Seeds['candidates'], found: Map<string, ExcerptSeed>): void {
  const quiet = { hop: 0, candidate: false, named: false };
  for (const candidate of candidates) {
    const sources = candidate.sourceIds.map((id) => ({ table: 'sources', id, version: null }));
    if (nodeKindOf(candidate.nodeId) === 'source') {
      const sourceId = rowIdOf(candidate.nodeId, 'source');
      found.set(sourceId, { sourceId, evidence: 'edge', anchor: null, anchorAt: '', from: candidate.from, sources });
    } else
      walker.raise({
        ...quiet,
        nodeId: candidate.nodeId,
        evidence: 'edge',
        anchor: null,
        anchorAt: '',
        keep: false,
        sources,
      });
  }
}

type ExcerptSeed = {
  sourceId: string;
  evidence: Evidence;
  anchor: string | null;
  anchorAt: string;
  from: ExcerptEntry['from'];
  sources: Array<EntrySource>;
};

/** One step of the walk from a raised node: what the listed paths of its kind reach. */
function expand(db: Db, walker: Walker, settings: MindSettings, from: Raised): void {
  const next = { anchor: from.anchor, anchorAt: from.anchorAt, candidate: false, named: false, keep: false };
  const further = from.hop + 1 <= settings.maxHops && !from.candidate;
  if (from.kind === 'person' && further) {
    for (const placeNode of walker.membershipPlaces(from.nodeId))
      walker.raise({ ...next, nodeId: placeNode, evidence: 'edge', hop: from.hop + 1 });
    return;
  }
  if (from.kind === 'interface' && further) {
    for (const placeNode of walker.rootsOf(rowIdOf(from.nodeId, 'interface')))
      walker.raise({ ...next, nodeId: placeNode, evidence: 'edge', hop: from.hop + 1 });
    return;
  }
  if (from.kind !== 'place') return;
  const place = db.prepare('SELECT parent_id FROM places WHERE id = ?').get(rowIdOf(from.nodeId, 'place'));
  const parent = text(place?.parent_id);
  if (parent !== null) {
    const evidence = from.evidence === 'place' ? 'place' : 'edge';
    walker.raise({
      ...next,
      nodeId: node('place', parent),
      evidence,
      hop: from.hop,
      keep: from.keep && evidence === 'place',
    });
    return;
  }
  if (!from.named || !further) return;
  for (const room of walker.roomsOf(rowIdOf(from.nodeId, 'place')))
    walker.raise({ ...next, nodeId: room, evidence: 'edge', hop: from.hop + 1 });
  for (const member of walker.membersOf(from.nodeId))
    walker.raise({ ...next, nodeId: member, evidence: 'edge', hop: from.hop + 1 });
}

/** Every raised node expanded once, the nearest first, until the hops or the rows read run out. */
function walkAll(db: Db, walker: Walker, settings: MindSettings): void {
  const done = new Set<string>();
  for (;;) {
    if (walker.exhausted()) return;
    let pick: Raised | null = null;
    for (const one of walker.raised.values())
      if (!done.has(one.nodeId) && (pick === null || one.hop < pick.hop)) pick = one;
    if (pick === null) return;
    done.add(pick.nodeId);
    expand(db, walker, settings, pick);
  }
}

/** The current descriptions of a subject under the context, one per field, a direct chat's before a group's. */
function descriptionsOf(
  db: Db,
  walker: Walker,
  kind: string,
  id: string
): Map<string, { text: string; source: EntrySource }> {
  const where = walker.aud('d');
  const rows = db
    .prepare(
      `SELECT d.id, d.field, d.current_version, v.text FROM descriptions d JOIN description_versions v ON v.id = d.current_version
       WHERE d.subject_kind = ? AND d.subject_id = ? AND d.retired_at IS NULL AND ${where.sql}
       ORDER BY d.field, d.scope_kind = 'dm' DESC, d.id`
    )
    .all(kind, id, ...where.params);
  const out = new Map<string, { text: string; source: EntrySource }>();
  for (const row of rows) {
    const value = text(row.text);
    if (value === null || out.has(String(row.field))) continue;
    out.set(String(row.field), {
      text: value,
      source: { table: 'descriptions', id: String(row.id), version: text(row.current_version) },
    });
  }
  return out;
}

/** The live claims of `ids` the context reads, those sharing a word with the trigger first. */
function claimsOf(db: Db, walker: Walker, ids: Array<string>, trigger: ReadonlySet<string>): Array<Row> {
  if (ids.length === 0) return [];
  const where = walker.aud('c');
  const rows = db
    .prepare(
      `SELECT c.id, c.kind, c.text, c.subject_id FROM claims c
       WHERE c.id IN (${ids.map(() => '?').join(', ')}) AND c.retired_at IS NULL AND ${where.sql}`
    )
    .all(...ids, ...where.params);
  const order = new Map(ids.map((id, i) => [id, i]));
  const hits = (row: Row): number => (indexWords(row.text).some((word) => trigger.has(word)) ? 0 : 1);
  return rows.sort((a, b) => hits(a) - hits(b) || (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
}

type Built = {
  subtag: Subtag | 'interfaces';
  raised: Raised | null;
  entry: EntryBase;
  render: (detail: Detail) => string;
};

function personOf(
  db: Db,
  walker: Walker,
  raised: Raised,
  trigger: ReadonlySet<string>,
  recent: Map<string, Raised>
): Built | null {
  const personId = rowIdOf(raised.nodeId, 'person');
  const person = db.prepare('SELECT id, real_name, affinity, retired_at FROM people WHERE id = ?').get(personId);
  if (!person || person.retired_at !== null) return null;
  const accounts = walker.accountsOf(raised.nodeId);
  const marks = accounts.map(() => '?').join(', ');
  const accountRows =
    accounts.length === 0
      ? []
      : db.prepare(`SELECT id, names FROM accounts WHERE id IN (${marks}) ORDER BY id`).all(...accounts);
  const descriptions = descriptionsOf(db, walker, 'person', personId);
  const said = walker.about(raised.nodeId);
  for (const one of said) if (one.kind === 'episode') recent.set(one.id, raised);
  const claims = claimsOf(
    db,
    walker,
    said.filter((one) => one.kind === 'claim').map((one) => one.id),
    trigger
  );
  const entry: PersonEntry = {
    ...baseOf(raised),
    personId,
    name: accountRows.flatMap((row) => namesIn(row.names))[0] ?? null,
    realName: namesIn(person.real_name)[0] ?? null,
    affinity: typeof person.affinity === 'number' ? person.affinity : null,
    accounts,
    relation: descriptions.get('relationship')?.text ?? null,
    character: descriptions.get('character')?.text ?? null,
    style: descriptions.get('style')?.text ?? null,
    claims: claims.map((row) => ({ id: String(row.id), kind: String(row.kind), text: text(row.text) ?? '' })),
    sources: [
      { table: 'people', id: personId, version: null },
      ...accountRows.map((row) => ({ table: 'accounts', id: String(row.id), version: null })),
      ...[...descriptions.values()].map((one) => one.source),
      ...claims.map((row) => ({ table: 'claims', id: String(row.id), version: null })),
      ...raised.sources,
    ],
  };
  const render = (detail: Detail): string => {
    const head = [entry.name, entry.realName, ...entry.accounts].filter((one) => one !== null).join(' ');
    if (detail === 'name') return head;
    if (detail === 'compact') return [head, entry.relation].filter((one) => one !== null).join('\n');
    return [head, entry.relation, entry.character, entry.style, ...entry.claims.map((claim) => claim.text)]
      .filter((one) => one !== null)
      .join('\n');
  };
  return { subtag: 'people', raised, entry, render };
}

function placeOf(
  db: Db,
  walker: Walker,
  raised: Raised,
  lore: Array<Built>,
  recent: Map<string, Raised>,
  trigger: ReadonlySet<string>
): Built | null {
  const placeId = rowIdOf(raised.nodeId, 'place');
  const place = db
    .prepare('SELECT id, iface, kind, native_id, name, conversation, retired_at FROM places WHERE id = ?')
    .get(placeId);
  if (!place || place.retired_at !== null) return null;
  const face = db.prepare('SELECT name, extra FROM interfaces WHERE id = ?').get(place.iface);
  const ifaceName = text(face?.name) ?? text(place.iface) ?? '';
  const dm = place.conversation === 'dm' || place.kind === 'dm';
  const dmWord = text(
    (() => {
      try {
        return (JSON.parse(text(face?.extra) ?? '{}') as { dm?: unknown }).dm;
      } catch {
        return null;
      }
    })()
  );
  const chain = placeChainInDb(db, placeId)
    .reverse()
    .map((one) => one.name ?? one.id);
  const path = dm ? [ifaceName, dmWord ?? 'dm', text(place.native_id) ?? placeId] : [ifaceName, ...chain];
  const descriptions = descriptionsOf(db, walker, 'place', placeId);
  const lines = walker.aud('s');
  const mine = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(s.occurred_at) AS last FROM sources s
       WHERE s.place_id = ? AND s.author_kind = 'self' AND s.retired_at IS NULL AND ${lines.sql}`
    )
    .get(placeId, ...lines.params);
  const said = raised.candidate ? [] : walker.about(raised.nodeId);
  for (const one of said) if (one.kind === 'episode') recent.set(one.id, raised);
  for (const row of claimsOf(
    db,
    walker,
    said.filter((one) => one.kind === 'claim').map((one) => one.id),
    trigger
  )) {
    const claim: ClaimEntry = {
      ...baseOf(raised),
      claimId: String(row.id),
      subjectId: placeId,
      kind: String(row.kind),
      text: text(row.text) ?? '',
      sources: [{ table: 'claims', id: String(row.id), version: null }],
    };
    lore.push({ subtag: 'lore', raised, entry: claim, render: () => claim.text });
  }
  const entry: PlaceEntry = {
    ...baseOf(raised),
    placeId,
    iface: text(place.iface),
    kind: text(place.kind),
    name: text(place.name),
    path,
    purpose: descriptions.get('purpose')?.text ?? null,
    tone: descriptions.get('tone')?.text ?? null,
    topics: descriptions.get('topics')?.text ?? null,
    ownLines: Number(mine?.n ?? 0),
    ownLastAt: text(mine?.last),
    sources: [
      { table: 'places', id: placeId, version: null },
      ...[...descriptions.values()].map((one) => one.source),
      ...raised.sources,
    ],
  };
  const render = (detail: Detail): string => {
    const head = entry.path.join(' > ');
    if (detail === 'name') return head;
    if (detail === 'compact') return [head, entry.purpose].filter((one) => one !== null).join('\n');
    return [head, entry.purpose, entry.tone, entry.topics, `${entry.ownLines} ${entry.ownLastAt ?? ''}`]
      .filter((one) => one !== null)
      .join('\n');
  };
  return { subtag: 'places', raised, entry, render };
}

function baseOf(raised: Raised): EntryBase {
  return {
    nodeId: raised.nodeId,
    evidence: raised.evidence,
    detail: detailOf(raised),
    candidate: raised.candidate,
    anchorMessageId: raised.anchor,
    sources: [],
  };
}

function detailOf(raised: Raised): Detail {
  if (raised.candidate || raised.evidence === 'prose') return 'name';
  return WHOLE.has(raised.evidence) ? 'whole' : 'compact';
}

function interfaceOf(db: Db, raised: Raised): Built {
  const iface = rowIdOf(raised.nodeId, 'interface');
  const row = db.prepare('SELECT name FROM interfaces WHERE id = ?').get(iface);
  const entry: InterfaceEntry = {
    ...baseOf(raised),
    iface,
    name: text(row?.name),
    sources: [{ table: 'interfaces', id: iface, version: null }],
  };
  return { subtag: 'interfaces', raised, entry, render: () => entry.name ?? iface };
}

function episodesOf(db: Db, walker: Walker, recent: Map<string, Raised>): Array<Built> {
  const out: Array<Built> = [];
  const where = walker.aud('e');
  const read = db.prepare(
    `SELECT e.id, e.place_id, e.date, e.what, e.created_at FROM episodes e WHERE e.id = ? AND e.retired_at IS NULL AND ${where.sql}`
  );
  for (const [id, raised] of recent) {
    const row = read.get(id, ...where.params);
    if (!row || text(row.what) === null) continue;
    const entry: EpisodeEntry = {
      ...baseOf(raised),
      episodeId: id,
      placeId: text(row.place_id),
      date: text(row.date) ?? text(row.created_at),
      what: String(row.what),
      sources: [{ table: 'episodes', id, version: null }],
    };
    out.push({ subtag: 'recent', raised, entry, render: () => `${entry.date ?? ''} ${entry.what}` });
  }
  return out.sort((a, b) =>
    String((b.entry as EpisodeEntry).date).localeCompare(String((a.entry as EpisodeEntry).date))
  );
}

function excerptsOf(walker: Walker, found: Map<string, ExcerptSeed>): Array<Built> {
  const out: Array<Built> = [];
  for (const seed of found.values()) {
    const row = walker.line(seed.sourceId);
    if (row === undefined) continue;
    const raised: Raised = {
      nodeId: node('source', seed.sourceId),
      kind: 'place',
      evidence: seed.evidence,
      hop: 0,
      anchor: seed.anchor,
      anchorAt: seed.anchorAt,
      candidate: false,
      named: false,
      keep: false,
      own: false,
      sources: [],
    };
    const entry: ExcerptEntry = {
      ...baseOf(raised),
      detail: 'compact',
      sourceId: seed.sourceId,
      placeId: text(row.place_id),
      at: text(row.occurred_at),
      text: text(row.text) ?? '',
      from: seed.from,
      sources: [{ table: 'sources', id: seed.sourceId, version: null }, ...seed.sources],
    };
    out.push({ subtag: 'found', raised, entry, render: () => entry.text });
  }
  return out;
}

/** Names in the claims of the entries rendered whole: the weakest evidence, a name each, never walked further. */
function seedProse(db: Db, ctx: Context, walker: Walker, settings: MindSettings, built: Array<Built>): void {
  for (const one of built) {
    if (one.subtag !== 'people' || one.raised === null || one.entry.detail !== 'whole') continue;
    if (one.raised.hop + 1 > settings.maxHops) continue;
    const anchor = { anchor: one.raised.anchor, anchorAt: one.raised.anchorAt };
    for (const claim of (one.entry as PersonEntry).claims)
      for (const phrase of new Set(phrasesOf(claim.text))) {
        const found = wordHits(db, ctx, walker, settings, phrase, () => false, ['exact']);
        if (found.candidate) continue;
        for (const hit of found.nodes)
          if (!walker.raised.has(hit.nodeId))
            walker.raise({
              ...anchor,
              nodeId: hit.nodeId,
              evidence: 'prose',
              hop: one.raised.hop + 1,
              candidate: false,
              named: false,
              keep: false,
            });
      }
  }
}

/** The order of entries in a subtag: the counterpart, then evidence, hops, the newest anchor, her affinity, the id. */
function compare(a: Built, b: Built): number {
  const ra = a.raised;
  const rb = b.raised;
  if (ra === null || rb === null) return 0;
  const counterpart = Number(rb.evidence === 'counterpart') - Number(ra.evidence === 'counterpart');
  if (counterpart !== 0) return counterpart;
  const own = Number(ra.own) - Number(rb.own);
  if (own !== 0) return own;
  const evidence = rankOf(ra.evidence) - rankOf(rb.evidence);
  if (evidence !== 0) return evidence;
  if (ra.hop !== rb.hop) return ra.hop - rb.hop;
  if (ra.anchorAt !== rb.anchorAt) return ra.anchorAt > rb.anchorAt ? -1 : 1;
  const affinity = ((b.entry as PersonEntry).affinity ?? -Infinity) - ((a.entry as PersonEntry).affinity ?? -Infinity);
  if (Number.isFinite(affinity) && affinity !== 0) return affinity;
  return a.entry.nodeId < b.entry.nodeId ? -1 : a.entry.nodeId > b.entry.nodeId ? 1 : 0;
}

/** Each subtag's tokens: its share, plus what the shares its entries leave unused lend, in the subtags' order. */
function allowances(settings: MindSettings, demand: Record<Subtag, number>): Record<Subtag, number> {
  const budget = Math.max(0, settings.budgetTokens);
  const out = Object.fromEntries(
    SUBTAGS.map((tag) => [tag, Math.floor(budget * Math.max(0, settings.shares[tag]))])
  ) as Record<Subtag, number>;
  let spare = SUBTAGS.reduce((sum, tag) => sum + Math.max(0, out[tag] - demand[tag]), 0);
  for (const tag of SUBTAGS) {
    const want = demand[tag] - out[tag];
    if (want <= 0 || spare <= 0) continue;
    const lent = Math.min(want, spare);
    out[tag] += lent;
    spare -= lent;
  }
  return out;
}

/** The entries the budget keeps, at the detail that fits; the rest counted per subtag. */
function cut(settings: MindSettings, built: Array<Built>): { kept: Array<Built>; leftOut: Record<string, number> } {
  const bySubtag = new Map<Subtag, Array<Built>>(SUBTAGS.map((tag) => [tag, []]));
  const kept: Array<Built> = [];
  for (const one of built) {
    if (one.subtag === 'interfaces') kept.push(one);
    else bySubtag.get(one.subtag)?.push(one);
  }
  const demand = Object.fromEntries(
    SUBTAGS.map((tag) => [
      tag,
      (bySubtag.get(tag) ?? []).reduce((sum, one) => sum + tokensOf(one.render(one.entry.detail)), 0),
    ])
  ) as Record<Subtag, number>;
  const allowance = allowances(settings, demand);
  const leftOut: Record<string, number> = Object.fromEntries(SUBTAGS.map((tag) => [tag, 0]));
  for (const tag of SUBTAGS) {
    let left = allowance[tag];
    for (const one of (bySubtag.get(tag) ?? []).sort(compare)) {
      const raised = one.raised;
      const counterpart = raised?.evidence === 'counterpart';
      const room = counterpart ? Math.max(left, settings.counterpartTokens) : left;
      const details = DETAILS.slice(DETAILS.indexOf(one.entry.detail));
      const fits = details.find((detail) => tokensOf(one.render(detail)) <= room);
      if (fits === undefined && raised?.keep !== true) {
        leftOut[tag] = (leftOut[tag] ?? 0) + 1;
        continue;
      }
      one.entry.detail = fits ?? 'name';
      left -= tokensOf(one.render(one.entry.detail));
      kept.push(one);
    }
  }
  return { kept, leftOut };
}

/**
 * What comes to her mind on a turn: the walk from `seeds` under `ctx`, ranked and cut to the budget of `settings`.
 * `now` is the turn's clock. The rank reads the times of the anchors, so it is not read yet.
 */
export function mindOf(db: Db, ctx: Context, seeds: Seeds, settings: MindSettings, now: number): Mind {
  void now;
  const walker = walkerOf(db, ctx, settings, seeds);
  const window = windowOf(seeds.messages, settings.windowMessages);
  const found = new Map<string, ExcerptSeed>();
  seedTies(walker, seeds, window, found);
  seedWords(db, ctx, walker, settings, window, seeds.place);
  walkAll(db, walker, settings);
  const trigger = new Set(window.filter((message) => message.trigger).flatMap((message) => indexWords(message.text)));
  const lore: Array<Built> = [];
  const recent = new Map<string, Raised>();
  const build = (raised: Raised): Built | null =>
    raised.kind === 'person'
      ? personOf(db, walker, raised, trigger, recent)
      : raised.kind === 'place'
        ? placeOf(db, walker, raised, lore, recent, trigger)
        : interfaceOf(db, raised);
  const first = [...walker.raised.values()].map(build).filter((one): one is Built => one !== null);
  const before = new Set(walker.raised.keys());
  seedProse(db, ctx, walker, settings, first);
  const prose = [...walker.raised.values()].filter((one) => !before.has(one.nodeId)).map(build);
  const built = [
    ...first,
    ...prose.filter((one): one is Built => one !== null),
    ...lore,
    ...episodesOf(db, walker, recent),
    ...excerptsOf(walker, found),
  ];
  const { kept, leftOut } = cut(settings, built);
  const pick = <T extends EntryBase>(tag: Built['subtag']): Array<T> =>
    kept.filter((one) => one.subtag === tag).map((one) => one.entry as T);
  return {
    people: pick<PersonEntry>('people'),
    places: pick<PlaceEntry>('places'),
    interfaces: pick<InterfaceEntry>('interfaces'),
    lore: pick<ClaimEntry>('lore'),
    recent: pick<EpisodeEntry>('recent'),
    found: pick<ExcerptEntry>('found'),
    leftOut,
    reads: walker.reads(),
  };
}
