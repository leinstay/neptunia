// Stage V.1: the read-only consistency audit of memory (scripts/memory-audit.ts). Counts only: every row's place exists, its
// scope kind matches its place, its audience is the one its scope derives, every link points at a live row, no row sits in
// `aud:none` without a reason. Synthetic rows on a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditMemory } from '../scripts/memory-audit.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { AT, KINDS, fixture, observeLine } from './fixtures/media-memory.ts';
import type { Env } from './fixtures/media-memory.ts';

function withLine(body: (env: Env, source: string) => void) {
  const env = fixture();
  try {
    const source = observeLine(env, KINDS[0], 'full');
    fillEnvAudiences(env);
    body(env, source);
  } finally {
    env.done();
  }
}

const unlink = (env: Env, sql: string, ...params: Array<string>) => env.db.prepare(sql).run(...params);

test('a consistent database has no finding', () =>
  withLine((env) => {
    const { findings } = auditMemory(env.db);
    assert.deepEqual(
      Object.entries(findings).filter(([, count]) => count !== 0),
      []
    );
  }));

test('a link to a media row that is gone is a finding', () =>
  withLine((env, source) => {
    unlink(env, "UPDATE media_links SET media_id = 'nothing' WHERE owner_id = ? AND position = 0", source);
    assert.equal(auditMemory(env.db).findings.linkToMissingMedia, 1);
  }));

test('a link from a message that is gone is a finding', () =>
  withLine((env, source) => {
    unlink(env, "UPDATE media_links SET owner_id = 'nothing' WHERE owner_id = ? AND position = 0", source);
    assert.equal(auditMemory(env.db).findings.linkFromMissingOwner, 1);
  }));

test('a retired media row a live message links is a finding', () =>
  withLine((env) => {
    unlink(env, "UPDATE media SET retired_at = '2026-11-01T00:00:00.000Z' WHERE native_ref = 'pic-a'");
    assert.equal(auditMemory(env.db).findings.linkedMediaRetired, 1);
  }));

test('a source in a place that does not exist is a finding', () =>
  withLine((env) => {
    env.say({ native: 'lost', at: AT, text: 'x', place: 'discord:channel:missing' });
    fillEnvAudiences(env);
    unlink(env, "DELETE FROM places WHERE id = 'discord:channel:missing'");
    assert.equal(auditMemory(env.db).findings.sourceWithoutPlace, 1);
  }));

test('a source whose audience is not the one its scope derives is a finding', () =>
  withLine((env, source) => {
    unlink(env, "UPDATE sources SET scope_kind = 'dm', scope_dm = 'someone' WHERE id = ?", source);
    assert.equal(auditMemory(env.db).findings.audienceMismatch, 1);
  }));

test('a row in aud:none without a reason is a finding', () =>
  withLine((env, source) => {
    unlink(env, "UPDATE sources SET audience_id = 'aud:none' WHERE id = ?", source);
    assert.ok(auditMemory(env.db).findings.audienceNone >= 1);
  }));

test('the audit holds counts and no content of any row', () =>
  withLine((env) => {
    assert.ok(!JSON.stringify(auditMemory(env.db)).includes(KINDS[0].first.word));
  }));

test('the audit changes nothing', () =>
  withLine((env) => {
    const before = env.db.prepare('SELECT COUNT(*) AS n, MAX(rowid) AS r FROM sources').get();
    auditMemory(env.db);
    assert.deepEqual(env.db.prepare('SELECT COUNT(*) AS n, MAX(rowid) AS r FROM sources').get(), before);
  }));
