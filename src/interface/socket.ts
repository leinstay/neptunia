// The socket server of the core: it listens on a Unix socket and hands each connection to the caller as a
// Transport (src/protocol/wire.ts). The folder is created at mode 0700 and the socket is set to 0600, so
// only the user that runs the core reaches it. A file left at the path by a crash is removed before
// listening. Which connection may speak is the caller's decision (the token check of the link).

import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';
import type { log } from '../log.js';
import { wrapSocket } from '../protocol/wire.ts';
import type { Transport } from '../protocol/wire.ts';

export type Logger = typeof log;

export function listenSocket(options: {
  path: string;
  maxFrameBytes: number;
  log: Logger;
  onConnection(transport: Transport): void;
}): Promise<{ close(): Promise<void> }> {
  const { path, maxFrameBytes, log: logger } = options;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
      chmodSync(path, 0o600);
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
