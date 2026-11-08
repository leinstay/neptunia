// The session request's place block (src/memory/db/session.ts): the place fields a place of the batch has not written.
// Synthetic rows only; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL, chat, fixture, request, textOf } from './fixtures/memory-db/session-rig.ts';

test('the place block names the place fields a place of the batch has not written, and only those', () => {
  const env = fixture();
  try {
    chat(env);
    const bare = textOf(request(env).messages[1].content);
    const place = (text: string) => text.slice(text.indexOf('<place>'), text.indexOf('</place>'));
    assert.match(place(bare), /\[p1\] UNWRITTEN purpose, tone, topics/, 'an undescribed place lists all three fields');

    env.db
      .prepare(
        "INSERT INTO descriptions (id, subject_kind, subject_id, field, scope_kind, scope_iface, audience_id, current_version) VALUES ('d-purpose', 'place', ?, 'purpose', 'group', 'discord', 'aud:none', 'dv-purpose')"
      )
      .run(CHANNEL);
    env.db
      .prepare(
        "INSERT INTO description_versions (id, description_id, text, written_at) VALUES ('dv-purpose', 'd-purpose', 'planning trips', '2026-10-20T10:00:00Z')"
      )
      .run();
    const partly = place(textOf(request(env).messages[1].content));
    assert.match(partly, /\[p1\] UNWRITTEN tone, topics/, 'a written field leaves the list');
    assert.doesNotMatch(partly, /UNWRITTEN[^\n]*purpose/);
  } finally {
    env.done();
  }
});
