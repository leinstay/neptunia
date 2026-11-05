// The registry of her skills in the memory database (schema v11 tables, v22 for the stored text and `skill_uses`).
// A skill is a `SKILL.md` on disk; the registry records which version of it is active and who made it so. `syncSkills`
// turns every new file text into a `candidate` version and never touches an active one. Nobody approves a candidate:
// her done task activates the exact version it bound with `activateNamedVersion`, the owner the newest one with
// `activateSkill`, the first version included, and `rollbackSkill` walks the activations back. A skill's disabled flag is her own or the owner's switch and keeps its
// active version. A version stores the text it was synced from, so she reads what was activated after the file moved
// on. `skill_uses` is the append-only record of how her turns used a skill.
//
// Everything here is synchronous over the writer connection (`handle`); the memory writer applies `SkillsUpdate`
// writes through `applySkillsWrite` (session-write.ts), and the reads take any connection with a `db`. Results are
// `{ ok: true, ... }` or `{ ok: false, code }` with a kebab-case code. A skill's row is `skill:<name>`; its `extra` JSON
// holds `activatedAt`, `activatedBy`, `history` (the ids a rollback walks back) and the disabled switch.

import { createHash } from 'node:crypto';
import type { openMemoryDb } from './open.ts';
import type { ParsedSkill } from '../../skills/format.ts';

export const SKILL_USE_KINDS = ['discovered', 'read', 'tried', 'succeeded', 'corrected', 'declined'] as const;

/** The writer connection, as `openMemoryDb` returns it. */
export type SkillsHandle = ReturnType<typeof openMemoryDb>;
export type SkillSource = Pick<ParsedSkill, 'name' | 'tools' | 'task' | 'contentHash' | 'source'>;
export type UseKind = (typeof SKILL_USE_KINDS)[number];
export type UseCounts = Record<UseKind, number>;
export type SkillUse = { skill: string; versionId: string; turnId: string; kind: UseKind; at: number };
export type VersionStatus = 'candidate' | 'active' | 'retired';

/** The commit a version of a skill file carries: a skill file is not an engine build. */
const COMMIT = 'skill-file';

type Row = Record<string, unknown>;
type Db = {
  prepare(sql: string): {
    get(...p: Array<unknown>): Row | undefined;
    all(...p: Array<unknown>): Array<Row>;
    run(...p: Array<unknown>): { changes: number };
  };
};
// open.ts types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method Db names.
const dbOf = (handle: { db: object }): Db => handle.db as Db;

/** One transaction on the writer connection; the result is what `fn` returned. */
function tx<TResult>(handle: SkillsHandle, fn: () => TResult): TResult {
  return handle.transaction(fn);
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const iso = (at: number): string => new Date(at).toISOString();
const skillId = (name: string): string => `skill:${name}`;

type Extra = {
  activatedAt?: string;
  activatedBy?: string;
  history?: Array<string>;
  disabled?: boolean;
  disabledBy?: string | null;
  disabledAt?: string | null;
  rejected?: { versionId: string; by: string; at: string };
};

function extraOf(row: Row | undefined): Extra {
  try {
    const parsed: unknown = JSON.parse(typeof row?.extra === 'string' ? row.extra : '{}');
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const historyOf = (extra: Extra): Array<string> => (Array.isArray(extra.history) ? [...extra.history] : []);

const emptyCounts = (): UseCounts => ({ discovered: 0, read: 0, tried: 0, succeeded: 0, corrected: 0, declined: 0 });

const toolsOfManifest = (manifest: unknown): Array<string> => {
  try {
    const parsed: unknown = JSON.parse(typeof manifest === 'string' ? manifest : '{}');
    const tools = (parsed as { tools?: unknown } | null)?.tools;
    return Array.isArray(tools) ? tools.map(String) : [];
  } catch {
    return [];
  }
};

function versionIdOf(name: string, contentHash: string, manifestHash: string): string {
  return `skillver:${name}:${sha256(`${contentHash}\n${manifestHash}\n${COMMIT}`).slice(0, 32)}`;
}

/**
 * Registers what the files hold: a skill row per name, a candidate version per new content, the older candidates
 * of a changed skill retired, and a skill whose file is gone `stale`.
 */
export function syncSkills(
  handle: SkillsHandle,
  files: ReadonlyArray<SkillSource>,
  options: { at: number }
): { skills: number; versions: number; stale: number } {
  const stamp = iso(options.at);
  return tx(handle, () => {
    const db = dbOf(handle);
    const counts = { skills: 0, versions: 0, stale: 0 };
    const names = new Set<string>();
    for (const file of files) {
      names.add(file.name);
      const id = skillId(file.name);
      const known = db.prepare('SELECT lifecycle FROM skills WHERE id = ?').get(id);
      if (known === undefined) {
        db.prepare(
          "INSERT INTO skills (id, name, active_version, lifecycle, origin_work_id, pinned, extra) VALUES (?, ?, NULL, 'active', NULL, 0, NULL)"
        ).run(id, file.name);
        counts.skills += 1;
      } else if (known.lifecycle === 'stale') {
        db.prepare("UPDATE skills SET lifecycle = 'active' WHERE id = ?").run(id);
      }
      const manifest = { tools: [...file.tools] };
      const manifestHash = sha256(JSON.stringify(manifest));
      const versionId = versionIdOf(file.name, file.contentHash, manifestHash);
      const written = db
        .prepare(
          `INSERT OR IGNORE INTO skill_versions (id, skill_id, version, content_hash, manifest_hash, commit_sha, origin_work_id, status, created_at, manifest, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`
        )
        .run(
          versionId,
          id,
          file.contentHash.slice(0, 12),
          file.contentHash,
          manifestHash,
          COMMIT,
          file.task,
          stamp,
          JSON.stringify(manifest),
          file.source
        );
      if (written.changes === 0) continue;
      counts.versions += 1;
      db.prepare(
        "UPDATE skill_versions SET status = 'retired' WHERE skill_id = ? AND status = 'candidate' AND id <> ?"
      ).run(id, versionId);
    }
    for (const row of db.prepare("SELECT id, name FROM skills WHERE lifecycle = 'active'").all()) {
      if (names.has(String(row.name))) continue;
      db.prepare("UPDATE skills SET lifecycle = 'stale' WHERE id = ?").run(row.id);
      counts.stale += 1;
    }
    return counts;
  });
}

/** Makes a candidate version the active one of its skill; the version it replaces is retired and kept for a rollback. */
export function activateVersion(
  handle: SkillsHandle,
  versionId: string,
  options: { at: number; by: string }
): { ok: true; previous: string | null } | { ok: false; code: 'unknown-version' | 'already-active' | 'not-candidate' } {
  return tx(handle, () => {
    const db = dbOf(handle);
    const version = db.prepare('SELECT skill_id, status FROM skill_versions WHERE id = ?').get(versionId);
    if (version === undefined) return { ok: false, code: 'unknown-version' } as const;
    const skill = db.prepare('SELECT id, active_version, extra FROM skills WHERE id = ?').get(version.skill_id);
    if (skill?.active_version === versionId) return { ok: false, code: 'already-active' } as const;
    if (version.status !== 'candidate') return { ok: false, code: 'not-candidate' } as const;
    const previous = typeof skill?.active_version === 'string' ? skill.active_version : null;
    const extra = extraOf(skill);
    const history = historyOf(extra);
    if (previous !== null) {
      db.prepare("UPDATE skill_versions SET status = 'retired' WHERE id = ?").run(previous);
      history.push(previous);
    }
    db.prepare("UPDATE skill_versions SET status = 'active' WHERE id = ?").run(versionId);
    db.prepare('UPDATE skills SET active_version = ?, extra = ? WHERE id = ?').run(
      versionId,
      JSON.stringify({ ...extra, activatedAt: iso(options.at), activatedBy: options.by, history }),
      version.skill_id
    );
    return { ok: true, previous } as const;
  });
}

/**
 * `activateVersion` for exactly the version `versionId` of the skill `name`. A version of another skill is unknown here, so
 * a task that names one activates nothing.
 */
export function activateNamedVersion(
  handle: SkillsHandle,
  name: string,
  versionId: string,
  options: { at: number; by: string }
):
  | { ok: true; versionId: string; previous: string | null }
  | { ok: false; code: 'unknown-version' | 'already-active' | 'not-candidate' } {
  const version = dbOf(handle).prepare('SELECT skill_id FROM skill_versions WHERE id = ?').get(versionId);
  if (version?.skill_id !== skillId(name)) return { ok: false, code: 'unknown-version' };
  const done = activateVersion(handle, versionId, options);
  return done.ok ? { ok: true, versionId, previous: done.previous } : done;
}

/** The newest candidate of a skill, oldest-first order reversed. */
function newestCandidate(db: Db, name: string): string | null {
  const row = db
    .prepare(
      "SELECT id FROM skill_versions WHERE skill_id = ? AND status = 'candidate' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
    .get(skillId(name));
  return typeof row?.id === 'string' ? row.id : null;
}

export function activateSkill(
  handle: SkillsHandle,
  name: string,
  options: { at: number; by: string }
): { ok: true; versionId: string; previous: string | null } | { ok: false; code: 'unknown-skill' | 'no-candidate' } {
  const db = dbOf(handle);
  if (db.prepare('SELECT 1 AS ok FROM skills WHERE id = ?').get(skillId(name)) === undefined) {
    return { ok: false, code: 'unknown-skill' };
  }
  const versionId = newestCandidate(db, name);
  if (versionId === null) return { ok: false, code: 'no-candidate' };
  const done = activateVersion(handle, versionId, options);
  // The candidate was read a line above and nothing writes between, so the activation cannot be refused.
  return done.ok ? { ok: true, versionId, previous: done.previous } : { ok: false, code: 'no-candidate' };
}

/** Makes the version active before the current one active again; the current one is retired. */
export function rollbackSkill(
  handle: SkillsHandle,
  name: string,
  options: { at: number; by: string }
): { ok: true; active: string; retired: string } | { ok: false; code: 'unknown-skill' | 'no-rollback' } {
  return tx(handle, () => {
    const db = dbOf(handle);
    const skill = db.prepare('SELECT id, active_version, extra FROM skills WHERE id = ?').get(skillId(name));
    if (skill === undefined) return { ok: false, code: 'unknown-skill' } as const;
    const extra = extraOf(skill);
    const history = historyOf(extra);
    const previous = history.pop();
    const current = typeof skill.active_version === 'string' ? skill.active_version : null;
    if (previous === undefined || current === null) return { ok: false, code: 'no-rollback' } as const;
    db.prepare("UPDATE skill_versions SET status = 'retired' WHERE id = ?").run(current);
    db.prepare("UPDATE skill_versions SET status = 'active' WHERE id = ?").run(previous);
    db.prepare('UPDATE skills SET active_version = ?, extra = ? WHERE id = ?').run(
      previous,
      JSON.stringify({ ...extra, activatedAt: iso(options.at), activatedBy: `${options.by} (rollback)`, history }),
      skill.id
    );
    return { ok: true, active: previous, retired: current } as const;
  });
}

/** Retires a candidate. A sync of the same text finds the retired row and registers nothing. */
export function rejectVersion(
  handle: SkillsHandle,
  versionId: string,
  options: { at: number; by: string }
): { ok: true } | { ok: false; code: 'unknown-version' | 'not-candidate' } {
  return tx(handle, () => {
    const db = dbOf(handle);
    const version = db.prepare('SELECT status FROM skill_versions WHERE id = ?').get(versionId);
    if (version === undefined) return { ok: false, code: 'unknown-version' } as const;
    if (version.status !== 'candidate') return { ok: false, code: 'not-candidate' } as const;
    db.prepare("UPDATE skill_versions SET status = 'retired' WHERE id = ?").run(versionId);
    const skill = db
      .prepare('SELECT id, extra FROM skills WHERE id = (SELECT skill_id FROM skill_versions WHERE id = ?)')
      .get(versionId);
    db.prepare('UPDATE skills SET extra = ? WHERE id = ?').run(
      JSON.stringify({ ...extraOf(skill), rejected: { versionId, by: options.by, at: iso(options.at) } }),
      skill?.id
    );
    return { ok: true } as const;
  });
}

/** Her switch or the owner's: a disabled skill stays registered with its active version and leaves her index. */
export function setDisabled(
  handle: SkillsHandle,
  name: string,
  disabled: boolean,
  options: { at: number; by: string }
): { ok: true; changed: boolean } | { ok: false; code: 'unknown-skill' } {
  return tx(handle, () => {
    const db = dbOf(handle);
    const skill = db.prepare('SELECT id, extra FROM skills WHERE id = ?').get(skillId(name));
    if (skill === undefined) return { ok: false, code: 'unknown-skill' } as const;
    const extra = extraOf(skill);
    if ((extra.disabled === true) === disabled) return { ok: true, changed: false } as const;
    db.prepare('UPDATE skills SET extra = ? WHERE id = ?').run(
      JSON.stringify({
        ...extra,
        disabled,
        disabledBy: disabled ? options.by : null,
        disabledAt: disabled ? iso(options.at) : null,
      }),
      skill.id
    );
    return { ok: true, changed: true } as const;
  });
}

export type VersionView = {
  versionId: string;
  version: string;
  status: VersionStatus;
  tools: Array<string>;
  task: string | null;
  createdAt: string;
  source: string;
  contentHash: string;
  uses: UseCounts;
};

export type SkillRow = {
  name: string;
  lifecycle: 'active' | 'stale' | 'archived';
  disabled: boolean;
  disabledBy: string | null;
  active: (VersionView & { activatedAt: string; activatedBy: string }) | null;
  rollbackTo: VersionView | null;
  candidates: number;
};

function usesOfVersion(db: Db, versionId: string): UseCounts {
  const counts = emptyCounts();
  for (const row of db
    .prepare('SELECT kind, COUNT(*) AS n FROM skill_uses WHERE version_id = ? GROUP BY kind')
    .all(versionId)) {
    counts[row.kind as UseKind] = Number(row.n);
  }
  return counts;
}

function viewOf(db: Db, versionId: string): VersionView | null {
  const row = db.prepare('SELECT * FROM skill_versions WHERE id = ?').get(versionId);
  if (row === undefined) return null;
  return {
    versionId: String(row.id),
    version: String(row.version),
    status: row.status as VersionStatus,
    tools: toolsOfManifest(row.manifest),
    task: typeof row.origin_work_id === 'string' ? row.origin_work_id : null,
    createdAt: String(row.created_at),
    source: typeof row.source === 'string' ? row.source : '',
    contentHash: String(row.content_hash),
    uses: usesOfVersion(db, String(row.id)),
  };
}

function rowOf(db: Db, skill: Row): SkillRow {
  const extra = extraOf(skill);
  const activeId = typeof skill.active_version === 'string' ? skill.active_version : null;
  const view = activeId === null ? null : viewOf(db, activeId);
  const last = historyOf(extra).at(-1);
  const candidates = db
    .prepare("SELECT COUNT(*) AS n FROM skill_versions WHERE skill_id = ? AND status = 'candidate'")
    .get(skill.id);
  return {
    name: String(skill.name),
    lifecycle: skill.lifecycle as SkillRow['lifecycle'],
    disabled: extra.disabled === true,
    disabledBy: extra.disabled === true ? (extra.disabledBy ?? null) : null,
    active:
      view === null
        ? null
        : { ...view, activatedAt: extra.activatedAt ?? view.createdAt, activatedBy: extra.activatedBy ?? '' },
    rollbackTo: activeId !== null && last !== undefined ? viewOf(db, last) : null,
    candidates: Number(candidates?.n ?? 0),
  };
}

export function listSkills(handle: { db: object }): Array<SkillRow> {
  const db = dbOf(handle);
  return db
    .prepare('SELECT * FROM skills ORDER BY name')
    .all()
    .map((skill) => rowOf(db, skill));
}

/** Every candidate version, oldest first. */
export function pendingVersions(handle: { db: object }): Array<VersionView & { skill: string }> {
  const db = dbOf(handle);
  const out: Array<VersionView & { skill: string }> = [];
  for (const row of db
    .prepare(
      `SELECT v.id, s.name FROM skill_versions v JOIN skills s ON s.id = v.skill_id
       WHERE v.status = 'candidate' ORDER BY v.created_at, v.rowid`
    )
    .all()) {
    const view = viewOf(db, String(row.id));
    if (view !== null) out.push({ ...view, skill: String(row.name) });
  }
  return out;
}

/** The active version of a skill and its candidates, or null for a name nobody registered. */
export function reviewOf(
  handle: { db: object },
  name: string
): { active: VersionView | null; candidates: Array<VersionView> } | null {
  const db = dbOf(handle);
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId(name));
  if (skill === undefined) return null;
  const activeId = typeof skill.active_version === 'string' ? skill.active_version : null;
  const candidates: Array<VersionView> = [];
  for (const row of db
    .prepare("SELECT id FROM skill_versions WHERE skill_id = ? AND status = 'candidate' ORDER BY created_at, rowid")
    .all(skill.id)) {
    const view = viewOf(db, String(row.id));
    if (view !== null) candidates.push(view);
  }
  return { active: activeId === null ? null : viewOf(db, activeId), candidates };
}

/** Writes the uses in one transaction; a use of a version nobody registered refuses them all. */
export function appendUses(handle: SkillsHandle, uses: ReadonlyArray<SkillUse>): number {
  if (uses.length === 0) return 0;
  return tx(handle, () => {
    const insert = dbOf(handle).prepare(
      'INSERT INTO skill_uses (skill, version_id, turn_id, kind, at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const use of uses) insert.run(use.skill, use.versionId, use.turnId, use.kind, iso(use.at));
    return uses.length;
  });
}

/** The uses with `at >= since`, counted per skill; a skill with no use in the window is absent. */
export function useCountsBySkill(handle: { db: object }, options: { since: number }): Record<string, UseCounts> {
  const out: Record<string, UseCounts> = {};
  for (const row of dbOf(handle)
    .prepare('SELECT skill, kind, COUNT(*) AS n FROM skill_uses WHERE at >= ? GROUP BY skill, kind')
    .all(iso(options.since))) {
    const counts = (out[String(row.skill)] ??= emptyCounts());
    counts[row.kind as UseKind] = Number(row.n);
  }
  return out;
}

/**
 * The skills with an active version that are not disabled, were activated `days` days ago or more and were not read
 * in the last `days` days. A reminder for `/skills`; nothing is deleted.
 */
export function reviewsDue(
  handle: { db: object },
  options: { now: number; days: number }
): Array<{ skill: string; versionId: string; activatedAt: string; lastReadAt: string | null }> {
  const db = dbOf(handle);
  const window = options.days * 86_400_000;
  const out: Array<{ skill: string; versionId: string; activatedAt: string; lastReadAt: string | null }> = [];
  for (const skill of db
    .prepare(
      "SELECT name, active_version, extra FROM skills WHERE active_version IS NOT NULL AND lifecycle <> 'archived' ORDER BY name"
    )
    .all()) {
    const extra = extraOf(skill);
    if (extra.disabled === true || typeof extra.activatedAt !== 'string') continue;
    if (Date.parse(extra.activatedAt) > options.now - window) continue;
    const last = db.prepare("SELECT MAX(at) AS at FROM skill_uses WHERE skill = ? AND kind = 'read'").get(skill.name);
    const lastReadAt = typeof last?.at === 'string' ? last.at : null;
    if (lastReadAt !== null && Date.parse(lastReadAt) >= options.now - window) continue;
    out.push({
      skill: String(skill.name),
      versionId: String(skill.active_version),
      activatedAt: extra.activatedAt,
      lastReadAt,
    });
  }
  return out;
}

/** The writes of kind `skills` the memory writer runs (session-write.ts). */
export type SkillsUpdate =
  | { kind: 'skills'; op: 'sync'; files: Array<SkillSource>; at: number }
  | { kind: 'skills'; op: 'activate'; name: string; at: number; by: string }
  | { kind: 'skills'; op: 'activate-version'; name: string; versionId: string; at: number; by: string }
  | { kind: 'skills'; op: 'rollback'; name: string; at: number; by: string }
  | { kind: 'skills'; op: 'reject'; name: string; at: number; by: string }
  | { kind: 'skills'; op: 'disable'; name: string; disabled: boolean; at: number; by: string }
  | { kind: 'skills'; op: 'uses'; uses: Array<SkillUse> };

/**
 * Runs one skills write on the writer's connection. The memory writer hands over its handle and the update as it
 * received them (session-write.ts), so both are checked here: a write of no known op is refused.
 */
export function applySkillsWrite(handle: unknown, update: unknown): unknown {
  if (handle === null || typeof handle !== 'object' || !('db' in handle) || !('transaction' in handle)) {
    throw Object.assign(new Error('a skills write needs the writer handle'), { code: 'BAD_UPDATE' });
  }
  // The handle is open.ts's writer connection, its shape checked above.
  const writer = handle as SkillsHandle;
  const write = update as SkillsUpdate;
  switch (write?.op) {
    case 'sync':
      return syncSkills(writer, write.files, { at: write.at });
    case 'activate':
      return activateSkill(writer, write.name, { at: write.at, by: write.by });
    case 'activate-version':
      return activateNamedVersion(writer, write.name, write.versionId, { at: write.at, by: write.by });
    case 'rollback':
      return rollbackSkill(writer, write.name, { at: write.at, by: write.by });
    case 'reject':
      return rejectPending(writer, write.name, { at: write.at, by: write.by });
    case 'disable':
      return setDisabled(writer, write.name, write.disabled, { at: write.at, by: write.by });
    case 'uses':
      return appendUses(writer, write.uses);
    default:
      throw Object.assign(
        new Error('a skills write names sync, activate, activate-version, rollback, reject, disable or uses'),
        {
          code: 'BAD_UPDATE',
        }
      );
  }
}

/** Retires every pending version of a skill. */
export function rejectPending(
  handle: SkillsHandle,
  name: string,
  options: { at: number; by: string }
): { ok: true; rejected: number } | { ok: false; code: 'unknown-skill' | 'no-candidate' } {
  const review = reviewOf(handle, name);
  if (review === null) return { ok: false, code: 'unknown-skill' };
  if (review.candidates.length === 0) return { ok: false, code: 'no-candidate' };
  for (const candidate of review.candidates) rejectVersion(handle, candidate.versionId, options);
  return { ok: true, rejected: review.candidates.length };
}
