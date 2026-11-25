// The `nep` MCP server of one subscription turn, started by `claude -p` or `codex exec` as
// `<node> bin/neptunia-mcp.ts --socket <path> --token-file <file>` (src/subharness/subscription-client.ts). It reads
// newline-delimited JSON-RPC on stdin and writes each answer as one line on stdout. Its tools and their calls come from
// the core over the socket, with the turn's token read from the file (src/subharness/tool-bridge.ts, `bridgePeer`).
// The logic is src/subharness/mcp-server.ts; this file is the process around it, and it ends when stdin closes.

import fs from 'node:fs';
import readline from 'node:readline';
import { connectSocket, MAX_FRAME_BYTES } from '../src/protocol/wire.ts';
import { createMcpServer } from '../src/subharness/mcp-server.ts';
import { bridgePeer } from '../src/subharness/tool-bridge.ts';

/** The value after `flag` in argv, or a refusal that names the usage. */
function argOf(flag: string): string {
  const at = process.argv.indexOf(flag);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (value === undefined || value === '')
    throw new Error(`neptunia-mcp: ${flag} is missing; run as neptunia-mcp.ts --socket <path> --token-file <file>`);
  return value;
}

const token = fs.readFileSync(argOf('--token-file'), 'utf8').trim();
const transport = await connectSocket({ path: argOf('--socket'), maxFrameBytes: MAX_FRAME_BYTES });
const server = createMcpServer(bridgePeer(transport, token));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  if (line.trim() === '') return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    // a line that is no JSON is no request; the CLI sends none
    return;
  }
  void server.handle(message).then((answer) => {
    if (answer !== null) process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
});
input.on('close', () => transport.close());
