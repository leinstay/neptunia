// The owner's command line serves no community, yet his private memory may already sit under the home community. His DM
// (`dmCommunityOf`, src/pipeline/private-gate.ts) keeps reading those units, and with none stored it has no community.
// Only his: another interface never falls back to a home community it does not serve. A real store over the memory
// service, so the read goes under the DM's interface whatever interface is current when it is asked.
import { accountOf } from '../src/memory/addresses.ts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { currentIface, withIface } from '../src/memory/db/current-iface.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { createStore } from '../src/memory/store.ts';
import { createPrivateGate } from '../src/pipeline/private-gate.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';

const HOME = 'home-community';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

/** The gate over a real store, `first` being the interface that serves the home community. */
function rigOf(): { store: ReturnType<typeof createStore>; gate: ReturnType<typeof createPrivateGate> } {
  const dataDir = tempDir('nep-cli-home-');
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => currentIface() ?? 'first',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const store = createStore({ dataDir, memoryDb });
  // The gate's other parts stay untouched by this question, so the fake carries only what `dmCommunityOf` reads.
  const context = wrongly<Parameters<typeof createPrivateGate>[0]>({
    hot: { config: { private: { enabled: true } } },
    store,
    isServedCommunity: (id: unknown) => id === HOME,
    communitiesOf: (name: string) => (name === 'first' ? [HOME] : []),
  });
  return { store, gate: createPrivateGate(context) };
}

const keepPrivate = async (store: ReturnType<typeof createStore>, iface: string, member: string): Promise<void> => {
  withIface(iface, () =>
    store.applyPrivateOps(accountOf(store, member), { details: { add: ['keeps a private note'] } })
  );
  store.flush();
  await store.flushSettled({});
};

test('the owner chat with private units under the home community reads them', async () => {
  // Bug: the DM moves to no community and the owner's private memory disappears from his own chat.
  const { store, gate } = rigOf();
  await keepPrivate(store, 'cli', 'owner');
  const units = withIface('cli', () => store.getPrivate(accountOf(store, 'owner'))) as {
    details: Array<{ text: string }>;
  };
  assert.deepEqual(
    units.details.map((detail) => detail.text),
    ['keeps a private note']
  );
  assert.equal('dmCommunityOf' in gate, false, 'a private chat is its own place: no community is looked for');
});

// Two more tests of `dmCommunityOf` stood here: the function is gone with the home community (owner, 2026-11-05).
