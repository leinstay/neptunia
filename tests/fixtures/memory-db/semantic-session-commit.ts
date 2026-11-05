// Writes a semantic candidate the way her memory session does: through the session's two operations
// (`writeSessionEntity` and `writeSessionAssertion` of src/memory/db/semantic-write.ts, the pair `applySemantic` of
// src/memory/db/session-write.ts calls) inside one writer transaction. The assertion op carries the candidate whole, so
// a successor (`claimId` with `baseVersionId`) and conflicting evidence travel the same road as a new fact. A refusal of
// the writer throws with its code, so a seed that fails stops the test at its cause.
import { writeSessionAssertion, writeSessionEntity } from '../../../src/memory/db/semantic-write.ts';
import type { SessionSemantics } from '../../../src/memory/db/semantic-write.ts';
import type { Context } from '../../../src/memory/db/scope.ts';
import type {
  SemanticCandidate,
  SemanticEntityCandidate,
  SemanticReadSet,
  SemanticWriteResult,
} from '../../../src/memory/db/semantic-types.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { World } from './semantic-world.ts';

/** Every stored source and claim version: the read set of a writer that was shown all of them. */
export function everythingRead(world: World): SemanticReadSet {
  return {
    sourceIds: world.db
      .prepare('SELECT id FROM sources')
      .all()
      .map((row) => String(row.id)),
    versionIds: world.db
      .prepare('SELECT id FROM claim_versions')
      .all()
      .map((row) => String(row.id)),
  };
}

/** Commits `candidate` in `ctx` through the session operations; a refusal throws with its code. */
export function commitViaSession(
  world: World,
  candidate: SemanticCandidate | SemanticEntityCandidate,
  ctx: Context = world.contexts.group,
  read: SemanticReadSet = everythingRead(world)
): SemanticWriteResult {
  const session: SessionSemantics = {
    ctx,
    read,
    handles: new Map(),
    at: new Date(world.now()).toISOString(),
    uuid: world.uuid,
  };
  const sources = candidate.evidence.map((one) => one.sourceId);
  const outcome = world.handle.transaction(() =>
    'kind' in candidate
      ? writeSessionEntity(
          dbOf(world.handle),
          { handle: 'h1', kind: candidate.kind, name: candidate.name.text, language: candidate.name.language, sources },
          session
        )
      : writeSessionAssertion(dbOf(world.handle), { ...candidate, sources }, session)
  );
  if (!outcome.ok) throw new Error(`the session path refused the write: ${outcome.code}`);
  return outcome.result;
}
