// The socket server of the core: it listens on a Unix socket and hands each connection to the caller as a
// Transport (src/protocol/wire.ts). The folder is set to mode 0750 and the socket to 0660, and both go to the group
// `neptunia` where the system has it, so the interface units, whose users are in that group, reach the socket. A file
// left at the path by a crash is removed before listening. Which connection may speak is the caller's decision (the
// token check of the link). `coreSocketPath` is where the core listens under its data directory, for the core and
// for the interface runner (bin/neptunia.ts).

import { chmodSync, chownSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import type { log } from '../log.js';
import { wrapSocket } from '../protocol/wire.ts';
import type { Transport } from '../protocol/wire.ts';

export type Logger = typeof log;

/** The group the core and the interface units share (deploy/README.md). */
const SOCKET_GROUP = 'neptunia';

/** The core's socket under the data directory. */
export const coreSocketPath = (dataDir: string): string => join(dataDir, 'run', 'core.sock');

/** The id of group `name` from /etc/group, or null where the system has no such group. */
function groupId(name: string): number | null {
  let text: string;
  try {
    text = readFileSync('/etc/group', 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const [entry, , gid] = line.split(':');
    if (entry === name && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  return null;
}

/** `file` handed to the shared group when it exists; a process outside the group keeps its own and says so. */
function shareWithGroup(file: string, logger: Logger): void {
  const gid = groupId(SOCKET_GROUP);
  if (gid === null) return;
  try {
    chownSync(file, -1, gid);
  } catch (err) {
    logger.warn('socket: group not set', { group: SOCKET_GROUP, code: (err as NodeJS.ErrnoException).code ?? null });
  }
}

export function listenSocket(options: {
  path: string;
  maxFrameBytes: number;
  log: Logger;
  onConnection(transport: Transport): void;
}): Promise<{ close(): Promise<void> }> {
  const { path, maxFrameBytes, log: logger } = options;
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o750 });
  chmodSync(folder, 0o750);
  shareWithGroup(folder, logger);
  rmSync(path, { force: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const transport = wrapSocket(socket, maxFrameBytes);
    transport.onClose((reason) => logger.info('socket: connection closed', { reason }));
    options.onConnection(transport);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      chmodSync(path, 0o660);
      shareWithGroup(path, logger);
      server.on('error', (error) => logger.error('socket: server error', { error }));
      resolve({
        close(): Promise<void> {
          return new Promise((done) => {
            server.close(() => {
              rmSync(path, { force: true });
              done();
            });
            for (const socket of sockets) socket.destroy();
          });
        },
      });
    });
  });
}
