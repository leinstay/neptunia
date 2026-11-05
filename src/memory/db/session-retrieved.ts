// What a memory session is shown of what it already stored: the read through the one retrieval service, under the scope's
// own context and as of the batch's newest line, and the `<retrieved>` lines with their handles. Only what the block renders
// becomes a handle and a read, so a claim shown here never licenses a line it does not show. session.ts is the caller.

import { entityLabels } from './semantic-read.ts';
import { retrieveMemory } from './retrieve.ts';
import { scopeWhere } from './scope.ts';
import type { Context } from './scope.ts';
import type { MemoryPage, RetrievedAssertion } from './semantic-types.ts';
import { asText } from './types.ts';
import type { Config, Db, Row } from './types.ts';
import { memoryQueryFor, retrievalBounds } from '../retrieval-input.ts';

/**
 * The page of one batch: structured facts and the lines they rest on. Null when there is nothing to read or the read failed,
 * and the session then runs as it always did.
 */
export async function readRetrieved(given: {
  db: Db;
  ctx: Context;
  config: Config;
  batch: ReadonlyArray<Row & { at: number }>;
  people: ReadonlyArray<string>;
  now: () => number;
  log?: { warn?(message: string, fields: Row): void };
}): Promise<MemoryPage | null> {
  const { db, ctx, config, batch, people, now, log } = given;
  if (!config?.memoryDb?.retrieval) return null;
  try {
    return await pageOf(db, ctx, config, batch, people, now);
  } catch (error) {
    log?.warn?.('memory session: retrieval failed', { code: (error as Row | null)?.code ?? null });
    return null;
  }
}

async function pageOf(
  db: Db,
  ctx: Context,
  config: Config,
  batch: ReadonlyArray<Row & { at: number }>,
  people: ReadonlyArray<string>,
  now: () => number
): Promise<MemoryPage | null> {
  const bounds = retrievalBounds(
    { memoryDb: config.memoryDb, recall: { prefetch: config.recall?.prefetch } },
    'session'
  );
  const query = memoryQueryFor(
    {
      purpose: 'session',
      batch: batch.map((line) => asText(line.text)),
      people,
      places: [...new Set(batch.map((line) => line.place_id).filter((id): id is string => typeof id === 'string'))],
      entities: [],
    },
    bounds
  );
  const recordedBefore = new Date(Math.max(...batch.map((line) => line.at))).toISOString();
  const page = await retrieveMemory(
    db,
    ctx,
    { ...query, recordedBefore },
    { now, embedQuery: null, model: null, sources: false, plainClaims: false }
  );
  return page.assertions.length > 0 ? page : null;
}

/** The most tokens a session request may estimate at, or null without a cap. */
export function requestCapOf(config: Config, share: number): number | null {
  const cap = Number(config?.llm?.maxRequestTokens);
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap * share) : null;
}

const standingOf = (fact: RetrievedAssertion): string =>
  fact.polarity === 'negative' ? `${fact.state}, not so` : fact.state;

/**
 * The lines of `<retrieved>`: `[xN]` entities and `[vN]` facts, then the older lines numbered on past `lineNumber`. Fills
 * the three maps and `read`; returns the lines and the last number used.
 */
export function retrievedLines(given: {
  db: Db;
  ctx: Context;
  retrieved: MemoryPage;
  cutoffIso: string;
  lineNumber: number;
  sources: Map<string, string>;
  versions: Map<string, string>;
  entities: Map<string, string>;
  read: (kind: string, id: unknown, block: string) => void;
  timeOf: (ms: number) => string;
}): { lines: Array<string>; lineNumber: number } {
  const { db, ctx, retrieved, sources, versions, entities, read } = given;
  const lines: Array<string> = [];
  const handleOfEntity = (id: string): string => {
    const known = [...entities].find(([, entity]) => entity === id)?.[0];
    if (known !== undefined) return known;
    const handle = `x${entities.size + 1}`;
    entities.set(handle, id);
    const name = entityLabels(db, ctx, id, { recordedBefore: given.cutoffIso })[0]?.text ?? '';
    lines.push(`[${handle}] ${name}`);
    return handle;
  };
  for (const fact of retrieved.assertions) {
    const handle = `v${versions.size + 1}`;
    versions.set(handle, fact.versionId);
    read('claim_version', fact.versionId, 'retrieved');
    const named = fact.arguments.flatMap((one) => ('ref' in one && one.ref.kind === 'entity' ? [one.ref.id] : []));
    const handles = named.map(handleOfEntity);
    const tail = handles.length > 0 ? ` {${handles.join(', ')}}` : '';
    lines.push(`[${handle}] (${standingOf(fact)}) ${fact.text}${tail}`);
  }
  const scoped = scopeWhere(ctx, 's');
  const stored = db.prepare(`SELECT s.id, s.text, s.occurred_at FROM sources s WHERE s.id = ? AND ${scoped.sql}`);
  const evidence = retrieved.assertions.flatMap((fact) => fact.evidence.map((one) => one.sourceId));
  const shown = new Set(sources.values());
  let { lineNumber } = given;
  for (const id of new Set([...retrieved.sourceIds, ...evidence])) {
    const row = shown.has(id) ? undefined : stored.get(id, ...scoped.params);
    if (!row || typeof row.text !== 'string' || row.text.trim() === '') continue;
    lineNumber += 1;
    sources.set(`#${lineNumber}`, id);
    read('source_id', id, 'retrieved');
    lines.push(`#${lineNumber} [${given.timeOf(Date.parse(String(row.occurred_at)))}] ${row.text}`);
  }
  return { lines, lineNumber };
}
