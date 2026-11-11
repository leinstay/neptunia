// The config keys that govern the persona's own authority, and the check of one path against them, read by the
// self-authority rule of `config.set` and `config.unset` (src/tools/operations/config.ts). Pure; imports nothing
// that registers operations, so any module may use it.

/**
 * The config keys that govern authorization or the persona's own controls: who is an owner and
 * which tools she holds (`bot.ownerPerson`, `bot.access`), the language of the phrase codes (`bot.mnemonic`), her tools' settings, safe mode included (`tools.*`, and the name it
 * had before, `skills.*`), the wakes' mode, caps and limits (`wakes.*`, and the old name `innerLife.*`), and the
 * heartbeat's and the selfimprovement wake's own limits (`heartbeat.*`, `selfimprovement.*`), and the boundary and limits
 * of the development worker (`development.*`).
 * The one list behind the non-delegable rule: she never changes her effective authority, directly or indirectly
 * (src/tools/operations/config.ts, src/tools/operations/access.ts).
 */
export const PERSONA_GOVERNED_CONFIG: ReadonlyArray<string> = Object.freeze([
  'bot.ownerPerson',
  'bot.access',
  'bot.mnemonic',
  'tools',
  'skills',
  'wakes',
  'heartbeat',
  'selfimprovement',
  'development',
]);

/**
 * True when the dotted config path `key` is one of PERSONA_GOVERNED_CONFIG, lies under one, or
 * holds one (a whole section).
 */
export function governsPersona(key: unknown): boolean {
  const path = typeof key === 'string' ? key : '';
  if (!path) return false;
  return PERSONA_GOVERNED_CONFIG.some(
    (governed) => path === governed || path.startsWith(`${governed}.`) || governed.startsWith(`${path}.`)
  );
}
