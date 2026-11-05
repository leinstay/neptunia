// The pure pieces the elsewhere pick (src/behavior/elsewhere-pick.ts) reads a turn through: which line it judges, the
// transcript and the candidate around it, and the member who writes most of a stored place.

import { block, classifierTranscript } from './prompt.ts';
import { oneLine } from '../memory/clamp.ts';
import { topByRank } from '../memory/ranking.ts';
import { MAX_MESSAGE_CHARS } from '../format.ts';
import type { Untyped } from '../tools/types.ts';
import type { Line } from './lines.ts';

/** A channel of the server's stored map, as the route classifier lists it. */
export type StoredChannel = {
  id: string;
  name?: string;
  lastMessageAt?: unknown;
  messageCount?: unknown;
  purpose?: unknown;
  topWriters?: Array<{ id?: string; count?: number }>;
};

/** A stored member profile, as far as the route classifier names a channel's main writer. */
export type StoredProfile = { names?: Array<string>; aliases?: Array<Untyped> };

/** How many aliases a channel's writer shows in its list line, best ranked first. */
const WRITER_ALIASES = 2;

/**
 * The channel's main writer: its first `topWriters` entry when that writer
 * wrote at least half of `messageCount`, named by their stored profile
 * (`names[0]`) with their top WRITER_ALIASES aliases by rank
 * (src/memory/ranking.js#topByRank, decayed with `aliasHalfLifeDays`). Null
 * when there is none, or no stored name to show.
 * @param channel  A stored channel entry.
 */
export function routeWriter(
  channel: StoredChannel,
  profileOf: ((accountId: string) => StoredProfile | null) | undefined,
  aliasHalfLifeDays?: number
): { name: string; aliases: Array<string> } | null {
  const top = Array.isArray(channel?.topWriters) ? channel.topWriters[0] : null;
  const count = Number(top?.count);
  const total = Number(channel?.messageCount);
  if (!top?.id || !Number.isFinite(count) || count < 1 || !Number.isFinite(total) || count < total / 2) return null;
  const profile = typeof profileOf === 'function' ? profileOf(String(top.id)) : null;
  const name = oneLine(Array.isArray(profile?.names) ? profile.names[0] : '');
  if (!name) return null;
  const aliases = topByRank(Array.isArray(profile?.aliases) ? profile.aliases : [], WRITER_ALIASES, aliasHalfLifeDays)
    .map((alias: Untyped) => oneLine(alias?.name))
    .filter(Boolean);
  return { name, aliases };
}

/**
 * The turn's message the classifier judges: the trigger, or on a turn
 * without one the newest message of `history` that is neither the persona's
 * own nor another bot's. Null when there is none.
 * @param history  Normalized messages, oldest first.
 */
export function routeCandidate(history: Array<Line>, trigger: Line | null): Line | null {
  if (trigger) return trigger;
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message && !message.self && !message.bot) return message;
  }
  return null;
}

/**
 * The `<transcript>` and `<candidate>` blocks: the last `contextMessages`
 * messages of `history` before the candidate (all of it but the candidate
 * when the candidate is not in it), rendered like the other classifiers'
 * context (src/behavior/prompt.ts#classifierTranscript, labels from `labels`,
 * no caption: the request runs beside the turn's media preparation), and the candidate's
 * author and text cut to `MAX_MESSAGE_CHARS`. `transcriptBlock` is ''
 * for a window of 0 or no earlier message.
 */
export function routeContext({
  history,
  candidate,
  contextMessages,
  config,
  labels,
  selfName,
}: {
  history: Array<Line>;
  candidate: Line;
  contextMessages: number;
  config: Untyped;
  labels: Untyped;
  selfName: string;
}): { transcriptBlock: string; candidateBlock: string } {
  const list = Array.isArray(history) ? history : [];
  const at = list.findIndex((m) => m?.id === candidate.id);
  const before = (at === -1 ? list.filter((m) => m && m.id !== candidate.id) : list.slice(0, at)).filter(Boolean);
  const context = contextMessages > 0 ? before.slice(-contextMessages) : [];
  const maxChars = MAX_MESSAGE_CHARS;
  const text = [...String(candidate.content ?? '')].slice(0, maxChars).join('');
  const candidateBlock = block('candidate', `${candidate.authorName}: ${text}`);
  if (context.length === 0) return { transcriptBlock: '', candidateBlock };
  return {
    transcriptBlock: block('transcript', classifierTranscript(context, { config, selfName, labels })),
    candidateBlock,
  };
}
