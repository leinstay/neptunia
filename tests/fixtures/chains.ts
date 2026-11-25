// The chains of routes of a test's settings (`models.routes`, src/llm/route-chain.ts), written as the role models the
// test means: `chainsOf({ core: 'x/core', vision: null })` gives the core a chain of one route on the key `main` with
// that model and leaves vision with an empty chain, which turns it off. For tests of something else than the routing,
// whose settings named each role's model before the chains.

/** One route of a chain, as `models.routes.<role>` holds it. */
export type ChainRoute = { via: 'api'; key: string; model: string; effort: null };

/**
 * `models.routes` for `models`: a role named with a non-empty model id gets one API route on `key` with it, a role named
 * with null, false or an empty string an empty chain.
 */
export function chainsOf(models: Readonly<Record<string, unknown>>, key = 'main'): Record<string, Array<ChainRoute>> {
  return Object.fromEntries(
    Object.entries(models).map(([role, model]) => [
      role,
      typeof model === 'string' && model !== '' ? [{ via: 'api', key, model, effort: null }] : [],
    ])
  );
}

/** The models the optional roles had while a config named none of them: on, each with its built-in default. */
const OPTIONAL_DEFAULTS: Readonly<Record<string, string>> = {
  vision: 'google/gemini-3.8-flash',
  video: 'google/gemini-3.8-flash',
  speech: 'elevenlabs/eleven-v4',
  drawing: 'openai/gpt-image-2.5-flare',
};

/**
 * `chainsOf` with the optional roles `models` leaves out on their built-in defaults, as a config that named only some
 * roles ran before the chains: an optional role turns off with an explicit null, false or empty model alone.
 */
export function chainsOnDefaults(
  models: Readonly<Record<string, unknown>>,
  key = 'main'
): Record<string, Array<ChainRoute>> {
  return chainsOf({ ...OPTIONAL_DEFAULTS, ...models }, key);
}
