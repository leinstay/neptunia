// The registry of the engine's skills (schema v11, spec 2026-10-24-memory-schema-v7, sections 6 and 11 on skills). The
// skills stay code in the repository; the registry records which version of each one is active, bound to three hashes:
// the content hash (its definition and the source file of its operation), the manifest hash (what it may reach: tools,
// destinations, network, file access, capabilities) and the engine commit. An evaluation carries the same three, so a
// passing evaluation of one version never counts for another. Nothing here writes or changes a skill.
//
//   skillVersionsOf({ definitions, nested, sourceOf, commit })   pure: one entry per definition of
//       src/skills/definitions.js with its hashes and manifest. `nested` is the skills a skill reaches inside its own
//       operation (src/skills/access.js#NESTED_CAPABILITIES), `sourceOf(op)` the text of the operation's source file
//       ('' when unknown), `commit` the engine commit (`unknown` when there is none).
//   registerSkills(handle, entries, { at })   at start-up: a `skills` row per name (lifecycle `active`; a name no
//       longer defined becomes `stale`), a `skill_versions` row per new (content, manifest, commit). A skill's first
//       version is its running code and becomes active at once (`extra.bootstrap`); every later version is a `candidate`.
//   addEvaluation(handle, evaluation)   one `skill_evaluations` row (append-only), with the hashes it evaluated.
//   activateVersion(handle, versionId, { at })   the agents' rule (the owner's): refused unless a passing `tests` and a
//       passing `audience_check` evaluation bind the version's three hashes (`no-tests`, `no-audience-check`), a
//       previous active version exists to roll back to (`no-rollback`), and the manifest asks nothing the active
//       version lacks (`new-capability`, with what). Everything else waits for the owner.
//   rollback(handle, skillName, { at })   the version active before the current one becomes active again.
//   reviewsDue(db, { now, usesOf, uses, days })   the monitoring reminder: an agent-activated version with `uses` (5)
//       uses or `days` (14) days since its activation and no `outcome` evaluation since. A reminder, never a gate.
// Results are `{ ok: true, ... }` or `{ ok: false, code }` with a kebab-case code. Imports only node:crypto (the sync
// worker loads it).

import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const iso = (value) => (Number.isFinite(value) ? new Date(value).toISOString() : typeof value === 'string' && value ? value : new Date().toISOString());
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const sorted = (values) => [...new Set(values)].sort();

/** JSON with the keys of every object sorted: the one serialisation a hash is taken of. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  if (typeof value === 'function') return JSON.stringify(String(value));
  return JSON.stringify(value === undefined ? null : value);
}

/** The manifest's lists, each sorted and without repeats. */
const MANIFEST_KEYS = ['tools', 'destinations', 'network', 'fileAccess', 'capabilities'];

/**
 * What one skill definition may reach, from what it declares: `tools` (itself and the skills its operation reaches,
 * `nested`), `destinations` (`current`, and `other-channel` when it takes a channel), `network` (`provider` for a paid
 * skill, `web` for the web family), `fileAccess` (`errand-files` when it takes a file handle) and `capabilities` (its
 * effect class and its feature switch).
 */
export function manifestOf(definition, nested = []) {
  const refs = Object.values(definition.refs ?? {});
  const params = Object.keys(definition.params?.properties ?? {});
  const manifest = {
    tools: [definition.name, ...nested],
    destinations: definition.effects === 'read' && nested.length === 0 ? [] : ['current', ...(refs.includes('channel') ? ['other-channel'] : [])],
    network: [...(definition.costClass === 'paid' ? ['provider'] : []), ...(String(definition.name).startsWith('web.') ? ['web'] : [])],
    fileAccess: params.includes('file') ? ['errand-files'] : [],
    capabilities: [definition.effects, ...(definition.feature ? [`feature:${definition.feature}`] : [])],
  };
  return Object.fromEntries(MANIFEST_KEYS.map((key) => [key, sorted(manifest[key])]));
}

/** What `next` asks that `previous` lacks, as `<key>:<value>` (empty when nothing). */
export function newCapabilities(previous, next) {
  const out = [];
  for (const key of MANIFEST_KEYS) {
    const had = new Set(Array.isArray(previous?.[key]) ? previous[key] : []);
    for (const value of Array.isArray(next?.[key]) ? next[key] : []) if (!had.has(value)) out.push(`${key}:${value}`);
  }
  return out;
}

/** The content hash of a definition (every field, `toArgs` by its source) and its operation's source text. */
export function contentHashOf(definition, source = '') {
  return sha256(`${canonicalJson(definition)}\n${source}`);
}

/**
 * One registry entry per definition: `{ name, contentHash, manifestHash, commitSha, manifest }`.
 * @param {{ definitions: object[], nested?: Record<string, string[]>, sourceOf?: (op: string) => string, commit?: string|null }} input
 */
export function skillVersionsOf({ definitions, nested = {}, sourceOf = () => '', commit = null }) {
  const commitSha = typeof commit === 'string' && commit.trim() ? commit.trim() : 'unknown';
  return definitions.map((definition) => {
    const manifest = manifestOf(definition, Array.isArray(nested[definition.name]) ? nested[definition.name] : []);
    let source = '';
    try {
      source = String(sourceOf(definition.op ?? definition.name) ?? '');
    } catch {
      source = '';
    }
    return { name: definition.name, contentHash: contentHashOf(definition, source), manifestHash: sha256(canonicalJson(manifest)), commitSha, manifest };
  });
}

const skillId = (name) => `skill:${name}`;
const versionId = (entry) => `skillver:${entry.name}:${sha256(`${entry.contentHash}\n${entry.manifestHash}\n${entry.commitSha}`).slice(0, 32)}`;

/**
 * Registers the entries (see the head of this file) in one transaction.
 * @returns {{ skills: number, versions: number, stale: number }}
 */
export function registerSkills(handle, entries, { at } = {}) {
  const stamp = iso(at);
  return handle.transaction(() => {
    const { db } = handle;
    const counts = { skills: 0, versions: 0, stale: 0 };
    const names = new Set();
    for (const entry of entries) {
      names.add(entry.name);
      const id = skillId(entry.name);
      const known = db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
      if (!known) {
        db.prepare("INSERT INTO skills (id, name, active_version, lifecycle, origin_work_id, pinned, extra) VALUES (?, ?, NULL, 'active', NULL, 0, NULL)").run(id, entry.name);
        counts.skills += 1;
      } else if (known.lifecycle === 'stale') {
        db.prepare("UPDATE skills SET lifecycle = 'active' WHERE id = ?").run(id);
      }
      const vid = versionId(entry);
      const first = !known?.active_version;
      const written = db.prepare(`INSERT OR IGNORE INTO skill_versions (id, skill_id, version, content_hash, manifest_hash, commit_sha, origin_work_id, status, created_at, manifest)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
        .run(vid, id, `${entry.commitSha.slice(0, 12)}-${entry.contentHash.slice(0, 8)}`, entry.contentHash, entry.manifestHash, entry.commitSha, first ? 'active' : 'candidate', stamp, canonicalJson(entry.manifest));
      if (written.changes > 0) counts.versions += 1;
      if (first) db.prepare('UPDATE skills SET active_version = ?, extra = ? WHERE id = ?').run(vid, JSON.stringify({ bootstrap: true, activatedAt: stamp, history: [] }), id);
    }
    for (const row of db.prepare("SELECT id, name FROM skills WHERE lifecycle = 'active'").all()) {
      if (names.has(row.name)) continue;
      db.prepare("UPDATE skills SET lifecycle = 'stale' WHERE id = ?").run(row.id);
      counts.stale += 1;
    }
    return counts;
  });
}

/**
 * One evaluation of a version, append-only.
 * @param {{ id: string, versionId: string, kind: 'tests'|'trial'|'outcome'|'audience_check', passed: boolean, result?: object|null,
 *   evidenceId?: string|null, at?: number|string, contentHash: string, manifestHash: string, commitSha: string }} evaluation
 */
export function addEvaluation(handle, evaluation) {
  return handle.transaction(() => {
    handle.db.prepare(`INSERT INTO skill_evaluations (id, version_id, kind, passed, result, evidence_id, at, content_hash, manifest_hash, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(evaluation.id, evaluation.versionId, evaluation.kind, evaluation.passed === true ? 1 : 0, evaluation.result === undefined || evaluation.result === null ? null : JSON.stringify(evaluation.result),
        evaluation.evidenceId ?? null, iso(evaluation.at), evaluation.contentHash, evaluation.manifestHash, evaluation.commitSha);
    return { ok: true, id: evaluation.id };
  });
}

/** Whether a passing evaluation of `kind` binds the version's three hashes. */
function bound(db, version, kind) {
  return db.prepare(`SELECT 1 AS ok FROM skill_evaluations WHERE version_id = ? AND kind = ? AND passed = 1
    AND content_hash = ? AND manifest_hash = ? AND commit_sha = ? LIMIT 1`).get(version.id, kind, version.content_hash, version.manifest_hash, version.commit_sha) !== undefined;
}

/** Activates a candidate under the agents' rule (see the head of this file). */
export function activateVersion(handle, id, { at } = {}) {
  const stamp = iso(at);
  return handle.transaction(() => {
    const { db } = handle;
    const version = db.prepare('SELECT * FROM skill_versions WHERE id = ?').get(id);
    if (!version) return { ok: false, code: 'unknown-version' };
    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(version.skill_id);
    if (skill.active_version === id) return { ok: false, code: 'already-active' };
    if (!bound(db, version, 'tests')) return { ok: false, code: 'no-tests' };
    if (!bound(db, version, 'audience_check')) return { ok: false, code: 'no-audience-check' };
    const current = skill.active_version ? db.prepare('SELECT * FROM skill_versions WHERE id = ?').get(skill.active_version) : null;
    if (!current) return { ok: false, code: 'no-rollback' };
    const added = newCapabilities(parse(current.manifest, {}), parse(version.manifest, {}));
    if (added.length > 0) return { ok: false, code: 'new-capability', added };
    const extra = parse(skill.extra, {});
    db.prepare("UPDATE skill_versions SET status = 'retired' WHERE id = ?").run(current.id);
    db.prepare("UPDATE skill_versions SET status = 'active' WHERE id = ?").run(id);
    db.prepare('UPDATE skills SET active_version = ?, extra = ? WHERE id = ?')
      .run(id, JSON.stringify({ ...extra, bootstrap: false, activatedAt: stamp, activatedBy: 'agents', history: [...(Array.isArray(extra.history) ? extra.history : []), current.id] }), skill.id);
    return { ok: true, previous: current.id };
  });
}

/** Makes the version active before the current one active again (`no-rollback` when there is none). */
export function rollback(handle, name, { at } = {}) {
  const stamp = iso(at);
  return handle.transaction(() => {
    const { db } = handle;
    const skill = db.prepare('SELECT * FROM skills WHERE name = ?').get(name);
    if (!skill) return { ok: false, code: 'unknown-skill' };
    const extra = parse(skill.extra, {});
    const history = Array.isArray(extra.history) ? [...extra.history] : [];
    const previous = history.pop();
    if (!previous) return { ok: false, code: 'no-rollback' };
    if (skill.active_version) db.prepare("UPDATE skill_versions SET status = 'retired' WHERE id = ?").run(skill.active_version);
    db.prepare("UPDATE skill_versions SET status = 'active' WHERE id = ?").run(previous);
    db.prepare('UPDATE skills SET active_version = ?, extra = ? WHERE id = ?')
      .run(previous, JSON.stringify({ ...extra, activatedAt: stamp, activatedBy: 'rollback', history }), skill.id);
    return { ok: true, active: previous, retired: skill.active_version };
  });
}

/**
 * The versions due a monitoring look (see the head of this file): `[{ skill, versionId, reason: 'uses' | 'days' }]`.
 * `usesOf(name, sinceIso)` counts the uses since the activation (default: the wake actions naming the skill).
 */
export function reviewsDue(db, { now, usesOf = null, uses = 5, days = 14 } = {}) {
  const count = usesOf ?? ((name, since) => db.prepare('SELECT COUNT(*) AS n FROM wake_actions WHERE kind = ? AND at >= ?').get(name, since).n);
  const out = [];
  for (const skill of db.prepare('SELECT * FROM skills WHERE active_version IS NOT NULL ORDER BY name').all()) {
    const extra = parse(skill.extra, {});
    if (extra.activatedBy !== 'agents' || typeof extra.activatedAt !== 'string') continue;
    const reviewed = db.prepare("SELECT 1 AS ok FROM skill_evaluations WHERE version_id = ? AND kind = 'outcome' AND at >= ? LIMIT 1").get(skill.active_version, extra.activatedAt);
    if (reviewed) continue;
    if (count(skill.name, extra.activatedAt) >= uses) out.push({ skill: skill.name, versionId: skill.active_version, reason: 'uses' });
    else if (Number.isFinite(now) && now - Date.parse(extra.activatedAt) >= days * 86_400_000) out.push({ skill: skill.name, versionId: skill.active_version, reason: 'days' });
  }
  return out;
}

/** One skills write on the writer connection (service.js): `{ kind: 'skills', entries, now }`. */
export function applySkillsWrite(handle, update) {
  return registerSkills(handle, Array.isArray(update?.entries) ? update.entries : [], { at: update?.now });
}
