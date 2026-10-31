// An agent client of the core's socket, in the test process: it connects with an agent principal's token, says
// hello under the agents' namespace `agent`, and sends each board command as a `command.requested` event whose
// answer comes back as a `command.result` action. Every command asks for JSON (`json: true`), so a test reads the
// answer's data, never its wording. The fake adapter only fills the hello: the core never sends an agent anything
// but command results.
import { randomUUID } from 'node:crypto';
import { createFakeAdapter } from '../../src/interface/fake.js';
import { serveAdapter } from '../../src/protocol/serve.ts';
import type { CommandResult } from '../../src/protocol/serve.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../../src/protocol/wire.ts';

const quiet = { info() {}, warn() {}, error() {} };

/** The namespace an agent principal says hello under. */
export const AGENT_IFACE = 'agent';

/** One answer: the core's status, the text, and the text parsed as JSON when it is JSON. */
export type AgentAnswer = { status: string; text: string; data: unknown };

export type AgentClient = {
  /** Sends `task.<...>` with `args` and `json: true`; resolves with the answer, or the ack's status when not taken. */
  ask(name: string, args?: Record<string, unknown>): Promise<AgentAnswer>;
  /** Sends any event body as it is and resolves with the ack's status. */
  emit(body: Record<string, unknown>): Promise<string>;
  close(): void;
};

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A command event of the agent `name`, answered by the `command.result` naming `replyRef`. */
export function agentCommand(
  name: string,
  command: string,
  args: Record<string, unknown>,
  replyRef: string
): Record<string, unknown> {
  return {
    kind: 'command.requested',
    iface: AGENT_IFACE,
    at: Date.now(),
    id: `${AGENT_IFACE}:command:${replyRef}`,
    conversation: { id: `${AGENT_IFACE}:${name}`, kind: 'dm' },
    name: command,
    args,
    requester: { id: name, name, roles: [], owner: false },
    replyRef,
  };
}

/** Connects to the socket at `socketPath` as the agent `name` holding `token`; rejects when no core listens. */
export async function connectAgent(socketPath: string, name: string, token: string): Promise<AgentClient> {
  const transport = await connectSocket({ path: socketPath, maxFrameBytes: MAX_FRAME_BYTES });
  const answers = new Map<string, (result: CommandResult) => void>();
  transport.onClose(() => {
    for (const resolve of answers.values()) resolve({ replyRef: '', text: '', status: 'link-closed' });
    answers.clear();
  });
  const adapter = createFakeAdapter();
  const served = serveAdapter({
    transport,
    hello: {
      iface: AGENT_IFACE,
      self: { id: name, name },
      community: null,
      capabilities: adapter.capabilities(),
      resume: null,
    },
    token,
    adapter,
    log: quiet,
    onCommandResult: (result) => {
      const resolve = answers.get(result.replyRef);
      answers.delete(result.replyRef);
      resolve?.(result);
    },
  });
  return {
    async ask(command, args = {}) {
      const replyRef = randomUUID();
      const answer = new Promise<CommandResult>((resolve) => answers.set(replyRef, resolve));
      const acked = await served.emit(agentCommand(name, command, { ...args, json: true }, replyRef));
      if (acked !== 'ok') {
        answers.delete(replyRef);
        return { status: `ack:${acked}`, text: '', data: undefined };
      }
      const result = await answer;
      return { status: result.status ?? 'ok', text: result.text, data: parsed(result.text) };
    },
    emit: (body) => served.emit(body),
    close: () => served.close(),
  };
}
