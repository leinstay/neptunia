// How a turn's recall reads the one retrieval service (src/memory/db/retrieve.ts): the read itself, under the settings read
// now, and the excerpts its facts become in the prefetch. recall-run.ts is the caller; the wording is the request's.

import { log } from '../log.ts';
import { dbSettings } from '../memory/db/recall.ts';
import { retrieveMemory } from '../memory/db/retrieve.ts';
import type { RetrieveDeps } from '../memory/db/retrieve.ts';
import type { Context } from '../memory/db/scope.ts';
import type { MemoryPage } from '../memory/db/semantic-types.ts';
import type { Config, Db } from '../memory/db/types.ts';
import { memoryQueryFor, retrievalBounds } from '../memory/retrieval-input.ts';
import type { RetrievalInput } from '../memory/retrieval-input.ts';

/**
 * One read for a turn under its own context. Null while the retrieval settings are absent or when the read fails: the turn
 * keeps what the source search found. The turn has searched the sources itself, so the service does not.
 */
export async function memoryPage(given: {
  db: unknown;
  ctx: unknown;
  input: RetrievalInput;
  config: unknown;
  prefetch: unknown;
  now: () => number;
  embedQuery: RetrieveDeps['embedQuery'];
  model: unknown;
  plainClaims?: boolean;
}): Promise<MemoryPage | null> {
  const config = given.config as Config;
  if (!config?.memoryDb?.retrieval) return null;
  try {
    const bounds = retrievalBounds(
      { recall: { prefetch: given.prefetch }, memoryDb: config.memoryDb },
      given.input.purpose
    );
    const recall = dbSettings(config);
    return await retrieveMemory(given.db as Db, given.ctx as Context, memoryQueryFor(given.input, bounds), {
      now: given.now,
      embedQuery: given.embedQuery,
      model: typeof given.model === 'string' ? given.model : null,
      sources: false,
      plainClaims: given.plainClaims,
      recall,
      minSimilarity: recall?.minMeaning,
    });
  } catch (err) {
    log.warn('recall: retrieval failed', {
      purpose: given.input.purpose,
      code: (err as { code?: unknown } | null)?.code ?? null,
    });
    return null;
  }
}

/** A prefetch's query: the trigger's words, its partner and speaker, the place it was issued for. */
export function prefetchInput(ctx: unknown, text: unknown, speaker: ReadonlyArray<string>): RetrievalInput {
  const issued = ctx as Context;
  const partner = issued.kind === 'dm' && typeof issued.person === 'string' ? [issued.person] : [];
  return {
    purpose: 'prefetch',
    text: typeof text === 'string' ? text : '',
    people: [...new Set([...partner, ...speaker])],
    place: typeof issued.destination === 'string' ? issued.destination : null,
    entities: [],
  };
}

/**
 * A page's facts as excerpts. A name alone says nothing a turn can use, and a plain claim's home is her profile blocks, so a
 * memory with no structured fact adds nothing to a request.
 */
export function factExcerpts(page: MemoryPage | null): Array<{
  source: 'semantic';
  versionId: string;
  state: string;
  polarity: string;
  lines: string;
  text: string;
}> {
  return (page?.assertions ?? [])
    .filter((fact) => fact.assertionKind !== 'label' && fact.assertionKind !== 'text')
    .map((fact) => ({
      source: 'semantic',
      versionId: fact.versionId,
      state: fact.state,
      polarity: fact.polarity,
      lines: fact.text,
      text: fact.text,
    }));
}

/** The stored facts of a persona's search: her question and her filters, under the turn's context. */
export function searchFacts(given: {
  db: unknown;
  ctx: unknown;
  text: unknown;
  retrieval: unknown;
  config: unknown;
  prefetch: unknown;
  now: () => number;
  vector: unknown;
  model: unknown;
}): Promise<MemoryPage | null> {
  const filters = (given.retrieval ?? {}) as {
    entity?: unknown;
    predicate?: unknown;
    asOf?: unknown;
    historical?: unknown;
  };
  const { vector } = given;
  return memoryPage({
    db: given.db,
    ctx: given.ctx,
    input: {
      purpose: 'search',
      text: typeof given.text === 'string' ? given.text : '',
      anchors: typeof filters.entity === 'string' && filters.entity ? [{ kind: 'entity', id: filters.entity }] : [],
      predicates: typeof filters.predicate === 'string' && filters.predicate ? [filters.predicate] : [],
      recordedBefore: typeof filters.asOf === 'string' ? filters.asOf : null,
      historical: filters.historical === true,
    },
    config: given.config,
    prefetch: given.prefetch,
    now: given.now,
    embedQuery: vector ? () => Promise.resolve(vector as ArrayLike<number>) : null,
    model: given.model,
  });
}

/** The stored facts of a prefetch, or a wake's own `retrieval` instead of the turn's query. */
export function prefetchFacts(given: {
  db: unknown;
  ctx: unknown;
  retrieval: RetrievalInput | null;
  text: unknown;
  speaker: ReadonlyArray<string>;
  config: unknown;
  prefetch: unknown;
  now: () => number;
  laneVectors: unknown;
  model: unknown;
}): Promise<MemoryPage | null> {
  const vectors = given.laneVectors as Promise<ReadonlyArray<ArrayLike<number>> | null> | null;
  return memoryPage({
    db: given.db,
    ctx: given.ctx,
    input: given.retrieval ?? prefetchInput(given.ctx, given.text, given.speaker),
    config: given.config,
    prefetch: given.prefetch,
    now: given.now,
    embedQuery: vectors ? () => vectors.then((all) => all?.[0] ?? null) : null,
    model: given.model,
    plainClaims: false,
  });
}
