// The `<people_now>` rows of the live snapshot src/behavior/around-store.ts keeps: for each person a
// request is about, the voice channel they sit in (muted, deafened, streaming,
// camera on) and what they are doing; and who else sits in a voice channel.
// src/behavior/prompt.ts puts them in the `<people_now>` rows, one per person.
//
// Member-supplied text (names, activity names, details, channel names) is untrusted data: one
// line, clamped, angle brackets removed so it cannot close or open a prompt block.
//
// Pure: no platform SDK import, no clock; src/behavior/prompt.ts builds the rows: a heading line
// per person, then one labelled field per line, negatives written out ("no", "none") only where
// the live data can tell, "unavailable" / "stale" where it cannot. Every word the model reads
// comes from `labels.peopleNow`.

import { fill, formatDuration } from '../format.ts';
import { oneLine } from '../memory/clamp.ts';
import { isFiniteNumber } from '../tools/types.ts';
import type { PresenceRecord, VoiceRecord } from './around-store.ts';

type ActivityRecord = PresenceRecord['activities'][number];
type Units = Parameters<typeof formatDuration>[1];

/** The labels of `<people_now>` (`labels.peopleNow`), each text the module fills or reads. */
export type PeopleNow = {
  field?: string;
  fields?: Record<string, string>;
  joinedAgo?: string;
  voiceYes?: string;
  activity?: Record<string, string>;
  activityTrack?: string;
  activityDetails?: string;
  heading: string;
  headingMarked: string;
  unavailable?: string;
  stale?: string;
  marks?: Record<string, string>;
  values?: Record<string, string>;
};

/** The whole labels object, as far as `<people_now>` reads it. */
export type AroundLabels = { readonly peopleNow?: unknown; readonly units?: Units } | null | undefined;

/** `labels.peopleNow`, which the live prompts and the typed request share under different types. */
function peopleNowOf(labels: AroundLabels): PeopleNow | undefined {
  return labels?.peopleNow as PeopleNow | undefined;
}

export const STATUSES = new Set(['online', 'idle', 'dnd', 'offline']);
// An activity's `kind` (the protocol's word) is the key of `labels.peopleNow.activity`; an unknown kind uses `other`.
const LISTENING = 'listening';

/**
 * One line of member-supplied text, whole, without angle brackets.
 * @returns '' for anything that is not text.
 */
export function cleanText(text: unknown): string {
  if (typeof text !== 'string') return '';
  return oneLine(text.replace(/[<>]/g, ''));
}

/**
 * One field line of a `<people_now>` row: `labels.peopleNow.field` (`{field}` `{value}`) with
 * `{field}` = `labels.peopleNow.fields[key]`. '' when either label is missing or the value is
 * empty. The value is kept on one line.
 * @param labels  The whole labels object.
 * @param key     A key of `labels.peopleNow.fields`.
 */
export function fieldLine(labels: AroundLabels, key: string, value: string): string {
  const l = peopleNowOf(labels);
  const field = l?.fields?.[key];
  const text = oneLine(value);
  return l?.field && field && text ? fill(l.field, { field, value: text }) : '';
}

/**
 * `labels.peopleNow.joinedAgo` (`{ago}`) for a voice record seen joining (`joinedAt`), the age
 * through formatDuration and `labels.units`; '' without `joinedAt`, a clock, the labels.
 */
function joinedText(record: VoiceRecord | undefined, now: number | undefined, labels: AroundLabels) {
  const template = peopleNowOf(labels)?.joinedAgo;
  if (!template || !labels?.units || !isFiniteNumber(record?.joinedAt) || now === undefined || !Number.isFinite(now))
    return '';
  return fill(template, { ago: formatDuration(Math.max(0, now - record.joinedAt), labels.units) });
}

/** A yes/no word of `labels.peopleNow.values`. */
function yesNo(l: PeopleNow, flag: boolean | undefined) {
  return flag ? (l.values?.yes ?? '') : (l.values?.no ?? '');
}

/**
 * One activity as a phrase: `labels.peopleNow.activity[kind]` (else `other`; `{name}`), then a
 * listening activity of Spotify with a track (details) and an artist (state) as `activityTrack`
 * (`{activity}` `{track}` `{artist}`), any other with details or state as `activityDetails`
 * (`{activity}` `{details}`, the two joined by ` / `).
 */
function activityPhrase(activity: ActivityRecord, l: PeopleNow) {
  const forms = l.activity ?? {};
  const template = forms[activity.kind] ?? forms.other;
  if (!template) return '';
  const phrase = fill(template, { name: activity.name });
  const spotify = activity.kind === LISTENING && activity.name.toLowerCase() === 'spotify';
  if (spotify && activity.details && activity.state && l.activityTrack) {
    return fill(l.activityTrack, { activity: phrase, track: activity.details, artist: activity.state });
  }
  const details = [activity.details, activity.state].filter(Boolean).join(' / ').trim();
  return details && l.activityDetails ? fill(l.activityDetails, { activity: phrase, details }) : phrase;
}

/**
 * The live field lines of one member's `<people_now>` row (fieldLine), in this order. The platform's status
 * (online, idle, do not disturb, offline) is never shown: only the presence record's activities use it
 * (an offline member's are not kept, never a guess):
 * - `voice`: from the voice snapshot (the voice states do not depend on the presences intent):
 *   `labels.peopleNow.voiceYes` (`{channel}` `{joined}` `{muted}` `{deafened}` `{streaming}`
 *   `{camera}`, each flag a yes/no word; `{joined}` is `labels.peopleNow.joinedAgo` with `{ago}`
 *   through formatDuration and `labels.units` when the record has `joinedAt` and `now` is given,
 *   else empty: never a guess) when the member sits in a voice channel `channelNameOf` names
 *   (one the audience may see), else `values.no`; `values.stale` with a stale snapshot. An
 *   offline member in voice shows it.
 * - `activity`: every activity the platform shows (a game and Spotify at once, say), each through
 *   `activityPhrase`, joined by `; `, else `values.none` -- also for an offline member, whose
 *   activities are not kept. Unavailable with the presences intent off or a status the platform does not define, stale when stale: never `none` then.
 * Custom statuses are never kept. [] with no snapshot, no member id or no labels.
 * @param snapshot  createAroundStore().view().
 *   The whole labels object; `now` the request's clock (ms).
 */
export function liveFields(
  snapshot: {
    presences: boolean;
    stale: boolean;
    voice: Map<string, VoiceRecord>;
    presence: Map<string, PresenceRecord>;
  },
  accountId: string,
  {
    labels,
    channelNameOf,
    now,
  }: { labels?: AroundLabels; channelNameOf?: (placeId: string) => string | null; now?: number } = {}
): Array<string> {
  const l = peopleNowOf(labels);
  if (!l || !snapshot || typeof accountId !== 'string' || accountId === '') return [];
  const values = l.values ?? {};
  const stale = snapshot.stale === true;
  const record = snapshot.presence.get(accountId);
  const status = record ? record.status : 'offline';
  // What the activity side may say: the activities, or one word for why it says nothing.
  const unknown = stale ? 'stale' : snapshot.presences !== true || !STATUSES.has(status) ? 'unavailable' : null;
  const lines = [];

  const here = snapshot.voice.get(accountId);
  const seat = here as VoiceRecord;
  const channel = here && typeof channelNameOf === 'function' ? cleanText(channelNameOf(here.placeId) ?? '') : '';
  const voice = stale
    ? values.stale
    : channel && l.voiceYes
      ? fill(l.voiceYes, {
          channel,
          joined: joinedText(here, now, labels),
          // `channel` is set only when the member has a seat.
          muted: yesNo(l, seat.muted),
          deafened: yesNo(l, seat.deafened),
          streaming: yesNo(l, seat.streaming),
          camera: yesNo(l, seat.camera),
        })
      : values.no;
  lines.push(fieldLine(labels, 'voice', voice ?? ''));

  const doing =
    !unknown && status !== 'offline'
      ? (record?.activities ?? []).map((activity) => activityPhrase(activity, l)).filter((phrase) => phrase !== '')
      : [];
  lines.push(fieldLine(labels, 'activity', unknown ? (values[unknown] ?? '') : doing.join('; ') || values.none || ''));
  return lines.filter((line): line is string => Boolean(line));
}
