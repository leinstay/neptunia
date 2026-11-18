// The choice lists the operations share: the model roles and the config path of each, the sections of a profile
// read, the fields and parts of the status card, the journal kinds, the notification modes and the errand agents.
// The operations under src/tools/operations/, her tool definitions (src/tools/definitions.ts) and the owner's command table
// read them, and `leafPaths` lists every setting of a config.

import { BASE_ROLES, CORE_ROLES } from '../../llm/roles.ts';
import { isObj, objOf } from '../types.ts';

/**
 * The core's model roles (src/llm/roles.ts#CORE_ROLES: the core, then the model roles other than `core`): the roles the
 * status card probes; every role choice list is derived from these. `core` is the one model that speaks as the persona:
 * its replies. `embedding` serves the embeddings (src/llm/embed.ts), which take no chat completion.
 */
export const MODEL_ROLES: ReadonlyArray<string> = Object.freeze([...CORE_ROLES]);

/**
 * The roles whose model `model.show` lists and `model.set` changes (src/llm/roles.ts#BASE_ROLES): the core, the other
 * model roles and drawing, whose model is their chain's. Drawing (src/llm/images.ts#IMAGE_ROLE) takes no chat
 * completion. The choices of `model.set` and, with the agents, of `/model set`.
 */
export const MODEL_SET_ROLES: ReadonlyArray<string> = Object.freeze([...BASE_ROLES]);

/** The `section` choices of `memory.profile.read`, in display order (it falls back to `summary`). */
export const MEMORY_SHOW_SECTIONS = Object.freeze([
  'summary',
  'character',
  'style',
  'relationship',
  'affinity',
  'aliases',
  'interests',
  'details',
  'episodes',
  'raw',
]);

/**
 * The fields of the status card, in order (src/tools/operations/status.ts renders them; the costs,
 * memory and speed ones are the owner's only): the `field` argument of `status.show`.
 */
export const STATUS_FIELDS = Object.freeze([
  'state',
  'tasks',
  'models.base',
  'keys.base',
  'costs.base',
  'models.errands',
  'costs.errands',
  'inner',
  'limits',
  'memory',
  'speed',
]);

/** The `kind` choices of `memory.journal.read` (`all` reads every kind). */
export const JOURNAL_KINDS = Object.freeze(['turn', 'action', 'memory', 'system', 'answer', 'inner', 'all']);

/** Every dotted leaf path of a plain config object, depth-first in key order; an empty object or an array is a leaf. */
export function leafPaths(config: unknown, prefix = ''): Array<string> {
  const out: Array<string> = [];
  for (const [key, value] of Object.entries(objOf(config))) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (isObj(value) && Object.keys(value).length > 0) {
      out.push(...leafPaths(value, full));
    } else {
      out.push(full);
    }
  }
  return out;
}
