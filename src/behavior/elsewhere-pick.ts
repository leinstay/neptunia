// The elsewhere pick: one cheap classifier call per started turn that answers two fields, the other place whose view the
// turn should see and the stored episodes from other places the line refers to. The candidates are cut before the
// prompt, and a place whose audience the engine cannot prove is no candidate. The pure pieces are the candidates, the
// lines, the request and the parser; createElsewherePicker is the call, and createElsewhereHooks fits it to a turn, whose
// pull phase and request phase both want it and share the one answer. No wording of ours goes into the request: the
// prompt file says everything, the list lines carry structural fields only.

import { formatDuration } from '../format.ts';
import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { accountOf } from '../memory/addresses.ts';
import { clampText, oneLine } from '../memory/clamp.ts';
import { episodeHeadlines, participationSettings } from '../memory/index.ts';
import { MEMORY_LIMITS } from '../memory/text-limits.ts';
import { isFiniteNumber, listOf, objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';
import { block, fillPromptTemplate, stableThenTail } from './prompt.ts';
import { checkPull } from './pull-fetch.ts';
import { routeCandidate, routeContext, routeWriter } from './route.ts';
import type { StoredChannel, StoredProfile } from './route.ts';
import { audienceAllows } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import type { Line } from './lines.ts';

/** A place a turn may look at: an id, what the list shows of it, and when it was last active and last had her attention. */
export type ElsewherePlace = {
  id: string;
  name: string;
  iface: string;
  kind: string;
  lastActivityAt: number | null;
  lastAttentionAt: number | null;
  /** The member who writes most of it, with their aliases, already rendered. */
  writer?: string;
  purpose?: string;
};

/** A stored exchange in another place, as its list line shows it. */
export type ElsewhereEpisode = {
  id: string;
  placeId: string;
  ageMs: number;
  memberName: string | null;
  memberLines: string;
  selfLines: string;
  /** The name of its place, when that place is not among the listed ones. */
  placeName?: string | null;
};

/** What elsewhereCandidates cuts. */
type CandidatesInput = {
  places: Array<ElsewherePlace>;
  episodes: Array<ElsewhereEpisode>;
  currentPlaceId: string | null;
  audience: (placeId: string) => boolean;
  maxPlaces: number;
  maxEpisodes: number;
};

/** The most episodes one answer may take. */
const MAX_PICKED_EPISODES = 4;
/** The lines of the current place in the request, and how much of a place's purpose its line shows. */
const CONTEXT_MESSAGES = 20;
const PURPOSE_CHARS = 80;

const DEFAULTS = Object.freeze({ maxPlaces: 40, maxEpisodes: 30, maxOutputTokens: 120, pickTimeoutMs: 3000 });

/** An integer from a finite `value` of at least `min` (floored), else `fallback`. */
function intAtLeast(value: unknown, fallback: number, min: number): number {
  return isFiniteNumber(value) && value >= min ? Math.floor(value) : fallback;
}

/** The `elsewhere` settings of the live config. `pickTimeoutMs` null waits as long as the turn does. */
export function elsewherePickSettings(config: Record<string, Untyped>): {
  maxPlaces: number;
  maxEpisodes: number;
  maxOutputTokens: number;
  pickTimeoutMs: number | null;
} {
  const group = objOf(config?.elsewhere);
  return {
    maxPlaces: intAtLeast(group.maxPlaces, DEFAULTS.maxPlaces, 0),
    maxEpisodes: intAtLeast(group.maxEpisodes, DEFAULTS.maxEpisodes, 0),
    maxOutputTokens: intAtLeast(group.maxOutputTokens, DEFAULTS.maxOutputTokens, 1),
    pickTimeoutMs: group.pickTimeoutMs === null ? null : intAtLeast(group.pickTimeoutMs, DEFAULTS.pickTimeoutMs, 1),
  };
}

/** Whether `audience` strictly allows `id`: an answer other than true, or a throw, is no. */
function allowed(audience: (placeId: string) => boolean, id: string): boolean {
  try {
    return audience(id) === true;
  } catch {
    return false;
  }
}

const recencyOf = (place: ElsewherePlace): number =>
  Math.max(place.lastActivityAt ?? Number.NEGATIVE_INFINITY, place.lastAttentionAt ?? Number.NEGATIVE_INFINITY);

const compareById = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The candidates of one pick. Places: the group places other than the current one that pass `audience`, the newest
 * `maxPlaces` by the later of activity and attention, listed by id, so the text stays the same between turns (the
 * provider's prompt cache). Episodes: those of other places that pass `audience`, the newest `maxEpisodes`, listed oldest
 * first, so a new episode appends a line. Pure.
 */
export function elsewhereCandidates(input: CandidatesInput): {
  places: Array<ElsewherePlace>;
  episodes: Array<ElsewhereEpisode>;
} {
  const { currentPlaceId, audience, maxPlaces, maxEpisodes } = input;
  const places = input.places
    .filter((place) => place.kind !== 'dm' && place.id !== currentPlaceId && allowed(audience, place.id))
    .sort((a, b) => recencyOf(b) - recencyOf(a))
    .slice(0, Math.max(0, maxPlaces))
    .sort(compareById);
  const episodes = input.episodes
    .filter((episode) => episode.placeId !== currentPlaceId && allowed(audience, episode.placeId))
    .sort((a, b) => a.ageMs - b.ageMs)
    .slice(0, Math.max(0, maxEpisodes))
    .sort((a, b) => b.ageMs - a.ageMs);
  return { places, episodes };
}

const noPipes = (text: string): string => String(text ?? '').replaceAll('|', '/');

/** The `<places>` lines, numbered from 1: `n | name | writer | purpose`. */
export function elsewherePlaceLines(
  places: Array<ElsewherePlace>,
  purposeChars: number = PURPOSE_CHARS
): Array<string> {
  return places.map((place, i) => {
    const purpose = purposeChars > 0 ? clampText(oneLine(place.purpose ?? ''), purposeChars, { tolerance: 1 }) : '';
    return `${i + 1} | ${oneLine(place.name)} | ${place.writer ?? ''} | ${purpose}`.trimEnd();
  });
}

/**
 * The `<episodes>` lines, numbered from 1 (`n | place | member: lines | persona: lines`, the member part empty when the
 * episode has none, a `|` in a text becoming `/`), and the per-turn `<episode_ages>` lines, `n | age`. An episode of a
 * place with no name is left out; `ids[n - 1]` is the episode of line `n`.
 */
export function elsewhereEpisodeLines(
  episodes: Array<ElsewhereEpisode>,
  {
    placeNameOf,
    units,
    selfName,
  }: { placeNameOf: (placeId: string) => string | null; units: unknown; selfName: string }
): { lines: Array<string>; ages: Array<string>; ids: Array<string> } {
  const lines: Array<string> = [];
  const ages: Array<string> = [];
  const ids: Array<string> = [];
  for (const episode of episodes) {
    const name = oneLine(placeNameOf(episode.placeId) ?? '');
    if (!name) continue;
    const member =
      episode.memberName && episode.memberLines
        ? `${oneLine(episode.memberName)}: ${noPipes(episode.memberLines)}`
        : '';
    const n = ids.length + 1;
    lines.push(`${n} | ${name} | ${member} | ${selfName}: ${noPipes(episode.selfLines)}`);
    ages.push(`${n} | ${formatDuration(episode.ageMs, units as Parameters<typeof formatDuration>[1])}`);
    ids.push(episode.id);
  }
  return { lines, ages, ids };
}

/**
 * The request of one pick: system is `prompt` with `{{name}}`; user is the part that changes only with the lists,
 * `<places>` and `<episodes>` (tagged `cacheSegment: 'stable'`), then `<episode_ages>`, the transcript and the candidate.
 * A list with no line leaves out its block. Null for a blank prompt or no line at all.
 */
export function buildElsewhereRequest({
  prompt,
  selfName,
  placeLines,
  episodeLines,
  episodeAges = [],
  transcriptBlock = '',
  candidateBlock = '',
}: {
  prompt: string | null | undefined;
  selfName: string;
  placeLines: Array<string>;
  episodeLines: Array<string>;
  episodeAges?: Array<string>;
  transcriptBlock?: string;
  candidateBlock?: string;
}): Array<{ role: string; content: string | Array<Record<string, Untyped>> }> | null {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  if (placeLines.length === 0 && episodeLines.length === 0) return null;
  const stable = [
    placeLines.length > 0 ? block('places', placeLines.join('\n')) : '',
    episodeLines.length > 0 ? block('episodes', episodeLines.join('\n')) : '',
  ]
    .filter(Boolean)
    .join('\n');
  const ages = episodeAges.length > 0 ? block('episode_ages', episodeAges.join('\n')) : '';
  return [
    { role: 'system', content: fillPromptTemplate(prompt, { name: selfName ?? '' }) },
    { role: 'user', content: stableThenTail(stable, [ages, transcriptBlock, candidateBlock], '\n') },
  ];
}

type ParseCode = 'pick' | 'none' | 'unknown-id' | 'empty' | 'unparsed';

/** Quotes that may wrap a value, and punctuation that may trail it. */
const WRAPPING = /^["'`«“‘]+|["'`»”’]+$/gu;
const TRAILING = /[.;:!?…]+$/u;

const cleaned = (value: string): string => value.trim().replace(WRAPPING, '').trim().replace(TRAILING, '').trim();

function parsePlace(
  value: string | undefined,
  count: number
): { index: number | null; direction: 'earlier' | null; reason: ParseCode } {
  const none = (reason: ParseCode) => ({ index: null, direction: null, reason });
  if (value === undefined) return none('unparsed');
  const text = cleaned(value);
  if (/^none$/iu.test(text)) return none('none');
  const match = /^#?(\d+)(?:\s+(earlier|older))?$/iu.exec(text);
  if (!match) return none('unparsed');
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < 1 || index > count) return none('unknown-id');
  return { index, direction: match[2] ? 'earlier' : null, reason: 'pick' };
}

function parseEpisodes(value: string | undefined, count: number): { indices: Array<number>; reason: ParseCode } {
  if (value === undefined) return { indices: [], reason: 'unparsed' };
  const text = cleaned(value);
  if (/^none$/iu.test(text)) return { indices: [], reason: 'none' };
  const parts = text.split(/[\s,]+/u).filter(Boolean);
  const numbers = parts.map((part) => /^#?(\d+)\.?$/u.exec(part)?.[1]);
  if (parts.length === 0 || numbers.some((number) => number === undefined)) return { indices: [], reason: 'unparsed' };
  const known = numbers.map(Number).filter((n) => Number.isSafeInteger(n) && n >= 1 && n <= count);
  const indices = [...new Set(known)].slice(0, MAX_PICKED_EPISODES);
  return indices.length > 0 ? { indices, reason: 'pick' } : { indices: [], reason: 'unknown-id' };
}

/**
 * The classifier's answer: two labelled lines, `place:` and `episodes:`, in either order and any case. Each field stands
 * alone, so a bad line voids only its own. A field with no line is `unparsed`, and a blank answer `empty` for both. Only
 * `pick` carries numbers (1-based).
 */
export function parseElsewhereAnswer(
  raw: unknown,
  counts: { places: number; episodes: number }
): {
  place: { index: number | null; direction: 'earlier' | null; reason: ParseCode };
  episodes: { indices: Array<number>; reason: ParseCode };
} {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model's answer as it came, read as text
  const text = String(raw ?? '');
  if (!text.trim()) {
    return { place: { index: null, direction: null, reason: 'empty' }, episodes: { indices: [], reason: 'empty' } };
  }
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(place|episodes)\s*:(.*)$/iu.exec(line);
    if (match && !fields.has(match[1].toLowerCase())) fields.set(match[1].toLowerCase(), match[2]);
  }
  return {
    place: parsePlace(fields.get('place'), counts.places),
    episodes: parseEpisodes(fields.get('episodes'), counts.episodes),
  };
}

/** The real timer behind `schedule`: `fn` once after `ms`; resolves a cancel function. */
function scheduleTimer(fn: () => void, ms: number) {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/** What one pick resolves. */
export type ElsewhereResult = { place: { id: string; direction: 'earlier' | null } | null; episodes: Array<string> };

const NOTHING = (): ElsewhereResult => ({ place: null, episodes: [] });

/** The modes and trigger kinds that never ask: nobody waits on a place view in a selfreflection post or a missed recovery. */
const refusesPick = (mode: string, triggerKind: string | null): boolean =>
  mode === 'selfreflection' || triggerKind === 'missed';

/** One request under a time limit: past it the request is aborted, and an answer that came with the abort is not taken. */
async function askWithin(
  timeoutMs: number | null,
  schedule: NonNullable<PickerDeps['schedule']>,
  ask: (signal: AbortSignal | undefined) => unknown
): Promise<{ late: boolean; completion?: unknown } | { late: false; error: unknown }> {
  const abort = timeoutMs === null ? null : new AbortController();
  let late = false;
  const cancel =
    abort && timeoutMs !== null
      ? schedule(() => {
          late = true;
          abort.abort();
        }, timeoutMs)
      : null;
  try {
    const completion: unknown = await ask(abort?.signal);
    return late ? { late } : { late, completion };
  } catch (error) {
    return late ? { late } : { late, error };
  } finally {
    cancel?.();
  }
}

/** What createElsewherePicker reads. */
type PickerDeps = {
  hot: { config: Record<string, Untyped>; prompts: Record<string, unknown> | null | undefined };
  llm: { complete(messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>): unknown };
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  listPlaces: (args: PickArgs) => Array<ElsewherePlace>;
  listEpisodes: (args: PickArgs) => Array<ElsewhereEpisode>;
};

/** One pick's arguments. */
export type PickArgs = {
  channel: { id?: string | null; rootId?: string | null } | null | undefined;
  history: Array<unknown>;
  trigger: unknown;
  triggerKind?: string | null;
  mode?: string;
  selfName: string;
  audience: (placeId: string) => boolean;
  limits?: { add: (entry: { kind: string; where: string }) => unknown } | null;
};

/**
 * The pick of a started turn. Per call, with `hot.config` and `hot.prompts` read at that moment: nothing with no request
 * for a selfreflection post, a missed recovery or no candidate at all; `elsewhere: skipped` (`reason` `no-prompt` or
 * `no-candidate`) without its prompt or a line to judge. Else one request on the `analyzer` role, purpose
 * `elsewhere-pick`, logged `elsewhere: classified` with the two parse codes and counts. Past `elsewhere.pickTimeoutMs` it
 * is aborted, logged `elsewhere: late` and told to `limits`; a failure is logged `elsewhere: failed` with its rail code.
 * Never rejects, and each of these resolves none for both fields.
 */
export function createElsewherePicker({
  hot,
  llm,
  now = Date.now,
  schedule = scheduleTimer,
  listPlaces,
  listEpisodes,
}: PickerDeps): (args: PickArgs) => Promise<ElsewhereResult> {
  return async function pickElsewhere(args) {
    const { channel, history, trigger = null, triggerKind = null, mode = 'reply', selfName, audience } = args;
    const placeId = channel?.id ?? null;
    try {
      if (refusesPick(mode, triggerKind)) return NOTHING();
      const config = hot.config;
      const settings = elsewherePickSettings(config);
      const { places, episodes } = elsewhereCandidates({
        places: listPlaces(args),
        episodes: listEpisodes(args),
        currentPlaceId: placeId,
        audience,
        maxPlaces: settings.maxPlaces,
        maxEpisodes: settings.maxEpisodes,
      });
      if (places.length === 0 && episodes.length === 0) return NOTHING();
      const prompt: unknown = hot.prompts?.['elsewhere-pick'];
      if (typeof prompt !== 'string' || !prompt.trim()) {
        log.info('elsewhere: skipped', { channel: placeId, reason: 'no-prompt' });
        return NOTHING();
      }
      const candidate = routeCandidate(history as Array<Line>, trigger as Line | null);
      if (!candidate) {
        log.info('elsewhere: skipped', { channel: placeId, reason: 'no-candidate' });
        return NOTHING();
      }
      const labels: unknown = hot.prompts?.labels;
      const names = new Map(listPlaces(args).map((place) => [place.id, place.name]));
      const listed = elsewhereEpisodeLines(episodes, {
        placeNameOf: (id) => names.get(id) ?? episodes.find((entry) => entry.placeId === id)?.placeName ?? null,
        units: objOf(labels).units,
        selfName,
      });
      const { transcriptBlock, candidateBlock } = routeContext({
        history: history as Array<Line>,
        candidate,
        contextMessages: CONTEXT_MESSAGES,
        config,
        labels,
        selfName,
      });
      const messages = buildElsewhereRequest({
        prompt,
        selfName,
        placeLines: elsewherePlaceLines(places),
        episodeLines: listed.lines,
        episodeAges: listed.ages,
        transcriptBlock,
        candidateBlock,
      });
      if (!messages) return NOTHING();

      const at = now();
      const counts = { places: places.length, episodes: listed.ids.length };
      const ended = await askWithin(settings.pickTimeoutMs, schedule, (signal) =>
        llm.complete(messages, {
          model: roleModel(config, 'analyzer', 'elsewhere-pick'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: settings.maxOutputTokens,
            purpose: 'elsewhere-pick',
            signal,
          }),
        })
      );
      if (ended.late) {
        log.info('elsewhere: late', { channel: placeId, ...counts, timeoutMs: settings.pickTimeoutMs });
        args.limits?.add?.({ kind: 'helper-timeout', where: 'elsewhere-pick' });
        return NOTHING();
      }
      if ('error' in ended) {
        log.warn('elsewhere: failed', {
          channel: placeId,
          reason: railReason(ended.error),
          status: objOf(ended.error).statusCode ?? null,
          name: objOf(ended.error).name ?? null,
        });
        return NOTHING();
      }
      const answer = parseElsewhereAnswer(objOf(ended.completion).text, counts);
      const place = answer.place.index === null ? null : places[answer.place.index - 1];
      const picked = answer.episodes.indices.map((n) => listed.ids[n - 1]);
      log.info('elsewhere: classified', {
        channel: placeId,
        kind: triggerKind,
        ...counts,
        pick: place?.id ?? null,
        direction: place ? answer.place.direction : null,
        picked: picked.length,
        placeParse: answer.place.reason,
        episodesParse: answer.episodes.reason,
        ms: now() - at,
      });
      return { place: place ? { id: place.id, direction: answer.place.direction } : null, episodes: picked };
    } catch (err) {
      log.warn('elsewhere: failed', { channel: placeId, reason: 'error', status: null, name: objOf(err).name ?? null });
      return NOTHING();
    }
  };
}

/** What a turn's two call sites hand in. */
type TurnPick = {
  placeId: string;
  channel: ConversationInfo;
  snapshot?: Snapshot | null;
  partner?: { id: string } | null;
  history: Array<unknown>;
  trigger: unknown;
  triggerKind?: string | null;
  mode?: string;
  selfName: string;
  limits?: PickArgs['limits'];
};

/** What createElsewhereHooks reads of the store: the stored places, her episodes and a member's profile. */
type ElsewhereStore = {
  listChannels?: (placeId: string) => Array<object>;
  getParticipation?: (placeId: string) => unknown;
  getUser?: (accountId: string) => StoredProfile | null;
};

/**
 * The pick as a turn uses it: the pull phase wants its place (`routeChannels`, the shape of the turn runner's route hook)
 * and the request phase its episodes (`pickEpisodes`), and both share one request. One turn runs at a time, so the last
 * pick stands until a turn asks about another line. The places are the stored ones the pull phase's rails would show
 * (src/behavior/pull-fetch.ts#checkPull); the episodes are the turn's community ones, none in a DM, which shows no
 * `<participation>`. The audience is the rail of src/behavior/snapshot.ts#audienceAllows, per place, over the turn's
 * listing: a place the listing does not hold is refused.
 */
export function createElsewhereHooks({
  hot,
  store,
  llm,
  now = Date.now,
  schedule = scheduleTimer,
  lastPostAt = () => null,
}: {
  hot: PickerDeps['hot'];
  store: ElsewhereStore;
  llm: PickerDeps['llm'];
  now?: () => number;
  schedule?: PickerDeps['schedule'];
  lastPostAt?: (placeId: string) => number | null;
}): {
  routeChannels: (args: TurnPick) => Promise<Array<string | { id: string; direction: 'earlier' }>>;
  pickEpisodes: (args: TurnPick) => Promise<Array<string>>;
} {
  const listPlaces = (args: PickArgs): Array<ElsewherePlace> => {
    const { placeId, channel, snapshot = null, partner = null } = args as PickArgs & TurnPick;
    const stored = (store.listChannels?.(placeId) ?? []) as Array<StoredChannel>;
    return stored.flatMap((entry): Array<ElsewherePlace> => {
      if (typeof entry?.id !== 'string' || !entry.id) return [];
      let live: ConversationInfo | null;
      try {
        const judged = checkPull({
          snapshot,
          placeId: entry.id,
          destination: channel,
          partnerId: partner?.id ?? null,
          config: hot.config,
          now: now(),
        });
        live = judged.skip === null ? judged.channel : null;
      } catch {
        live = null;
      }
      const name = oneLine(entry.name ?? '') || oneLine(live?.name ?? '');
      if (!live || !name) return [];
      const writer = routeWriter(
        entry,
        (accountId) => store.getUser?.(accountOf(store, accountId)) ?? null,
        MEMORY_LIMITS.aliasHalfLifeDays
      );
      return [
        {
          id: entry.id,
          name,
          iface: live.iface,
          kind: live.kind ?? 'channel',
          lastActivityAt: isFiniteNumber(entry.lastMessageAt) ? entry.lastMessageAt : null,
          lastAttentionAt: lastPostAt(entry.id),
          ...(writer
            ? { writer: writer.aliases.length > 0 ? `${writer.name} (${writer.aliases.join(', ')})` : writer.name }
            : {}),
          ...(typeof entry.purpose === 'string' ? { purpose: entry.purpose } : {}),
        },
      ];
    });
  };

  const listEpisodes = (args: PickArgs): Array<ElsewhereEpisode> => {
    const { placeId, channel, snapshot = null } = args as PickArgs & TurnPick;
    if (channel?.rootId == null || typeof store.getParticipation !== 'function') return [];
    const channels = (store.listChannels?.(placeId) ?? []) as Array<StoredChannel>;
    const nameOf = (id: string): string =>
      oneLine(channels.find((entry) => entry?.id === id)?.name ?? '') || oneLine(snapshot?.get(id)?.name ?? '');
    const state = store.getParticipation(placeId);
    const stateEpisodes = listOf(objOf(state).episodes).map(objOf);
    const headlines = episodeHeadlines(
      state,
      { excludeChannelId: channel.id, audience: args.audience, now: now() },
      participationSettings()
    );
    return headlines.map((headline) => {
      const stored = stateEpisodes.find((entry) => entry.id === headline.id);
      const member = listOf(stored?.messages)
        .map(objOf)
        .find((line) => !line.self);
      return {
        id: headline.id,
        placeId: headline.placeId,
        ageMs: headline.ageMs,
        memberName: typeof member?.name === 'string' ? member.name : null,
        memberLines: headline.memberLines,
        selfLines: headline.selfLines,
        placeName: nameOf(headline.placeId),
      };
    });
  };

  const pick = createElsewherePicker({ hot, llm, now, schedule, listPlaces, listEpisodes });
  let last: { key: string; answer: Promise<ElsewhereResult> } | null = null;

  /** The one pick of this line, asked by whichever call site comes first. */
  function shared(args: TurnPick): Promise<ElsewhereResult> {
    const candidate = routeCandidate(args.history as Array<Line>, args.trigger as Line | null);
    const key = JSON.stringify([args.channel?.iface, args.channel?.id, candidate?.id, candidate?.content]);
    if (last?.key === key) return last.answer;
    const { channel, snapshot = null, partner = null } = args;
    const audience = (placeId: string): boolean => {
      const other = snapshot?.get(String(placeId)) ?? null;
      return Boolean(other) && audienceAllows(channel, other, hot.config, { partnerId: partner?.id ?? null });
    };
    const answer = pick({ ...args, audience });
    last = { key, answer };
    return answer;
  }

  return {
    routeChannels: async (args) => {
      const { place } = await shared(args);
      if (!place) return [];
      return place.direction === 'earlier' ? [{ id: place.id, direction: 'earlier' }] : [place.id];
    },
    pickEpisodes: async (args) => (await shared(args)).episodes,
  };
}
