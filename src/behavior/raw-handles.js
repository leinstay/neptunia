// The discord.js objects behind a message event, as the message pipeline (src/behavior/pipeline.js) reads them.
// An event that crossed the link carries none, so the pipeline asks an injected `rawOf(event)`; an event built in
// process still carries its own `raw` and `rawPrevious`.

/** @typedef {import('discord.js').Message} Message */
/** @typedef {{ message: Message, previous: Message|null }} RawHandles */

/**
 * The handles an event carries itself, or null.
 * @param {{ raw?: Message, rawPrevious?: Message|null }} event
 * @returns {RawHandles|null}
 */
export function defaultRawOf(event) {
  return event.raw ? { message: event.raw, previous: event.rawPrevious ?? null } : null;
}

/**
 * The message of an event and the old one of an edit through `rawOf`, with nothing for an event it does not know.
 * @param {(event: any) => RawHandles|null} rawOf
 * @param {{ id: string }|null|undefined} event
 * @returns {{ message: Message|undefined, previous: Message|null }}
 */
export function handlesOf(rawOf, event) {
  return (event && rawOf(event)) || { message: undefined, previous: null };
}
