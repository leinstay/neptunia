import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, fixture, observeLine } from '../../../fixtures/media-memory.ts';
import type { Env, Kind, Presence } from '../../../fixtures/media-memory.ts';

const IMAGE = KINDS[0];

async function withLine(kind: Kind, presence: Presence, body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  try {
    observeLine(env, kind, presence);
    env.stem();
    await body(env);
  } finally {
    env.done();
  }
}

// ---------- one store of a text form ----------

test("a text form is stemmed on its media row: the message's stems and text stay what was written", () =>
  withLine(IMAGE, 'full', (env) => {
    const row = env.db.prepare('SELECT text, stems FROM sources WHERE native_id = ?').get('pic');
    assert.equal(row?.text, '');
    assert.ok(!((row?.stems as string | null) ?? '').includes(IMAGE.first.word));
  }));
