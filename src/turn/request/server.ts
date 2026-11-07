// What memory learned of a place, as a request quotes it: the stored place notes (`PlaceMemory`, read by `<self>` and
// the selfreflection's notes) and the settings and text of what people taught the persona (`learnedText`).

import { fill } from '../../format.ts';
import { isConfirmed } from '../../memory/index.ts';
import { ID_DIGITS } from '../../memory/mentions.ts';
import { topByRank } from '../../memory/ranking.ts';
import { resolveChatText } from './text.ts';
import type { Claim, LabelGroup, NameOf, RequestConfig } from './types.ts';
import { MEMORY_LIMITS } from '../../memory/text-limits.ts';

/** What the place's memory holds about the server (store.getPlace), as `<about_chat>` and `<self_facts>` read it. */
export type PlaceMemory = {
  readonly patterns?: string;
  readonly starters?: string;
  readonly injokes?: Array<string>;
  readonly learned?: unknown;
  readonly self?: Array<string>;
  readonly emojiUsage?: unknown;
};

/** `learnedText`'s settings from the live config. */
export type LearnedConfig = { max: number; halfLifeDays: number; confirmAfter: number | undefined };

/** One thing people taught the persona (`place.learned`). */
type LearnedItem = Claim & { readonly text?: string; readonly from?: unknown };

/** A stored `from`: a `<@id>`/`<@!id>` token or a bare id, in the shared id range. */
const TEACHER_ID_RE = new RegExp(`^(?:<@!?(${ID_DIGITS})>|(${ID_DIGITS}))$`);

/** The member id inside a stored `from` (`<@id>`/`<@!id>`, or a bare id), or null. */
function teacherId(from: unknown): string | null {
  if (typeof from !== 'string') return null;
  const match = TEACHER_ID_RE.exec(from.trim());
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/** The `learnedCfg` of `learnedText`: the memory limits' `maxLearned`, `learnedHalfLifeDays` and `confirmAfter`. */
export const learnedConfig: (config?: Pick<RequestConfig, 'memory'>) => LearnedConfig = () => ({
  max: MEMORY_LIMITS.maxLearned,
  halfLifeDays: MEMORY_LIMITS.learnedHalfLifeDays,
  confirmAfter: MEMORY_LIMITS.confirmAfter,
});

/**
 * The `labels.aboutChat.learned` line's `{text}`: the top `learnedCfg.max`
 * stored place items (`{ id, text, from?, weight, firstSeen, lastSeen }`, the
 * same atomic items as a member's details) by RANK (decayed with
 * `learnedCfg.halfLifeDays`), in rank order, joined with `'; '`. Each item is
 * `aboutChat.learnedItem` (`{text}`/`{who}`) when its `from` resolves through
 * `nameOf` to a name, else `aboutChat.learnedItemNoFrom` (`{text}`); a missing
 * item label falls back to the next simpler form, then to the bare text. An
 * item below `learnedCfg.confirmAfter` gets `aboutChat.unsureMark` appended
 * when that label exists. `''` when there is nothing to show.
 * `learned` is `place.learned`, `a` is `labels.aboutChat`, `learnedCfg` see `learnedConfig`.
 */
export function learnedText(
  learned: unknown,
  a: LabelGroup,
  learnedCfg: Partial<LearnedConfig>,
  nameOf?: NameOf | null
): string {
  if (!Array.isArray(learned) || learned.length === 0) return '';
  // topByRank keeps the stored items it is given, which it returns as plain objects.
  const top = topByRank(learned as Array<LearnedItem>, learnedCfg.max, learnedCfg.halfLifeDays) as Array<LearnedItem>;
  return top
    .map((item) => {
      const text = resolveChatText(item?.text, nameOf) ?? '';
      const id = teacherId(item?.from);
      const who = id && typeof nameOf === 'function' ? nameOf(id) : null;
      const noFrom = a.learnedItemNoFrom ? fill(a.learnedItemNoFrom, { text }) : text;
      const line = who && a.learnedItem ? fill(a.learnedItem, { text, who }) : noFrom;
      return !isConfirmed(item, learnedCfg.confirmAfter) && a.unsureMark ? line + a.unsureMark : line;
    })
    .join('; ');
}
