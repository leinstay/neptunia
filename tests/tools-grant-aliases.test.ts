// A grant stored under the name of a merged tool opens the merged tool: `memory.affinity.read` is read by
// `memory.profile.read`, `errand.status` by `errand.list` (src/tools/access.ts). Her stored grants and the wake
// envelopes (`heartbeat.tools`, `wakes.kinds.<kind>.tools`) name tools by string, so a live config written before the
// merge keeps working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantedToPersona, skillAccess, wakeEnvelopeRefusal } from '../src/tools/access.ts';

const SELF = 'self-1';
const grant = (name: string) => ({ bot: { access: { [name]: { everyone: false, roles: [], users: [SELF] } } } });

test('grantedToPersona: a grant of memory.affinity.read opens memory.profile.read', () => {
  // Catches: the merge silently takes the attitude reads away from her until the grant is rewritten.
  assert.equal(grantedToPersona(grant('memory.affinity.read'), SELF, 'memory.profile.read'), true);
});

test('grantedToPersona: a grant of errand.status opens errand.list', () => {
  // Catches: her errand listing stops working with `not-allowed` after the merge.
  assert.equal(grantedToPersona(grant('errand.status'), SELF, 'errand.list'), true);
});

test('grantedToPersona: an alias opens only the tool it merged into', () => {
  // Catches: the mapping reads every grant under one old name as a grant of everything.
  assert.equal(grantedToPersona(grant('memory.affinity.read'), SELF, 'memory.channel.read'), false);
  assert.equal(grantedToPersona(grant('errand.status'), SELF, 'errand.cancel'), false);
});

test('grantedToPersona: an alias grant that does not name her user id opens nothing', () => {
  // Catches: the alias lookup skips the user check of a grant.
  const others = { bot: { access: { 'errand.status': { everyone: true, roles: ['r1'], users: ['someone-else'] } } } };
  assert.equal(grantedToPersona(others, SELF, 'errand.list'), false);
  assert.equal(grantedToPersona(grant('errand.status'), null, 'errand.list'), false);
});

test('skillAccess: the merged tool is allowed under the old grant', () => {
  const verdict = skillAccess({ skill: { name: 'errand.list' }, config: grant('errand.status'), selfId: SELF });
  assert.deepEqual(verdict, { allowed: true, reason: 'allowed' });
});

test('a wake envelope that names the old tool allows the merged one', () => {
  // Catches: `heartbeat.tools` listing memory.affinity.read refuses her attitude reads on a heartbeat.
  const config = { heartbeat: { tools: ['memory.affinity.read', 'errand.status'] } };
  for (const skill of ['memory.profile.read', 'errand.list'])
    assert.equal(wakeEnvelopeRefusal({ config, wakeKind: 'heartbeat', skill }), null, skill);
  assert.equal(
    wakeEnvelopeRefusal({ config, wakeKind: 'heartbeat', skill: 'memory.channel.read' })?.reason,
    'not-allowed'
  );
});
