// The `<people_now>` rows of the live snapshot src/behavior/around-store.ts keeps: for each person a
// request is about, the voice channel they sit in (muted, deafened, streaming,
// camera on) and what they are doing; and who else sits in a voice channel.
// src/behavior/prompt.js puts them in the `<people_now>` rows, one per person.
//
// Member-supplied text (names, activity names, details, channel names) is untrusted data: one
// line, clamped, angle brackets removed so it cannot close or open a prompt block.
//
// Pure: no discord.js import, no clock; src/behavior/prompt.js builds the rows: a heading line
// per person, then one labelled field per line, negatives written out ("no", "none") only where
// the live data can tell, "unavailable" / "stale" where it cannot. Every word the model reads
// comes from `labels.peopleNow`.

import { fill, formatDuration } from '../format.js';
import { clampChars, oneLine } from '../memory/clamp.js';

/** Longest member-supplied text kept, in code points. */
export const AROUND_TEXT_CHARS = 80;
/** Longest activity details (a game's rich presence) shown in a row, in code points. */
export const NOW_DETAIL_CHARS = 40;

export const STATUSES = new Set(['online', 'idle', 'dnd', 'offline']);
// An activity's `kind` (the protocol's word) is the key of `labels.peopleNow.activity`; an unknown kind uses `other`.
const LISTENING = 'listening';

/**
 * One line of member-supplied text, at most AROUND_TEXT_CHARS code points, without angle brackets.
 * @param {unknown} text
 * @returns {string}  '' for anything that is not text.
 */
export function cleanText(text) {
  if (typeof text !== 'string') return '';
  return clampChars(oneLine(text.replace(/[<>]/g, '')), AROUND_TEXT_CHARS).trim();
}

/** Names compare by plain code unit order: stable whatever the locale. */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One field line of a `<people_now>` row: `labels.peopleNow.field` (`{field}` `{value}`) with
 * `{field}` = `labels.peopleNow.fields[key]`. '' when either label is missing or the value is
 * empty. The value is kept on one line.
 * @param {object} labels  The whole labels object.
 * @param {string} key     A key of `labels.peopleNow.fields`.
 * @param {string} value
 * @returns {string}
 */
export function fieldLine(labels, key, value) {
  const l = labels?.peopleNow;
  const field = l?.fields?.[key];
  const text = oneLine(value);
  return l?.field && field && text ? fill(l.field, { field, value: text }) : '';
}

/**
 * `labels.peopleNow.joinedAgo` (`{ago}`) for a voice record seen joining (`joinedAt`), the age
 * through formatDuration and `labels.units`; '' without `joinedAt`, a clock, the labels.
 */
function joinedText(record, now, labels) {
  const template = labels?.peopleNow?.joinedAgo;
  if (!template || !labels?.units || !Number.isFinite(record?.joinedAt) || !Number.isFinite(now)) return '';
  return fill(template, { ago: formatDuration(Math.max(0, now - record.joinedAt), labels.units) });
}

/** A yes/no word of `labels.peopleNow.values`. */
function yesNo(l, flag) {
  return flag ? (l.values?.yes ?? '') : (l.values?.no ?? '');
}

/**
 * One activity as a phrase: `labels.peopleNow.activity[kind]` (else `other`; `{name}`), then a
 * listening activity of Spotify with a track (details) and an artist (state) as `activityTrack`
 * (`{activity}` `{track}` `{artist}`), any other with details or state as `activityDetails`
 * (`{activity}` `{details}`, the two joined by ` / `, clamped to NOW_DETAIL_CHARS).
 */
function activityPhrase(activity, l) {
  const forms = l.activity ?? {};
  const template = forms[activity.kind] ?? forms.other;
  if (!template) return '';
  const phrase = fill(template, { name: activity.name });
  const spotify = activity.kind === LISTENING && activity.name.toLowerCase() === 'spotify';
  if (spotify && activity.details && activity.state && l.activityTrack) {
    return fill(l.activityTrack, { activity: phrase, track: activity.details, artist: activity.state });
  }
  const details = clampChars([activity.details, activity.state].filter(Boolean).join(' / '), NOW_DETAIL_CHARS).trim();
  return details && l.activityDetails ? fill(l.activityDetails, { activity: phrase, details }) : phrase;
}

/**
 * The live field lines of one member's `<people_now>` row (fieldLine), in this order. The Discord status
 * (online, idle, do not disturb, offline) is never shown: only the presence record's activities use it
 * (an offline member's are not kept, never a guess):
 * - `voice`: from the voice snapshot (the voice states do not depend on the presences intent):
 *   `labels.peopleNow.voiceYes` (`{channel}` `{joined}` `{muted}` `{deafened}` `{streaming}`
 *   `{camera}`, each flag a yes/no word; `{joined}` is `labels.peopleNow.joinedAgo` with `{ago}`
 *   through formatDuration and `labels.units` when the record has `joinedAt` and `now` is given,
 *   else empty: never a guess) when the member sits in a voice channel `channelNameOf` names
 *   (one the audience may see), else `values.no`; `values.stale` with a stale snapshot. An
 *   offline member in voice shows it.
 * - `activity`: every activity Discord shows (a game and Spotify at once, say), each through
 *   `activityPhrase`, joined by `; `, else `values.none` -- also for an offline member, whose
 *   activities are not kept. Unavailable with the presences intent off or a status Discord does not define, stale when stale: never `none` then.
 * Custom statuses are never kept. [] with no snapshot, no member id or no labels.
 * @param {{ presences: boolean, stale: boolean, voice: Map<string, object>, presence: Map<string, object> }} snapshot  createAroundStore().view().
 * @param {string} memberId
 * @param {{ labels: object, channelNameOf?: (channelId: string) => string|null, now?: number }} options
 *   The whole labels object; `now` the request's clock (ms).
 * @returns {string[]}
 */
export function liveFields(snapshot, memberId, { labels, channelNameOf, now } = {}) {
  const l = labels?.peopleNow;
  if (!l || !snapshot || typeof memberId !== 'string' || memberId === '') return [];
  const values = l.values ?? {};
  const stale = snapshot.stale === true;
  const record = snapshot.presence.get(memberId);
  const status = record ? record.status : 'offline';
  // What the activity side may say: the activities, or one word for why it says nothing.
  const unknown = stale ? 'stale' : snapshot.presences !== true || !STATUSES.has(status) ? 'unavailable' : null;
  const lines = [];

  const here = snapshot.voice.get(memberId);
  const channel = here && typeof channelNameOf === 'function' ? cleanText(channelNameOf(here.channelId) ?? '') : '';
  const voice = stale
    ? values.stale
    : channel && l.voiceYes
      ? fill(l.voiceYes, {
          channel,
          joined: joinedText(here, now, labels),
          muted: yesNo(l, here.muted),
          deafened: yesNo(l, here.deafened),
          streaming: yesNo(l, here.streaming),
          camera: yesNo(l, here.camera),
        })
      : values.no;
  lines.push(fieldLine(labels, 'voice', voice ?? ''));

  const doing =
    !unknown && status !== 'offline'
      ? (record?.activities ?? []).map((activity) => activityPhrase(activity, l)).filter(Boolean)
      : [];
  lines.push(fieldLine(labels, 'activity', unknown ? (values[unknown] ?? '') : doing.join('; ') || values.none || ''));
  return lines.filter(Boolean);
}

/**
 * The block-level notices of `<people_now>`, in this order: `labels.peopleNow.stale` when the
 * gateway dropped since the last update (what is held may be out of date), then
 * `labels.peopleNow.unavailable` when the presences intent is off (no activity
 * can be known). [] for a fresh snapshot with the intent on, no snapshot or no labels. The
 * caller shows them only when the block has rows anyway.
 * @param {{ presences: boolean, stale: boolean }|null} snapshot
 * @param {object} labels  The whole labels object.
 * @returns {string[]}
 */
export function liveNotices(snapshot, labels) {
  const l = labels?.peopleNow;
  if (!l || !snapshot) return [];
  return [snapshot.stale === true ? l.stale : '', snapshot.presences !== true ? l.unavailable : ''].filter(Boolean);
}

/**
 * The members sitting in a voice channel the audience may see (`channelNameOf` names it), but
 * those in `excludeIds`, each with a name (`nameOf`, else the name the snapshot holds; one
 * without either is left out), by name then id.
 * @param {{ voice: Map<string, object> }} snapshot
 * @param {{ excludeIds?: Set<string>, nameOf?: (memberId: string) => string|null, channelNameOf?: (channelId: string) => string|null }} [options]
 * @returns {{ memberId: string, name: string }[]}
 */
export function voiceOccupants(snapshot, { excludeIds = new Set(), nameOf, channelNameOf } = {}) {
  if (!snapshot?.voice || typeof channelNameOf !== 'function') return [];
  const out = [];
  for (const entry of snapshot.voice.values()) {
    if (excludeIds.has(entry.memberId)) continue;
    if (!cleanText(channelNameOf(entry.channelId) ?? '')) continue;
    const name = cleanText((typeof nameOf === 'function' ? nameOf(entry.memberId) : null) ?? entry.name ?? '');
    if (name) out.push({ memberId: entry.memberId, name });
  }
  return out.sort((a, b) => byText(a.name, b.name) || byText(a.memberId, b.memberId));
}

/**
 * One person's `<people_now>` entry: a heading line, then one field line each (fieldLine). The
 * heading is `labels.peopleNow.heading` (`{who}`), or `labels.peopleNow.headingMarked` (`{who}`
 * `{mark}`) with a mark (a tag about the person in this request, from `labels.peopleNow.marks`).
 * `{who}` is `@handle` (the member's mention handle, src/behavior/handles.js, the join key with
 * `<people>` and `<directory>`) and the name (member text: cleaned like any). '' with nothing to
 * say (no field, no mark), no name and no handle, or the labels missing.
 * @param {{ handle?: string|null, name?: string, mark?: string, fields?: string[] }} row
 * @param {object} labels  The whole labels object.
 * @returns {string}
 */
export function personRow({ handle = null, name = '', mark = '', fields = [] }, labels) {
  const l = labels?.peopleNow;
  const who = [handle ? `@${handle}` : '', cleanText(name)].filter(Boolean).join(' ');
  const lines = fields.filter(Boolean);
  if (!l || !who || (lines.length === 0 && !mark)) return '';
  const heading = mark ? fill(l.headingMarked, { who, mark }) : fill(l.heading, { who });
  if (!heading) return '';
  return [oneLine(heading), ...lines].join('\n');
}
