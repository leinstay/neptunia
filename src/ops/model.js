// Operations: `/nep model show|set`: which model serves each role.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { MODEL_ROLES, MODEL_SET_PATHS, MODEL_SET_ROLES } from '../discord/commands.js';
import { IMAGE_ROLE } from '../llm/images.js';
import { onOff, reloadNote, MODEL_ID_RE, modelForRole } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, writeLocalPath, imageModelLabel } = env;

  function cmdModelShow() {
    const cfg = hot.config;
    const lines = [
      ...MODEL_ROLES.map((role) => `${role}: ${modelForRole(role, cfg) ?? '-'}`),
      `${IMAGE_ROLE}: ${imageModelLabel(cfg)}`,
      `mediaDescriptions: ${onOff(cfg?.features?.mediaDescriptions === true)}`,
    ];
    return lines.join('\n');
  }

  function cmdModelSet(args) {
    const role = String(args?.role ?? '');
    const dottedPath = Object.hasOwn(MODEL_SET_PATHS, role) ? MODEL_SET_PATHS[role] : null;
    if (!dottedPath) throw invalid(`unknown role: ${role} (${MODEL_SET_ROLES.join(', ')})`);

    const id = String(args?.id ?? '').trim();
    if (!MODEL_ID_RE.test(id)) throw invalid('id must look like a model id, e.g. anthropic/claude-haiku-4.5 (3-100 chars)');

    const ok = writeLocalPath(dottedPath, id);
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
