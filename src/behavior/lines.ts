// The lines of a conversation as a turn reads them: the interface's `history` events turned into lines (`lineOf`), and
// for the persona's own lines the members who reacted to them. The reactor store (src/behavior/reactor-store.ts) is
// fed by `reaction.changed`; what it lacks for a reaction on her line is read once through `reactors`, within a time
// budget, and the reactors are named from the member directory, else through `memberInfo` (once per member).

import type { ConversationRef } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import type { Logger } from '../protocol/serve.ts';
import { lineOf } from './line-of.js';
import { backfillPlan, runBackfill, withReactors } from './reactor-store.ts';
import type { ReactorName } from './reactor-store.ts';
import type { ReactorStore } from './reactor-store.ts';

/** A line as the transcript reads it: the fields this module needs, the rest passes through. */
export type Line = Record<string, unknown> & {
  id: string;
  self: boolean;
  ts: number;
  reactions: Array<{ emoji: string; count: number; mine: boolean; users?: Array<ReactorName> }>;
};

/** How a turn names the reactors of her lines: the store, the time budget, how many to read and who is who. */
export type ReactorNames = {
  store: ReactorStore;
  budgetMs: number;
  fetchUsers: number;
  /** The name and the kind of a member the core already knows. */
  known(memberId: string): { name: string; bot: boolean } | null;
  /** Names read through `memberInfo`, kept by the caller for the attempt. */
  cache: Map<string, { name: string; bot: boolean } | null>;
  selfId: string;
  communityId: string | null;
  log: Logger;
};

/** The lines of up to `limit` newest messages of `ref`, oldest first; throws when the interface cannot read them. */
export async function historyLines(
  reads: Reads,
  ref: ConversationRef,
  { limit, before, names = null }: { limit: number; before?: string; names?: ReactorNames | null }
): Promise<Array<Line>> {
  const page = await reads.history(ref, before === undefined ? { limit } : { limit, before });
  if (page === null) throw new Error('history unavailable');
  const lines = page.events.map((event) => lineOf(event) as Line);
  return names === null ? lines : await withReactorNames(reads, ref, lines, names);
}

/** The lines with the reactors of her lines read, once each, and named. */
async function withReactorNames(
  reads: Reads,
  ref: ConversationRef,
  lines: Array<Line>,
  names: ReactorNames
): Promise<Array<Line>> {
  const { store } = names;
  const plan = backfillPlan(lines, store);
  if (plan.length > 0) {
    const stats = await runBackfill(
      plan,
      store,
      async (item) =>
        (await reads.reactors({ ...ref, messageId: item.messageId }, item.emoji, names.fetchUsers))?.memberIds ?? null,
      { budgetMs: names.budgetMs, selfId: names.selfId }
    );
    names.log.info('reactors: backfill', { channel: ref.conversationId, ...stats });
  }
  await resolveMissing(reads, lines, names);
  return withReactors(lines, store, (id) => names.known(id) ?? names.cache.get(id) ?? null) as unknown as Array<Line>;
}

/** Reads, once, the members that react on her lines and that the directory does not know. */
async function resolveMissing(reads: Reads, lines: Array<Line>, names: ReactorNames): Promise<void> {
  const wanted = new Set<string>();
  for (const line of lines) {
    if (!line.self) continue;
    for (const reaction of line.reactions)
      for (const id of names.store.reactors(line.id, reaction.emoji) ?? [])
        if (names.known(id) === null && !names.cache.has(id)) wanted.add(id);
  }
  await Promise.all(
    [...wanted].map(async (memberId) => {
      const found = await reads.memberInfo({ communityId: names.communityId, memberId });
      const member = found?.member ?? null;
      names.cache.set(
        memberId,
        member !== null && member.name !== null && member.name !== '' ? { name: member.name, bot: member.bot } : null
      );
    })
  );
}
