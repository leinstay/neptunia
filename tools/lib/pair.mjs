// The pure part of the paired replay (tools/replay.mjs --pair, tools/replay-score.mjs): the
// trigger list, the blind order of each pair, the sheet the owner scores (A and B shown in a
// random order with no label saying which is which), the key that says it, and the tally of
// the owner's scores. Randomness is injected (`rng`); no I/O.

const SNOWFLAKE = /^\d{17,20}$/;
const TURN_ID = /^t-[A-Za-z0-9-]{1,80}$/;
/** The verdicts a score may give, by the position on the sheet. */
export const SCORES = Object.freeze(['first', 'second', 'even']);

/**
 * The triggers file: one trigger per line, `<channelId> <triggerMessageId> [<turnId>]`; blank
 * lines and `#` comments are skipped. Throws an Error naming the first bad line.
 * @param {string} text
 * @returns {{ channelId: string, triggerId: string, turnId: string|null }[]}
 */
export function parseTriggers(text) {
  const out = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      const [channelId, triggerId, turnId, extra] = line.split(/\s+/);
      if (extra !== undefined || !SNOWFLAKE.test(channelId ?? '') || !SNOWFLAKE.test(triggerId ?? '') || (turnId !== undefined && !TURN_ID.test(turnId))) {
        throw new Error(`triggers line ${index + 1}: expected "<channelId> <triggerMessageId> [<turnId>]"`);
      }
      out.push({ channelId, triggerId, turnId: turnId ?? null });
    });
  return out;
}

/**
 * The blind order of `n` pairs: for each, which side the sheet shows first (`'A'` or `'B'`),
 * drawn with `rng` (a value in [0, 1)).
 * @param {number} n
 * @param {() => number} rng
 * @returns {('A'|'B')[]}
 */
export function pairOrder(n, rng) {
  return Array.from({ length: n }, () => (rng() < 0.5 ? 'A' : 'B'));
}

/** `text` safe inside HTML text and attribute values. */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** One answer as sheet HTML: its messages, reactions, GIF, pictures drawn and posts of message calls, or that it stayed silent. */
function answerHtml(answer) {
  if (!answer) return '<p class="none">(no answer: the request failed)</p>';
  const parts = [];
  for (const text of answer.messages ?? []) parts.push(`<p class="msg">${escapeHtml(text)}</p>`);
  for (const reaction of answer.reactions ?? []) parts.push(`<p class="act">reaction: ${escapeHtml(reaction.emoji ?? reaction)}</p>`);
  if (answer.gif) parts.push(`<p class="act">gif: ${escapeHtml(answer.gif.id ?? '')}</p>`);
  for (const drawing of answer.drawings ?? []) parts.push(`<p class="act">drawing: ${escapeHtml(drawing.text ?? '')}</p>`);
  for (const post of answer.posts ?? []) parts.push(`<p class="act">posted: ${escapeHtml(post.text ?? '')}</p>`);
  if (parts.length === 0 || answer.skip) parts.push('<p class="none">(stays silent)</p>');
  return parts.join('\n');
}

/**
 * The blind sheet: for each pair the chat lines before the trigger, the trigger, then the two
 * answers as "1" and "2" in the order `first` gives (the key says which is A), with a choice
 * (1 better, 2 better, even) and a button that writes the scores as JSON
 * (`{ "<pairId>": "first"|"second"|"even" }`) into a box to copy into scores.json.
 * @param {{ id: string, context: { author: string, text: string }[], first: object|null, second: object|null }[]} pairs
 * @returns {string}
 */
export function renderSheet(pairs) {
  const items = pairs.map((pair) => {
    const lines = (pair.context ?? []).map((line) => `<p class="line"><b>${escapeHtml(line.author)}</b>: ${escapeHtml(line.text)}</p>`).join('\n');
    const choice = SCORES.map((score, i) => `<label><input type="radio" name="${escapeHtml(pair.id)}" value="${score}"> ${['1 better', '2 better', 'even'][i]}</label>`).join(' ');
    return [
      `<section class="pair" data-pair="${escapeHtml(pair.id)}">`,
      `<h2>${escapeHtml(pair.id)}</h2>`,
      `<div class="chat">${lines}</div>`,
      '<div class="answers">',
      `<div class="answer"><h3>1</h3>${answerHtml(pair.first)}</div>`,
      `<div class="answer"><h3>2</h3>${answerHtml(pair.second)}</div>`,
      '</div>',
      `<p class="choice">${choice}</p>`,
      '</section>',
    ].join('\n');
  });
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>replay pairs</title>',
    '<style>body{font-family:sans-serif;max-width:70em;margin:auto}.pair{border-top:2px solid #888;padding:1em 0}',
    '.chat{color:#555}.answers{display:flex;gap:1em}.answer{flex:1;border:1px solid #ccc;padding:.5em}.none,.act{color:#777}</style>',
    '</head><body>',
    ...items,
    '<p><button id="collect">scores to JSON</button></p>',
    '<textarea id="scores" rows="10" cols="80"></textarea>',
    '<script>document.getElementById("collect").onclick=function(){var o={};document.querySelectorAll("section.pair").forEach(function(s){',
    'var c=s.querySelector("input:checked");if(c)o[s.dataset.pair]=c.value;});document.getElementById("scores").value=JSON.stringify(o,null,1);};</script>',
    '</body></html>',
    '',
  ].join('\n');
}

/**
 * The pair ids a sheet holds, in order (its `data-pair` attributes).
 * @param {string} html
 * @returns {string[]}
 */
export function sheetPairIds(html) {
  const ids = [];
  const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const match of String(html ?? '').matchAll(/<section class="pair" data-pair="([^"]*)">/g)) ids.push(unescape(match[1]));
  return ids;
}

/**
 * The owner's scores against the key: per pair the verdict in A/B terms (`A`, `B`, `even`, or
 * `unscored` when no valid score was given), and the totals. A pair missing from the key is an
 * Error (the sheet and the key are not of one run).
 * @param {{ ids: string[], key: { pairs: Record<string, { first: 'A'|'B' }> }, scores: Record<string, string> }} input
 * @returns {{ pairs: { id: string, verdict: 'A'|'B'|'even'|'unscored' }[], totals: { A: number, B: number, even: number, unscored: number } }}
 */
export function tallyScores({ ids, key, scores }) {
  const totals = { A: 0, B: 0, even: 0, unscored: 0 };
  const pairs = ids.map((id) => {
    const entry = key?.pairs?.[id];
    if (!entry || (entry.first !== 'A' && entry.first !== 'B')) throw new Error(`pair ${id} is not in the key`);
    const score = scores?.[id];
    let verdict = 'unscored';
    if (score === 'even') verdict = 'even';
    else if (score === 'first') verdict = entry.first;
    else if (score === 'second') verdict = entry.first === 'A' ? 'B' : 'A';
    totals[verdict] += 1;
    return { id, verdict };
  });
  return { pairs, totals };
}
