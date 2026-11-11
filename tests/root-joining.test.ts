// Joining a root (src/interface/root-joining.ts): `/interfaces invite <name>` opens joining on an interface for an hour,
// a root the interface reports joined while it is open is served at once and added to the interface's list, and any
// other unlisted root waits, stored nowhere, with one notice to the owner. `/interfaces roots` lists the served,
// waiting and listed-but-absent roots, `accept` serves a waiting one, `remove` stops serving one. Every command refuses
// an interface that cannot work, naming its repair. The first half drives the module over recording dependencies and the
// real root routes of src/core-routing.ts; the second half runs the core, the fake interface unit and `neptunia -p`
// (tests/fixtures/core-units.ts), so the event, the commands and the exit codes go through the real wiring. Synthetic
// ids only, and no model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRootRoutes } from '../src/core-routing.ts';
import { JOINING_MS, createRootJoining } from '../src/interface/root-joining.ts';
import type {
  InterfaceState,
  JoiningAnswer,
  Named,
  RootJoining,
  RootNotice,
  RootRow,
} from '../src/interface/root-joining.ts';
import type { ReadAnswer } from '../src/interface/reads.ts';
import type { RootChanged } from '../src/protocol/events.ts';
import { channelInfo, lineEvent } from './fixtures/core-over-fake.ts';
import {
  query,
  runCli,
  seenIds,
  settle,
  spawnCli,
  startUnitsCore,
  startedUnit,
  until,
  withRig,
} from './fixtures/core-units.ts';
import type { Dirs, Unit } from './fixtures/core-units.ts';
import { INVITE } from './fixtures/interfaces/fake/index.ts';

const IFACE = 'chatnet';
const NOW = Date.parse('2026-11-11T12:00:00Z');
const URL_OF_INVITE = 'https://chat.invalid/invite/chatnet';

/** Labels that place each value the code fills, so a test reads the value and never the wording. */
const LABELS = {
  roots: {
    invite: '{iface} {url}',
    row: '{root} {name} {state}',
    state: { served: 'served', waiting: 'waiting', absent: 'absent' },
    none: '{iface}',
    accepted: '{iface} {root}',
    removed: '{iface} {root}',
    notice: '{iface} {root} {name}',
    refused: {
      'no-token': '{iface} {repair}',
      'interface-disabled': '{iface} {repair}',
      'link-down': '{iface} {repair}',
      'no-invite': '{iface}',
      'invite-failed': '{iface}',
      'not-waiting': '{iface} {root}',
      'unknown-root': '{iface} {root}',
      'no-roots-setting': '{iface}',
    },
  },
};

const WORKING: InterfaceState = { token: true, enabled: true, connected: true };

type Rig = {
  joining: RootJoining;
  routes: ReturnType<typeof createRootRoutes>;
  listed: Array<string>;
  noted: Array<ReadonlyArray<Named>>;
  notices: Array<RootNotice>;
  invites: Array<string>;
  clock: { now: number };
};

function rig(
  options: {
    state?: Partial<InterfaceState>;
    listed?: Array<string>;
    served?: Array<string>;
    invite?: ReadAnswer<'inviteLink'>;
  } = {}
): Rig {
  const clock = { now: NOW };
  const routes = createRootRoutes({ current: () => null });
  if (options.served !== undefined) routes.note(IFACE, options.served);
  const listed = [...(options.listed ?? [])];
  const noted: Array<ReadonlyArray<Named>> = [];
  const notices: Array<RootNotice> = [];
  const invites: Array<string> = [];
  const answer: ReadAnswer<'inviteLink'> = options.invite ?? { status: 'ok', url: URL_OF_INVITE };
  const joining = createRootJoining({
    hot: { prompts: { labels: LABELS } },
    now: () => clock.now,
    stateOf: () => ({ ...WORKING, ...options.state }),
    listed: {
      read: () => [...listed],
      add: (_iface, rootId) => {
        if (!listed.includes(rootId)) listed.push(rootId);
      },
      remove: (_iface, rootId) => {
        const at = listed.indexOf(rootId);
        if (at >= 0) listed.splice(at, 1);
      },
    },
    routes,
    noteRoots: (_iface, roots) => void noted.push(roots),
    invite: (iface) => {
      invites.push(iface);
      return Promise.resolve(answer);
    },
    notify: (notice) => void notices.push(notice),
  });
  return { joining, routes, listed, noted, notices, invites, clock };
}

let eventCount = 0;
const rootEvent = (change: RootChanged['change'], id: string, name: string, iface = IFACE): RootChanged => {
  eventCount += 1;
  return {
    kind: 'root.changed',
    iface,
    at: NOW,
    id: `${iface}:root:${id}:${change}:${eventCount}`,
    root: { id, name },
    change,
  };
};

const byId = (rows: Array<RootRow>): Array<[string, string]> =>
  rows.map((row): [string, string] => [row.id, row.state]).sort(([a], [b]) => a.localeCompare(b));

/** The four commands on one interface, each answered. */
async function everyCommand(joining: RootJoining, rootId: string): Promise<Array<JoiningAnswer>> {
  return [
    await joining.invite(IFACE),
    joining.roots(IFACE),
    joining.accept(IFACE, rootId),
    joining.remove(IFACE, rootId),
  ];
}

test('invite answers the link the interface gives and opens joining on that interface for an hour', async () => {
  // Catches: the link never reaching the owner, joining opened on every interface, or a window that never closes.
  const { joining, clock } = rig();
  const answer = await joining.invite(IFACE);
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes(URL_OF_INVITE), answer.text);
  assert.equal(joining.isOpen(IFACE), true);
  assert.equal(joining.isOpen('other'), false);
  clock.now += JOINING_MS + 1;
  assert.equal(joining.isOpen(IFACE), false);
});

test('a root that joins while joining is open is served at once, added to the list, and joining closes', async () => {
  // Catches: an invited root that needs a restart, is never written to the interface's list, or lets a second one in.
  const { joining, routes, listed, noted, notices } = rig();
  await joining.invite(IFACE);
  assert.equal(joining.rootChanged(rootEvent('joined', 'g7', 'Gamma')), 'served');
  assert.equal(routes.isServed('g7'), true);
  assert.deepEqual(listed, ['g7']);
  assert.deepEqual(noted, [[{ id: 'g7', name: 'Gamma' }]]);
  assert.equal(joining.isOpen(IFACE), false);
  assert.equal(notices.length, 0);
});

test('a root that joins while joining is closed waits: no route, no stored place, and one notice that names it', () => {
  // Catches: a stranger's server served or stored on its own, or the owner told nothing, or told on every report.
  const { joining, routes, listed, noted, notices } = rig();
  assert.equal(joining.rootChanged(rootEvent('joined', 'g8', 'Delta')), 'waiting');
  assert.equal(joining.rootChanged(rootEvent('joined', 'g8', 'Delta')), 'waiting');
  assert.equal(routes.isServed('g8'), false);
  assert.deepEqual(listed, []);
  assert.deepEqual(noted, []);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.iface, IFACE);
  assert.deepEqual(notices[0]?.root, { id: 'g8', name: 'Delta' });
});

test('a root the interface finds at its start waits even while joining is open', async () => {
  // Catches: an old unlisted server accepted by the invite meant for a new one.
  const { joining, routes } = rig();
  await joining.invite(IFACE);
  assert.equal(joining.rootChanged(rootEvent('present', 'g4', 'Old')), 'waiting');
  assert.equal(routes.isServed('g4'), false);
  assert.equal(joining.isOpen(IFACE), true);
});

test('a listed root that comes back is served with joining closed', () => {
  // Catches: a server the owner already accepted left waiting after the bot was invited back to it.
  const { joining, routes } = rig({ listed: ['g3'] });
  assert.equal(joining.rootChanged(rootEvent('joined', 'g3', 'Back')), 'served');
  assert.equal(routes.isServed('g3'), true);
});

test('accept serves a waiting root at once and adds it to the list', () => {
  // Catches: an accepted root that waits for a restart, or one served but forgotten at the next start.
  const { joining, routes, listed, noted } = rig();
  joining.rootChanged(rootEvent('joined', 'g8', 'Delta'));
  const answer = joining.accept(IFACE, 'g8');
  assert.equal(answer.status, 'ok');
  assert.equal(routes.isServed('g8'), true);
  assert.deepEqual(listed, ['g8']);
  assert.deepEqual(noted, [[{ id: 'g8', name: 'Delta' }]]);
  assert.deepEqual(byId(joining.rows(IFACE)), [['g8', 'served']]);
});

test('accept writes the root served with an empty list beside the accepted one, so a restart serves both', () => {
  // Bug: with an empty list the interface serves its only root implicitly; accepting a second wrote the second alone,
  // so after a restart the first was unlisted and waited.
  const { joining, listed } = rig({ listed: [], served: ['g1'] });
  joining.rootChanged(rootEvent('joined', 'g8', 'Delta'));
  assert.equal(joining.accept(IFACE, 'g8').status, 'ok');
  assert.deepEqual([...listed].sort(), ['g1', 'g8']);
});

test('accept refuses a root that is not waiting and changes nothing', () => {
  // Catches: any id typed by mistake becoming a served root of the interface.
  const { joining, routes, listed } = rig();
  const answer = joining.accept(IFACE, 'g99');
  assert.equal(answer.status, 'invalid');
  assert.equal(answer.code, 'not-waiting');
  assert.equal(routes.isServed('g99'), false);
  assert.deepEqual(listed, []);
});

test('remove stops serving a root and takes it off the list, writing nothing to memory', () => {
  // Catches: a removed root still served until a restart, left on the list, or its places written again.
  const { joining, routes, listed, noted } = rig({ listed: ['g1', 'g2'], served: ['g1', 'g2'] });
  const answer = joining.remove(IFACE, 'g1');
  assert.equal(answer.status, 'ok');
  assert.equal(routes.isServed('g1'), false);
  assert.equal(routes.isServed('g2'), true);
  assert.deepEqual(listed, ['g2']);
  assert.deepEqual(noted, []);
  assert.deepEqual(byId(joining.rows(IFACE)), [['g2', 'served']]);
});

test('roots lists the served, the waiting and the listed roots the bot is not in', () => {
  // Catches: a waiting root the owner cannot see to accept, or a listed root the bot is not in shown as served.
  const { joining } = rig({ listed: ['g1', 'g2'], served: ['g1'] });
  joining.rootChanged(rootEvent('present', 'g5', 'Epsilon'));
  assert.deepEqual(byId(joining.rows(IFACE)), [
    ['g1', 'served'],
    ['g2', 'absent'],
    ['g5', 'waiting'],
  ]);
  assert.equal(joining.roots(IFACE).status, 'ok');
});

test('a root the bot leaves is shown absent, stays on the list, and nothing is written', () => {
  // Catches: a server the bot was kicked from still routed, or wiped from the owner's list and her memory.
  const { joining, routes, listed, noted } = rig({ listed: ['g1'], served: ['g1'] });
  joining.rootChanged(rootEvent('left', 'g1', 'Alpha'));
  assert.equal(routes.isServed('g1'), false);
  assert.deepEqual(listed, ['g1']);
  assert.deepEqual(noted, []);
  assert.deepEqual(byId(joining.rows(IFACE)), [['g1', 'absent']]);
});

test('every command refuses an interface with no stored token, names its setup, and changes nothing', async () => {
  // Catches: an invite printed for an interface that can never connect, or a root accepted onto it.
  const { joining, routes, listed, invites } = rig({ state: { token: false }, listed: ['g1'], served: ['g1'] });
  joining.rootChanged(rootEvent('present', 'g5', 'Epsilon'));
  for (const answer of await everyCommand(joining, 'g5')) {
    assert.equal(answer.status, 'failed');
    assert.equal(answer.code, 'no-token');
    assert.ok(answer.text.includes(`/interfaces setup ${IFACE}`), answer.text);
  }
  assert.deepEqual(invites, []);
  assert.equal(joining.isOpen(IFACE), false);
  assert.deepEqual(listed, ['g1']);
  assert.deepEqual(routes.rootsOf(IFACE), ['g1']);
});

test('every command refuses a disabled interface, names its enable, and changes nothing', async () => {
  // Catches: joining opened on an interface the core refuses at its hello, so the root never arrives.
  const { joining, routes, listed, invites } = rig({ state: { enabled: false }, listed: ['g1'], served: ['g1'] });
  joining.rootChanged(rootEvent('present', 'g5', 'Epsilon'));
  for (const answer of await everyCommand(joining, 'g5')) {
    assert.equal(answer.status, 'failed');
    assert.equal(answer.code, 'interface-disabled');
    assert.ok(answer.text.includes(`/interfaces enable ${IFACE}`), answer.text);
  }
  assert.deepEqual(invites, []);
  assert.equal(joining.isOpen(IFACE), false);
  assert.deepEqual(listed, ['g1']);
  assert.deepEqual(routes.rootsOf(IFACE), ['g1']);
});

test('every command refuses an interface whose link is down, names its unit, and changes nothing', async () => {
  // Catches: a command that waits on a link nobody answers, or a list changed behind an interface that is not running.
  const { joining, routes, listed, invites } = rig({ state: { connected: false }, listed: ['g1'], served: ['g1'] });
  joining.rootChanged(rootEvent('present', 'g5', 'Epsilon'));
  for (const answer of await everyCommand(joining, 'g5')) {
    assert.equal(answer.status, 'failed');
    assert.equal(answer.code, 'link-down');
    assert.ok(answer.text.includes(`neptunia-interface@${IFACE}`), answer.text);
  }
  assert.deepEqual(invites, []);
  assert.equal(joining.isOpen(IFACE), false);
  assert.deepEqual(listed, ['g1']);
  assert.deepEqual(routes.rootsOf(IFACE), ['g1']);
});

test('invite refuses an interface that declares no invite read and opens nothing', async () => {
  // Catches: joining opened with no link to give, or a platform link made up in the core.
  const { joining } = rig({ invite: { status: 'unsupported', code: 'not-offered' } });
  const answer = await joining.invite(IFACE);
  assert.equal(answer.status, 'failed');
  assert.equal(answer.code, 'no-invite');
  assert.equal(joining.isOpen(IFACE), false);
});

// ---- the core, the fake interface unit and the command line ------------------------------------------------------

/** The fake interface as an authored package with a roots list, its token stored, so the core can accept its roots. */
function prepareFake(dirs: Dirs, { token = true }: { token?: boolean } = {}): void {
  const dir = path.join(dirs.dataDir, 'interfaces', 'fake');
  fs.mkdirSync(dir, { recursive: true });
  // An entry point marks the folder as the package (src/config/files.ts#interfacePackageDir); the unit itself is loaded
  // from tests/fixtures/interfaces.
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export {};\n');
  fs.writeFileSync(
    path.join(dir, 'setup.json'),
    JSON.stringify({
      settings: [
        { key: 'token', question: 'Token', kind: 'secret', required: true },
        { key: 'roots', question: 'Roots', kind: 'list', roots: true },
      ],
    })
  );
  if (token) fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: 'chat-token' }));
}

const listedOf = (dirs: Dirs): unknown => {
  const file = path.join(dirs.dataDir, 'interfaces', 'fake', 'config.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { roots?: unknown }).roots : undefined;
};

const coreRootEvent = (change: RootChanged['change'], id: string, name: string): RootChanged =>
  rootEvent(change, id, name, 'fake');

/** A member's call to her in the chat `chatId` of the root `rootId`, the chat seeded on the unit first. */
async function callIn(unit: Unit, rootId: string, chatId: string, id: string): Promise<string> {
  await unit.ask({ op: 'seed-chat', info: channelInfo(chatId, { rootId }) }, 'done');
  const line = lineEvent({ chatId, id, text: `Nova, hello from ${chatId}`, at: Date.now(), mention: true });
  const sent = await unit.emit({ ...line, chat: { ...line.chat, rootId } });
  return sent.acked;
}

async function postedIn(unit: Unit, chatId: string): Promise<Array<string>> {
  let posted: Array<string> = [];
  for (let tries = 0; tries < 160 && posted.length === 0; tries += 1) {
    posted = await unit.posted(chatId);
    if (posted.length === 0) await settle(50);
  }
  return posted;
}

test('a root invited from the command line is served at once: its message is kept and answered', async () => {
  // Catches: the module built but never wired to the event or the command, so the owner still needs a restart.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    prepareFake(dirs);
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    const invited = await runCli(dirs, ['-p', '/interfaces invite fake']);
    assert.equal(invited.code, 0, invited.stderr.slice(-2000));
    assert.ok(invited.stdout.includes(INVITE), invited.stdout);

    assert.equal(await (await unit.emit(coreRootEvent('joined', 'g7', 'Gamma'))).acked, 'ok');
    assert.equal(await callIn(unit, 'g7', 'c7', 'm7'), 'ok');
    assert.notEqual((await postedIn(unit, 'c7')).length, 0, 'a turn answered the call in the new root');
    assert.ok(seenIds(dirs).includes('m7'));
    assert.deepEqual(listedOf(dirs), ['g7']);
  });
});

test('a root that joins while joining is closed is ignored, kept nowhere, and named once on the open chat', async () => {
  // Catches: a stranger's server answered or stored, or the owner never learning that it waits.
  await withRig({}, async ({ dirs, llm, units, clis, cores }) => {
    prepareFake(dirs);
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    await until(() => chat.stdout().trim() !== '', 'the chat header');

    await (
      await unit.emit(coreRootEvent('joined', 'g8', 'Deltaroot'))
    ).acked;
    await (
      await unit.emit(coreRootEvent('joined', 'g8', 'Deltaroot'))
    ).acked;
    await callIn(unit, 'g8', 'c8', 'm8');
    await until(() => chat.stdout().includes('Deltaroot'), 'the notice on the open chat');
    await settle();
    assert.equal(chat.stdout().split('Deltaroot').length - 1, 1, chat.stdout());
    assert.equal(seenIds(dirs).includes('m8'), false);
    assert.equal(
      llm.requests.some((request) => JSON.stringify(request).includes('hello from c8')),
      false
    );
    assert.equal(
      query(dirs, "SELECT id FROM places WHERE kind = 'server' AND native_id = ?", 'g8').length,
      0,
      'no place of the waiting root'
    );
  });
});

test('accept from the command line serves a waiting root at once', async () => {
  // Catches: `/interfaces roots accept` writing the list but leaving the root unserved until a restart.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    prepareFake(dirs);
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await (
      await unit.emit(coreRootEvent('present', 'g6', 'Zeta'))
    ).acked;
    const accepted = await runCli(dirs, ['-p', '/interfaces roots accept fake g6']);
    assert.equal(accepted.code, 0, accepted.stderr.slice(-2000));
    assert.equal(await callIn(unit, 'g6', 'c6', 'm6'), 'ok');
    assert.notEqual((await postedIn(unit, 'c6')).length, 0, 'a turn answered the call in the accepted root');
    assert.deepEqual(listedOf(dirs), ['g6']);
  });
});

test('remove from the command line stops serving a root and keeps what she stored of it', async () => {
  // Catches: a removed root still answered, or its lines deleted from her memory with it.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    prepareFake(dirs);
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await (
      await unit.emit(coreRootEvent('present', 'g6', 'Zeta'))
    ).acked;
    assert.equal((await runCli(dirs, ['-p', '/interfaces roots accept fake g6'])).code, 0);
    await callIn(unit, 'g6', 'c6', 'm6');
    await until(() => seenIds(dirs).includes('m6'), 'the first line kept');

    const removed = await runCli(dirs, ['-p', '/interfaces roots remove fake g6']);
    assert.equal(removed.code, 0, removed.stderr.slice(-2000));
    await callIn(unit, 'g6', 'c6', 'm6b');
    await settle();
    assert.equal(seenIds(dirs).includes('m6b'), false);
    assert.ok(seenIds(dirs).includes('m6'), 'her memory of the root stays');
    assert.deepEqual(listedOf(dirs), []);
  });
});

test('a refused command exits 1 in the shell and names its repair', async () => {
  // Catches: a refusal printed as success, so a script goes on as if the invite link existed.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    prepareFake(dirs, { token: false });
    cores.push(await startUnitsCore(dirs, llm));
    units.push(await startedUnit(dirs));
    const refused = await runCli(dirs, ['-p', '/interfaces invite fake']);
    assert.equal(refused.code, 1);
    assert.ok(refused.stderr.includes('/interfaces setup fake'), refused.stderr.slice(-2000));
  });
});
