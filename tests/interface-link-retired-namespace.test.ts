// The namespace `plugin` retired with the plugin mechanism. A client that still says hello under it meets the link's
// ordinary refusal for a namespace its principal does not own (src/interface/link.ts), never a crash of the core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback, envelope } from '../src/protocol/index.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import { createEventDoor } from '../src/interface/door.ts';
import type { Principal } from '../src/interface/principals.ts';

const FAKE: Principal = { name: 'fake', kind: 'interface', iface: 'fake', permissions: [] };

test('a hello under the retired namespace plugin is refused with iface and the link closes', async () => {
  // Bug it catches: the core once routed a first `hello` under `plugin` to a plugin link. With that branch gone, a
  // leftover plugin unit must reach the adapter link's refusal, not an unhandled path that takes the core down.
  const warnings: Array<{ message: string; meta: unknown }> = [];
  const log = {
    info() {},
    warn: (message: string, meta?: unknown) => warnings.push({ message, meta }),
    error() {},
  };
  const door = createEventDoor({ handlers: {}, log });
  const { core, client } = createLoopback();
  const link = openAdapterLink({
    transport: core,
    door,
    principalOf: (token) => (token === 'fake-token' ? FAKE : null),
    log,
  });
  const closed: Array<string> = [];
  client.onClose((reason) => closed.push(reason));
  client.send(
    envelope(
      'hello',
      { iface: 'plugin', self: { id: 'echo', name: 'echo' }, root: null, token: 'fake-token' },
      { id: 'hello:plugin:echo' }
    )
  );
  await assert.rejects(link.hello, /link closed before hello: iface/);
  assert.deepEqual(warnings, [{ message: 'link: hello refused', meta: { reason: 'iface', principal: 'fake' } }]);
  assert.equal(link.isClosed(), true);
  assert.equal(closed.length, 1);
});
