// The main arguments of one skill call, as the call mark of her transcript line shows them
// (src/format.js#withCalls: `[you called web.search (query: "...") : done]`). Rendered from the
// recorded call (the resolved arguments), never from her wording: only the arguments listed here for
// the skill (the others for a skill with no row), one line, each value cut with a marker, the whole
// bounded, and never a field whose name suggests a secret. Pure.

/** The arguments worth showing per skill, in order. The target (message, channel) is shown by the mark itself where it can. */
const SHOWN = Object.freeze({
  'web.search': ['query', 'goal'],
  'web.read': ['url'],
  'media.look': ['question', 'url', 'item'],
  'media.find': ['query', 'n'],
  'memory.search': ['question', 'people', 'channel', 'when', 'terms'],
  'conversation.read': ['channel', 'around', 'before', 'after', 'since', 'last'],
  'memory.profile.read': ['user', 'section', 'limit'],
  'memory.journal.read': ['day', 'kind', 'n', 'message'],

  'memory.archive.read': ['user', 'kind', 'n'],
  'places.list': ['filter', 'sort', 'page'],
  'skills.describe': ['name'],
  'status.show': ['field', 'part'],
  'lore.list': ['query'],
  'lore.show': ['id'],
  'draw.create': ['text'],
  'task.run': ['agent', 'goal'],
  'task.read': ['id', 'from'],
  'task.status': ['id', 'from'],
  'task.cancel': ['id'],
  'task.resolve': ['id', 'from'],
  'intent.set': ['id', 'text', 'due', 'every', 'channel'],
  'intent.update': ['id', 'text', 'due', 'every', 'channel'],
  'intent.cancel': ['id'],
  'message.create': [],
  'message.react.add': ['emoji'],
  'message.react.remove': ['emoji'],
});

/** Arguments shown for a skill with no row above. */
const DEFAULT_SHOWN = Object.freeze(['query', 'name', 'id', 'part']);

/** An argument whose name suggests a secret is never shown. */
const SECRET_NAME = /key|token|secret|password|passwd|credential|auth|value|confirm/i;

const VALUE_MAX = 60;
const ALL_MAX = 160;
const CUT = '…';

/** One value as a short single-line string; '' when it has nothing to show. */
function valueText(value) {
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else if (Array.isArray(value)) text = value.filter((item) => ['string', 'number'].includes(typeof item)).join(', ');
  else return '';
  // One line; nothing that closes the mark or opens a tag.
  text = text.replace(/\s+/g, ' ').replace(/[\[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const chars = Array.from(text);
  const cut = chars.length > VALUE_MAX ? `${chars.slice(0, VALUE_MAX).join('').trimEnd()}${CUT}` : text;
  return typeof value === 'string' ? `"${cut}"` : cut;
}

/**
 * The call's main arguments as `name: value, name: value`, or '' when there are none to show.
 * @param {string} skill
 * @param {Record<string, unknown>|null|undefined} args  The resolved arguments the call ran with.
 * @returns {string}
 */
export function callArgsText(skill, args) {
  if (!args || typeof args !== 'object') return '';
  const names = Object.hasOwn(SHOWN, skill) ? SHOWN[skill] : DEFAULT_SHOWN;
  const parts = [];
  for (const name of names) {
    if (SECRET_NAME.test(name) || !Object.hasOwn(args, name)) continue;
    const text = valueText(args[name]);
    if (text) parts.push(`${name}: ${text}`);
  }
  const joined = parts.join(', ');
  const chars = Array.from(joined);
  return chars.length > ALL_MAX ? `${chars.slice(0, ALL_MAX).join('').trimEnd()}${CUT}` : joined;
}
