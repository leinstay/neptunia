// The plugin registry: which tools of a plugin the core takes, how they stand beside the core's own in the gateway's
// registry, and how a call reaches the plugin. A plugin may register only the tools its `plugin.json` declares and
// only under its own prefix, and what it sends must equal what the manifest says of the tool's schema, effect, cost
// and rights, so a plugin cannot widen its own rights. A tool the manifest declares is read from the manifest
// (`manifests()`, the enabled plugins' at the moment of the call), never from what the plugin sent. A registered
// tool is a `Skill` of the gateway (src/tools/gateway.ts): her grant, the schema check and the requester's right
// apply to it as to a core tool. A tool stays registered after its plugin disconnects, until `forget`, so her grants
// and her tool list do not flicker. A call goes through the port last attached for its plugin (src/plugins/link.ts).

import type { Logger } from '../protocol/serve.ts';
import type { PluginManifest, RegisterOutcome, ToolAnswer, ToolCallBody, ToolDeclaration } from '../protocol/plugin.ts';
import { CODE } from '../tools/codes.ts';
import type { Schema } from '../tools/definitions.ts';
import type { Skill, SkillMap } from '../tools/types.ts';
import { declarationOf } from './manifest.ts';

export type PluginCallContext = {
  requester: { id: string | null; roleIds: ReadonlyArray<string> } | null;
  conversationId: string | null;
  idempotencyKey: string;
};

/** What the registry calls through: a live plugin link (src/plugins/link.ts). */
export type PluginPort = {
  isClosed(): boolean;
  callTool(request: Omit<ToolCallBody, 'deadlineAt'>): Promise<ToolAnswer>;
};

export type PluginRegistry = {
  /** Takes the tools a plugin sent. `manifests()` is read now. Never throws. */
  register(plugin: string, tools: ReadonlyArray<unknown>): RegisterOutcome;
  /** The link calls go through for `plugin`; the last one attached wins. */
  attach(plugin: string, port: PluginPort): void;
  /** Every registered tool as a skill of the gateway's registry. */
  skills(): SkillMap;
  /** The registered tool names, sorted; of one plugin when named. */
  tools(plugin?: string): Array<string>;
  connected(plugin: string): boolean;
  /** Drops every tool of `plugin` (a disable). */
  forget(plugin: string): void;
  /** One call. Never throws and never rejects. */
  call(tool: string, args: Record<string, unknown>, context: PluginCallContext): Promise<ToolAnswer>;
};

export const REGISTER_REFUSALS = [
  'unknown-plugin',
  'wrong-prefix',
  'not-declared',
  'differs-from-manifest',
  'invalid-declaration',
] as const;

/** The statuses a call result may have (src/tools/executors.ts#RESULT_STATUSES, without the retired `refused`). */
const CALL_STATUSES: ReadonlyArray<string> = [
  'ok',
  'denied',
  'not_configured',
  'invalid',
  'unknown',
  'partial',
  'failed',
];

/** `value` as JSON with every object's keys in sorted order, so two equal declarations compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const sameContract = (sent: ToolDeclaration, declared: ToolDeclaration): boolean =>
  canonical([sent.schema, sent.effect, sent.cost, sent.rights]) ===
  canonical([declared.schema, declared.effect, declared.cost, declared.rights]);

const nameOf = (entry: unknown): string => {
  const name = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>).name : undefined;
  return typeof name === 'string' ? name : '';
};

/** The tool as a skill: the gateway's fields from the manifest, her call mapped to the arguments as they are. */
function skillOf(plugin: string, tool: ToolDeclaration): Skill {
  // The manifest's schema is checked by the same validator as a core tool's (src/tools/schema.ts) at each call.
  const schema = tool.schema as Schema;
  const options = Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    kind: typeof property.type === 'string' ? property.type : 'string',
  }));
  return Object.freeze({
    name: tool.name,
    family: plugin,
    op: null,
    kind: tool.rights.kind,
    ownerOnly: tool.rights.ownerOnly === true,
    member: tool.rights.member === true,
    argsSchema: schema,
    effects: tool.effect,
    sharedState: tool.effect !== 'read',
    costClass: tool.cost,
    targets: null,
    interfaceCapability: null,
    api: tool.name.replaceAll('.', '_'),
    result: 'data',
    wording: Object.freeze({ ...tool.wording }),
    dispatch: Object.freeze({
      op: tool.name,
      body: null,
      options: Object.freeze(options.map((option) => Object.freeze(option))),
      toOp: (given: Record<string, unknown> | null | undefined) => ({ op: tool.name, args: given ?? {} }),
    }),
  });
}

/** The plugin's answer as the engine reads a call result: a known status, a code, and `data.text` only as text. */
function resultOf(answer: unknown): ToolAnswer {
  const given = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  if (typeof given.status !== 'string' || !CALL_STATUSES.includes(given.status))
    return { status: 'failed', code: CODE.INVALID_ANSWER };
  const data = given.data !== null && typeof given.data === 'object' ? (given.data as Record<string, unknown>) : null;
  return {
    status: given.status,
    ...(typeof given.code === 'string' && given.code !== '' ? { code: given.code } : {}),
    ...(data === null ? {} : { data: typeof data.text === 'string' ? { text: data.text } : {} }),
  };
}

export function createPluginRegistry(options: {
  manifests: () => ReadonlyArray<PluginManifest>;
  log: Logger;
}): PluginRegistry {
  const registered = new Map<string, { plugin: string; skill: Skill }>();
  const ports = new Map<string, PluginPort>();
  let listed: SkillMap | null = null;

  function refusalOf(plugin: string, manifest: PluginManifest | undefined, entry: unknown): string | null {
    if (manifest === undefined) return 'unknown-plugin';
    const name = nameOf(entry);
    if (!name.startsWith(`${plugin}.`)) return 'wrong-prefix';
    const declared = manifest.tools.find((tool) => tool.name === name);
    if (declared === undefined) return 'not-declared';
    const sent = declarationOf(entry);
    if (sent === null) return 'invalid-declaration';
    return sameContract(sent, declared) ? null : 'differs-from-manifest';
  }

  return {
    register(plugin, tools) {
      const manifest = options.manifests().find((one) => one.name === plugin);
      const outcome: RegisterOutcome = { accepted: [], refused: [] };
      for (const entry of tools) {
        const name = nameOf(entry);
        const reason = refusalOf(plugin, manifest, entry);
        const declared = manifest?.tools.find((tool) => tool.name === name);
        if (reason !== null || declared === undefined) {
          outcome.refused.push({ name, reason: reason ?? 'not-declared' });
          continue;
        }
        registered.set(name, { plugin, skill: skillOf(plugin, declared) });
        outcome.accepted.push(name);
      }
      listed = null;
      options.log.info('plugins: registry', {
        plugin,
        accepted: outcome.accepted.length,
        refused: outcome.refused.length,
      });
      return outcome;
    },
    attach(plugin, port) {
      ports.set(plugin, port);
    },
    skills() {
      listed ??= new Map([...registered].map(([name, entry]) => [name, entry.skill]));
      return listed;
    },
    tools(plugin) {
      return [...registered]
        .filter(([, entry]) => plugin === undefined || entry.plugin === plugin)
        .map(([name]) => name)
        .sort();
    },
    connected: (plugin) => ports.get(plugin)?.isClosed() === false,
    forget(plugin) {
      for (const [name, entry] of registered) if (entry.plugin === plugin) registered.delete(name);
      ports.delete(plugin);
      listed = null;
    },
    async call(tool, args, context) {
      const entry = registered.get(tool);
      if (entry === undefined) return { status: 'invalid', code: CODE.UNKNOWN_SKILL };
      const port = ports.get(entry.plugin);
      if (port === undefined || port.isClosed()) return { status: 'failed', code: CODE.PLUGIN_NOT_CONNECTED };
      try {
        const answer = await port.callTool({
          tool,
          args,
          requester:
            context.requester === null ? null : { id: context.requester.id, roleIds: [...context.requester.roleIds] },
          conversationId: context.conversationId,
          idempotencyKey: context.idempotencyKey,
        });
        return resultOf(answer);
      } catch (err) {
        options.log.warn('plugins: call failed', { tool, name: err instanceof Error ? err.name : null });
        return { status: 'unknown', code: CODE.PLUGIN_NO_ANSWER };
      }
    },
  };
}
