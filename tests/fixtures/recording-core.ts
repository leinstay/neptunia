// A stand-in for the core on `<data>/run/core.sock`, for the tests of the `neptunia` command's argv boundary. It takes
// the `cli` client's hello, records every command and every chat line a child sends and answers each command as the
// test says, with no handler behind it. The real core (tests/fixtures/core-units.ts) would run the leaves that probe a
// provider (`/keys check`, `/model set`, `/doctor live`), and a generated check over the whole table must call none.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { coreSocketPath } from '../../src/interface/socket.ts';
import { ackOf, envelope } from '../../src/protocol/index.ts';
import { MAX_FRAME_BYTES, wrapSocket } from '../../src/protocol/wire.ts';
import { folders, spawnCli } from './core-units.ts';
import type { Dirs, Exit } from './core-units.ts';

/** One `command.requested` event: `dialogId` and `answer` only when it answers a question. */
export type Received = { name: string; args: unknown; dialogId?: unknown; answer?: unknown };

/** What the core says to a command: a result, or a question through a dialog. */
export type Reply =
  | { status: string; text: string }
  | { status: 'ask'; text: string; dialogId: string; prompt: string; secret: boolean };

export type RecordingCore = {
  commands: Array<Received>;
  /** The text of each `message.received`, which a real core would turn into a model request. */
  lines: Array<string>;
  connections(): number;
  close(): Promise<void>;
};

/** The default answer: `handled <name>`, status `ok`. */
export const handled = (command: Received): Reply => ({ status: 'ok', text: `handled ${command.name}` });

const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

export async function startRecordingCore(dirs: Dirs, reply: (command: Received) => Reply): Promise<RecordingCore> {
  const commands: Array<Received> = [];
  const lines: Array<string> = [];
  const sockets = new Set<net.Socket>();
  let connections = 0;
  let actions = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {
      // A child that exits while an answer is on its way resets the socket; its exit is what the test reads.
    });
    const transport = wrapSocket(socket, MAX_FRAME_BYTES);
    transport.onEnvelope((value) => {
      if (value.type === 'hello') transport.send(ackOf(value, 'ok'));
      if (value.type !== 'event') return;
      transport.send(ackOf(value, 'ok'));
      const body = record(value.body);
      if (body.kind === 'message.received') lines.push(String(record(body.message).content));
      if (body.kind !== 'command.requested') return;
      const command: Received = {
        name: String(body.name),
        args: body.args,
        ...(body.dialogId === undefined ? {} : { dialogId: body.dialogId, answer: body.answer }),
      };
      commands.push(command);
      actions += 1;
      transport.send(
        envelope('action', { action: 'command.result', replyRef: body.replyRef, ...reply(command) }, {
          id: `action:${actions}`,
        })
      );
    });
  });
  const file = coreSocketPath(dirs.dataDir);
  mkdirSync(dirname(file), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, resolve);
  });
  return {
    commands,
    lines,
    connections: () => connections,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Fresh folders holding the `cli` token, with no core. */
export function cliFolders(): Dirs {
  const dirs = folders({});
  mkdirSync(join(dirs.privateDir, 'clients'), { recursive: true });
  writeFileSync(join(dirs.privateDir, 'clients', 'cli.token'), 'recording-core-token\n');
  return dirs;
}

/** Runs `body` over fresh folders and a recording core that answers with `reply`, removing both after. */
export async function withRecordingCore(
  reply: (command: Received) => Reply,
  body: (rig: { dirs: Dirs; core: RecordingCore }) => Promise<void>
): Promise<void> {
  const dirs = cliFolders();
  const core = await startRecordingCore(dirs, reply);
  try {
    await body({ dirs, core });
  } finally {
    await core.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

export type Run = Exit & { stdout: string; stderr: string };

/**
 * One `neptunia` child to its end. Its stdin gets `input` and closes, or with `open: true` stays an open pipe nobody
 * writes to, as a process started by an agent has it. A child still running after `ms` is killed and fails the test,
 * which is how a test sees a hang.
 */
export async function runChild(
  dirs: Dirs,
  argv: ReadonlyArray<string>,
  options: { env?: NodeJS.ProcessEnv; input?: string; open?: boolean; ms?: number } = {}
): Promise<Run> {
  const ms = options.ms ?? 30_000;
  const cli = spawnCli(dirs, argv, options.env ?? {});
  if (options.open !== true) {
    if (options.input !== undefined) cli.child.stdin?.write(options.input);
    cli.end();
  }
  const timer = setTimeout(() => void cli.kill(), ms);
  const exit = await cli.exited;
  clearTimeout(timer);
  assert.equal(exit.signal, null, `neptunia ${argv.join(' ')} was still running after ${ms} ms:\n${cli.stderr()}`);
  return { ...exit, stdout: cli.stdout(), stderr: cli.stderr() };
}
