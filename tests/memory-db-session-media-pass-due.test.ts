// A quiet scope with old media-only lines is due for the media pass (src/memory/db/writer-switch.ts#dueScopes):
// the scheduled sweep takes only the scopes `dueScopes` returns, and the pass runs in `sweep`'s quiet branch, so a scope
// with fewer lines than `minMessages` must still be listed while the pass has lines left. Synthetic rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorKey, scopesOf } from '../src/memory/db/session.ts';
import { dueScopes } from '../src/memory/db/writer-switch.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { AT, GENERAL, KINDS, fixture, observeLine } from './fixtures/media-memory.ts';

const HOUR = 3600 * 1000;

function withQuietScope(body: (env: ReturnType<typeof fixture>, key: string, cursorKeyOf: string) => void) {
  const env = fixture();
  try {
    observeLine(env, KINDS[0], 'part', { native: 'told-1', at: AT });
    env.say({ native: 'words', at: AT + 1000, text: 'words of its own', place: GENERAL });
    fillEnvAudiences(env);
    const scope = scopesOf(env.db).find((one) => one.scope.scope_kind === 'group');
    assert.ok(scope);
    // The ordinary cursor is past every line: the told image line was passed because it held no words.
    const last = Number(env.db.prepare('SELECT MAX(rowid) AS r FROM sources').get()?.r);
    const key = cursorKey('apply', scope.key);
    env.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, String(last));
    body(env, scope.key, key);
  } finally {
    env.done();
  }
}

test('lists a quiet scope while the media pass has old lines left and the pass is on', () =>
  withQuietScope((env, scopeKey) => {
    const config = { memoryDb: { session: { mode: 'apply', mediaPass: true } } };
    const due = dueScopes(env.db, config as never, AT + 24 * HOUR);
    assert.deepEqual(
      due.map((one) => one.key),
      [scopeKey]
    );
  }));

test('lists nothing for a quiet scope when the media pass is off', () =>
  withQuietScope((env) => {
    const config = { memoryDb: { session: { mode: 'apply' } } };
    assert.deepEqual(dueScopes(env.db, config as never, AT + 24 * HOUR), []);
  }));
