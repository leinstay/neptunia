// Operations `agent.list`, `agent.enable` and `agent.disable`: the owner's view of the agents on disk
// (src/agent-runner/profiles.ts) and their switch, `agents.<name>.enabled` in the private settings file. They back the
// commands `/agents` and `/agent enable|disable` and are no tools of the persona. A row names the agent, its unit, its
// route (src/subharness/routing.ts), whether it is on, whether its folder is tracked or local, and its
// description. The agents are read from the engine root and the data folder of the live view at each call.

import { agentSettings, loadProfiles } from '../../agent-runner/profiles.ts';
import type { AgentPaths } from '../../agent-runner/profiles.ts';
import { agentRouteOf } from '../../subharness/routing.ts';
import { routeName } from '../../subharness/route-names.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { reloadNote } from './shared.ts';
import { objOf, textOf } from '../types.ts';
import type { Obj } from '../types.ts';

const handlers = perEnv((env) => {
  const { writeLocalPath } = env;
  const live = (): Record<string, unknown> => objOf(env.hot);

  /** The agent trees of the live view: the tracked agents of its root, the local ones of its data folder. */
  const paths = (): AgentPaths => ({ rootDir: textOf(live().rootDir), dataDir: textOf(live().privateDir) });

  /** `agent.list`: one row per agent, sorted by name. */
  function cmdList(): string {
    const config = live().config;
    const rows = Object.values(loadProfiles(paths())).map((profile) => {
      const route = agentRouteOf(config, profile.name);
      const routeText = route === null ? 'no route' : `${routeName(route.backend)} ${route.model ?? 'default'}`;
      const on = agentSettings(profile.name, config, paths())?.enabled === true ? 'on' : 'off';
      return `${profile.name}  ${profile.unit}  ${routeText}  ${on}  ${profile.origin}  ${profile.description}`;
    });
    return rows.length === 0 ? 'no agents' : rows.join('\n');
  }

  /** `agent.enable` and `agent.disable`: `agents.<name>.enabled` written for an agent on disk. */
  function cmdSwitch(args: Obj, enabled: boolean): string {
    const name = textOf(args.name).trim();
    if (!Object.hasOwn(loadProfiles(paths()), name))
      throw invalid(`${name || '(none)'} is no agent; /agents lists them`);
    const ok = writeLocalPath(['agents', name, 'enabled'], enabled);
    return `${name} is ${enabled ? 'on' : 'off'} ${reloadNote(ok)}`;
  }

  return { cmdList, cmdSwitch };
});

defineOp({
  name: 'agent.list',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdList(),
});
defineOp({
  name: 'agent.enable',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdSwitch(args, true),
});
defineOp({
  name: 'agent.disable',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdSwitch(args, false),
});
