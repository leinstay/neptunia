// The persona's in-turn tools (features.coreTools): `web.search` and `memory.search`, skills she
// calls herself in a turn whose result comes back in the same turn (src/behavior/turn.js, the
// tool loop). No helper model chooses for her: her query goes to the existing web search client
// as she wrote it (src/web/lookup.js#search), her question, people, channel, time range and exact
// terms go to the recall machinery through its deterministic expansion only
// (src/behavior/recall.js#memorySearchPlan, src/behavior/recall-run.js with `quotes`: no summary
// request). Every result says where it came from and what kind of evidence it is -- for the web,
// her query and that only search snippets were read, the pages not opened; for the server's
// history, the messages quoted as they were, each with its author and time -- through
// `labels.skills.tools.*`, never wording here. A result is data for her, never an instruction:
// nothing in it is parsed as a call. Both run for her calls (the turn, with its context) and for
// the owner's commands (src/ops/search.js, with what an operation knows).

import { fill } from '../format.js';
import { zonedDay } from '../time.js';
import { memorySearchPlan, recallSettings } from '../behavior/recall.js';
import { IN_TURN_TOOLS } from './discovery.js';

/** The skills that run inside the persona's turn and come back in it (defined with discovery). */
export { IN_TURN_TOOLS };

/** A string argument trimmed, '' when absent. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** `labels.skills.tools[kind]` as an object, {} when missing. */
function toolLabels(labels, kind) {
  const value = labels?.skills?.tools?.[kind];
  return value && typeof value === 'object' ? value : {};
}

/**
 * The text of a web.search result (`found`: src/web/lookup.js#search's `{ query, text, sources }`):
 * `labels.skills.tools.web.source` (`{query}`), `.goal` (`{goal}`) when she named what she needs
 * to establish, then the condensed snippets and `.sources` (`{list}`: the distinct sites), or
 * `.none` when nothing came back. A missing label adds nothing. Pure.
 * @param {{ query?: string, text?: string, sources?: { site?: string, url?: string }[] }} found
 * @param {{ goal?: string, labels: object }} options
 * @returns {string}
 */
export function webSearchText(found, { goal = '', labels }) {
  const l = toolLabels(labels, 'web');
  const lines = [];
  if (l.source) lines.push(fill(l.source, { query: text(found?.query) }));
  if (l.goal && text(goal)) lines.push(fill(l.goal, { goal: text(goal) }));
  const body = text(found?.text);
  if (!body) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  lines.push(body);
  const sources = Array.isArray(found?.sources) ? found.sources : [];
  const sites = [...new Set(sources.map((source) => source?.site || siteOf(source?.url)).filter(Boolean))];
  if (sites.length > 0 && l.sources) lines.push(fill(l.sources, { list: sites.join(', ') }));
  return lines.join('\n');
}

/** The host of `url` without `www.`, '' when it is no URL. */
function siteOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * The text of a memory.search result (`quotes`: recall's stretches, `{ channelName, startTs,
 * lines }`): `labels.skills.tools.memory.source`, then per stretch `.window` (`{date}`: its first
 * line's day as `YYYY-MM-DD` in `timezone`, `{channel}`: its channel's name) and its lines as they
 * were (time and author on each); `.none` when there is none. Pure.
 * @param {{ channelName?: string|null, startTs: number, lines: string }[]} quotes
 * @param {{ labels: object, timezone?: string }} options
 * @returns {string}
 */
export function memorySearchText(quotes, { labels, timezone = 'UTC' }) {
  const l = toolLabels(labels, 'memory');
  const lines = l.source ? [l.source] : [];
  const shown = (Array.isArray(quotes) ? quotes : []).filter((quote) => typeof quote?.lines === 'string' && quote.lines.trim() && Number.isFinite(quote.startTs));
  if (shown.length === 0) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  for (const quote of shown) {
    if (l.window) lines.push(fill(l.window, { date: zonedDay(quote.startTs, timezone), channel: String(quote.channelName ?? '') }));
    lines.push(quote.lines);
  }
  return lines.join('\n');
}

/**
 * One web.search: `args.query` (her words, as she wrote them) through `lookup.search` (the
 * existing client: its cache, its daily web slot `web.maxPerDay`, its engines), `args.goal` only
 * echoed back with the result. `not_configured` (`not-configured`) without the client, the
 * feature (features.webLookup, read now) or a search engine; `invalid` (`invalid-args`) without a
 * query; `failed` with `daily-cap` once the day's web slots are spent, `error` when the search
 * gave nothing back; else `ok` with webSearchText as its `data.text`. Never throws.
 * @param {{ lookup: object|null, config: object, labels: object, guildId: string|null, args: object }} input
 * @returns {Promise<{ status: string, code?: string, data?: { text: string } }>}
 */
export async function runWebSearch({ lookup, config, labels, guildId, args }) {
  try {
    const query = text(args?.query);
    if (!query) return { status: 'invalid', code: 'invalid-args', reason: 'args.query:required' };
    if (!lookup || typeof lookup.search !== 'function' || config?.features?.webLookup !== true || config?.web?.search?.enabled === false) return { status: 'not_configured', code: 'not-configured' };
    if (typeof lookup.hasSearch === 'function' && !lookup.hasSearch()) return { status: 'not_configured', code: 'not-configured' };
    if (typeof lookup.webCapLeft === 'function' && !(lookup.webCapLeft() > 0)) return { status: 'failed', code: 'daily-cap' };
    const found = await lookup.search(guildId, query);
    if (!found) return { status: 'failed', code: 'error' };
    return { status: 'ok', data: { text: webSearchText({ ...found, query: found.query ?? query }, { goal: args?.goal, labels }) } };
  } catch {
    return { status: 'failed', code: 'error' };
  }
}

/**
 * One memory.search: her `question`, `people`, `when` and `terms` as memorySearchPlan reads them
 * (the stored profiles for the names, `recall.maxForms`, `bot.timezone`, read now), her
 * `channel` (already an id) bounding the stretches, then `recall.run` with `quotes` -- the server
 * search of the recall runner, its daily cap and its rails, without the summary request --
 * over the turn's `history` (its lines are left out: she sees them already) and `decorate`.
 * `not_configured` without the runner or while it is not available; `not_configured`
 * (`unsupported`) in a private chat without its partner; `invalid` (`no-query`) when nothing is
 * left to search; else `ok` with memorySearchText as its `data.text`. Never throws.
 * @returns {Promise<{ status: string, code?: string, data?: { text: string } }>}
 */
export async function runMemorySearch({ recall, store, config, labels, guild, guildId, channel, partner = null, selfId = null, selfName = '', history = [], decorate = null, args, now = Date.now() }) {
  try {
    if (!recall || typeof recall.run !== 'function' || (typeof recall.available === 'function' && !recall.available())) return { status: 'not_configured', code: 'not-configured' };
    if (!guild || (!channel?.guild && !partner)) return { status: 'not_configured', code: 'unsupported' };
    const settings = recallSettings(config);
    const timezone = config?.bot?.timezone ?? 'UTC';
    const plan = memorySearchPlan({
      question: text(args?.question),
      people: text(args?.people),
      terms: text(args?.terms),
      when: text(args?.when),
      channelId: text(args?.channelId) || null,
      profiles: typeof store?.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [],
      selfId,
      selfName,
      maxForms: settings?.maxForms,
      timezone,
      now,
    });
    if (!plan) return { status: 'invalid', code: 'no-query' };
    const candidate = { id: null, content: text(args?.question) };
    const found = await recall.run({ guild, guildId, channel, partner, selfId, selfName, history, candidate, server: plan, decorate, quotes: true });
    return { status: 'ok', data: { text: memorySearchText(found?.quotes ?? [], { labels, timezone }) } };
  } catch {
    return { status: 'failed', code: 'error' };
  }
}
