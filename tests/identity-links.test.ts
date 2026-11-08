// The links the observation writes for the owner's command line (src/memory/db/identity-links.ts): a line carries the
// owner's person, and the writer links the chat's account to it and folds her proposals for that account into him. Real
// temporary databases, synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { mergePeople } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { addAccount, addPerson } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const OWNER = 'person:0w0w0w0w-synthetic';
const PROPOSED = 'person:9r9r9r9r-synthetic';
const ELSEWHERE = 'person:e1e1e1e1-synthetic';
const AT = Date.parse('2026-11-05T10:00:00Z');

test('a line of the command line is stored when her proposal for it was merged into somebody else', () => {
  // Bug: the observation folds her tentative person into the owner, the merge refuses a person already merged
  // elsewhere, and the refusal rolls back the line, so every line of the owner's chat is lost.
  const handle = openMemoryDb(path.join(tempDir('nep-identity-links-'), 'memory.db'));
  try {
    const db = dbOf(handle);
    addPerson(db, OWNER);
    addPerson(db, ELSEWHERE);
    addAccount(db, {
      id: 'cli:owner',
      iface: 'cli',
      authority: 'cli/local',
      native: 'owner',
      person: PROPOSED,
      link: 'proposed',
    });
    db.prepare("UPDATE account_person_links SET by = 'her' WHERE account_id = 'cli:owner'").run();
    mergePeople(handle, PROPOSED, ELSEWHERE, { by: 'session', now: AT });
    const envelope = observationOf(
      {
        kind: 'message.received',
        iface: 'cli',
        at: AT,
        chat: { id: 'cli:dm:owner', kind: 'dm', chatType: 'dm', partnerId: 'owner' },
        message: { id: 'line-1', at: AT, content: 'a synthetic line', author: { id: 'owner', name: 'owner' } },
      },
      { connection: 'conn:cli', direct: true }
    );
    assert.ok(envelope);
    const result = observe(handle, { ...envelope, consoleOwner: { person: OWNER, listed: [] } }, { now: () => AT });
    assert.equal(result.ok, true);
    assert.equal(db.prepare("SELECT person_id FROM accounts WHERE id = 'cli:owner'").get()?.person_id, OWNER);
    assert.equal(
      db.prepare('SELECT into_person FROM people_merges WHERE from_person = ?').get(PROPOSED)?.into_person,
      ELSEWHERE
    );
  } finally {
    handle.close();
  }
});
