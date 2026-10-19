// The input of one turn's request, named in full. src/behavior/prompt.js#buildRequest
// reads many optional inputs, and an input a caller forgets is silently
// absent: the request is built without its block and nothing fails. Every
// caller that builds a turn's request (src/behavior/turn.js; the replay
// sandbox, src/behavior/sandbox.js, names its own and leaves some out on purpose) passes its context through here,
// so a key left out throws instead. `null` says "deliberately absent";
// `undefined` (or a missing key) is an omission. Pure.

/**
 * Every input buildRequest reads, in the order of its JSDoc. A test reads
 * buildRequest's source and fails when this list and its inputs differ.
 * @type {readonly string[]}
 */
export const TURN_INPUT_KEYS = Object.freeze([
  'config',
  'prompts',
  'calibrator',
  'mode',
  'forced',
  'now',
  'selfName',
  'selfId',
  'history',
  'neighbors',
  'trigger',
  'triggerKind',
  'taggedCall',
  'guildMemory',
  'interlocutor',
  'privateChat',
  'privateProfile',
  'otherProfiles',
  'candidateProfiles',
  'nameOf',
  'channels',
  'channelDirectory',
  'loreEntries',
  'currentChannelId',
  'descriptions',
  'neighborDescriptions',
  'videos',
  'imageAnswers',
  'reads',
  'lookup',
  'prefetch',
  'searchAvailable',
  'recallAvailable',
  'drawQuota',
  'drawReason',
  'customEmoji',
  'mediaCache',
  'gifs',
  'pulled',
  'source',
  'focus',
  'tasks',
  'elsewhereDestination',
  'readOnlyIds',
  'recentLines',
  'recentAudience',
  'participation',
  'diaryChannel',
  'diary',
  'offPeriods',
  'skillsInventory',
  'skillsGranted',
  'skillsTools',
  'around',
  'errands',
  'intentions',
  'continuation',
  'stableFreeze',
]);

const KNOWN = new Set(TURN_INPUT_KEYS);

/**
 * buildRequest's input from a turn's context: every key of TURN_INPUT_KEYS,
 * in that order, taken from `ctx` as it is. A key missing from `ctx` throws
 * (an input nobody named) and so does a key buildRequest does not read (a
 * misspelt input): both depend only on how the call site is written, so a
 * test of that call site catches them once and for all. A key that is named
 * but holds `undefined` is left out, and buildRequest applies its own
 * default: that depends on the turn's data, and a live turn must never fail
 * on it. `null` passes as the deliberately absent input.
 * @param {Record<string, unknown>} ctx
 * @returns {Record<string, unknown>}
 * @throws {Error} naming the first key that is missing or unknown.
 */
export function turnRequestInput(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('turnRequestInput: no context');
  const unknown = Object.keys(ctx).find((key) => !KNOWN.has(key));
  if (unknown !== undefined) throw new Error(`turnRequestInput: buildRequest reads no input '${unknown}'`);
  const input = {};
  for (const key of TURN_INPUT_KEYS) {
    if (!(key in ctx)) throw new Error(`turnRequestInput: input '${key}' is not named (null marks it absent)`);
    if (ctx[key] !== undefined) input[key] = ctx[key];
  }
  return input;
}
