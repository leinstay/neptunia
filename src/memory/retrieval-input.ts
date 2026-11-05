// What each consumer of memory already holds, turned into the one retrieval service's query (src/memory/db/retrieve.ts) with
// no model in between, and the budget of that read from the settings at the moment of use. Same input, same query: no clock,
// no random pick and no other model decides what she is reminded of. A query names no destination, so what is retrieved can
// never choose where an answer goes.

import { estimateTokens } from '../llm/tokens.ts';
import type { MemoryQuery, RetrievalBounds, SemanticRef } from './db/semantic-types.ts';

type Ids = ReadonlyArray<string>;
type Turn = { purpose: 'turn' | 'prefetch'; text: string; people: Ids; place: string | null; entities: Ids };
export type RetrievalInput =
  | Turn
  | {
      purpose: 'search';
      text: string;
      anchors: ReadonlyArray<SemanticRef>;
      predicates: Ids;
      validAt?: string | null;
      recordedBefore?: string | null;
      historical?: boolean;
    }
  | { purpose: 'heartbeat'; recent: Ids; intentions: Ids; focus: Ids; entities: Ids }
  | {
      purpose: 'attention';
      intention: { purpose: string; people: Ids; entities: Ids; place: string | null };
    }
  | { purpose: 'reflection'; from: string; to: string; participants: Ids; entities: Ids }
  | {
      purpose: 'improvement';
      failures: ReadonlyArray<{ tool: string; code: string | null }>;
      lessons: Ids;
      entities: Ids;
    }
  | { purpose: 'session'; batch: Ids; people: Ids; places: Ids; entities: Ids }
  | { purpose: 'task'; goal: string; refs: ReadonlyArray<SemanticRef> }
  | { purpose: 'watcher'; goal: string; runIds: Ids };

/** The longest query text, whatever the budget: a query spends its tokens on results. */
const MAX_QUERY_CHARS = 2000;

const refs = (kind: SemanticRef['kind'], ids: Ids): Array<SemanticRef> => ids.map((id) => ({ kind, id }));
const placeRef = (id: string | null): Array<SemanticRef> => (id === null || id === '' ? [] : refs('place', [id]));

/** The lines that fit the budget, in their order, whole; the first line alone is cut to size. */
function queryText(lines: ReadonlyArray<string>, bounds: RetrievalBounds): string {
  const room = Math.min(MAX_QUERY_CHARS, bounds.tokens);
  const kept: Array<string> = [];
  let used = 0;
  for (const line of lines) {
    const piece = line.trim();
    if (piece === '') continue;
    const cost = estimateTokens(`${kept.join('\n')}\n${piece}`);
    if (used + piece.length > MAX_QUERY_CHARS || cost > room) {
      if (kept.length === 0) kept.push(piece.slice(0, room));
      break;
    }
    used += piece.length;
    kept.push(piece);
  }
  return kept.join('\n');
}

/** The words and anchors of one consumer. */
function seedsOf(input: RetrievalInput): { lines: ReadonlyArray<string>; anchors: Array<SemanticRef> } {
  switch (input.purpose) {
    case 'turn':
    case 'prefetch':
      return {
        lines: [input.text],
        anchors: [...refs('person', input.people), ...refs('entity', input.entities), ...placeRef(input.place)],
      };
    case 'search':
      return { lines: [input.text], anchors: [...input.anchors] };
    case 'heartbeat':
      return {
        lines: [...input.intentions, ...input.recent],
        anchors: [...refs('person', input.focus), ...refs('entity', input.entities)],
      };
    case 'attention': {
      const { intention } = input;
      return {
        lines: [intention.purpose],
        anchors: [
          ...refs('person', intention.people),
          ...refs('entity', intention.entities),
          ...placeRef(intention.place),
        ],
      };
    }
    case 'reflection':
      return { lines: [], anchors: [...refs('person', input.participants), ...refs('entity', input.entities)] };
    case 'improvement':
      return {
        lines: [...input.failures.map((one) => `${one.tool} ${one.code ?? ''}`), ...input.lessons],
        anchors: refs('entity', input.entities),
      };
    case 'session':
      return {
        lines: input.batch,
        anchors: [...refs('person', input.people), ...refs('entity', input.entities), ...refs('place', input.places)],
      };
    case 'task':
      return { lines: [input.goal], anchors: [...input.refs] };
    case 'watcher':
      return { lines: [input.goal, ...input.runIds], anchors: [] };
  }
}

/** The query of one consumer under `bounds`. Pure. */
export function memoryQueryFor(input: RetrievalInput, bounds: RetrievalBounds): MemoryQuery {
  const { lines, anchors } = seedsOf(input);
  const search = input.purpose === 'search' ? input : null;
  return {
    text: queryText(lines, bounds),
    anchors,
    predicates: search ? [...search.predicates] : [],
    validAt: search?.validAt ?? null,
    recordedBefore: input.purpose === 'reflection' ? input.to : (search?.recordedBefore ?? null),
    includeHistorical: search?.historical === true,
    purpose: input.purpose,
    bounds,
    cursor: null,
  };
}

/** The settings a budget reads; everything else in the config is none of this module's business. */
type BoundSettings = { recall?: { prefetch?: unknown }; memoryDb?: { retrieval?: unknown } | Record<string, unknown> };

/** A bound that is no positive number would read as no bound, so a hub loads whole: it is refused by name. */
function bound(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw Object.assign(new Error(`${key} is not a positive number`), { code: 'BAD_RETRIEVAL_BOUND' });
  return value;
}

/**
 * The budget of one read, from the settings given now. A prefetch and a turn share `recall.prefetch.deadlineMs` and
 * `recall.prefetch.maxTokens` with the source windows; another purpose reads `memoryDb.retrieval.tokens` and `.deadlineMs`,
 * falling back on the prefetch's when the setting is absent.
 */
export function retrievalBounds(settings: BoundSettings, purpose: MemoryQuery['purpose']): RetrievalBounds {
  const retrieval = (settings.memoryDb?.retrieval ?? {}) as Record<string, unknown>;
  const prefetch = (settings.recall?.prefetch ?? {}) as { deadlineMs?: unknown; maxTokens?: unknown };
  const shared = purpose === 'prefetch' || purpose === 'turn';
  const count = (name: string): number => bound(retrieval[name], `memoryDb.retrieval.${name}`);
  return {
    seeds: count('seeds'),
    hops: count('hops'),
    nodes: count('nodes'),
    edges: count('edges'),
    assertions: count('assertions'),
    evidence: count('evidence'),
    tokens: shared
      ? bound(prefetch.maxTokens, 'recall.prefetch.maxTokens')
      : bound(retrieval.tokens ?? prefetch.maxTokens, 'memoryDb.retrieval.tokens'),
    deadlineMs: shared
      ? bound(prefetch.deadlineMs, 'recall.prefetch.deadlineMs')
      : bound(retrieval.deadlineMs ?? prefetch.deadlineMs, 'memoryDb.retrieval.deadlineMs'),
  };
}

/** A stored fact's standing as words: its state from `labels.prefetch.factStates`, and that it says something is not so. */
export function factStateWords(
  fact: { state?: unknown; polarity?: unknown },
  states: Readonly<Record<string, unknown>> | null | undefined
): string {
  const words = [states?.[String(fact.state ?? 'unknown')], fact.polarity === 'negative' ? states?.negative : ''];
  return words.filter((word) => typeof word === 'string' && word !== '').join(', ');
}
