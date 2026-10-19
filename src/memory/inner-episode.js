// What the persona did and found on her own in an inner turn (docs/inner-life.md), as lines of
// her memory buffer, so the existing analyzer batch (src/memory/update.js) builds memory from it
// the way it builds memory from chat: no new model role, no request of its own. The inner turn
// (src/behavior/turn.js#innerEpisodeOf) hands what her reads found (web.search, web.read,
// memory.search, her errands' results through task.status / task.list, ...), her thinks and how
// her other calls went; this module turns that into first-person buffer lines of hers, every
// word from `labels.memory.inner` (none in code), each line marked with its provenance
// (`inner: { kind: 'inner', turnId, shadow, sources }`): her own experience, never a person's
// claim, and never a chat line (the record, the address counts and an errand's context skip it).
//
// Shadow turns count too: their reads really ran, so what they found is a fact of her day; what
// she only proposed there (and what was refused) is listed as not done, never as done. What did
// not go through in the turn (`episode.feedback`, the scheduler's feedback facts,
// src/behavior/inner.js#feedbackFacts) joins the first line as `labels.memory.innerFeedback`, each
// fact worded as in `<wake>` (src/behavior/wake.js#feedbackFactText): a fact of her day, not a
// lesson. Pure.

import { fill } from '../format.js';
import { feedbackFactText } from '../behavior/wake.js';
import { clampWithEllipsis, oneLine } from './clamp.js';

/** The defaults of `innerLife.memory` (config.json carries the same). */
export const INNER_MEMORY_DEFAULTS = Object.freeze({
  enabled: true,
  thinkChars: 1200,
  resultChars: 1500,
  maxFindings: 5,
  maxSources: 10,
  skills: Object.freeze(['web.search', 'web.read', 'memory.search', 'task.status', 'task.list']),
});

const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);

/**
 * The `innerLife.memory` section with every value checked (a missing or bad one takes the
 * default). `enabled` is off only when it says `false`.
 * @param {object} config
 */
export function innerMemorySettings(config) {
  const raw = config?.innerLife?.memory ?? {};
  const d = INNER_MEMORY_DEFAULTS;
  const skills = Array.isArray(raw.skills) ? raw.skills.filter((name) => typeof name === 'string' && name) : [...d.skills];
  return {
    enabled: raw.enabled !== false,
    thinkChars: positive(raw.thinkChars, d.thinkChars),
    resultChars: positive(raw.resultChars, d.resultChars),
    maxFindings: positive(raw.maxFindings, d.maxFindings),
    maxSources: positive(raw.maxSources, d.maxSources),
    skills,
  };
}

/** An http(s) link in a text: up to a space, an angle bracket, a quote or a closing bracket. */
const LINK_RE = /https?:\/\/[^\s<>"'()[\]]+/gi;
/** Punctuation that ends a sentence after a link rather than belonging to it. */
const LINK_TAIL_RE = /[.,;:!?]+$/;

/**
 * The distinct http(s) links of `texts`, in order of first appearance, at most `max`. Pure.
 * @param {unknown[]} texts
 * @param {number} [max]
 * @returns {string[]}
 */
export function linksOf(texts, max = INNER_MEMORY_DEFAULTS.maxSources) {
  const out = [];
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(LINK_RE)) {
      const link = match[0].replace(LINK_TAIL_RE, '');
      if (!out.includes(link)) out.push(link);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * The last `limit` code points of `text`, led by an ellipsis when cut (and started at a word):
 * the end of her thinking is where she concluded. Pure.
 */
export function tailChars(text, limit) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const points = Array.from(trimmed);
  if (!Number.isFinite(limit) || limit <= 0 || points.length <= limit) return trimmed;
  const tail = points.slice(points.length - Math.max(1, limit - 1)).join('');
  const space = tail.search(/\s/);
  const fromWord = space !== -1 && space < tail.length / 2 ? tail.slice(space).trimStart() : tail;
  return `…${fromWord}`;
}

/** The separator between the feedback facts of one episode line (data joined, not wording). */
const FACTS_JOIN = '; ';

/**
 * The feedback facts of `episode` (`feedback`, src/behavior/inner.js#feedbackFacts) as one text,
 * each worded by `labels.wake.feedback.<kind>` (feedbackFactText), joined by `; `; '' without
 * facts or their labels. Pure.
 * @param {object} episode
 * @param {object} labels
 */
export function feedbackText(episode, labels) {
  return (Array.isArray(episode?.feedback) ? episode.feedback : []).map((fact) => feedbackFactText(fact, labels?.wake)).filter(Boolean).join(FACTS_JOIN);
}

/** What her call asked, for a finding's line: the query, the url or the question. */
function askedOf(args) {
  for (const key of ['query', 'url', 'question', 'id']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  }
  return '';
}

/**
 * The buffer lines of one inner turn's episode (`episode`: turn.js#innerEpisodeOf's), or [] when
 * memory from inner turns is off, the labels lack `memory.inner.found`, or none of its findings
 * is of a skill `settings.skills` keeps and it carries no feedback fact with a label. Line one:
 * her thinks (the tail, `thinkChars`), her calls done and not done, and what did not go through
 * (`memory.innerFeedback` with `{facts}`, feedbackText's); then one line per finding (at most
 * `maxFindings`, each result cut to `resultChars`), with the links it holds. Every line is hers (`self`), in the episode's
 * conversation, at the episode's moment (one millisecond apart, in order), cut to `maxChars` (the
 * analyzer's per-line limit), and carries `inner` (`kind`, `turnId`, `shadow`, `sources`). Pure.
 * @param {object} episode
 * @param {{ labels: object, settings: object, maxChars?: number }} options
 * @returns {object[]}
 */
export function innerEpisodeLines(episode, { labels, settings, maxChars = 0 }) {
  const words = labels?.memory?.inner;
  if (!settings?.enabled || !episode || typeof words?.found !== 'string' || !words.found) return [];
  const findings = (Array.isArray(episode.findings) ? episode.findings : [])
    .filter((finding) => settings.skills.includes(finding?.skill) && typeof finding.text === 'string' && finding.text.trim())
    .slice(0, settings.maxFindings);
  const feedback = typeof labels?.memory?.innerFeedback === 'string' && labels.memory.innerFeedback ? feedbackText(episode, labels) : '';
  if ((findings.length === 0 && !feedback) || typeof episode.channelId !== 'string' || !episode.channelId) return [];
  const at = Number.isFinite(episode.at) ? episode.at : 0;
  const turnId = typeof episode.turnId === 'string' ? episode.turnId : null;
  const shadow = episode.shadow === true;
  const cut = (text) => (Number.isFinite(maxChars) && maxChars > 0 ? clampWithEllipsis(text, maxChars) : text);
  const lines = [];
  const line = (content, sources, n) => ({
    id: `inner:${turnId ?? at}:${n}`,
    channelId: episode.channelId,
    channelName: episode.channelName ?? null,
    authorId: episode.selfId ?? null,
    authorName: episode.selfName ?? null,
    self: true,
    bot: false,
    content: cut(content),
    ts: at + n,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    direct: false,
    inner: { kind: 'inner', turnId, shadow, sources },
  });

  const list = (status) => [...new Set((episode.actions ?? []).filter((action) => (status === 'executed' ? action?.status === 'executed' : action?.status !== 'executed')).map((action) => action?.skill).filter(Boolean))];
  const done = list('executed');
  const notDone = list('other');
  const thinks = (Array.isArray(episode.thinks) ? episode.thinks : []).filter((text) => typeof text === 'string' && text.trim());
  const head = [
    thinks.length > 0 && words.think ? fill(words.think, { text: tailChars(thinks.join('\n\n'), settings.thinkChars) }) : '',
    done.length > 0 && words.done ? fill(words.done, { skills: done.join(', ') }) : '',
    notDone.length > 0 && words.notDone ? fill(words.notDone, { skills: notDone.join(', ') }) : '',
    feedback ? fill(labels.memory.innerFeedback, { facts: feedback }) : '',
  ].filter(Boolean);
  if (head.length > 0) lines.push(line(head.join('\n'), [], lines.length));

  for (const finding of findings) {
    const asked = askedOf(finding.args);
    const sources = linksOf([finding.args?.url, finding.text], settings.maxSources);
    const parts = [
      fill(words.found, { skill: finding.skill, asked: asked && words.asked ? fill(words.asked, { text: asked }) : '', text: clampWithEllipsis(finding.text, settings.resultChars) }),
      sources.length > 0 && words.sources ? fill(words.sources, { links: sources.join(' ') }) : '',
    ].filter(Boolean);
    lines.push(line(parts.join('\n'), sources, lines.length));
  }
  return lines;
}
