// The persona's human-looking randomness, in one place: a value drawn from a
// `[min, max]` config pair (pauses, delays, chances) and how long a person
// would type a message. Pure: the random source is always injected (`rng`,
// a () => [0, 1) function), so turns, the inner life and the
// message pipeline stay deterministic under test.

/**
 * Uniform random number inside a `[min, max]` config pair.
 */
export function between([min, max]: [number, number], rng: () => number): number {
  return min + (max - min) * rng();
}

/**
 * How long a person would type `text`, per config.typing: `msPerChar` (a
 * `[min, max]` pair) per character, kept within `minMs`..`maxMs`, rounded.
 */
export function typingMs(
  text: string,
  cfg: { msPerChar: [number, number]; minMs: number; maxMs: number },
  rng: () => number
): number {
  const ms = text.length * between(cfg.msPerChar, rng);
  return Math.round(Math.min(cfg.maxMs, Math.max(cfg.minMs, ms)));
}

/** A copy of `items` in a random order (Fisher-Yates over `rng`). */
export function shuffled<T>(items: ReadonlyArray<T>, rng: () => number): Array<T> {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
