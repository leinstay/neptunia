// The owner's `/memory bind` (plan 2026-11-08-meta-person, slice 6): an account binds to a meta-person and only to one.
// `bindAccount` plans on the read connection and writes through the one writer (`applyMemoryWrite` kind `person-bind`).
//
//   - An account no person holds is attached: a verified link by the owner, its `person_accounts` row under the target
//     and the target as `author_person` of its lines.
//   - An account already under the target is left as it is.
//   - An account under another person asks the owner one Y/n naming the person it removes, by id and name. On yes that
//     person merges into the target, the target's data winning: claims, episodes, affinity events, accounts, DM places
//     and scoped rows move (person-merge.ts#mergePersonInto), every account of the person who went moves under the target
//     in `person_accounts`, `author_person` of their lines follows, and the person who went stays as an alias
//     (`people_merges`, `status` `merged_into:<target>`, `meta` 0). The target keeps its own `people` row, its affinity
//     score included. Where both hold a current description of one field in one audience, the memory model joins the two
//     texts before anything is written (prompts/description-merge.md, purpose `description-merge`), the target's text
//     first. The joined text becomes the target's current version and the other description stays with the alias as
//     history. A description only the person who went holds moves to the target as it is.
//
// Refused, with nothing written: an account nobody stored (`UNKNOWN_ACCOUNT`), a target nobody stored
// (`UNKNOWN_PERSON`), a target not marked `meta` or merged away (`NOT_META`), her own person on either side
// (`SELF_PERSON`), and the owner's meta-person on the side that goes (`OWNER_PERSON`). A merge with no way to ask
// answers `unconfirmed`, a no answers `declined`, and a failed or unreadable model answer fails the bind whole.
// Accounts are never unbound. Called by service.ts (`personBind`) and session-write.ts (the write).

import { block } from '../../behavior/prompt.ts';
import { MEMORY_ROLE, roleModel } from '../../llm/roles.ts';
import { projectRow } from './graph.ts';
import { SELF_PERSON, shortHash } from './ids.ts';
import { personOfAccount } from './meta-person.ts';
import { linkAccount } from './person-links.ts';
import { mergePersonInto } from './person-merge.ts';
import type { SessionContext } from './session.ts';
import { dbOf } from './types.ts';
import type { Config, Db, MemoryHandle, Row } from './types.ts';

export const MERGE_PURPOSE = 'description-merge';

/** A person as the question names it: the id and the name she knows them by, null when she knows none. */
export type BindTarget = { id: string; name: string | null };
/** The owner's Y/n before a merge: true runs it. */
export type BindConfirm = (question: { removed: BindTarget; into: BindTarget }) => Promise<boolean>;
/**
 * What a bind names: the account node and the meta-person it binds to, and who proved it: the owner (his command or
 * his pairing), or a one-time code the person answered (her link tool, src/interface/person-link.ts). `owner` when
 * absent.
 */
export type BindInput = { accountId: string; personId: string; by?: 'owner' | 'code' };
/** What a bind reads and writes with: the read connection, the writer, the memory model client (null while off). */
export type BindDeps = {
  db: Db;
  write: (update: Row) => Promise<unknown>;
  llm: SessionContext['llm'] | null;
  hot: { config: Config; prompts?: Row | null };
  selfName?: string;
  now?: () => number;
};
export type BindResult =
  | { status: 'attached' | 'bound'; person: string }
  | { status: 'merged'; person: string; removed: string }
  | { status: 'declined' | 'unconfirmed'; removed: string }
  | { status: 'refused' | 'failed'; code: string };

type Plan =
  | { kind: 'attach'; into: string }
  | { kind: 'bound'; into: string }
  | { kind: 'merge'; into: string; removed: string }
  | { kind: 'refused'; code: string };

/** One description the target and the person who goes both hold, in one field and one audience. */
type Pair = {
  intoId: string;
  intoVersion: string | null;
  intoText: string;
  fromId: string;
  fromText: string;
  field: string;
};
/** A joined text for the target's description, written by the bind. */
type Joined = {
  descriptionId: string;
  basedOn: string | null;
  text: string;
  reason: string | null;
  mergedFrom: string;
};

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'ERROR';
};

/** Whether `person` is a meta-person that still stands: marked `meta`, not merged away, not retired. */
function standingMeta(db: Db, person: string): 'yes' | 'no' | 'unknown' {
  const row = db.prepare('SELECT meta, status, retired_at FROM people WHERE id = ?').get(person);
  if (row === undefined) return 'unknown';
  const merged = typeof row.status === 'string' && row.status.startsWith('merged_into:');
  return row.meta === 1 && !merged && row.retired_at == null ? 'yes' : 'no';
}

/** What a bind of `accountId` to `personId` would do, read on `db`; `ownerPerson` never goes. */
function planOf(db: Db, { accountId, personId }: BindInput, ownerPerson: string): Plan {
  if (db.prepare('SELECT 1 AS ok FROM accounts WHERE id = ?').get(accountId) === undefined)
    return { kind: 'refused', code: 'UNKNOWN_ACCOUNT' };
  // An account already under the person is left as it is, whatever the person's row says.
  const current = personOfAccount(db, accountId);
  if (current === personId) return { kind: 'bound', into: personId };
  const standing = standingMeta(db, personId);
  if (standing !== 'yes') return { kind: 'refused', code: standing === 'unknown' ? 'UNKNOWN_PERSON' : 'NOT_META' };
  if (current === null) return { kind: 'attach', into: personId };
  if (current === SELF_PERSON || personId === SELF_PERSON) return { kind: 'refused', code: 'SELF_PERSON' };
  if (current === ownerPerson) return { kind: 'refused', code: 'OWNER_PERSON' };
  return { kind: 'merge', into: personId, removed: current };
}

/** The first name in a stored value: a plain string, a JSON string or the first string of a JSON array. */
function firstName(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return parsed.trim() || null;
    if (Array.isArray(parsed))
      return parsed.find((one): one is string => typeof one === 'string' && one !== '') ?? null;
  } catch {
    return value.trim();
  }
  return null;
}

/** The name she knows a person by: the real name, else the display name of the first account under them. */
function nameOf(db: Db, person: string): string | null {
  const real = firstName(db.prepare('SELECT real_name FROM people WHERE id = ?').get(person)?.real_name);
  if (real !== null) return real;
  const shown = db
    .prepare(
      `SELECT display_name FROM person_accounts WHERE person_id = ? AND display_name IS NOT NULL
       ORDER BY recorded_at, id LIMIT 1`
    )
    .get(person)?.display_name;
  if (typeof shown === 'string' && shown !== '') return shown;
  const names = db.prepare('SELECT names FROM accounts WHERE person_id = ? ORDER BY id LIMIT 1').get(person)?.names;
  return firstName(names);
}

const target = (db: Db, person: string): BindTarget => ({ id: person, name: nameOf(db, person) });

/** The descriptions of `from` whose field and audience the target holds as well, with both current texts. */
function pairsOf(db: Db, from: string, into: string): Array<Pair> {
  return db
    .prepare(
      `SELECT t.id AS intoId, t.current_version AS intoVersion, COALESCE(tv.text, '') AS intoText, f.id AS fromId,
         fv.text AS fromText, f.field AS field
       FROM descriptions f JOIN description_versions fv ON fv.id = f.current_version
       JOIN descriptions t ON t.subject_kind = 'person' AND t.subject_id = ? AND t.field IS f.field
         AND t.audience_id IS f.audience_id
       LEFT JOIN description_versions tv ON tv.id = t.current_version
       WHERE f.subject_kind = 'person' AND f.subject_id = ? AND COALESCE(fv.text, '') != '' ORDER BY f.id`
    )
    .all(into, from)
    .map((row) => ({
      intoId: String(row.intoId),
      intoVersion: typeof row.intoVersion === 'string' ? row.intoVersion : null,
      intoText: String(row.intoText),
      fromId: String(row.fromId),
      fromText: String(row.fromText),
      field: String(row.field),
    }));
}

/** The joined text of one pair: the other text alone when the target's is empty, else the memory model's answer. */
async function joinPair(deps: BindDeps, pair: Pair): Promise<Joined> {
  const base = { descriptionId: pair.intoId, basedOn: pair.intoVersion, mergedFrom: pair.fromId };
  if (pair.intoText.trim() === '') return { ...base, text: pair.fromText, reason: null };
  const prompts = deps.hot.prompts;
  if (deps.llm === null) throw coded('not_configured');
  if (typeof prompts?.[MERGE_PURPOSE] !== 'string' || prompts[MERGE_PURPOSE].trim() === '') throw coded('no_prompt');
  // The model's side loads when a merge needs it: session.ts reads the service, which loads this writer.
  const [{ askMemoryModel, fieldCap, parseDescriptionAnswer }, { sessionSettings, systemTextOf }] = await Promise.all([
    import('./describe.ts'),
    import('./session.ts'),
  ]);
  const subject = [`field: ${pair.field}`, `cap: ${fieldCap(deps.hot.config, pair.field)} characters`].join('\n');
  const user = [block('subject', subject), block('kept', pair.intoText), block('merged', pair.fromText)].join('\n\n');
  const completion = await askMemoryModel(
    { llm: deps.llm, hot: deps.hot },
    [
      { role: 'system', content: systemTextOf(prompts, deps.selfName ?? '', prompts[MERGE_PURPOSE]) },
      { role: 'user', content: user },
    ],
    { purpose: MERGE_PURPOSE, maxOutputTokens: sessionSettings(deps.hot.config).descriptionMaxOutputTokens }
  );
  const answer = parseDescriptionAnswer(completion?.text);
  if (answer === null) throw coded('bad_answer');
  return { ...base, text: answer.description, reason: answer.reason || null };
}

/**
 * Binds an account to a meta-person (see the head of this file). Never throws: a refusal, a declined merge and a
 * failure come back as results, and only a bind that answers `attached` or `merged` wrote anything.
 */
export async function bindAccount(deps: BindDeps, input: BindInput, confirm: BindConfirm | null): Promise<BindResult> {
  const { hot } = deps;
  const owner = hot.config?.bot?.ownerPerson;
  const ownerPerson = typeof owner === 'string' ? owner : '';
  const plan = planOf(deps.db, input, ownerPerson);
  if (plan.kind === 'refused') return { status: 'refused', code: plan.code };
  if (plan.kind === 'bound') return { status: 'bound', person: plan.into };
  const now = (deps.now ?? Date.now)();
  try {
    if (plan.kind === 'attach') {
      await deps.write({ kind: 'person-bind', ...input, from: null, descriptions: [], now });
      return { status: 'attached', person: plan.into };
    }
    if (confirm === null) return { status: 'unconfirmed', removed: plan.removed };
    const question = { removed: target(deps.db, plan.removed), into: target(deps.db, plan.into) };
    if (!(await confirm(question))) return { status: 'declined', removed: plan.removed };
    const descriptions: Array<Joined> = [];
    for (const pair of pairsOf(deps.db, plan.removed, plan.into)) descriptions.push(await joinPair(deps, pair));
    const model = roleModel(hot.config, MEMORY_ROLE) ?? null;
    const prompt = shortHash(hot.prompts?.[MERGE_PURPOSE]);
    await deps.write({ kind: 'person-bind', ...input, from: plan.removed, descriptions, model, prompt, now });
    return { status: 'merged', person: plan.into, removed: plan.removed };
  } catch (error) {
    return { status: 'failed', code: codeOf(error) };
  }
}

/** The joined texts become the target's current versions, each checked against the version it was based on. */
function writeJoined(db: Db, joined: ReadonlyArray<Joined>, extra: Row, at: string): void {
  for (const one of joined) {
    const current = db.prepare('SELECT current_version FROM descriptions WHERE id = ?').get(one.descriptionId);
    if (current === undefined || (current.current_version ?? null) !== one.basedOn) throw coded('VERSION_CONFLICT');
    const id = `dv:${one.descriptionId}:${shortHash(at, one.text)}`;
    db.prepare(
      `INSERT OR REPLACE INTO description_versions (id, description_id, text, author, written_at, chars, reason, origin,
           extra) VALUES (?, ?, ?, 'her', ?, ?, ?, 'merge', ?)`
    ).run(
      id,
      one.descriptionId,
      one.text,
      at,
      [...one.text].length,
      one.reason,
      JSON.stringify({ ...extra, basedOn: one.basedOn, mergedFrom: one.mergedFrom })
    );
    db.prepare('UPDATE descriptions SET current_version = ? WHERE id = ?').run(id, one.descriptionId);
    projectRow(db, 'description_versions', { description_id: one.descriptionId }, { at });
  }
}

/** Every verified account of `person` gets its `person_accounts` row under them, and their lines name them. */
function settleAccounts(db: Db, person: string, at: string): void {
  db.prepare(
    `INSERT INTO person_accounts (id, person_id, iface, platform_id, generation, display_name, avatar, recorded_at)
     SELECT a.id, a.person_id, a.iface, COALESCE(a.native_key, a.native_id, a.id), COALESCE(a.generation, 1),
       CASE WHEN json_valid(a.names) AND json_type(a.names) = 'array' THEN json_extract(a.names, '$[0]') END, a.avatar, ?
     FROM accounts a WHERE a.person_id = ? AND a.link = 'verified' AND true
     ON CONFLICT(id) DO UPDATE SET person_id = excluded.person_id`
  ).run(at, person);
  db.prepare(
    `UPDATE sources SET author_person = ? WHERE author_person IS NOT ?
       AND author_account IN (SELECT id FROM person_accounts WHERE person_id = ?)`
  ).run(person, person, person);
}

/**
 * The write of `applyMemoryWrite` kind `person-bind`: `{ accountId, personId, from, descriptions, model?, prompt?, now }`,
 * one transaction. Throws `STALE_BIND` when the account's person is no longer `from`, and the refusals of the plan.
 */
export function applyPersonBindWrite(
  handle: MemoryHandle,
  update: Row
): { ok: true; person: string; merged: string | null } {
  const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
  const accountId = typeof update.accountId === 'string' ? update.accountId : '';
  const person = typeof update.personId === 'string' ? update.personId : '';
  const from = typeof update.from === 'string' && update.from !== '' ? update.from : null;
  const by = update.by === 'code' ? 'code' : 'owner';
  return handle.transaction(() => {
    const db = dbOf(handle);
    if (standingMeta(db, person) !== 'yes') throw coded('NOT_META');
    if (personOfAccount(db, accountId) !== from) throw coded('STALE_BIND');
    if (from !== null) {
      const joined = Array.isArray(update.descriptions) ? (update.descriptions as Array<Joined>) : [];
      writeJoined(db, joined, { model: update.model ?? null, prompt: update.prompt ?? null }, at);
      mergePersonInto(db, { from, into: person, by, reason: by === 'code' ? 'link code' : 'bind', at });
      db.prepare('UPDATE person_accounts SET person_id = ? WHERE person_id = ?').run(person, from);
      db.prepare('UPDATE sources SET author_person = ? WHERE author_person = ?').run(person, from);
      db.prepare('UPDATE people SET meta = 0 WHERE id = ?').run(from);
    } else {
      linkAccount(db, accountId, person, at, { by, reason: by === 'code' ? 'link code' : 'owner command' });
    }
    settleAccounts(db, person, at);
    projectRow(db, 'people', { id: person }, { at });
    projectRow(db, 'accounts', { id: accountId }, { at });
    return { ok: true as const, person, merged: from };
  });
}
