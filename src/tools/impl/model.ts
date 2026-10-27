// Operations: `/nep model show|set`: which model serves each role.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { MODEL_SET_PATHS, MODEL_SET_ROLES } from './catalog.ts';
import { IMAGE_ROLE } from '../../llm/images.js';
import {
  CORE_ROLE,
  DEVELOPMENT_ROLES,
  ERRAND_ROLES,
  HELPER_ROLES,
  roleConfigKeys,
  roleModel,
} from '../../llm/roles.js';
import { onOff, reloadNote, setPath, MODEL_ID_RE, modelForRole } from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { objOf } from '../types.ts';

/** The roles whose model writes the media cache's descriptions: a change re-describes them (media.recacheBefore). */
const MEDIA_ROLES = new Set(['vision', 'video']);

const handlers = perEnv((env) => {
  const { hot, writeLocalPath, editLocalConfig, imageModelLabel, now } = env;

  /** One `<role>: <model>` line per role: the base roles (the core, the helpers, drawing), then the errand and development roles each under a group line (`errands:`, `development:`). */
  function cmdModelShow() {
    const cfg = hot.config;
    const lineOf = (role: string): string => `${role}: ${modelForRole(role, cfg) ?? '-'}`;
    const lines = [
      'base:',
      lineOf(CORE_ROLE),
      ...HELPER_ROLES.map(lineOf),
      `${IMAGE_ROLE}: ${imageModelLabel(cfg)}`,
      'errands:',
      ...ERRAND_ROLES.map(lineOf),
      'development:',
      ...DEVELOPMENT_ROLES.map(lineOf),
      `mediaDescriptions: ${onOff(cfg?.features?.mediaDescriptions === true)}`,
    ];
    return lines.join('\n');
  }

  function cmdModelSet(args: unknown): string {
    const given = objOf(args);
    const role = typeof given.role === 'string' ? given.role : '';
    const dottedPath = Object.hasOwn(MODEL_SET_PATHS, role) ? MODEL_SET_PATHS[role] : null;
    if (!dottedPath) throw invalid(`unknown role: ${role} (${MODEL_SET_ROLES.join(', ')})`);
    // `models.<group>.<role>`.
    const keys = roleConfigKeys(role) ?? [];

    const id = (typeof given.id === 'string' ? given.id : '').trim();
    if (!MODEL_ID_RE.test(id))
      throw invalid('id must look like a model id, e.g. anthropic/claude-haiku-4.5 (3-100 chars)');

    // A new vision or video model: every description cached before now is described again
    // when it comes up (src/memory/describe.js), written in the same config.local.json edit.
    if (MEDIA_ROLES.has(role) && roleModel(hot.config, role) !== id) {
      const at = new Date(now()).toISOString();
      const ok = editLocalConfig((local) => setPath(setPath(local, keys, id), 'media.recacheBefore', at));
      return [
        `Set ${role} model to ${id} ${reloadNote(ok)}`,
        `media.recacheBefore set to ${at}: cached picture, GIF and video descriptions written before it are described again when they come up.`,
      ].join('\n');
    }

    const ok = writeLocalPath(keys, id);
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
