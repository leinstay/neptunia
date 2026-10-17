// Operations: `/nep set|unset`: one config override in config.local.json; a path under bot.owners or bot.access only for an owner.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { leafPaths } from '../discord/commands.js';
import { isOwnerId } from './grants.js';
import { governsPersona } from './rights.js';
import { splitPath, unsetPath, ownValueAt, jsonTypeOf, withArticle, touchesOwnerOnlyConfig, reloadNote } from './shared.js';
import { defineOp, perEnv, invalid, denied } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, editLocalConfig, writeLocalPath } = env;

  /** Refuses a change under `bot.owners` / `bot.access` (see OWNER_ONLY_CONFIG_PATHS) unless the
   * caller is an owner: a member granted `set` must never make themselves one. Made by the persona
   * (`context.actor`, her skills) a change of any key that governs authorization or her own
   * controls (src/ops/rights.js#governsPersona) is refused whoever asked. */
  function assertMayChangeConfig(parts, context) {
    if (context?.actor === 'persona' && governsPersona(parts.join('.'))) {
      throw denied(`the persona never changes ${parts.join('.')}`, 'self-grant');
    }
    if (touchesOwnerOnlyConfig(parts) && !isOwnerId(hot.config, context?.userId)) {
      throw denied(`only an owner may change ${parts.join('.')}`);
    }
  }

  /**
   * `/nep set`: one leaf of the live config (a path autocomplete offers, src/discord/commands.js
   * #leafPaths, walked over own keys only) overridden in config.local.json. The value is JSON, or
   * the raw text when it does not parse -- or when the setting is a string, so an id typed bare
   * stays text. Its JSON type must be the current one's (any type when the current is null).
   */
  function cmdSet(args, context) {
    const dottedPath = String(args?.path ?? '').trim();
    const rawValue = String(args?.value ?? '').trim();
    if (!dottedPath) throw invalid('a config path is required');
    // Read against the live config, so a key holding a dot (a model role such as `agent.web`) is one key.
    const parts = splitPath(dottedPath, hot.config);
    const key = parts.join('.');
    assertMayChangeConfig(parts, context);

    const current = ownValueAt(hot.config, parts);
    if (!key || !current.found) throw invalid(`unknown config path: ${dottedPath}`);
    if (!leafPaths(hot.config).includes(key)) throw invalid(`${key} is a section, not a value: set one of its keys`);

    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
    if (typeof current.value === 'string' && typeof value !== 'string') value = rawValue;
    const expected = jsonTypeOf(current.value);
    if (expected !== 'null' && jsonTypeOf(value) !== expected) {
      throw invalid(`${key} expects ${withArticle(expected)}, got ${withArticle(jsonTypeOf(value))}`);
    }

    const ok = writeLocalPath(parts, value);
    return `Set ${key} = ${JSON.stringify(value)} ${reloadNote(ok)}`;
  }

  function cmdUnset(args, context) {
    const dottedPath = String(args?.path ?? '').trim();
    if (!dottedPath) throw invalid('a config path is required');
    const parts = splitPath(dottedPath, hot.config);
    const key = parts.join('.');
    if (!key) throw invalid('a config path is required');
    assertMayChangeConfig(parts, context);
    const ok = editLocalConfig((local) => unsetPath(local, parts));
    return `Unset ${key} ${reloadNote(ok)}`;
  }

  return { assertMayChangeConfig, cmdSet, cmdUnset };
});

defineOp({
  name: 'config.set',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdSet(args, ctx),
});
defineOp({
  name: 'config.unset',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdUnset(args, ctx),
});
