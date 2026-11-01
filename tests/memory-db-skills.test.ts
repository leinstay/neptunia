// The skills registry in the memory database (src/memory/db/skills.ts, schema v11 tables and v22's `skill_uses`):
// a synced SKILL.md becomes a candidate version, an agent or the owner activates it, nobody else does, and every
// activation can be rolled back. Reuse is an append-only table of uses, counted per skill, and a skill unread for
// `days` days is due for review and never deleted. A memory database in memory on the calling thread, an injected
// clock, no disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openMemoryDb } from '../src/memory/db/open.ts';
import {
  SKILL_USE_KINDS,
  activateSkill,
  activateVersion,
  appendUses,
  listSkills,
  pendingVersions,
  rejectVersion,
  reviewOf,
  reviewsDue,
  rollbackSkill,
  setDisabled,
  syncSkills,
  useCountsBySkill,
} from '../src/memory/db/skills.ts';
import type { SkillSource, SkillsHandle, UseKind } from '../src/memory/db/skills.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T09:00:00Z');
const AGENT = 'agent:hand';

/** A skill file as the loader hands it over: the text decides the hash. */
function skill(
  name: string,
  text = `v1 of ${name}`,
  tools: Array<string> = ['web.search'],
  task: string | null = null
): SkillSource {
  const source = `---\nname: ${name}\n---\n${text}`;
  return { name, tools, task, source, contentHash: createHash('sha256').update(source).digest('hex') };
}

function open(t: { after: (fn: () => void) => void }): SkillsHandle {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  return handle;
}

type Db = {
  prepare(sql: string): {
    get(...p: Array<unknown>): Record<string, unknown> | undefined;
    all(...p: Array<unknown>): Array<Record<string, unknown>>;
    run(...p: Array<unknown>): unknown;
  };
};
// open.js types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method Db names.
const dbOf = (handle: SkillsHandle): Db => handle.db as Db;

/** The active version id of a skill, from its row. */
const activeOf = (handle: SkillsHandle, name: string): string | null => {
  const row = listSkills(handle).find((one) => one.name === name);
  return row?.active?.versionId ?? null;
};

/** The id of the newest pending version of `name`. */
function pendingId(handle: SkillsHandle, name: string): string {
  const found = pendingVersions(handle)
    .filter((one) => one.skill === name)
    .at(-1);
  if (found === undefined) throw new Error(`no pending version of ${name}`);
  return found.versionId;
}

test('a synced file is one candidate version and nothing is active until someone activates it', (t) => {
  const handle = open(t);
  const counts = syncSkills(handle, [skill('look-it-up', 'v1', ['web.read', 'web.search'], 't0000001f')], { at: T0 });
  assert.deepEqual(counts, { skills: 1, versions: 1, stale: 0 });
  const [row] = listSkills(handle);
  assert.equal(row?.name, 'look-it-up');
  assert.equal(row?.active, null);
  assert.equal(row?.candidates, 1);
  const [pending] = pendingVersions(handle);
  assert.deepEqual(pending?.tools, ['web.read', 'web.search']);
  assert.equal(pending?.task, 't0000001f');
  assert.equal(pending?.status, 'candidate');
  assert.equal(pending?.source.endsWith('v1'), true);
});

test('syncing the same file again changes nothing', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  assert.deepEqual(syncSkills(handle, [skill('look-it-up')], { at: T0 + 1000 }), { skills: 0, versions: 0, stale: 0 });
  assert.equal(pendingVersions(handle).length, 1);
});

test('syncing no file registers nothing', (t) => {
  const handle = open(t);
  assert.deepEqual(syncSkills(handle, [], { at: T0 }), { skills: 0, versions: 0, stale: 0 });
  assert.deepEqual(listSkills(handle), []);
});

test('an agent activates the first version and the list shows who, when, and the activation as it stands', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  const done = activateSkill(handle, 'look-it-up', { at: T0 + 1000, by: AGENT });
  assert.equal(done.ok, true);
  const [row] = listSkills(handle);
  assert.equal(row?.active?.activatedBy, AGENT);
  assert.equal(row?.active?.activatedAt, new Date(T0 + 1000).toISOString());
  assert.equal(row?.candidates, 0);
  assert.equal(row?.rollbackTo, null, 'a first version has nothing to roll back to');
});

test('a later version waits as a candidate beside the active one, and activation retires the old one with a rollback', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up', 'one')], { at: T0 });
  activateSkill(handle, 'look-it-up', { at: T0 + 1, by: AGENT });
  const first = activeOf(handle, 'look-it-up');
  syncSkills(handle, [skill('look-it-up', 'two')], { at: T0 + 2 });
  assert.equal(activeOf(handle, 'look-it-up'), first, 'a sync never moves the active version');
  const review = reviewOf(handle, 'look-it-up');
  assert.equal(review?.active?.versionId, first);
  assert.equal(review?.candidates.length, 1);
  const done = activateSkill(handle, 'look-it-up', { at: T0 + 3, by: 'owner' });
  assert.deepEqual(done.ok && done.previous, first);
  const [row] = listSkills(handle);
  assert.equal(row?.rollbackTo?.versionId, first);
  assert.equal(row?.active?.activatedBy, 'owner');
});

test('a newer file retires the candidate it replaces before anyone activated that one', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up', 'draft')], { at: T0 });
  syncSkills(handle, [skill('look-it-up', 'better draft')], { at: T0 + 1 });
  const pending = pendingVersions(handle);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.source.endsWith('better draft'), true);
});

test('refuses to activate a version twice, a retired version, and a name nobody synced', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  const id = pendingId(handle, 'look-it-up');
  assert.equal(activateVersion(handle, id, { at: T0 + 1, by: AGENT }).ok, true);
  assert.deepEqual(activateVersion(handle, id, { at: T0 + 2, by: AGENT }), { ok: false, code: 'already-active' });
  assert.deepEqual(activateVersion(handle, 'skillver:nope', { at: T0, by: AGENT }), {
    ok: false,
    code: 'unknown-version',
  });
  assert.deepEqual(activateSkill(handle, 'ghost', { at: T0, by: AGENT }), { ok: false, code: 'unknown-skill' });
  assert.deepEqual(activateSkill(handle, 'look-it-up', { at: T0, by: AGENT }), { ok: false, code: 'no-candidate' });
});

test('a rejected candidate is retired, cannot be activated, and a sync of the same text does not bring it back', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  const id = pendingId(handle, 'look-it-up');
  assert.deepEqual(rejectVersion(handle, id, { at: T0 + 1, by: 'owner' }), { ok: true });
  assert.deepEqual(activateVersion(handle, id, { at: T0 + 2, by: AGENT }), { ok: false, code: 'not-candidate' });
  assert.deepEqual(rejectVersion(handle, id, { at: T0 + 3, by: 'owner' }), { ok: false, code: 'not-candidate' });
  syncSkills(handle, [skill('look-it-up')], { at: T0 + 4 });
  assert.deepEqual(pendingVersions(handle), []);
});

test('rollback restores the previous version, twice walks back two, and a first version has none', (t) => {
  const handle = open(t);
  const stamps = [T0 + 10, T0 + 20, T0 + 30];
  const ids: Array<string> = [];
  for (const [index, text] of ['one', 'two', 'three'].entries()) {
    syncSkills(handle, [skill('look-it-up', text)], { at: stamps[index] ?? T0 });
    ids.push(pendingId(handle, 'look-it-up'));
    activateSkill(handle, 'look-it-up', { at: (stamps[index] ?? T0) + 1, by: AGENT });
  }
  assert.equal(activeOf(handle, 'look-it-up'), ids[2]);
  const back = rollbackSkill(handle, 'look-it-up', { at: T0 + 40, by: 'owner' });
  assert.deepEqual(back, { ok: true, active: ids[1], retired: ids[2] });
  assert.deepEqual(rollbackSkill(handle, 'look-it-up', { at: T0 + 50, by: 'owner' }), {
    ok: true,
    active: ids[0],
    retired: ids[1],
  });
  assert.deepEqual(rollbackSkill(handle, 'look-it-up', { at: T0 + 60, by: 'owner' }), {
    ok: false,
    code: 'no-rollback',
  });
  assert.equal(activeOf(handle, 'look-it-up'), ids[0], 'the first version stays active');
  assert.deepEqual(rollbackSkill(handle, 'ghost', { at: T0, by: 'owner' }), { ok: false, code: 'unknown-skill' });
});

test('disabling is idempotent, keeps the active version, and enabling brings the switch back', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  activateSkill(handle, 'look-it-up', { at: T0 + 1, by: AGENT });
  const active = activeOf(handle, 'look-it-up');
  assert.deepEqual(setDisabled(handle, 'look-it-up', true, { at: T0 + 2, by: 'persona' }), { ok: true, changed: true });
  assert.deepEqual(setDisabled(handle, 'look-it-up', true, { at: T0 + 3, by: 'persona' }), {
    ok: true,
    changed: false,
  });
  const [off] = listSkills(handle);
  assert.equal(off?.disabled, true);
  assert.equal(off?.disabledBy, 'persona');
  assert.equal(off?.active?.versionId, active);
  assert.deepEqual(setDisabled(handle, 'look-it-up', false, { at: T0 + 4, by: 'owner' }), { ok: true, changed: true });
  assert.equal(listSkills(handle)[0]?.disabled, false);
  assert.deepEqual(setDisabled(handle, 'ghost', true, { at: T0, by: 'owner' }), { ok: false, code: 'unknown-skill' });
});

test('a skill whose file is gone is stale, keeps its active version, and is active again when the file returns', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up'), skill('other-one')], { at: T0 });
  activateSkill(handle, 'look-it-up', { at: T0 + 1, by: AGENT });
  assert.deepEqual(syncSkills(handle, [skill('other-one')], { at: T0 + 2 }), { skills: 0, versions: 0, stale: 1 });
  const gone = listSkills(handle).find((row) => row.name === 'look-it-up');
  assert.equal(gone?.lifecycle, 'stale');
  assert.equal(gone?.active?.activatedBy, AGENT);
  syncSkills(handle, [skill('look-it-up'), skill('other-one')], { at: T0 + 3 });
  assert.equal(listSkills(handle).find((row) => row.name === 'look-it-up')?.lifecycle, 'active');
});

test('uses are appended and counted per skill from a moment on', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  activateSkill(handle, 'look-it-up', { at: T0 + 1, by: AGENT });
  const versionId = activeOf(handle, 'look-it-up') ?? '';
  const use = (kind: UseKind, turnId: string, at: number) => ({
    skill: 'look-it-up',
    versionId,
    turnId,
    kind,
    at,
  });
  const written = appendUses(handle, [
    use('discovered', 't1', T0 + 10),
    use('read', 't1', T0 + 11),
    use('tried', 't1', T0 + 12),
    use('succeeded', 't1', T0 + 13),
    use('discovered', 't2', T0 + DAY),
  ]);
  assert.equal(written, 5);
  const all = useCountsBySkill(handle, { since: 0 })['look-it-up'];
  assert.deepEqual(all, { discovered: 2, read: 1, tried: 1, succeeded: 1, corrected: 0, declined: 0 });
  const late = useCountsBySkill(handle, { since: T0 + DAY })['look-it-up'];
  assert.equal(late?.discovered, 1);
  assert.equal(late?.read, 0);
  assert.equal(reviewOf(handle, 'look-it-up')?.active?.uses.tried, 1);
});

test('appending no use writes nothing, and a use of a version nobody registered is refused', (t) => {
  const handle = open(t);
  assert.equal(appendUses(handle, []), 0);
  assert.throws(() =>
    appendUses(handle, [{ skill: 'ghost', versionId: 'skillver:nope', turnId: 't1', kind: 'read', at: T0 }])
  );
  assert.equal(dbOf(handle).prepare('SELECT COUNT(*) AS n FROM skill_uses').get()?.n, 0);
});

test('a use cannot be changed or deleted once written', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  activateSkill(handle, 'look-it-up', { at: T0 + 1, by: AGENT });
  appendUses(handle, [
    { skill: 'look-it-up', versionId: activeOf(handle, 'look-it-up') ?? '', turnId: 't1', kind: 'read', at: T0 + 2 },
  ]);
  assert.throws(() => dbOf(handle).prepare("UPDATE skill_uses SET kind = 'declined'").run());
  assert.throws(() => dbOf(handle).prepare('DELETE FROM skill_uses').run());
});

test('a skill unread for the window is due for review, a read or a young activation clears it, and nothing is deleted', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('stale-habit'), skill('read-habit'), skill('young-habit'), skill('off-habit')], { at: T0 });
  for (const name of ['stale-habit', 'read-habit', 'off-habit']) activateSkill(handle, name, { at: T0 + 1, by: AGENT });
  const now = T0 + 40 * DAY;
  activateSkill(handle, 'young-habit', { at: now - 2 * DAY, by: AGENT });
  setDisabled(handle, 'off-habit', true, { at: now - DAY, by: 'persona' });
  appendUses(handle, [
    {
      skill: 'read-habit',
      versionId: activeOf(handle, 'read-habit') ?? '',
      turnId: 't1',
      kind: 'read',
      at: now - 5 * DAY,
    },
    {
      skill: 'stale-habit',
      versionId: activeOf(handle, 'stale-habit') ?? '',
      turnId: 't0',
      kind: 'discovered',
      at: now - DAY,
    },
  ]);
  const due = reviewsDue(handle, { now, days: 30 });
  assert.deepEqual(
    due.map((one) => one.skill),
    ['stale-habit']
  );
  assert.equal(due[0]?.lastReadAt, null);
  assert.equal(listSkills(handle).length, 4);
  assert.deepEqual(reviewsDue(handle, { now: T0, days: 30 }), [], 'nothing is due before the window has passed');
});

test('review of an unknown skill is null and of a skill with no active version lists only its candidates', (t) => {
  const handle = open(t);
  assert.equal(reviewOf(handle, 'ghost'), null);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  const review = reviewOf(handle, 'look-it-up');
  assert.equal(review?.active, null);
  assert.equal(review?.candidates.length, 1);
});

test('every kind the registry names can be appended and counted', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  activateSkill(handle, 'look-it-up', { at: T0 + 1, by: AGENT });
  const versionId = activeOf(handle, 'look-it-up') ?? '';
  const uses = SKILL_USE_KINDS.map((kind, n) => ({
    skill: 'look-it-up',
    versionId,
    turnId: 't1',
    kind,
    at: T0 + 10 + n,
  }));
  assert.equal(appendUses(handle, uses), SKILL_USE_KINDS.length);
  assert.deepEqual(
    Object.keys(useCountsBySkill(handle, { since: 0 })['look-it-up'] ?? {}).sort(),
    [...SKILL_USE_KINDS].sort()
  );
});
