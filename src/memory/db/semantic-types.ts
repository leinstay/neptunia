// The shapes of semantic memory: a typed reference, an argument of an assertion, what the writer is asked to store and
// what the one retrieval service answers. Types only; semantic-registry.ts checks them, semantic-write.ts stores them.

/** The typed homes a semantic argument may name. */
export type SemanticRefKind =
  | 'entity'
  | 'person'
  | 'place'
  | 'account'
  | 'participant'
  | 'source'
  | 'claim'
  | 'claim_version'
  | 'episode'
  | 'media';
export type SemanticRef = { kind: SemanticRefKind; id: string };
export type SemanticLiteral =
  | null
  | boolean
  | number
  | string
  | { kind: 'date'; value: string }
  | { kind: 'interval'; from: string | null; to: string | null };
export type SemanticArgument =
  { role: string; position: number; ref: SemanticRef } | { role: string; position: number; literal: SemanticLiteral };
export type SemanticEvidence = { sourceId: string; role: 'supports' | 'conflicts' };
export type SemanticDependency = { versionId: string; role: 'supports' | 'conflicts' | 'identity' };
export type SemanticState = 'current' | 'historical' | 'disputed' | 'retired';
export type SemanticPolarity = 'positive' | 'negative';

export type SemanticEntityCandidate = {
  kind: string;
  kindVersion: number;
  name: { text: string; language: string };
  evidence: Array<SemanticEvidence>;
  dependencies: Array<SemanticDependency>;
};
export type SemanticCandidate = {
  claimId: string | null;
  baseVersionId: string | null;
  assertionKind: 'label' | 'property' | 'relation' | 'nary';
  predicate: { id: string; version: number };
  text: string;
  arguments: Array<SemanticArgument>;
  evidence: Array<SemanticEvidence>;
  dependencies: Array<SemanticDependency>;
  polarity: SemanticPolarity;
  state: SemanticState;
  how: string;
  validFrom: string | null;
  validTo: string | null;
};

/** What the run was shown: the only sources and versions a candidate may cite. */
export type SemanticReadSet = { sourceIds: ReadonlyArray<string>; versionIds: ReadonlyArray<string> };

/** The audience a candidate resolved to, with the three scope columns that are its projection. */
type ResolvedAudience = {
  audienceId: string;
  scope: { scope_kind: string | null; scope_iface: string | null; scope_dm: string | null };
};
/** A validated entity, plain data so it crosses the writer's message. */
export type ResolvedEntity = ResolvedAudience & {
  kind: 'entity';
  entityKind: string;
  kindVersion: number;
  name: { text: string; language: string };
  evidence: Array<SemanticEvidence>;
  dependencies: Array<SemanticDependency>;
};
/** A validated assertion: `derivedFrom` names the claim a narrower audience forks from, and `claimId` is then null. */
export type ResolvedAssertion = ResolvedAudience &
  Omit<SemanticCandidate, 'assertionKind'> & {
    kind: 'assertion';
    assertionKind: SemanticCandidate['assertionKind'];
    derivedFrom: string | null;
  };
export type ResolvedSemanticWrite = ResolvedEntity | ResolvedAssertion;

export type SemanticRejection = { ok: false; code: string };
export type SemanticWriteResult =
  | { kind: 'entity'; entityId: string; claimId: string; versionId: string }
  | { kind: 'assertion'; claimId: string; versionId: string };

/** One assertion of a retrieved page. `text` is the candidate of a plain version, whose polarity stays `unknown`. */
export type RetrievedAssertion = {
  claimId: string;
  versionId: string;
  assertionKind: SemanticCandidate['assertionKind'] | 'text';
  text: string;
  polarity: SemanticPolarity | 'unknown';
  state: SemanticState | 'unknown';
  arguments: Array<SemanticArgument>;
  evidence: Array<SemanticEvidence>;
  dependencies: Array<SemanticDependency>;
  needsReview: boolean;
};
export type RetrievalBounds = {
  seeds: number;
  hops: number;
  nodes: number;
  edges: number;
  assertions: number;
  evidence: number;
  tokens: number;
  deadlineMs: number;
};
export type MemoryQuery = {
  text: string;
  anchors: Array<SemanticRef>;
  predicates: Array<string>;
  validAt: string | null;
  recordedBefore: string | null;
  includeHistorical: boolean;
  purpose:
    | 'turn'
    | 'search'
    | 'prefetch'
    | 'heartbeat'
    | 'attention'
    | 'reflection'
    | 'improvement'
    | 'session'
    | 'task'
    | 'watcher';
  bounds: RetrievalBounds;
  cursor: string | null;
};
export type MemoryPage = {
  assertions: Array<RetrievedAssertion>;
  sourceIds: Array<string>;
  paths: Array<{ from: SemanticRef; to: SemanticRef; versionIds: Array<string> }>;
  next: string | null;
  partialReason: 'deadline' | 'seeds' | 'nodes' | 'edges' | 'assertions' | 'evidence' | 'tokens' | 'depth' | null;
  /** The names that fit several entities, with every one of them and none chosen. */
  ambiguous: Array<{ text: string; candidates: Array<SemanticRef> }>;
  /** Why each assertion is on the page, as separate signals and never one blended score. */
  signals: Array<{ versionId: string; hops: number | null; anchored: boolean; similarity: number | null }>;
};
