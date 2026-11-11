// Joining a root (src/interface/root-joining.ts), as the owner cut it on 2026-11-11: nobody but the owner can add the
// bot to a root, so a root the interface reports joined, or finds at its start, is served at once, and a root it reports
// left stops being served at once while her memory of it stays. `/interfaces <name> invite` answers the interface's
// invite link and `/interfaces <name> list` the roots she serves there, and both refuse an interface that cannot work,
// naming its repair. The first half drives the module over recording dependencies and the real root routes of
// src/core-routing.ts; the second half runs the core, the fake interface unit and `neptunia` (tests/fixtures/core-units.ts),
// so the event, the commands and the exit codes go through the real wiring. Synthetic ids only, and no model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRootRoutes } from '../src/core-routing.ts';
import { createRootJoining } from '../src/interface/root-joining.ts';
import type { InterfaceState, JoiningAnswer, Named, RootJoining, RootRow } from '../src/interface/root-joining.ts';
import type { ReadAnswer } from '../src/interface/reads.ts';
import type { RootChanged } from '../src/protocol/events.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { channelInfo, lineEvent } from './fixtures/core-over-fake.ts';
import { runCli, seenIds, settle, startUnitsCore, startedUnit, until, withRig } from './fixtures/core-units.ts';
import type { Dirs, Unit } from './fixtures/core-units.ts';
import { INVITE } from './fixtures/interfaces/fake/index.ts';

const IFACE = 'chatnet';
const NOW = Date.parse('2026-11-11T12:00:00Z');
const URL_OF_INVITE = 'https://chat.invalid/invite/chatnet';

/** Labels that place each value the code fills, so a test reads the value and never the wording. */
const LABELS = {
  roots: {
    invite: '{iface} {url}',
    row: '{id} {name} {state}',
    state: { served: 'served' },
    none: '{iface}',
    refused: {
      'no-token': '{iface} {repair}',
      'interface-disabled': '{iface} {repair}',
      'link-down': '{iface} {repair}',
      'no-invite': '{iface}',
      'invite-failed': '{iface}',
    },
  },
};

const WORKING: InterfaceState = { token: true, enabled: true, connected: true };

type Rig = {
  joining: RootJoining;
  routes: ReturnType<typeof createRootRoutes>;
  noted: Array<ReadonlyArray<Named>>;
  invites: Array<string>;
};

function rig(
  options: {
    state?: Partial<InterfaceState>;
    served?: Array<string>;
    invite?: ReadAnswer<'inviteLink'>;
    labels?: object;
  } = {}
): Rig {
  const routes = createRootRoutes({ current: () => null });
  if (options.served !== undefined) routes.note(IFACE, options.served);
  const noted: Array<ReadonlyArray<Named>> = [];
  const invites: Array<string> = [];
  const answer: ReadAnswer<'inviteLink'> = options.invite ?? { status: 'ok', url: URL_OF_INVITE };
  // The dependencies after the owner's cut of 2026-11-11: no stored list of roots and no notice to the owner.
  const joining = createRootJoining({
    hot: { prompts: { labels: options.labels ?? LABELS } },
    now: () => NOW,
    stateOf: () => ({ ...WORKING, ...options.state }),
    routes,
    noteRoots: (_iface, roots) => void noted.push(roots),
    invite: (iface) => {
      invites.push(iface);
      return Promise.resolve(answer);
    },
  });
  return { joining, routes, noted, invites };
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

const idsOf = (rows: Array<RootRow>): Array<string> => rows.map((row) => row.id).sort();

/** The two commands on one interface, each answered. */
async function everyCommand(joining: RootJoining): Promise<Array<JoiningAnswer>> {
  return [await joining.invite(IFACE), joining.roots(IFACE)];
}

test('invite answers the link the interface gives, asking that interface alone', async () => {
  // Catches: the link never reaching the owner, or the read sent to another interface.
  const { joining, invites } = rig();
  const answer = await joining.invite(IFACE);
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes(URL_OF_INVITE), answer.text);
  assert.deepEqual(invites, [IFACE]);
});

test('a root the interface reports joined is served at once, with no invite before it, and its place written', () => {
  // Catches: a root the owner added left unserved until a restart or an accept, or served without its place.
  const { joining, routes, noted } = rig({ served: ['g1'] });
  joining.rootChanged(rootEvent('joined', 'g7', 'Gamma'));
  assert.equal(routes.isServed('g7'), true);
  assert.equal(routes.isServed('g1'), true);
  assert.deepEqual(noted, [[{ id: 'g7', name: 'Gamma' }]]);
  assert.deepEqual(idsOf(joining.rows(IFACE)), ['g1', 'g7']);
});

test('a root the interface finds at its start is served at once', () => {
  // Catches: a root the bot was already in at the start left waiting for a word the owner can no longer give.
  const { joining, routes } = rig();
  joining.rootChanged(rootEvent('present', 'g4', 'Old'));
  assert.equal(routes.isServed('g4'), true);
});

test('a root the bot leaves stops being served at once, its neighbours stay, and nothing is written', () => {
  // Catches: a server the bot was removed from still routed, every root of the interface dropped with it, or its
  // place written again on the way out.
  const { joining, routes, noted } = rig({ served: ['g1', 'g2'] });
  joining.rootChanged(rootEvent('left', 'g1', 'Alpha'));
  assert.equal(routes.isServed('g1'), false);
  assert.equal(routes.isServed('g2'), true);
  assert.deepEqual(noted, []);
  assert.deepEqual(idsOf(joining.rows(IFACE)), ['g2']);
});

test('list answers every root she serves on the interface', () => {
  // Catches: a served root missing from the owner's list, or a left one still on it.
  const { joining } = rig({ served: ['g1'] });
  joining.rootChanged(rootEvent('joined', 'g5', 'Epsilon'));
  joining.rootChanged(rootEvent('joined', 'g6', 'Zeta'));
  joining.rootChanged(rootEvent('left', 'g6', 'Zeta'));
  const answer = joining.roots(IFACE);
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('g1') && answer.text.includes('g5'), answer.text);
  assert.equal(answer.text.includes('g6'), false, answer.text);
});

test('invite and list refuse an interface with no stored token, name its setup, and ask for no link', async () => {
  // Catches: an invite printed for an interface that can never connect.
  const { joining, invites } = rig({ state: { token: false }, served: ['g1'] });
  for (const answer of await everyCommand(joining)) {
    assert.equal(answer.status, 'failed');
    assert.equal(answer.code, 'no-token');
    // Changed: the repair names the interface before its command, by the owner's decision of 2026-11-11.
    assert.ok(answer.text.includes(`/interfaces ${IFACE} setup`), answer.text);
  }
  assert.deepEqual(invites, []);
});

test('invite and list refuse a disabled interface, name its enable, and ask for no link', async () => {
  // Catches: a link handed out for an interface the core refuses at its hello, so the root never arrives.
  const { joining, invites } = rig({ state: { enabled: false }, served: ['g1'] });
  for (const answer of await everyCommand(joining)) {
    assert.equal(answer.status, 'failed');
    assert.equal(answer.code, 'interface-disabled');
    // Changed: the repair names the interface before its command, by the owner's decision of 2026-11-11.
    assert.ok(answer.text.includes(`/interfaces ${IFACE} enable`), answer.text);
  }
  assert.deepEqual(invites, []);
});

test('invite and list refuse an interface whose link is down, name its unit, and ask for no link', async () => {
  // Catches: a command that waits on a link nobody answers.
  const { joining, invites } = rig({ state: { connected: false }, served: ['g1'] });
  for (const answer of await everyCommand(joining)) {
    assert.equal(answer.status, 'failed');
    assert.equal(answer.code, 'link-down');
    assert.ok(answer.text.includes(`neptunia-interface@${IFACE}`), answer.text);
  }
  assert.deepEqual(invites, []);
});

test('invite refuses an interface that declares no invite read', async () => {
  // Catches: a platform link made up in the core.
  const { joining } = rig({ invite: { status: 'unsupported', code: 'not-offered' } });
  const answer = await joining.invite(IFACE);
  assert.equal(answer.status, 'failed');
  assert.equal(answer.code, 'no-invite');
});

/** Labels that hold nothing but the commands the code fills, so a test reads each command alone. */
const COMMAND_LABELS = {
  roots: {
    ...LABELS.roots,
    none: '{invite}',
    refused: { ...LABELS.roots.refused, 'no-token': '{repair}', 'interface-disabled': '{repair}' },
  },
};

/** The command a filled label holds parses to the operation `name` on the interface it serves, the interface first. */
function assertCommand(line: string, name: string): void {
  assert.ok(line.startsWith(`/interfaces ${IFACE} `), `${line}: the interface comes first`);
  const parsed = parseCommandLine(line);
  assert.ok(parsed.ok, `${line}: ${parsed.ok ? '' : parsed.reason}`);
  assert.equal(parsed.name, name, line);
  assert.equal(parsed.args.name, IFACE, line);
}

test('the commands the answers name put the interface first and run what they say', async () => {
  // Catches: the owner told to type a form the owner's decision of 2026-11-11 removed, or a repair that runs another
  // command than the one it names.
  assertCommand(rig({ labels: COMMAND_LABELS }).joining.roots(IFACE).text, 'interfaces.invite');
  assertCommand(
    (await rig({ labels: COMMAND_LABELS, state: { token: false } }).joining.invite(IFACE)).text,
    'interfaces.setup'
  );
  assertCommand(
    (await rig({ labels: COMMAND_LABELS, state: { enabled: false } }).joining.invite(IFACE)).text,
    'interfaces.enable'
  );
});

// The day she joined a root (the owner's decision of 2026-11-11). `RootChanged` gains `joinedAt?: number` (milliseconds
// since the epoch), `Named` gains `joinedAt?: number`, and `labels.roots.row` gains the placeholder `{since}`: the
// `labels.roots.since` label filled with `{day}` (`YYYY-MM-DD`), or '' for a root with no known moment.
const JOINED = Date.parse('2026-10-03T10:00:00Z');
const SINCE_LABELS = {
  roots: { ...LABELS.roots, row: '{id} {name} {since}', since: 'SINCE {day}' },
};
const withMoment = (event: RootChanged, joinedAt: number): RootChanged => ({ ...event, joinedAt });

test('a root joined with a moment is written with it, and one with none is written as before', () => {
  // Catches: the moment dropped between the event and the writer, or a `joinedAt: undefined` key that blanks the stored day.
  const { joining, noted } = rig();
  joining.rootChanged(withMoment(rootEvent('joined', 'g8', 'Theta'), JOINED));
  joining.rootChanged(rootEvent('joined', 'g9', 'Iota'));
  assert.deepEqual(noted, [[{ id: 'g8', name: 'Theta', joinedAt: JOINED }], [{ id: 'g9', name: 'Iota' }]]);
});

test('list shows the day beside a root that has a moment and nothing beside one that has none', () => {
  // Catches: the day missing from the owner's list, or printed for a root whose moment nobody knows.
  const { joining } = rig({ labels: SINCE_LABELS });
  joining.rootChanged(withMoment(rootEvent('joined', 'g8', 'Theta'), JOINED));
  joining.rootChanged(rootEvent('joined', 'g9', 'Iota'));
  const lines = joining.roots(IFACE).text.split('\n');
  const theta = lines.find((line) => line.includes('Theta')) ?? '';
  const iota = lines.find((line) => line.includes('Iota')) ?? '';
  assert.ok(theta.includes('SINCE 2026-10-03'), theta);
  assert.equal(iota.includes('SINCE'), false, iota);
});

test('a later event with no moment leaves the day the list shows for the root', () => {
  // Catches: a root found again at a restart, which cannot tell its day, losing the one it was joined with.
  const { joining } = rig({ labels: SINCE_LABELS });
  joining.rootChanged(withMoment(rootEvent('joined', 'g8', 'Theta'), JOINED));
  joining.rootChanged(rootEvent('present', 'g8', 'Theta'));
  assert.ok(joining.roots(IFACE).text.includes('SINCE 2026-10-03'), joining.roots(IFACE).text);
});

// ---- the core, the fake interface unit and the command line ------------------------------------------------------

/** The fake interface as an authored package with its token stored. */
function prepareFake(dirs: Dirs, { token = true }: { token?: boolean } = {}): void {
  const dir = path.join(dirs.dataDir, 'interfaces', 'fake');
  fs.mkdirSync(dir, { recursive: true });
  // An entry point marks the folder as the package (src/config/files.ts#interfacePackageDir); the unit itself is loaded
  // from tests/fixtures/interfaces.
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export {};\n');
  fs.writeFileSync(
    path.join(dir, 'setup.json'),
    JSON.stringify({ settings: [{ key: 'token', question: 'Token', kind: 'secret', required: true }] })
  );
  if (token) fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: 'chat-token' }));
}

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

test('a root the bot is added to while it runs is served at once: its message is kept and answered', async () => {
  // Catches: the event never wired to the routes, so the owner's new server needs a restart, an invite window or an
  // accept that no longer exists.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    prepareFake(dirs);
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    assert.equal(await (await unit.emit(coreRootEvent('joined', 'g7', 'Gamma'))).acked, 'ok');
    assert.equal(await callIn(unit, 'g7', 'c7', 'm7'), 'ok');
    assert.notEqual((await postedIn(unit, 'c7')).length, 0, 'a turn answered the call in the new root');
    assert.ok(seenIds(dirs).includes('m7'));
    const listed = await runCli(dirs, ['interfaces', 'fake', 'list']);
    assert.equal(listed.code, 0, listed.stderr.slice(-2000));
    assert.ok(listed.stdout.includes('g7'), listed.stdout);
  });
});

test('invite from the command line prints the link the interface gives', async () => {
  // Catches: the command parsed but never wired to the interface's invite read.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    prepareFake(dirs);
    cores.push(await startUnitsCore(dirs, llm));
    units.push(await startedUnit(dirs));
    const invited = await runCli(dirs, ['-p', '/interfaces fake invite']);
    assert.equal(invited.code, 0, invited.stderr.slice(-2000));
    assert.ok(invited.stdout.includes(INVITE), invited.stdout);
  });
});

test('a root the bot leaves stops being served: its later message is not kept, starts no turn, and her memory stays', async () => {
  // Catches: a removed server still answered, or its lines deleted from her memory with it.
  // Changed: this asserted an ack of `ignored`, which no ack carries (src/protocol/envelope.ts); the facts that matter
  // are the line and the turn.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    prepareFake(dirs);
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await (
      await unit.emit(coreRootEvent('joined', 'g6', 'Zeta'))
    ).acked;
    assert.equal(await callIn(unit, 'g6', 'c6', 'm6'), 'ok');
    await until(() => seenIds(dirs).includes('m6'), 'the first line kept');
    assert.notEqual((await postedIn(unit, 'c6')).length, 0, 'the turn over the first line ended');
    const turns = llm.requests.length;
    await (
      await unit.emit(coreRootEvent('left', 'g6', 'Zeta'))
    ).acked;
    await callIn(unit, 'g6', 'c6', 'm6b');
    await settle();
    assert.equal(seenIds(dirs).includes('m6b'), false);
    assert.equal(llm.requests.length, turns, 'no turn over the line in the left root');
    assert.ok(seenIds(dirs).includes('m6'), 'her memory of the root stays');
  });
});

test('a refused invite or list exits 1 in the shell and names its repair', async () => {
  // Catches: a refusal printed as success, so a script goes on as if the invite link existed.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    prepareFake(dirs, { token: false });
    cores.push(await startUnitsCore(dirs, llm));
    units.push(await startedUnit(dirs));
    // Changed: the command and its repair name the interface first, by the owner's decision of 2026-11-11.
    for (const args of [
      ['-p', '/interfaces fake invite'],
      ['interfaces', 'fake', 'list'],
    ]) {
      const refused = await runCli(dirs, args);
      assert.equal(refused.code, 1, args.join(' '));
      assert.ok(refused.stderr.includes('/interfaces fake setup'), refused.stderr.slice(-2000));
    }
  });
});
