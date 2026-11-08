// The names the owner reads and types for a route, mapped at the edge: `direct-api` for the OpenRouter API, and
// `claude-harness`, `codex-harness` and `opencode-harness` for the three CLIs. config.json, the folders under
// `data/subharness/`, the binaries and the logs keep the stored backend word (`claude`, `codex`, `opencode`), so
// nothing but the code that renders a route or parses `--via` knows a second word.

/** The stored word of a route: the API, or one backend. */
export type RouteBackend = 'api' | 'claude' | 'codex' | 'opencode';

export const ROUTE_NAMES: Readonly<Record<RouteBackend, string>> = {
  api: 'direct-api',
  claude: 'claude-harness',
  codex: 'codex-harness',
  opencode: 'opencode-harness',
};

/** The name of a route, for a line the owner reads. */
export function routeName(backend: RouteBackend): string {
  return ROUTE_NAMES[backend];
}

/** The stored word of a typed route name, or null for an old backend word and for anything else. */
export function backendOfRouteName(name: string): RouteBackend | null {
  const found = (Object.keys(ROUTE_NAMES) as Array<RouteBackend>).find((backend) => ROUTE_NAMES[backend] === name);
  return found ?? null;
}

/** Route names in one phrase for a refusal: `a, b or c`. */
export function routeNamesText(backends: ReadonlyArray<RouteBackend>): string {
  const names = backends.map(routeName);
  const last = names.pop();
  return names.length === 0 ? (last ?? '') : `${names.join(', ')} or ${last ?? ''}`;
}

/** The name of a route given as a plain stored word; a word that is no route stays as it is. */
export function routeNameOfWord(word: string): string {
  return Object.hasOwn(ROUTE_NAMES, word) ? ROUTE_NAMES[word as RouteBackend] : word;
}
