// The shapes the web search clients share: what a search gives back and what asks for one. Types only, read by
// `src/web/brave.ts`, `src/web/exa.ts` and `src/web/lookup.ts`.

/** One result of a search engine. */
export type SearchResult = { title: string; url: string; snippet: string; age?: string };

/** Why a search failed: the client's own reason, with the HTTP status when it came from one. */
export type SearchFailure = {
  ok: false;
  reason: 'no-key' | 'http' | 'timeout' | 'network' | 'empty' | 'rate-limited';
  status?: number;
};

/** What a search gives back. */
export type SearchOutcome = { ok: true; results: Array<SearchResult> } | SearchFailure;

/** What asks one search client for results. */
export type SearchOptions = { apiKey?: string | null; count?: number; timeoutMs?: number };

/** One search client: a query in, an outcome out, never a rejection. */
export type SearchClient = { search: (query: string, options?: SearchOptions) => Promise<SearchOutcome> };
