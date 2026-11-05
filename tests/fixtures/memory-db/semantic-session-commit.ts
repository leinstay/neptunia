// Writes a semantic candidate the way her memory session does: through the session's two operations
// (`writeSessionEntity` and `writeSessionAssertion` of src/memory/db/semantic-write.ts, the pair `applySemantic` of
// src/memory/db/session-write.ts calls) inside one writer transaction. It is the fixture that stands where tests called
// `applySemanticWrite`. The session path only creates: a candidate that names a claim to continue has no session
// operation, so the fixture refuses it instead of taking another road to the tables.
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
import { everythingRead } from './semantic-world.ts';

/** Commits `candidate` in `ctx` through the session operations; a refusal throws with its code. */
export function commitViaSession(
  world: World,
  candidate: SemanticCandidate | SemanticEntityCandidate,
  ctx: Context = world.contexts.group,
  read: SemanticReadSet = everythingRead(world)
): SemanticWriteResult {
  if ('claimId' in candidate && candidate.claimId !== null)
    throw new Error('the session path creates claims, it does not continue one');
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
