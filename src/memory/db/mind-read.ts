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
// names.ts), and a name found in the claims of an entry rendered whole (`prose`). The lines she sees beyond the window
// (`seen`) raise their authors and places alone. A word is matched exact, then by stems, then by trigrams. A word
// naming more than `commonWordEntries` entries raises none; several are first narrowed to the people present and the
// places under the current root. One exact match, or one stem match among those, is the entry the word names; what
// stays ambiguous, or is matched by trigram or by stem elsewhere, is raised as a candidate. An interface's noun for a
// kind of place raises the places of that kind on that interface instead.
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
// natively or by a word that names one entry are kept whatever the budget, at the detail that fits or as a name.

import { estimateTokens } from '../../llm/tokens.ts';
import { indexWords } from '../record-index.ts';
import { graphNodeId } from './graph.ts';
import { SELF_PERSON } from './ids.ts';
import { profileAccountsOf } from './meta-person.ts';
import { interestClaimsOf, storedAvatarOf, usualNameOf } from './person-fields.ts';
import type { PersonAccount, ProfileAccount } from './meta-person.ts';
import { IS_WRITTEN_ROW, LINE_AUTHOR_ACCOUNT, LINE_AUTHOR_KIND, LINE_MOMENT } from './source-current.ts';
import { loadStemmer } from './stems.ts';
import { interfaceNouns, matchName, normalName, phrasesOf, namesIn } from './names.ts';
import type { NameHitRow, NameMatch, NodeRef } from './names.ts';
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
/** One change of her attitude toward a person: the applied change, when it was stored and why. */
export type AttitudeMove = { delta: number; at: string; reason: string | null };
export type PersonEntry = EntryBase & {
  personId: string;
  name: string | null;
  realName: string | null;
  affinity: number | null;
  /**
   * Her attitude toward the person as the context may read it: the score and reason of the newest change of
   * `affinity_events` (never `people.affinity`) and the newest changes, newest first, at most `attitudeMoves` of them.
   * `delta` is the applied change, `at` the stored ISO string. Null when the context reads no change.
   */
  attitude: { score: number; reason: string | null; moves: ReadonlyArray<AttitudeMove> } | null;
  /** The account row ids she knows the person through. */
  accounts: Array<string>;
  /** Every account of `accounts` that has a row, with its interface and platform id, in id order. */
  platformAccounts: Array<PersonAccount>;
  /** Every account of the person the context may see, with its interface, platform id and own fields (meta-person.ts). */
  profileAccounts: Array<ProfileAccount>;
  relation: string | null;
  character: string | null;
  style: string | null;
  claims: Array<{ id: string; kind: string; text: string }>;
  /** The texts of the interest claims about the person that the context may read, the highest ranked first, at most `settings.interests`. */
  interests: Array<string>;
  /** The name the person is addressed by most, by the decayed score of `rankAddressed`, or null. */
  usualName: string | null;
  /** How many messages of the person she has seen, `people.message_count`, or null. */
  messagesSeen: number | null;
  /** True for a person the reader keeps whatever their room: the person she answers, an author of the window, one the trigger names. */
  keep?: boolean;
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
  /** The moment she joined the place, milliseconds since the epoch: a root's, null when the store knows none. */
  joinedAt: number | null;
  ownLines: number;
  ownLastAt: string | null;
  /** True for a place the reader keeps whatever its room: the turn's own place and a place the answered line names. */
  keep?: boolean;
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
/** A seed of an earlier turn of this chat, by its graph node's kind and row. */
export type EntryRef = NodeRef;
export type Seeds = {
  messages: Array<SeedMessage>;
  counterpart: { personId: string; accountId: string } | null;
  place: string | null;
  previous: Array<EntryRef>;
  candidates: Array<NodeRef & { sourceIds: Array<string>; from: 'prefetch' | 'query' }>;
  /**
   * The stored source ids of the lines she sees beyond the window (`<meanwhile>` and `<recall>` of a reply): each line's
   * author is raised as an author and its place as a place, kept only as the budget allows, and its words raise nothing.
   */
  seen?: Array<string>;
  /**
   * True for a read of the seeds alone (memory.read, src/turn/memory-read.ts): no place she wrote in, no walk and no name
   * in a claim joins them, so what comes back is the seeds' own entries, their lore and their episodes.
   */
  alone?: boolean;
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
  /** How many of her latest attitude changes toward a person an entry carries after the score; 0 carries none. */
  attitudeMoves: number;
  /** How many interests of a person an entry lists, the highest ranked first; 0 lists none. */
  interests: number;
  fanOut: { accounts: number; memberships: number; rooms: number; members: number; replies: number; about: number };
};

/** The shipped values of `context.memory` in config/config.json, for a key the live settings lack. */
export const MIND_DEFAULTS: Readonly<MindSettings> = Object.freeze({
  windowMessages: 100,
  maxHops: 2,
  maxNodesRead: 2000,
  budgetTokens: 10000,
  shares: { people: 0.4, places: 0.3, lore: 0.15, recent: 0.1, found: 0.05 },
  counterpartTokens: 1500,
  candidatesMax: 3,
  commonWordEntries: 3,
  attitudeMoves: 2,
  interests: 5,
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

/** The shipped `context.memory.budgetShare`, for live settings that lack the key. */
const BUDGET_SHARE_DEFAULT = 0.1;

/**
 * The total of the memory blocks: `budgetTokens`, lowered to `floor(budgetShare * llm.maxRequestTokens)` when the
 * share is a number above 0 and up to 1 and the cap is a positive number. A missing share is BUDGET_SHARE_DEFAULT, and
 * any other share, `null` included, counts as unset.
 */
function budgetTotalOf(budgetTokens: number, given: unknown, llm: unknown): number {
  const share = given === undefined ? BUDGET_SHARE_DEFAULT : given;
  const cap = isObj(llm) ? llm.maxRequestTokens : null;
  if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0 || share > 1) return budgetTokens;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return budgetTokens;
  return Math.min(budgetTokens, Math.floor(share * cap));
}

/** The reader's settings from the live config (`context.memory`), each missing or broken key at its shipped value. */
export function mindSettingsOf(config: unknown): MindSettings {
  const context = isObj(config) && isObj(config.context) ? config.context : {};
  const memory = isObj(context.memory) ? context.memory : {};
  const { shares, fanOut, ...plain } = MIND_DEFAULTS;
  const settings = numbers(memory, plain);
  return {
    ...settings,
    budgetTokens: budgetTotalOf(settings.budgetTokens, memory.budgetShare, isObj(config) ? config.llm : null),
    shares: numbers(memory.shares, shares),
    fanOut: numbers(memory.fanOut, fanOut),
  };
}

/**
 * The count of her lines in a place as a request shows it: the largest of 1, 2, 5, 10, 20, 50, 100 and so on that is not
 * above `count`, 0 for none. The exact count grows with every line she writes, and the rounded one keeps a place's entry
 * the same bytes between turns until it crosses a step (the owner's decision of 2026-11-11, the request laid out for the
 * prompt cache).
 */
export function ownLinesShown(count: number): number {
  if (!Number.isFinite(count) || count < 1) return 0;
  let step = 1;
  for (let scale = 1; scale <= count; scale *= 10)
    for (const mark of [1, 2, 5]) if (mark * scale <= count) step = mark * scale;
  return step;
}

/** The kinds of evidence, strongest first. */
export const EVIDENCE_ORDER: ReadonlyArray<Evidence> = [
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
// `found` stands last: it is filled from what the four stable shares leave (`allowances`).
const SUBTAGS = ['people', 'places', 'lore', 'recent', 'found'] as const;
type Subtag = (typeof SUBTAGS)[number];
const rankOf = (evidence: Evidence): number => EVIDENCE_ORDER.indexOf(evidence);

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
/** A graph node with its kind and row: the node id is never read back for either. */
type Node = NodeRef & { nodeId: string };
/** The node of a row the caller holds, by `graphNodeId`. */
const nodeOf = (kind: string, rowId: string): Node => ({ nodeId: graphNodeId(kind, rowId), kind, rowId });
/** The node a query read with its `graph_nodes` row, as `node`, `kind` and `row_id`. */
const readNode = (row: Row): Node => ({ nodeId: String(row.node), kind: String(row.kind), rowId: String(row.row_id) });
const tokensOf = (rendered: string): number => (rendered === '' ? 0 : estimateTokens(rendered) + 2);

/** A raised node before its rows are read. */
type Raised = {
  nodeId: string;
  kind: 'person' | 'place' | 'interface';
  rowId: string;
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
type Raise = Omit<Raised, 'kind' | 'sources' | 'own'> & { kind: string; sources?: Array<EntrySource>; own?: boolean };
type Sql = { sql: string; params: Array<string | number> };
/** How many line ids one query of the seen lines binds: below SQLite's default bound of 999 parameters with the audience's. */
const LINES_PER_QUERY = 500;
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
  function visible({ nodeId, kind, rowId }: Node): boolean {
    if (kind === 'interface' || ctx.internal === true) return true;
    if (kind === 'place') {
      const place = db.prepare('SELECT id, iface, kind, chat, retired_at FROM places WHERE id = ?').get(rowId);
      if (!place || place.retired_at !== null) return false;
      const own =
        place.chat === 'dm' || place.kind === 'dm'
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
    const { kind } = given;
    if (!RAISED_KINDS.has(kind) || (kind === 'person' && given.rowId === SELF_PERSON)) return;
    const found = raised.get(given.nodeId);
    if (found === undefined) {
      if (!visible(given)) return;
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

  /** The person an account's node belongs to, through its live verified link. */
  function personOfAccount(accountNode: string): Node | null {
    const edge = aud('e');
    const from = nodeOk('e.src', 'a1');
    const to = nodeOk('e.dst', 'a2');
    const [row] = all(
      'account_of',
      `SELECT e.dst AS node, n.kind, n.row_id FROM graph_edges e JOIN graph_nodes n ON n.id = e.dst
       WHERE e.src = ? AND e.predicate = 'account_of' AND ${live('e')} AND ${edge.sql} AND ${from.sql} AND ${to.sql}
       ORDER BY e.recorded_at DESC, e.dst LIMIT 1`,
      [accountNode, ...edge.params, ...from.params, ...to.params]
    );
    return row === undefined ? null : readNode(row);
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
  function membershipPlaces(personNode: string): Array<Node> {
    const [ao, hm, mi] = [aud('ao'), aud('hm'), aud('mi')];
    const [account, membership] = [nodeOk('ao.src', 'a1'), nodeOk('hm.dst', 'a2')];
    return all(
      'memberships',
      `SELECT mi.dst AS node, pn.kind, pn.row_id, MAX(mi.recorded_at) AS at FROM graph_edges ao
       JOIN graph_edges hm ON hm.src = ao.src AND hm.predicate = 'has_membership' AND ${live('hm')} AND ${hm.sql}
       JOIN graph_edges mi ON mi.src = hm.dst AND mi.predicate = 'membership_in' AND ${live('mi')} AND ${mi.sql}
       JOIN graph_nodes pn ON pn.id = mi.dst
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
    ).map(readNode);
  }

  /** The rooms of a root, by her own line count in each, then by id. */
  function roomsOf(rootId: string): Array<Node> {
    const lines = aud('s');
    return all(
      'rooms',
      `SELECT p.id, (SELECT COUNT(*) FROM sources s WHERE s.place_id = p.id AND s.author_kind = 'self'
         AND s.retired_at IS NULL AND ${IS_WRITTEN_ROW} AND ${lines.sql}) AS mine
       FROM places p WHERE p.parent_id = ? AND p.retired_at IS NULL ORDER BY mine DESC, p.id LIMIT ?`,
      [...lines.params, rootId, settings.fanOut.rooms]
    ).map((row) => nodeOf('place', String(row.id)));
  }

  /** The members of a root, by her affinity to each (none last), then by id; she and the counterpart are not listed. */
  function membersOf(rootNode: string): Array<Node> {
    const [mi, hm, ao] = [aud('mi'), aud('hm'), aud('ao')];
    const [membership, person] = [nodeOk('mi.src', 'a1'), nodeOk('ao.dst', 'a2')];
    const skip = [SELF_PERSON, counterpartPerson ?? SELF_PERSON];
    return all(
      'members',
      `SELECT ao.dst AS node, pn.kind, pn.row_id, MAX(pe.affinity) AS affinity FROM graph_edges mi
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
    ).map(readNode);
  }

  /** The top places of an interface, a direct chat excepted. */
  function rootsOf(iface: string): Array<Node> {
    return all(
      'roots',
      `SELECT id FROM places WHERE iface = ? AND parent_id IS NULL AND retired_at IS NULL
         AND COALESCE(chat, '') <> 'dm' AND kind <> 'dm' ORDER BY id LIMIT ?`,
      [iface, settings.maxNodesRead]
    ).map((row) => nodeOf('place', String(row.id)));
  }

  /** The places of one kind on an interface, by her own line count. */
  function placesOfKind(iface: string, kind: string): Array<Node> {
    const lines = aud('s');
    return all(
      'kind',
      `SELECT p.id, (SELECT COUNT(*) FROM sources s WHERE s.place_id = p.id AND s.author_kind = 'self'
         AND s.retired_at IS NULL AND ${IS_WRITTEN_ROW} AND ${lines.sql}) AS mine
       FROM places p WHERE p.iface = ? AND p.kind = ? AND p.retired_at IS NULL ORDER BY mine DESC, p.id LIMIT ?`,
      [...lines.params, iface, kind, settings.fanOut.rooms]
    ).map((row) => nodeOf('place', String(row.id)));
  }

  /** The places she wrote in lately, newest first. */
  function ownPlaces(): Array<Node> {
    const lines = aud('s');
    return all(
      'own',
      `SELECT s.place_id, MAX(s.occurred_at) AS last FROM sources s
       WHERE s.author_kind = 'self' AND s.retired_at IS NULL AND ${IS_WRITTEN_ROW} AND s.place_id IS NOT NULL AND ${lines.sql}
       GROUP BY s.place_id ORDER BY last DESC, s.place_id LIMIT ?`,
      [...lines.params, settings.fanOut.rooms]
    ).map((row) => nodeOf('place', String(row.place_id)));
  }

  /** A stored line the context reads: its author, place, time and text. */
  function line(sourceId: string): Row | undefined {
    const where = aud('s');
    return all(
      'line',
      `SELECT s.id, ${LINE_AUTHOR_ACCOUNT} AS author_account, ${LINE_AUTHOR_KIND} AS author_kind, s.place_id, ${LINE_MOMENT} AS occurred_at, s.text FROM sources s
       WHERE s.id = ? AND s.retired_at IS NULL AND ${where.sql}`,
      [sourceId, ...where.params]
    )[0];
  }

  /** The stored lines of `ids` the context reads, each id once, read in chunks that stay under SQLite's bound of parameters. */
  function linesOf(ids: ReadonlyArray<string>): Array<Row> {
    const where = aud('s');
    const unique = [...new Set(ids)];
    const out: Array<Row> = [];
    for (let at = 0; at < unique.length; at += LINES_PER_QUERY) {
      const chunk = unique.slice(at, at + LINES_PER_QUERY);
      out.push(
        ...all(
          'seen',
          `SELECT s.id, ${LINE_AUTHOR_ACCOUNT} AS author_account, ${LINE_AUTHOR_KIND} AS author_kind, s.place_id, ${LINE_MOMENT} AS occurred_at FROM sources s
           WHERE s.id IN (${chunk.map(() => '?').join(', ')}) AND s.retired_at IS NULL AND ${where.sql}`,
          [...chunk, ...where.params]
        )
      );
    }
    return out;
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
      [graphNodeId('source', sourceId), ...edge.params, ...from.params, settings.fanOut.replies]
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
    linesOf,
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

/** One node a phrase names, the way it matched and the folded name it matched by. */
type WordNode = { target: Node; match: NameMatch; normalized: string };
type WordHits = { nouns: Array<NameHitRow>; nodes: Array<WordNode>; candidate: boolean };

/**
 * One node matched exactly, or one matched by stem or by script key among the people present or the places under the
 * current root, is the one the phrase names; any other match is a candidate.
 */
function isSure(nodes: ReadonlyArray<WordNode>, present: (target: Node) => boolean): boolean {
  const [single] = nodes;
  return (
    nodes.length === 1 &&
    (single.match === 'exact' || ((single.match === 'stem' || single.match === 'script') && present(single.target)))
  );
}

/** What one word of the window names, after the narrowing and the common-word rule. */
function wordHits(
  db: Db,
  ctx: Context,
  walker: Walker,
  settings: MindSettings,
  phrase: string,
  present: (target: Node) => boolean,
  only?: ReadonlyArray<NameMatch>
): WordHits {
  const hits = matchName(db, ctx, phrase, only, walker.stem);
  const nouns = hits.filter((hit) => hit.kind === 'interface_noun');
  const byNode = new Map<string, WordNode>();
  for (const hit of hits) {
    if (hit.kind === 'interface_noun' || hit.node === null) continue;
    const target =
      hit.node.kind === 'account' ? walker.personOfAccount(hit.nodeId) : { nodeId: hit.nodeId, ...hit.node };
    if (target === null || (target.kind === 'person' && target.rowId === SELF_PERSON) || byNode.has(target.nodeId))
      continue;
    byNode.set(target.nodeId, { target, match: hit.match, normalized: hit.normalized });
  }
  let nodes = [...byNode.values()];
  if (nodes.length > 1) {
    const near = nodes.filter((one) => present(one.target));
    if (near.length > 0) nodes = near;
  }
  if (nodes.length > settings.commonWordEntries) return { nouns, nodes: [], candidate: false };
  const candidate = nodes.length > 0 && !isSure(nodes, present);
  return { nouns, nodes: nodes.slice(0, Math.max(1, settings.candidatesMax)), candidate };
}

/**
 * What a single word names once the longer phrases of its line are read: a hit of a phrase of two or three words that
 * holds the word wins over the word's own hits, unless a hit of the word matches its name exactly and that name is no
 * part of the name the longer phrase matched.
 */
function withoutInnerHits(
  word: string,
  found: WordHits,
  longer: ReadonlyArray<{ phrase: string; nodes: ReadonlyArray<WordNode> }>,
  present: (target: Node) => boolean
): WordHits {
  const holding = longer.filter((one) => one.nodes.length > 0 && ` ${one.phrase} `.includes(` ${word} `));
  if (holding.length === 0 || found.nodes.length === 0) return found;
  const names = holding.flatMap((one) => one.nodes.map((node) => ` ${node.normalized} `));
  const nodes = found.nodes.filter(
    (node) => node.match === 'exact' && !names.some((name) => name.includes(` ${node.normalized} `))
  );
  return { nouns: found.nouns, nodes, candidate: nodes.length > 0 && !isSure(nodes, present) };
}

/** The places of the current root and the people already raised as present: what narrows an ambiguous word. */
function presenceOf(db: Db, walker: Walker, place: string | null): (target: Node) => boolean {
  const root = place === null ? null : (placeChainInDb(db, place).at(-1)?.id ?? null);
  return (target) => {
    const found = walker.raised.get(target.nodeId);
    if (found !== undefined && ['counterpart', 'author', 'native', 'reply'].includes(found.evidence)) return true;
    if (root === null || target.kind !== 'place') return false;
    return placeChainInDb(db, target.rowId).some((one) => one.id === root);
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
  const cache = new Map<string, WordHits>();
  const hitsOf = (phrase: string): WordHits => {
    let found = cache.get(phrase);
    if (found === undefined) {
      found = wordHits(db, ctx, walker, settings, phrase, present);
      cache.set(phrase, found);
    }
    return found;
  };
  for (const message of window) {
    const phrases = [...new Set(phrasesOf(message.text))];
    const longer = phrases
      .filter((phrase) => phrase.includes(' '))
      .map((phrase) => ({ phrase, nodes: hitsOf(phrase).nodes }));
    for (const phrase of phrases) {
      const read = hitsOf(phrase);
      const found = phrase.includes(' ') ? read : withoutInnerHits(phrase, read, longer, present);
      const base = { evidence: 'word' as const, hop: 0, anchor: message.id, anchorAt: message.at, own: false };
      for (const one of found.nodes)
        walker.raise({
          ...base,
          ...one.target,
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
  if (noun.node?.kind !== 'interface') return;
  const iface = noun.node.rowId;
  const extra = db.prepare('SELECT extra FROM interfaces WHERE id = ?').get(iface)?.extra;
  const kind = Object.entries(interfaceNouns(extra)).find(([, word]) => normalName(word) === noun.normalized)?.[0];
  if (kind === undefined) return;
  for (const placeNode of walker.placesOfKind(iface, kind))
    walker.raise({ ...base, ...placeNode, candidate: false, named: false, keep: false });
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
      ...nodeOf('person', seeds.counterpart.personId),
      evidence: 'counterpart',
      anchor: trigger?.id ?? null,
      anchorAt: at,
      keep: true,
    });
  if (seeds.place !== null)
    walker.raise({
      ...quiet,
      ...nodeOf('place', seeds.place),
      evidence: 'place',
      anchor: null,
      anchorAt: '',
      keep: true,
    });
  for (const message of window) seedMessageTies(walker, message, windowIds, found);
  for (const ref of seeds.previous)
    walker.raise({
      ...quiet,
      ...nodeOf(ref.kind, ref.rowId),
      evidence: 'edge',
      anchor: null,
      anchorAt: '',
      keep: false,
    });
  seedCandidates(walker, seeds.candidates, found);
  if (seeds.alone === true) return;
  for (const placeNode of walker.ownPlaces())
    walker.raise({ ...quiet, ...placeNode, evidence: 'edge', anchor: null, anchorAt: '', keep: false, own: true });
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
    const target = account === null ? null : walker.personOfAccount(graphNodeId('account', account));
    if (target !== null) walker.raise({ ...quiet, ...anchor, ...target, evidence, keep });
  };
  person(message.authorAccount, 'author', true);
  if (message.placeId !== null)
    walker.raise({ ...quiet, ...anchor, ...nodeOf('place', message.placeId), evidence: 'place', keep: false });
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

/**
 * The lines she sees beyond the window (`Seeds.seen`): each line's author as an author and its place as a place, both
 * anchored at the line and neither kept whatever the budget. Her own lines raise their place alone.
 */
function seedSeen(walker: Walker, ids: ReadonlyArray<string>): void {
  const quiet = { hop: 0, candidate: false, named: false, keep: false };
  const people = new Map<string, Node | null>();
  for (const row of walker.linesOf(ids)) {
    const anchor = { anchor: String(row.id), anchorAt: text(row.occurred_at) ?? '' };
    const place = text(row.place_id);
    if (place !== null) walker.raise({ ...quiet, ...anchor, ...nodeOf('place', place), evidence: 'place' });
    const account = row.author_kind === 'self' ? null : text(row.author_account);
    if (account === null) continue;
    if (!people.has(account)) people.set(account, walker.personOfAccount(graphNodeId('account', account)));
    const person = people.get(account) ?? null;
    if (person !== null) walker.raise({ ...quiet, ...anchor, ...person, evidence: 'author' });
  }
}

/** The finds a prefetch or a query handed over: a line goes to the excerpts, any other node is raised with its sources. */
function seedCandidates(walker: Walker, candidates: Seeds['candidates'], found: Map<string, ExcerptSeed>): void {
  const quiet = { hop: 0, candidate: false, named: false };
  for (const candidate of candidates) {
    const sources = candidate.sourceIds.map((id) => ({ table: 'sources', id, version: null }));
    if (candidate.kind === 'source') {
      const sourceId = candidate.rowId;
      found.set(sourceId, { sourceId, evidence: 'edge', anchor: null, anchorAt: '', from: candidate.from, sources });
    } else
      walker.raise({
        ...quiet,
        ...nodeOf(candidate.kind, candidate.rowId),
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
      walker.raise({ ...next, ...placeNode, evidence: 'edge', hop: from.hop + 1 });
    return;
  }
  if (from.kind === 'interface' && further) {
    for (const placeNode of walker.rootsOf(from.rowId))
      walker.raise({ ...next, ...placeNode, evidence: 'edge', hop: from.hop + 1 });
    return;
  }
  if (from.kind !== 'place') return;
  const place = db.prepare('SELECT parent_id FROM places WHERE id = ?').get(from.rowId);
  const parent = text(place?.parent_id);
  if (parent !== null) {
    const evidence = from.evidence === 'place' ? 'place' : 'edge';
    walker.raise({
      ...next,
      ...nodeOf('place', parent),
      evidence,
      hop: from.hop,
      keep: from.keep && evidence === 'place',
    });
    return;
  }
  if (!from.named || !further) return;
  for (const room of walker.roomsOf(from.rowId))
    walker.raise({ ...next, ...room, evidence: 'edge', hop: from.hop + 1 });
  for (const member of walker.membersOf(from.nodeId))
    walker.raise({ ...next, ...member, evidence: 'edge', hop: from.hop + 1 });
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

/**
 * The live claims of `ids` the context reads, those sharing a word with the trigger first. The in-jokes of a root and
 * her lessons (whether stored about a place or about herself) are no claim of the graph reader's lore: `<root>` and `<lessons>` hold them.
 */
function claimsOf(db: Db, walker: Walker, ids: Array<string>, trigger: ReadonlySet<string>): Array<Row> {
  if (ids.length === 0) return [];
  const where = walker.aud('c');
  const rows = db
    .prepare(
      `SELECT c.id, c.kind, c.text, c.subject_id FROM claims c
       WHERE c.id IN (${ids.map(() => '?').join(', ')}) AND c.retired_at IS NULL
         AND COALESCE(c.kind, '') NOT IN ('injoke', 'lesson') AND ${where.sql}`
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

/** Her attitude toward a person under the walker's context: the newest change's score and reason, and the newest moves. */
function attitudeOf(db: Db, walker: Walker, personId: string, settings: MindSettings): PersonEntry['attitude'] {
  const audience = walker.aud('e');
  const rows = db
    .prepare(
      `SELECT e.at, e.applied, e.score, e.reason FROM affinity_events e
       WHERE e.person_id = ? AND e.retired_at IS NULL AND ${audience.sql}
       ORDER BY e.at DESC, e.id DESC LIMIT ?`
    )
    .all(personId, ...audience.params, Math.max(1, Math.floor(settings.attitudeMoves)));
  const [newest] = rows;
  if (!newest || typeof newest.score !== 'number') return null;
  const moves = rows
    .slice(0, Math.floor(settings.attitudeMoves))
    .flatMap((row) =>
      typeof row.applied === 'number' && typeof row.at === 'string'
        ? [{ delta: row.applied, at: row.at, reason: text(row.reason) }]
        : []
    );
  return { score: newest.score, reason: text(newest.reason), moves };
}

/** The text the budget weighs for a person's entry at `detail`: the heading, then what the detail adds. */
function personRender(entry: PersonEntry, detail: Detail): string {
  const head = [entry.name, entry.realName, ...entry.accounts].filter((one) => one !== null).join(' ');
  if (detail === 'name') return head;
  if (detail === 'compact') return [head, entry.relation].filter((one) => one !== null).join('\n');
  const described = entry.profileAccounts.map((one) => storedAvatarOf(one.avatar)).find((one) => one && 'text' in one);
  const fields = [
    entry.interests.join('; '),
    described && 'text' in described ? described.text : null,
    entry.usualName,
    entry.messagesSeen === null ? null : String(entry.messagesSeen),
  ];
  return [head, entry.relation, entry.character, entry.style, ...fields, ...entry.claims.map((claim) => claim.text)]
    .filter((one) => one !== null && one !== '')
    .join('\n');
}

function personOf(
  db: Db,
  walker: Walker,
  settings: MindSettings,
  raised: Raised,
  trigger: ReadonlySet<string>,
  recent: Map<string, Raised>,
  now: number
): Built | null {
  const personId = raised.rowId;
  const person = db
    .prepare('SELECT id, real_name, affinity, message_count, retired_at FROM people WHERE id = ?')
    .get(personId);
  if (!person || person.retired_at !== null) return null;
  const profileAccounts = profileAccountsOf(db, personId).filter((one) => walker.visible(nodeOf('account', one.id)));
  const accounts = [...new Set([...walker.accountsOf(raised.nodeId), ...profileAccounts.map((one) => one.id)])].sort();
  const marks = accounts.map(() => '?').join(', ');
  const accountRows =
    accounts.length === 0
      ? []
      : db
          .prepare(`SELECT id, names, iface, native_id FROM accounts WHERE id IN (${marks}) ORDER BY id`)
          .all(...accounts);
  const descriptions = descriptionsOf(db, walker, 'person', personId);
  const said = walker.about(raised.nodeId);
  for (const one of said) if (one.kind === 'episode') recent.set(one.id, raised);
  const listed = interestClaimsOf(db, walker.aud('c'), personId, settings.interests);
  const listedIds = new Set(listed.map((one) => one.id));
  const claims = claimsOf(
    db,
    walker,
    said.filter((one) => one.kind === 'claim' && !listedIds.has(one.id)).map((one) => one.id),
    trigger
  );
  const entry: PersonEntry = {
    ...baseOf(raised),
    personId,
    name: accountRows.flatMap((row) => namesIn(row.names))[0] ?? null,
    realName: namesIn(person.real_name)[0] ?? null,
    affinity: typeof person.affinity === 'number' ? person.affinity : null,
    attitude: attitudeOf(db, walker, personId, settings),
    accounts,
    platformAccounts: accountRows.flatMap((row) =>
      typeof row.iface === 'string' && typeof row.native_id === 'string'
        ? [{ id: String(row.id), iface: row.iface, platformId: row.native_id }]
        : []
    ),
    profileAccounts,
    relation: descriptions.get('relationship')?.text ?? null,
    character: descriptions.get('character')?.text ?? null,
    style: descriptions.get('style')?.text ?? null,
    claims: claims.map((row) => ({ id: String(row.id), kind: String(row.kind), text: text(row.text) ?? '' })),
    interests: listed.map((one) => one.text),
    usualName: usualNameOf(db, accounts, (id) => walker.visible(nodeOf('place', id)), now),
    messagesSeen: typeof person.message_count === 'number' ? person.message_count : null,
    ...(raised.keep ? { keep: true } : {}),
    sources: [
      { table: 'people', id: personId, version: null },
      ...listed.map((one) => ({ table: 'claims', id: one.id, version: null })),
      ...accountRows.map((row) => ({ table: 'accounts', id: String(row.id), version: null })),
      ...[...descriptions.values()].map((one) => one.source),
      ...claims.map((row) => ({ table: 'claims', id: String(row.id), version: null })),
      ...raised.sources,
    ],
  };
  const render = (detail: Detail): string => personRender(entry, detail);
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
  const placeId = raised.rowId;
  const place = db
    .prepare('SELECT id, iface, kind, native_id, name, chat, retired_at FROM places WHERE id = ?')
    .get(placeId);
  if (!place || place.retired_at !== null) return null;
  const face = db.prepare('SELECT name, extra FROM interfaces WHERE id = ?').get(place.iface);
  const ifaceName = text(face?.name) ?? text(place.iface) ?? '';
  const dm = place.chat === 'dm' || place.kind === 'dm';
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
       WHERE s.place_id = ? AND s.author_kind = 'self' AND s.retired_at IS NULL AND ${IS_WRITTEN_ROW} AND ${lines.sql}`
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
    joinedAt: joinedAtOfPlace(db, placeId),
    ownLines: Number(mine?.n ?? 0),
    ownLastAt: text(mine?.last),
    ...(raised.keep ? { keep: true } : {}),
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
    return [head, entry.purpose, entry.tone, entry.topics, `${ownLinesShown(entry.ownLines)} ${entry.ownLastAt ?? ''}`]
      .filter((one) => one !== null)
      .join('\n');
  };
  return { subtag: 'places', raised, entry, render };
}

/** The moment she joined a place, from the `joinedAt` its `extra` holds; null when it holds none. */
function joinedAtOfPlace(db: Db, placeId: string): number | null {
  const row = db
    .prepare(
      "SELECT CASE WHEN json_valid(extra) THEN json_extract(extra, '$.joinedAt') END AS joined FROM places WHERE id = ?"
    )
    .get(placeId);
  return typeof row?.joined === 'number' && Number.isFinite(row.joined) ? row.joined : null;
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

/**
 * The strongest evidence class present renders whole. A reply always has one of `WHOLE`; a turn with nothing to answer
 * (a service, seeded from her own lines) has authors and places at best, and those then render whole.
 */
function promoteStrongest(built: ReadonlyArray<Built>): void {
  const ranks = built.flatMap((one) =>
    one.raised && !one.raised.candidate && one.entry.detail !== 'name' ? [rankOf(one.raised.evidence)] : []
  );
  if (ranks.length === 0) return;
  const top = EVIDENCE_ORDER[Math.min(...ranks)];
  if (top === undefined || WHOLE.has(top)) return;
  for (const one of built)
    if (one.raised?.evidence === top && !one.raised.candidate && one.entry.detail === 'compact')
      one.entry.detail = 'whole';
}

function interfaceOf(db: Db, raised: Raised): Built {
  const iface = raised.rowId;
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
      nodeId: graphNodeId('source', seed.sourceId),
      kind: 'place',
      rowId: seed.sourceId,
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
          if (!walker.raised.has(hit.target.nodeId))
            walker.raise({
              ...anchor,
              ...hit.target,
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

/**
 * Each subtag's tokens: its share of `budgetTokens`, plus what the shares their entries leave unused lend, in the
 * subtags' order. `demand` is what each subtag's entries would take. The four stable shares lend among themselves.
 * `found`, the turn's own, lends nothing, so the detail of a stable entry never follows what the turn found, and it is
 * filled last from what the four leave. The request's second cut (src/turn/request/reader.ts) lends by the same rule.
 */
export function allowances(
  settings: Pick<MindSettings, 'budgetTokens' | 'shares'>,
  demand: Readonly<Record<Subtag, number>>
): Record<Subtag, number> {
  const budget = Math.max(0, settings.budgetTokens);
  const out = Object.fromEntries(
    SUBTAGS.map((tag) => [tag, Math.floor(budget * Math.max(0, settings.shares[tag]))])
  ) as Record<Subtag, number>;
  let spare = SUBTAGS.reduce((sum, tag) => (tag === 'found' ? sum : sum + Math.max(0, out[tag] - demand[tag])), 0);
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
 * `now` is the turn's clock, the one the usual name of a person decays its scores to.
 */
export function mindOf(db: Db, ctx: Context, seeds: Seeds, settings: MindSettings, now: number): Mind {
  const walker = walkerOf(db, ctx, settings, seeds);
  const window = windowOf(seeds.messages, settings.windowMessages);
  const found = new Map<string, ExcerptSeed>();
  seedTies(walker, seeds, window, found);
  seedWords(db, ctx, walker, settings, window, seeds.place);
  // After the words, so an author seen only elsewhere does not count as present when a word is narrowed.
  seedSeen(walker, seeds.seen ?? []);
  if (seeds.alone !== true) walkAll(db, walker, settings);
  const trigger = new Set(window.filter((message) => message.trigger).flatMap((message) => indexWords(message.text)));
  const lore: Array<Built> = [];
  const recent = new Map<string, Raised>();
  const build = (raised: Raised): Built | null =>
    raised.kind === 'person'
      ? personOf(db, walker, settings, raised, trigger, recent, now)
      : raised.kind === 'place'
        ? placeOf(db, walker, raised, lore, recent, trigger)
        : interfaceOf(db, raised);
  const first = [...walker.raised.values()].map(build).filter((one): one is Built => one !== null);
  const before = new Set(walker.raised.keys());
  if (seeds.alone !== true) seedProse(db, ctx, walker, settings, first);
  const prose = [...walker.raised.values()].filter((one) => !before.has(one.nodeId)).map(build);
  const built = [
    ...first,
    ...prose.filter((one): one is Built => one !== null),
    ...lore,
    ...episodesOf(db, walker, recent),
    ...excerptsOf(walker, found),
  ];
  promoteStrongest(built);
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
