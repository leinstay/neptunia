// Operations: `/nep route`: which providers serve each model, per role (llm.providerByModel in config.local.json).
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { adaptLegacyModelKeys, isPlainObject } from '../config.js';
import { IMAGE_ROLE } from '../llm/images.js';
import { matchRoute } from '../llm/openrouter.js';
import { AGENT_ROLES } from '../llm/roles.js';
import { NONE, onOff, reloadNote, readLocalConfig, ROUTE_ROLES, PROVIDER_SLUG_RE, modelForRole, describeProviders, fallbacksText, routingSummary, routePrefixArg, routeRoleArg } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, localConfigFile, editLocalConfig, localOrLive } = env;

  /** `llm.providerByModel` as of the last write (`localOrLive`), `{}` when it is not a map. */
  function effectiveRoutes() {
    const routes = localOrLive('llm.providerByModel');
    return isPlainObject(routes) ? routes : {};
  }

  /** config.local.json with `llm.providerByModel` replaced by `edit(copyOfTheLocalMap)`'s result;
   * an emptied map, then an emptied `llm`, are pruned. The local map is read, and so written
   * back, under the current role names (src/config.js#adaptLegacyModelKeys), so a route kept
   * under an old role name is edited, not shadowed. Reloads the config; the reload's outcome. */
  function writeRoutes(edit) {
    return editLocalConfig((local) => {
      const next = structuredClone(local);
      const llmCfg = isPlainObject(next.llm) ? next.llm : {};
      const current = adaptLegacyModelKeys(local).config?.llm?.providerByModel;
      const map = edit(isPlainObject(current) ? { ...current } : {});
      if (Object.keys(map).length > 0) llmCfg.providerByModel = map;
      else delete llmCfg.providerByModel;
      if (Object.keys(llmCfg).length > 0) next.llm = llmCfg;
      else delete next.llm;
      return next;
    });
  }

  /** One by-role line of `/nep route list`: the model and the routing it gets now. */
  function routeRoleLine(role, cfg, byModel) {
    const model = modelForRole(role, cfg);
    if (!model) return `  ${role}: (no model configured)`;
    const match = matchRoute(model, byModel, role);
    const fallbackName = role === IMAGE_ROLE ? 'image.provider' : 'llm.provider';
    const fallback = role === IMAGE_ROLE ? cfg?.image?.provider : cfg?.llm?.provider;
    let applied = 'none';
    if (match) applied = `${match.key} ${routingSummary(match.value)}`;
    else if (isPlainObject(fallback)) applied = `${fallbackName} ${routingSummary(fallback)}`;
    const pin = cfg?.media?.video?.provider;
    const pinned = role === 'video' && isPlainObject(pin) ? `; direct-URL videos: media.video.provider ${routingSummary(pin)}` : '';
    return `  ${role}: ${model} -> ${applied}${pinned}`;
  }

  /** `/nep route list`: every route, one line each (prefix | role or any | providers | fallbacks),
   * then each role with the model it uses now and the routing that applies to it; the agent
   * roles last, whose OpenCode workers never read `llm.providerByModel` (no route resolved). */
  function cmdRouteList() {
    const cfg = hot.config;
    const byModel = effectiveRoutes();
    const roleRank = (role) => (role === null ? -1 : ROUTE_ROLES.includes(role) ? ROUTE_ROLES.indexOf(role) : ROUTE_ROLES.length);
    const routes = Object.entries(byModel)
      .filter(([, value]) => isPlainObject(value))
      .map(([key, value]) => {
        const at = key.lastIndexOf('@');
        return at === -1 ? { prefix: key, role: null, value } : { prefix: key.slice(0, at), role: key.slice(at + 1), value };
      })
      .sort((a, b) => (a.prefix === b.prefix ? roleRank(a.role) - roleRank(b.role) : a.prefix < b.prefix ? -1 : 1));
    const lines = routes.length === 0 ? [`routes: ${NONE}`] : ['routes:'];
    for (const route of routes) {
      lines.push(`  ${route.prefix} | ${route.role ?? 'any'} | ${describeProviders(route.value)} | fallbacks: ${fallbacksText(route.value)}`);
    }
    lines.push('by role:', ...ROUTE_ROLES.map((role) => routeRoleLine(role, cfg, byModel)));
    lines.push(...AGENT_ROLES.map((role) => `  ${role}: ${modelForRole(role, cfg) ?? '(no model configured)'} -> OpenCode's own routing (llm.providerByModel not read)`));
    return lines.join('\n');
  }

  /** `/nep route set`: `{ only: [providers], allow_fallbacks }` under `<prefix>` or `<prefix>@<role>`. */
  function cmdRouteSet(args) {
    const prefix = routePrefixArg(args);
    const role = routeRoleArg(args);
    const providers = [...new Set(String(args?.providers ?? '').split(',').map((slug) => slug.trim()).filter(Boolean))];
    if (providers.length === 0) throw invalid('at least one provider slug is required, e.g. google-vertex');
    const badSlug = providers.find((slug) => !PROVIDER_SLUG_RE.test(slug));
    if (badSlug) throw invalid(`invalid provider slug: ${badSlug} (lowercase letters, digits and -)`);
    const allowFallbacks = args?.fallbacks === true;

    const key = role ? `${prefix}@${role}` : prefix;
    const ok = writeRoutes((map) => ({ ...map, [key]: { only: providers, allow_fallbacks: allowFallbacks } }));
    return `Route ${key} (${role ?? 'any role'}): only ${providers.join(', ')}, fallbacks: ${onOff(allowFallbacks)} ${reloadNote(ok)}`;
  }

  /** `/nep route remove`: drops the `<prefix>` or `<prefix>@<role>` key from config.local.json
   * (a key kept under an old role name counts as its new one, see `writeRoutes`). */
  function cmdRouteRemove(args) {
    const prefix = routePrefixArg(args);
    const role = routeRoleArg(args);
    const key = role ? `${prefix}@${role}` : prefix;
    const local = adaptLegacyModelKeys(readLocalConfig(localConfigFile())).config;
    const localMap = isPlainObject(local?.llm?.providerByModel) ? local.llm.providerByModel : {};
    if (!Object.hasOwn(localMap, key)) {
      const live = hot.config?.llm?.providerByModel;
      const fromBase = isPlainObject(live) && Object.hasOwn(live, key) ? ' in config.local.json (it is set in config.json)' : '';
      throw invalid(`no route ${key}${fromBase}`, 'not-found');
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
