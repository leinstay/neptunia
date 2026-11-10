// The bounded session pass over old media lines (src/memory/db/session.ts#mediaPassBatch): lines the ordinary cursor passed
// because they held no words come back oldest first, only with a text form, and the ordinary cursor stays. Synthetic rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaPassBatch, scopesOf } from '../src/memory/db/session.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { AT, GENERAL, KINDS, fixture, observeLine } from './fixtures/media-memory.ts';
import type { Env } from './fixtures/media-memory.ts';

const IMAGE = KINDS[0];

function withLines(body: (env: Env, scope: ReturnType<typeof scopesOf>[number]) => void) {
  const env = fixture();
  try {
    observeLine(env, IMAGE, 'part', { native: 'told-1', at: AT });
    env.say({ native: 'words', at: AT + 1000, text: 'words of its own', place: GENERAL });
    observeLine(env, IMAGE, 'absent', { native: 'bare', at: AT + 2000 });
    observeLine(env, IMAGE, 'part', { native: 'told-2', at: AT + 3000 });
    fillEnvAudiences(env);
    const scope = scopesOf(env.db).find((one) => one.scope.scope_kind === 'group');
    assert.ok(scope);
    body(env, scope);
  } finally {
    env.done();
  }
}

const rowidOf = (env: Env, native: string) =>
  Number(env.db.prepare('SELECT rowid AS r FROM sources WHERE native_id = ?').get(native)?.r);

test('the pass reads media-only lines with a text form, oldest first, leaving words and bare lines out', () =>
  withLines((env, scope) => {
    const lines = mediaPassBatch(env.db, scope, {
      after: 0,
      upTo: rowidOf(env, 'told-2'),
      maxMessages: 10,
      since: null,
    });
    assert.deepEqual(
      lines.map((line) => line.native_id),
      ['told-1', 'told-2']
    );
  }));

test('the pass stops at the ordinary cursor: a line not yet learned stays for the ordinary batch', () =>
  withLines((env, scope) => {
    const lines = mediaPassBatch(env.db, scope, {
      after: 0,
      upTo: rowidOf(env, 'words'),
      maxMessages: 10,
      since: null,
    });
    assert.deepEqual(
      lines.map((line) => line.native_id),
      ['told-1']
    );
  }));

test('the pass takes up after its own cursor and holds at most its limit', () =>
  withLines((env, scope) => {
    const upTo = rowidOf(env, 'told-2');
    const first = mediaPassBatch(env.db, scope, { after: 0, upTo, maxMessages: 1, since: null });
    assert.equal(first.length, 1);
    const next = mediaPassBatch(env.db, scope, { after: Number(first[0].rowid), upTo, maxMessages: 1, since: null });
    assert.deepEqual(
      next.map((line) => line.native_id),
      ['told-2']
    );
  }));
