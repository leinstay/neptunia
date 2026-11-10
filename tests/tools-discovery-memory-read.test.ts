// exposedSkillNames (src/tools/discovery.ts) after the narrow reads of one subject merge into memory.read (slice 12 of
// the lookup loop): a grant under an old name opens memory.read (src/tools/operations/grants.ts), and the old names leave
// her list while they stay the owner's commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exposedSkillNames } from '../src/tools/discovery.ts';
import '../src/tools/operations/index.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { chainsOnDefaults } from './fixtures/chains.ts';

const SELF = 'self-id';
const GRANT = { everyone: false, roles: [], users: [SELF] };
const OLD_MEMORY_READS = [
  'memory.profile.read',
  'memory.channel.read',
  'memory.server.read',
  'lore.list',
  'lore.show',
  'memory.recent.read',
];

// Bug caught: a deployment whose `bot.access` names the old reads loses every memory read, or keeps offering the old ones.
test('offers memory.read and none of the old reads when the old reads are granted to her', () => {
  const config = {
    bot: { access: Object.fromEntries(OLD_MEMORY_READS.map((name) => [name, GRANT])) },
    models: { routes: chainsOnDefaults({}) },
  };
  const names = exposedSkillNames({ config, selfId: SELF, registry: skillRegistry() });
  assert.ok(names.includes('memory.read'), names.join(', '));
  assert.deepEqual(
    OLD_MEMORY_READS.filter((name) => names.includes(name)),
    []
  );
});

// Bug caught: memory.read missing from the registry or from the grantable tools, so a grant under its own name is dropped.
test('offers memory.read when it is granted by its own name', () => {
  const config = { bot: { access: { 'memory.read': GRANT } }, models: { routes: chainsOnDefaults({}) } };
  const names = exposedSkillNames({ config, selfId: SELF, registry: skillRegistry() });
  assert.ok(names.includes('memory.read'), names.join(', '));
});
