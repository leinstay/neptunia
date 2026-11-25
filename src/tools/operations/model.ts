// Operations: `model.show|set`: which model serves each role. A base role's model is the model of the routes of its
// chain (`models.routes.<role>`, src/llm/route-chain.ts): `model.set` puts the model on each route of the chain and
// refuses a role with no route, whose key only `/model set <role> <key>/<model>` can name. `model.show` also lists
// each errand agent's route, its harness and model (src/subharness/routing.ts), which `/model set <agent>` writes
// through the subharness. Each `run` calls one of the handlers with the operation's `ctx` as the command context.

import { MODEL_SET_ROLES } from './catalog.ts';
import { IMAGE_ROLE } from '../../llm/images.ts';
import { CORE_ROLE, NON_CORE_ROLES, roleModel } from '../../llm/roles.ts';
import { routesOf } from '../../llm/route-chain.ts';
import { isRouteRole } from '../../llm/route-text.ts';
import { agentRouteOf } from '../../subharness/routing.ts';
import { agentNames } from '../../agent-runner/profiles.ts';
import { routeName } from '../../subharness/route-names.ts';
import { reloadNote, setPath, MODEL_ID_RE } from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { objOf } from '../types.ts';

/** The roles whose model writes the media cache's descriptions: a change re-describes them (media.recacheBefore). */
const MEDIA_ROLES = new Set(['vision', 'video']);

const handlers = perEnv((env) => {
  const { hot, writeLocalPath, editLocalConfig, imageModelLabel, now } = env;

  /** One `<role>: <model>` line per role: the base roles (the core, the model roles other than `core`, drawing), then
   * under the group line `errands:` one `<agent>: <harness> <model>` line per agent, `-` for one with no route. */
  function cmdModelShow() {
    const cfg = hot.config;
    const lineOf = (role: string): string => `${role}: ${roleModel(cfg, role) ?? '-'}`;
    const agentLineOf = (agent: string): string => {
      const route = agentRouteOf(cfg, agent);
      return `${agent}: ${route === null ? '-' : `${routeName(route.backend)} ${route.model ?? 'default'}`}`;
    };
    const lines = [
      'base:',
      lineOf(CORE_ROLE),
      ...NON_CORE_ROLES.map(lineOf),
      `${IMAGE_ROLE}: ${imageModelLabel(cfg)}`,
      'errands:',
      ...agentNames().map(agentLineOf),
    ];
    return lines.join('\n');
  }

  function cmdModelSet(args: unknown): string {
    const config: unknown = hot.config;
    const given = objOf(args);
    const role = typeof given.role === 'string' ? given.role : '';
    if (!MODEL_SET_ROLES.includes(role)) throw invalid(`unknown role: ${role} (${MODEL_SET_ROLES.join(', ')})`);

    const id = (typeof given.id === 'string' ? given.id : '').trim();
    if (!MODEL_ID_RE.test(id))
      throw invalid('id must look like a model id, e.g. anthropic/claude-haiku-4.5 (3-100 chars)');

    // The role's chain, each route of it on the new model.
    const chain = isRouteRole(role) ? routesOf(config, role) : [];
    if (chain.length === 0)
      throw invalid(`the ${role} role has no route yet: /model set ${role} <key>/<model> names its key and model`);
    const keys = ['models', 'routes', role];
    const value = chain.map((route) => ({ ...route, model: id }));

    // A new vision or video model: every description cached before now is described again
    // when it comes up (src/memory/describe.ts), written in the same edit of the private settings file.
    if (MEDIA_ROLES.has(role) && roleModel(config, role) !== id) {
      const at = new Date(now()).toISOString();
      const ok = editLocalConfig((local) => setPath(setPath(local, keys, value), 'media.recacheBefore', at));
      return [
        `Set ${role} model to ${id} ${reloadNote(ok)}`,
        `media.recacheBefore set to ${at}: cached picture, GIF and video descriptions written before it are described again when they come up.`,
      ].join('\n');
    }

    const ok = writeLocalPath(keys, value);
    return `Set ${role} model to ${id} ${reloadNote(ok)}`;
  }

  return { cmdModelShow, cmdModelSet };
});

defineOp({
  name: 'model.show',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdModelShow(),
});
defineOp({
  name: 'model.set',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdModelSet(args),
});
