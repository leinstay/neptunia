// The MCP server her tools reach a subscription CLI through: the logic of `bin/neptunia-mcp.ts`, which `claude -p` or
// `codex exec` starts for one turn (src/subharness/subscription-client.ts). It speaks newline-delimited JSON-RPC 2.0 as
// the stdio transport of MCP does, and answers four methods: `initialize`, `tools/list`, `tools/call` and `ping`. The
// tools and their calls belong to a peer, which in the real process is the core over its socket
// (src/subharness/tool-bridge.ts, `bridgePeer`). The server keeps the tool names bare: Claude shows them to the model as
// `mcp__nep__<name>` because the server is named `nep`, so a prefixed name in the list would be prefixed twice. It
// imports nothing, so the process the CLI starts loads no part of the engine but the bridge's wire.

/** The server's name in the CLI's MCP configuration. */
export const MCP_SERVER_NAME = 'nep';
/** What Claude puts before each tool name of the server. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** One call of her tool as the bridge carries it: the bare name, the arguments, and the CLI's `_meta` or null. */
export type BridgeCall = { name: string; arguments: Record<string, unknown>; meta: Record<string, unknown> | null };
/** The tool's answer: its text, and whether it failed. */
export type BridgeAnswer = { text: string; isError: boolean };
/** The other side of the server: the tool definitions of the turn, and the call of one tool. */
export type McpPeer = { list(): Promise<ReadonlyArray<object>>; call(call: BridgeCall): Promise<BridgeAnswer> };

/** The MCP version the server answers when the client names none, the one the prototype ran on (2026-11-04). */
const FALLBACK_PROTOCOL = '2025-06-18';
/** JSON-RPC's code for a method nobody serves. */
const METHOD_NOT_FOUND = -32601;

type Message = { id?: unknown; method?: unknown; params?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A chat-completions tool definition as an MCP tool, or null for an entry that is not one. */
function mcpToolOf(definition: object): object | null {
  const fn = isRecord(definition) && isRecord(definition.function) ? definition.function : null;
  if (fn === null || typeof fn.name !== 'string') return null;
  return {
    name: fn.name,
    description: typeof fn.description === 'string' ? fn.description : '',
    inputSchema: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
  };
}

/** The code a rejected call carries, for the text the CLI reads. */
function codeOf(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : 'failed';
}

/** One `tools/call`: the peer's answer, or an error result naming the code, so the CLI always gets an answer. */
async function callTool(peer: McpPeer, params: Record<string, unknown>): Promise<object> {
  const given = typeof params.name === 'string' ? params.name : '';
  const name = given.startsWith(MCP_TOOL_PREFIX) ? given.slice(MCP_TOOL_PREFIX.length) : given;
  const args = isRecord(params.arguments) ? params.arguments : {};
  const meta = isRecord(params._meta) ? params._meta : null;
  try {
    const answer = await peer.call({ name, arguments: args, meta });
    return { content: [{ type: 'text', text: answer.text }], isError: answer.isError };
  } catch (error) {
    return { content: [{ type: 'text', text: `the call failed: ${codeOf(error)}` }], isError: true };
  }
}

/** The result of one request, or undefined for a method the server does not serve. */
async function resultOf(peer: McpPeer, method: string, params: Record<string, unknown>): Promise<object | undefined> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '1' },
      };
    case 'tools/list':
      return { tools: (await peer.list()).map(mcpToolOf).filter((tool): tool is object => tool !== null) };
    case 'tools/call':
      return callTool(peer, params);
    case 'ping':
      return {};
    default:
      return undefined;
  }
}

/** The server over `peer`: `handle` answers one parsed message, null for a notification. */
export function createMcpServer(peer: McpPeer): { handle(message: unknown): Promise<object | null> } {
  return {
    async handle(message) {
      const { id, method, params } = (isRecord(message) ? message : {}) as Message;
      if (id === undefined || id === null) return null;
      const result = await resultOf(peer, typeof method === 'string' ? method : '', isRecord(params) ? params : {});
      if (result === undefined)
        return { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `no method ${String(method)}` } };
      return { jsonrpc: '2.0', id, result };
    },
  };
}
