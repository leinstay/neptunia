// The media findings of the memory audit (src/memory/db/audit.ts): a link that points at nothing, from a message that is gone or
// to a row that is gone, and a retired row a live message links. Written by the observation path on a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditMemory } from '../src/memory/db/audit.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { KINDS, fixture, observeLine } from './fixtures/media-memory.ts';
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

test('an observed line with its items leaves no media finding', () =>
  withLine((env) => {
    const { checks } = auditMemory(env.db);
    assert.deepEqual([checks.danglingLinks, checks.linkedMediaKept], [0, 0]);
  }));

test('a link to a media row that is gone is a finding', () =>
  withLine((env, source) => {
    env.db.prepare("UPDATE media_links SET media_id = 'nothing' WHERE owner_id = ? AND position = 0").run(source);
    assert.equal(auditMemory(env.db).checks.danglingLinks, 1);
  }));

test('a link from a message that is gone is a finding', () =>
  withLine((env, source) => {
    env.db.prepare("UPDATE media_links SET owner_id = 'nothing' WHERE owner_id = ? AND position = 0").run(source);
    assert.equal(auditMemory(env.db).checks.danglingLinks, 1);
  }));

test('a retired media row a live message links is a finding', () =>
  withLine((env) => {
    env.db.prepare("UPDATE media SET retired_at = '2026-11-01T00:00:00.000Z' WHERE native_ref = 'pic-a'").run();
    assert.equal(auditMemory(env.db).checks.linkedMediaKept, 1);
  }));
