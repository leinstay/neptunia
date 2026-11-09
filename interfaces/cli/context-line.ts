// One line of what a request holds, from numbers the core supplies. A missing field reads as unknown and never as zero, and a
// share is shown only when both of its numbers exist. Nothing is estimated here. bin/chat-panels.ts draws it for `/context`.

export type ContextFacts = {
  usedTokens: number | null;
  limitTokens: number | null;
  route: string | null;
  model: string | null;
};

function usage({ usedTokens, limitTokens }: ContextFacts): string {
  if (usedTokens === null) return limitTokens === null ? 'context unknown' : `context unknown of ${limitTokens} tokens`;
  if (limitTokens === null || limitTokens <= 0) return `context ${usedTokens} tokens, limit unknown`;
  return `context ${usedTokens} of ${limitTokens} tokens (${Math.round((usedTokens / limitTokens) * 100)}%)`;
}

export function contextLine(facts: ContextFacts): string {
  return `${usage(facts)} · route ${facts.route ?? 'unknown'} · model ${facts.model ?? 'unknown'}`;
}
