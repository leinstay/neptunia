// Operations: `/nep route`: which providers serve each model, per role (llm.providerByModel in the private settings file).
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { IMAGE_ROLE } from '../../llm/images.js';
import { matchRoute } from '../../llm/openrouter.js';
import { OPENCODE_ROLES } from '../../llm/roles.js';
import {
  NONE,
  onOff,
  reloadNote,
  readLocalConfig,
  ROUTE_ROLES,
  PROVIDER_SLUG_RE,
  modelForRole,
  describeProviders,
  fallbacksText,
  byokText,
  routingSummary,
  routePrefixArg,
  routeRoleArg,
} from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { isObj, objOf, textOf } from '../types.ts';
import type { Obj, Untyped } from '../types.ts';

/** The `byok` option of `/nep route set`: `'true'` or `'false'` (the command's choices), or the
 * boolean a persona's call carries; absent (undefined or null) is false; anything else is refused. */
function routeByokArg(args: Obj): boolean {
  const value = args.byok;
  if (value === undefined || value === null) return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw invalid('byok must be true or false');
}

const handlers = perEnv((env) => {
  const { hot, localConfigFile, editLocalConfig, localOrLive } = env;

  /** `llm.providerByModel` as of the last write (`localOrLive`), `{}` when it is not a map. */
  function effectiveRoutes(): Obj {
    const routes = localOrLive('llm.providerByModel');
    return isObj(routes) ? routes : {};
  }

  /** The private settings file with `llm.providerByModel` replaced by `edit(copyOfTheLocalMap)`'s result;
   * an emptied map, then an emptied `llm`, are pruned. Reloads the config; the reload's outcome. */
  function writeRoutes(edit: (map: Obj) => Obj): boolean {
    return editLocalConfig((local) => {
      const next = structuredClone(local) as Obj;
      const llmCfg: Obj = isObj(next.llm) ? next.llm : {};
      const current = objOf(objOf(local).llm).providerByModel;
      const map = edit(isObj(current) ? { ...current } : {});
      if (Object.keys(map).length > 0) llmCfg.providerByModel = map;
      else delete llmCfg.providerByModel;
      if (Object.keys(llmCfg).length > 0) next.llm = llmCfg;
      else delete next.llm;
      return next;
    });
  }

  /** One by-role line of `/nep route list`: the model and the routing it gets now. */
  function routeRoleLine(role: string, cfg: Untyped, byModel: Obj): string {
    const model = modelForRole(role, cfg);
    if (!model) return `  ${role}: (no model configured)`;
    const match = matchRoute(model, byModel, role);
    const fallbackName = role === IMAGE_ROLE ? 'image.provider' : 'llm.provider';
    const fallback = role === IMAGE_ROLE ? cfg?.image?.provider : cfg?.llm?.provider;
    let applied = 'none';
    if (match) applied = `${match.key} ${routingSummary(match.value as Obj)}`;
    else if (isObj(fallback)) applied = `${fallbackName} ${routingSummary(fallback)}`;
    const pin = cfg?.media?.video?.provider;
    const pinned =
      role === 'video' && isObj(pin) ? `; direct-URL videos: media.video.provider ${routingSummary(pin)}` : '';
    return `  ${role}: ${model} -> ${applied}${pinned}`;
  }

  /** `/nep route list`: every route, one line each (prefix | role or any | providers | fallbacks | byok),
   * then each role with the model it uses now and the routing that applies to it; the OpenCode
   * agents' roles (`scout`, `server`, `thinker`, `dev`) last, which the bot never routes: their workers never
   * read `llm.providerByModel` (no route resolved). */
  function cmdRouteList(): string {
    const cfg = hot.config;
    const byModel = effectiveRoutes();
    const roleRank = (role: string | null): number =>
      role === null ? -1 : ROUTE_ROLES.includes(role) ? ROUTE_ROLES.indexOf(role) : ROUTE_ROLES.length;
    const routes = Object.entries(byModel)
      .flatMap(([key, value]) => (isObj(value) ? [[key, value] as const] : []))
      .map(([key, value]): { prefix: string; role: string | null; value: Obj } => {
        const at = key.lastIndexOf('@');
        return at === -1
          ? { prefix: key, role: null, value }
          : { prefix: key.slice(0, at), role: key.slice(at + 1), value };
      })
      .sort((a, b) => (a.prefix === b.prefix ? roleRank(a.role) - roleRank(b.role) : a.prefix < b.prefix ? -1 : 1));
    const lines = routes.length === 0 ? [`routes: ${NONE}`] : ['routes:'];
    for (const route of routes) {
      lines.push(
        `  ${route.prefix} | ${route.role ?? 'any'} | ${describeProviders(route.value)} | fallbacks: ${fallbacksText(route.value)} | byok: ${byokText(route.value)}`
      );
    }
    lines.push('by role:', ...ROUTE_ROLES.map((role) => routeRoleLine(role, cfg, byModel)));
    lines.push(
      ...OPENCODE_ROLES.map(
        (role) =>
          `  ${role}: ${modelForRole(role, cfg) ?? '(no model configured)'} -> OpenCode's own routing (llm.providerByModel not read)`
      )
    );
    return lines.join('\n');
  }

  /** `/nep route set`: `{ only: [providers], allow_fallbacks }` under `<prefix>` or `<prefix>@<role>`,
   * with `byok: true` when asked (src/llm/openrouter.js#assertByok; off writes no key). */
  function cmdRouteSet(args: Obj): string {
    const prefix = routePrefixArg(args);
    const role = routeRoleArg(args);
    const providers = [
      ...new Set(
        textOf(args.providers)
          .split(',')
          .map((slug) => slug.trim())
          .filter(Boolean)
      ),
    ];
    if (providers.length === 0) throw invalid('at least one provider slug is required, e.g. google-vertex');
    const badSlug = providers.find((slug) => !PROVIDER_SLUG_RE.test(slug));
    if (badSlug) throw invalid(`invalid provider slug: ${badSlug} (lowercase letters, digits and -)`);
    const allowFallbacks = args.fallbacks === true;
    const byok = routeByokArg(args);

    const key = role ? `${prefix}@${role}` : prefix;
    const value = { only: providers, allow_fallbacks: allowFallbacks, ...(byok ? { byok: true } : {}) };
    const ok = writeRoutes((map) => ({ ...map, [key]: value }));
    return `Route ${key} (${role ?? 'any role'}): only ${providers.join(', ')}, fallbacks: ${onOff(allowFallbacks)}, byok: ${onOff(byok)} ${reloadNote(ok)}`;
  }

  /** `/nep route remove`: drops the `<prefix>` or `<prefix>@<role>` key from the private settings file */
  function cmdRouteRemove(args: Obj): string {
    const prefix = routePrefixArg(args);
    const role = routeRoleArg(args);
    const key = role ? `${prefix}@${role}` : prefix;
    const local = readLocalConfig(localConfigFile());
    const localMap = objOf(objOf(local.llm).providerByModel);
    if (!Object.hasOwn(localMap, key)) {
      const live = hot.config?.llm?.providerByModel;
      const fromBase =
        isObj(live) && Object.hasOwn(live, key) ? ' in config.local/config.json (it is set in config/config.json)' : '';
      throw invalid(`no route ${key}${fromBase}`, CODE.NOT_FOUND);
    }
    const ok = writeRoutes((map) => {
      delete map[key];
      return map;
    });
    return `Removed route ${key} ${reloadNote(ok)}`;
  }

  return { effectiveRoutes, writeRoutes, routeRoleLine, cmdRouteList, cmdRouteSet, cmdRouteRemove };
});

defineOp({
  name: 'route.list',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdRouteList(),
});
defineOp({
  name: 'route.set',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdRouteSet(args),
});
defineOp({
  name: 'route.remove',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdRouteRemove(args),
});
