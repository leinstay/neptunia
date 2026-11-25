// Tests for src/admin.ts: the object of the owner's operations that the core builds once. The operations it runs
// belong to the modules under src/tools/operations/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAdmin, makeRoot, mayRun } from '../fixtures/admin-rig.ts';

// A typed command is the owner's, so runSkillOp checks no caller for it.
test('runSkillOp: a typed command runs an owner operation with no grant, whatever its account', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  for (const caller of [{ accountId: '8' }, {}]) {
    const listed = await admin.runSkillOp('access.list', {}, { placeId: 'g1', roleIds: [], ...caller });
    assert.equal(listed.status, 'ok', JSON.stringify(caller));
    assert.equal(await mayRun(admin, 'memory.journal.read', caller), true, JSON.stringify(caller));
  }
});
