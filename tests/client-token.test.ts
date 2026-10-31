// Tests for tools/client-token.mjs: `add <name> --kind <kind> [--iface <iface>]` writes a client's token file
// (`clients/<name>.token` under the private directory, mode 0600) and its entry in `clients.json`, `rotate <name>`
// gives the client a new token, and `revoke <name>` removes the entry and the file. The tool finds the private
// directory through NEPTUNIA_PRIVATE_DIR and never prints a token. Because the core reads `clients.json` at the moment
// of use, a rotated or revoked token closes the client's live link: the link over the loopback here resolves its
// token through src/interface/principals.ts, as the core does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrincipals, principalOfToken } from '../src/interface/principals.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import { createEventDoor } from '../src/interface/door.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { createLoopback } from '../src/protocol/index.js';
import { serveAdapter } from '../src/protocol/serve.ts';
import { tempDir } from './fixtures/tmp.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const quiet = { info() {}, warn() {}, error() {} };

function tool(privateDir: string, args: Array<string>): { code: number | null; out: string } {
  const run = spawnSync(process.execPath, ['tools/client-token.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NEPTUNIA_PRIVATE_DIR: privateDir },
  });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

const tokenFile = (privateDir: string, name: string): string => path.join(privateDir, 'clients', `${name}.token`);
const tokenOf = (privateDir: string, name: string): string =>
  fs.readFileSync(tokenFile(privateDir, name), 'utf8').trim();
const whoIs = (privateDir: string, token: string) => principalOfToken(token, { privateDir, boot: null });

test('add writes a 0600 token file whose token is the new principal, and prints no token', () => {
  const privateDir = tempDir('nep-token-');
  const run = tool(privateDir, ['add', 'discord', '--kind', 'interface', '--iface', 'discord']);
  assert.equal(run.code, 0);
  const token = tokenOf(privateDir, 'discord');
  assert.equal(fs.statSync(tokenFile(privateDir, 'discord')).mode & 0o777, 0o600);
  assert.equal(whoIs(privateDir, token)?.name, 'discord');
  assert.equal(whoIs(privateDir, token)?.iface, 'discord');
  assert.ok(token.length >= 32, 'the token is long enough to guess at');
  assert.equal(run.out.includes(token), false);
});

test('add of an interface without --iface refuses and writes nothing', () => {
  const privateDir = tempDir('nep-token-');
  const run = tool(privateDir, ['add', 'discord', '--kind', 'interface']);
  assert.notEqual(run.code, 0);
  assert.equal(loadPrincipals(privateDir), null);
  assert.equal(fs.existsSync(tokenFile(privateDir, 'discord')), false);
});

test('rotate gives the client a new token and the old one is no one', () => {
  const privateDir = tempDir('nep-token-');
  assert.equal(tool(privateDir, ['add', 'owner', '--kind', 'cli']).code, 0);
  const old = tokenOf(privateDir, 'owner');
  assert.equal(tool(privateDir, ['rotate', 'owner']).code, 0);
  const fresh = tokenOf(privateDir, 'owner');
  assert.notEqual(fresh, old);
  assert.equal(whoIs(privateDir, old), null);
  assert.equal(whoIs(privateDir, fresh)?.name, 'owner');
});

test('revoke removes the entry and the token file, and its token is no one', () => {
  const privateDir = tempDir('nep-token-');
  assert.equal(tool(privateDir, ['add', 'owner', '--kind', 'cli']).code, 0);
  const token = tokenOf(privateDir, 'owner');
  assert.equal(tool(privateDir, ['revoke', 'owner']).code, 0);
  assert.equal(whoIs(privateDir, token), null);
  assert.equal(fs.existsSync(tokenFile(privateDir, 'owner')), false);
  assert.deepEqual(
    (loadPrincipals(privateDir) ?? []).map((entry) => entry.name),
    []
  );
});

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function reaction(id: string): Record<string, unknown> {
  return {
    kind: 'reaction.changed',
    iface: 'fake',
    at: 1,
    id,
    conversation: { id: 'c1', kind: 'channel' },
    messageId: 'm1',
    emoji: { name: 'x' },
    userId: 'u1',
    added: true,
  };
}

/** A live link of the client `fake`, authenticated by its token from the private directory. */
async function liveLink(privateDir: string) {
  const handled: Array<string> = [];
  const door = createEventDoor({
    handlers: {
      'reaction.changed': (event: { id: string }) => {
        handled.push(event.id);
      },
    },
    log: quiet,
  });
  const { core, client } = createLoopback();
  const closed: Array<string> = [];
  client.onClose((reason) => closed.push(reason));
  const link = openAdapterLink({
    transport: core,
    door,
    principalOf: (token: string) => principalOfToken(token, { privateDir, boot: null }),
    log: quiet,
  });
  const adapter = createFakeAdapter();
  const hello = {
    iface: 'fake',
    self: { id: 'self-id', name: 'Nova' },
    community: null,
    capabilities: adapter.capabilities(),
    resume: null,
  };
  const served = serveAdapter({ transport: client, hello, token: tokenOf(privateDir, 'fake'), adapter, log: quiet });
  await link.hello;
  return { served, handled, closed };
}

for (const command of ['revoke', 'rotate']) {
  test(`${command} closes the live link of the client: its next event is not handled`, async () => {
    const privateDir = tempDir('nep-token-');
    assert.equal(tool(privateDir, ['add', 'fake', '--kind', 'interface', '--iface', 'fake']).code, 0);
    const live = await liveLink(privateDir);
    assert.equal(await live.served.emit(reaction('e1')), 'ok');
    assert.equal(tool(privateDir, [command, 'fake']).code, 0);
    assert.notEqual(await live.served.emit(reaction('e2')), 'ok');
    await until(() => live.closed.length === 1);
    assert.deepEqual(live.handled, ['e1']);
  });
}

// Stage 6c: an agent client and its board roles.
test('add --kind agent --roles writes the board roles and the token stands for an agent principal', () => {
  const privateDir = tempDir('nep-token-');
  const run = tool(privateDir, ['add', 'hand', '--kind', 'agent', '--roles', 'worker,reviewer']);
  assert.equal(run.code, 0, run.out);
  assert.equal(whoIs(privateDir, tokenOf(privateDir, 'hand'))?.kind, 'agent');
  const clients = JSON.parse(fs.readFileSync(path.join(privateDir, 'clients.json'), 'utf8')) as Record<
    string,
    { boardRoles?: Array<string> }
  >;
  assert.deepEqual(clients.hand?.boardRoles, ['worker', 'reviewer']);
});

test('add with a board role outside the board roles refuses and leaves clients.json as it was', () => {
  const privateDir = tempDir('nep-token-');
  assert.equal(tool(privateDir, ['add', 'boss', '--kind', 'agent', '--roles', 'owner']).code, 0);
  const run = tool(privateDir, ['add', 'hand', '--kind', 'agent', '--roles', 'worker,admin']);
  assert.notEqual(run.code, 0);
  assert.deepEqual(
    (loadPrincipals(privateDir) ?? []).map((entry) => entry.name),
    ['boss']
  );
  assert.equal(fs.existsSync(tokenFile(privateDir, 'hand')), false);
});
