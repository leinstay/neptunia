// A FAKE ledger read side for the tests: a net server on a Unix socket in a fresh temp directory
// that answers each request line (`{ id, op, args }`) with `answer(request)` -- `{ ok: true,
// result }`, `{ ok: false, error }`, or `null` to answer nothing -- and records the requests.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {(request: object) => ({ ok: boolean, result?: unknown, error?: unknown } | null)} answer
 * @returns {Promise<{ socket: string, requests: object[], close: () => Promise<void> }>}
 */
export async function startFakeLedger(answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-ledger-read-'));
  const socketPath = path.join(dir, 'core.sock');
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const request = JSON.parse(line);
        requests.push(request);
        const reply = answer(request);
        if (reply) socket.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    });
  });
  return { socket: socketPath, requests, close };
}

/** A socket path where nothing listens (its directory exists). */
export function deadSocket() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-ledger-dead-'));
  return path.join(dir, 'core.sock');
}
