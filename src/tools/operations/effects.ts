// The effect class of every operation and the persona's own operations, by name, as maps and lists derived from the
// tool definitions (src/tools/definitions.ts), where each tool declares its `effects` and its traits once. Nothing is
// declared here. Pure.

import { EFFECT_CLASSES, SKILL_DEFINITIONS, toolsWith } from '../definitions.ts';
import type { EffectClass } from '../definitions.ts';

export { EFFECT_CLASSES };
export type { EffectClass };

/** Operation name -> effect class. */
export const OP_EFFECTS: Readonly<Record<string, EffectClass>> = Object.freeze(
  Object.fromEntries(SKILL_DEFINITIONS.map((definition) => [definition.op, definition.effects]))
);

/** The persona's own operations: the tools with the trait `self`. */
export const SELF_OWNED_OPS: ReadonlyArray<string> = toolsWith('self');
