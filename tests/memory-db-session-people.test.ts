// The memory session's `<people>` block lists the people of a batch, and its author handles name the accounts that may
// become one. Her own accounts are linked to her person when they are seen (identity-links.ts), so an edit of her own
// line, stored as `seen`, must not put her among the people she reads about. A real memory service and synthetic ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { batchOf, buildSessionRequest, scopesOf } from '../src/memory/db/session.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { baseConfig, prompts } from './fixtures/memory-db/session-rig.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const AT = NOW - 60 * 60_000;
const HER = 'her-synthetic-id';

function line(id: string, author: string, name: string, edit = false) {
  const envelope = observationOf(
    {
      iface: 'discord',
      at: AT,
      edit,
      conversation: { id: 'room', kind: 'channel', chatType: 'channel', rootId: 'community' },
      message: { id, at: AT, content: `a synthetic line ${id}${edit ? ', edited' : ''}`, author: { id: author, name } },
    },
    { selfId: HER }
  );
  if (!envelope) throw new Error('the synthetic line was refused');
  return envelope;
}

test('an edit of her own line puts neither her person nor her account in the session request', async () => {
  // Bug: her account is linked to `person:self`, her edit is a `seen` line, and the session reads her as one of the
  // people of the batch, or offers her account to `people:add`.
  const memory = await openTestMemory({ now: () => NOW });
  try {
    await memory.memoryDb.observeMessage(line('m1', 'member', 'Member'));
    await memory.memoryDb.observeMessage(line('m2', HER, 'Her'));
    await memory.memoryDb.observeMessage(line('m2', HER, 'Her', true));
    const db = memory.memoryDb.database();
    if (!db) throw new Error('the synthetic memory database is unavailable');
    const scope = scopesOf(db).find((entry) => entry.key === 'group:discord');
    if (!scope) throw new Error('the synthetic lines have no group session scope');
    const batch = batchOf(db, scope.scope, { cursor: 0, since: null, maxMessages: 20, settleBefore: NOW });
    const request = buildSessionRequest({
      db,
      scope,
      batch,
      config: baseConfig(),
      prompts,
      selfName: 'Synthetic persona',
      now: NOW,
    });
    const herAccount = db.prepare("SELECT id FROM accounts WHERE native_key = ? AND kind = 'self'").get(HER)?.id;
    assert.equal(
      request.people.some((person) => person.id === 'person:self'),
      false
    );
    assert.equal(
      [...request.maps.authors.values()].some((author) => author.id === herAccount),
      false
    );
  } finally {
    await memory.close();
  }
});
