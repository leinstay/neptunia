// A synthetic world for the semantic memory tests: two people with a DM each, a group room, sources under each
// audience, the contexts the core would issue, and helpers that write entities and assertions through the one writer
// (semantic-write.ts) with an injected clock and uuid. Every structured row in a test comes through that writer, so a
// test that reads it proves the whole path. The names (Lumen, Orbis, Echo, Alex, Mira) are invented.
import path from 'node:path';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { groupsContext, internalContext, issueContext } from '../../../src/memory/db/scope.ts';
import type { Context } from '../../../src/memory/db/scope.ts';
import { applySemanticWrite, validateSemanticCandidate } from '../../../src/memory/db/semantic-write.ts';
import type {
  SemanticArgument,
  SemanticCandidate,
  SemanticEntityCandidate,
  SemanticReadSet,
  SemanticWriteResult,
} from '../../../src/memory/db/semantic-types.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../../../src/memory/db/types.ts';
import { tempDir } from '../tmp.ts';
import { addAccount, addDmPlace, addGroupPlace } from './opaque-people.ts';

export const ALEX = 'person:0a1f';
export const MIRA = 'person:7c3e';
export const KAI = 'person:91bd';
export const ALEX_ACCOUNT = 'account:alex';
export const MIRA_ACCOUNT = 'account:mira';
export const KAI_ACCOUNT = 'account:kai';
export const ROOM = 'place:room';
export const DM_ALEX = 'place:dm-alex';
export const DM_MIRA = 'place:dm-mira';
export const PUBLIC = 'aud:group:discord';
export const dmAudience = (place: string): string => `aud:dm:${place}`;
export const START = Date.UTC(2026, 10, 5, 10, 0, 0);

export type Where = 'public' | 'alex' | 'mira' | 'internal';
export type World = {
  handle: MemoryHandle;
  db: Db;
  file: string;
  contexts: { group: Context; alex: Context; mira: Context; internal: Context; groups: Context };
  /** The clock of the writes: every read of it moves one second on. */
  now: () => number;
  uuid: () => string;
  sourceCount: number;
};

/** A world on a real temporary file, every writer closed by the test through `world.handle.close()`. */
export function semanticWorld(): World {
  const file = path.join(tempDir('nep-semantic-'), 'memory.db');
  const handle = openMemoryDb(file);
  const db = dbOf(handle);
  addAccount(db, { id: ALEX_ACCOUNT, iface: 'discord', authority: 'discord/global', native: 'n1', person: ALEX });
  addAccount(db, { id: MIRA_ACCOUNT, iface: 'discord', authority: 'discord/global', native: 'n2', person: MIRA });
  addAccount(db, { id: KAI_ACCOUNT, iface: 'discord', authority: 'discord/global', native: 'n3', person: KAI });
  addDmPlace(db, { id: DM_ALEX, iface: 'discord', authority: 'discord/global', account: ALEX_ACCOUNT, person: ALEX });
  addDmPlace(db, { id: DM_MIRA, iface: 'discord', authority: 'discord/global', account: MIRA_ACCOUNT, person: MIRA });
  addGroupPlace(db, ROOM, 'discord', 'discord/global');
  db.exec(`INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES ('${PUBLIC}', 'group', 'discord');
    INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) VALUES ('${dmAudience(DM_ALEX)}', 'dm', 'discord', '${DM_ALEX}');
    INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) VALUES ('${dmAudience(DM_MIRA)}', 'dm', 'discord', '${DM_MIRA}');`);
  let clock = START;
  let ids = 0;
  const fixed = () => START;
  return {
    handle,
    db,
    file,
    contexts: {
      group: issueContext({ kind: 'group', iface: 'discord', destination: ROOM, now: fixed }),
      alex: issueContext({ kind: 'dm', iface: 'discord', person: ALEX, place: DM_ALEX, now: fixed }),
      mira: issueContext({ kind: 'dm', iface: 'discord', person: MIRA, place: DM_MIRA, now: fixed }),
      internal: issueContext({ kind: 'internal', now: fixed }),
      groups: groupsContext(),
    },
    now: () => (clock += 1000),
    uuid: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
    sourceCount: 0,
  };
}

export const plainInternal = internalContext;

const SCOPES: Record<Where, { kind: string; iface: string | null; dm: string | null; audience: string; place: string }> = {
  public: { kind: 'group', iface: 'discord', dm: null, audience: PUBLIC, place: ROOM },
  alex: { kind: 'dm', iface: 'discord', dm: ALEX, audience: dmAudience(DM_ALEX), place: DM_ALEX },
  mira: { kind: 'dm', iface: 'discord', dm: MIRA, audience: dmAudience(DM_MIRA), place: DM_MIRA },
  internal: { kind: 'internal', iface: null, dm: null, audience: 'aud:internal', place: ROOM },
};

/** One stored line of `where`, as the observer stores it; returns its source id. */
export function addSource(world: World, where: Where, text: string): string {
  world.sourceCount += 1;
  const id = `src:${world.sourceCount}`;
  const scope = SCOPES[where];
  const at = new Date(world.now()).toISOString();
  world.db
    .prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, author_kind, occurred_at, recorded_at, text,
        scope_kind, scope_iface, scope_dm, audience_id)
       VALUES (?, 'seen', 'discord', ?, 1, ?, ?, 'account', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, `m${world.sourceCount}`, scope.place, ALEX_ACCOUNT, at, at, text, scope.kind, scope.iface, scope.dm, scope.audience);
  return id;
}

/** Every stored source and claim version: the read set of a writer that was shown all of them. */
export function everythingRead(world: World): SemanticReadSet {
  return {
    sourceIds: world.db.prepare('SELECT id FROM sources').all().map((row) => String(row.id)),
    versionIds: world.db.prepare('SELECT id FROM claim_versions').all().map((row) => String(row.id)),
  };
}

const rejected = (result: object): string | null =>
  'ok' in result && result.ok === false && 'code' in result ? String(result.code) : null;

/** Validates and applies one candidate in `ctx`; a rejection throws, so a seed that fails stops the test at its cause. */
export function commit(
  world: World,
  candidate: SemanticCandidate | SemanticEntityCandidate,
  ctx: Context = world.contexts.group,
  read: SemanticReadSet = everythingRead(world)
): SemanticWriteResult {
  const checked = validateSemanticCandidate(world.db, ctx, candidate, read);
  if (!checked.ok) throw new Error(`the seed was refused: ${checked.code}`);
  const result = applySemanticWrite(world.handle, checked.resolved, {
    now: world.now,
    uuid: world.uuid,
    runId: `run:${world.uuid()}`,
  });
  const code = rejected(result);
  if (code !== null) throw new Error(`the seed was refused at apply: ${code}`);
  return result as SemanticWriteResult;
}

export const supports = (...sources: Array<string>): SemanticCandidate['evidence'] =>
  sources.map((sourceId) => ({ sourceId, role: 'supports' as const }));

export const entityCandidate = (
  kind: string,
  name: string,
  sources: Array<string>,
  language = 'en'
): SemanticEntityCandidate => ({
  kind,
  kindVersion: 1,
  name: { text: name, language },
  evidence: supports(...sources),
  dependencies: [],
});

/** An entity through the writer: its opaque id, and the claim and version of its name. */
export function addEntity(
  world: World,
  kind: string,
  name: string,
  sources: Array<string>,
  ctx: Context = world.contexts.group
): { entityId: string; claimId: string; versionId: string } {
  const result = commit(world, entityCandidate(kind, name, sources), ctx);
  if (result.kind !== 'entity') throw new Error('the writer answered no entity for an entity candidate');
  return { entityId: result.entityId, claimId: result.claimId, versionId: result.versionId };
}

const person = (id: string): SemanticArgument => ({ role: 'person', position: 0, ref: { kind: 'person', id } });
const project = (id: string): SemanticArgument => ({ role: 'project', position: 0, ref: { kind: 'entity', id } });

/** A candidate with the fields a test does not care about filled in as a plain current said fact. */
export const candidate = (
  predicate: string,
  assertionKind: SemanticCandidate['assertionKind'],
  args: Array<SemanticArgument>,
  sources: Array<string>,
  change: Partial<SemanticCandidate> = {}
): SemanticCandidate => ({
  claimId: null,
  baseVersionId: null,
  assertionKind,
  predicate: { id: predicate, version: 1 },
  text: `${predicate} as written by the persona`,
  arguments: args,
  evidence: supports(...sources),
  dependencies: [],
  polarity: 'positive',
  state: 'current',
  how: 'said',
  validFrom: null,
  validTo: null,
  ...change,
});

export const worksOn = (
  who: string,
  entityId: string,
  sources: Array<string>,
  change: Partial<SemanticCandidate> = {}
): SemanticCandidate => candidate('project.works_on', 'relation', [person(who), project(entityId)], sources, change);

export const sameAs = (
  from: string,
  into: string,
  sources: Array<string>,
  change: Partial<SemanticCandidate> = {}
): SemanticCandidate =>
  candidate(
    'identity.same_as',
    'relation',
    [
      { role: 'from', position: 0, ref: { kind: 'entity', id: from } },
      { role: 'into', position: 0, ref: { kind: 'entity', id: into } },
    ],
    sources,
    change
  );

export const partOf = (
  part: string,
  whole: string,
  sources: Array<string>,
  change: Partial<SemanticCandidate> = {}
): SemanticCandidate =>
  candidate(
    'concept.part_of',
    'relation',
    [
      { role: 'part', position: 0, ref: { kind: 'entity', id: part } },
      { role: 'whole', position: 0, ref: { kind: 'entity', id: whole } },
    ],
    sources,
    change
  );

/** An event with its roles in one assertion version. */
export const occurrence = (
  event: string,
  roles: { organizer?: Array<string>; speaker?: Array<string>; attendee?: Array<string>; project?: Array<string> },
  sources: Array<string>,
  change: Partial<SemanticCandidate> = {}
): SemanticCandidate => {
  const people = (role: string, ids: ReadonlyArray<string> = []): Array<SemanticArgument> =>
    ids.map((id, position) => ({ role, position, ref: { kind: 'person', id } }));
  return candidate(
    'event.occurrence',
    'nary',
    [
      { role: 'event', position: 0, ref: { kind: 'entity', id: event } },
      ...people('organizer', roles.organizer),
      ...people('speaker', roles.speaker),
      ...people('attendee', roles.attendee),
      ...(roles.project ?? []).map(
        (id, position): SemanticArgument => ({ role: 'project', position, ref: { kind: 'entity', id } })
      ),
    ],
    sources,
    change
  );
};

/** The version a successor is written on: the claim, its newest version and the new fields. */
export const successor = (
  of: { claimId: string; versionId: string },
  change: Partial<SemanticCandidate> = {}
): Partial<SemanticCandidate> => ({ claimId: of.claimId, baseVersionId: of.versionId, ...change });
