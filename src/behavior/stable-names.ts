// The engine's stable names on a message as it enters the core. An interface hands a custom emoji as the token
// `<emoji:ID>` in the content with an entry of `emojis`, a sticker as an entry of `stickers`, and a reaction with a
// custom emoji as `<emoji:ID>` with its platform name. `nameMessageMedia` names each through the store
// (src/memory/store-media-names.ts) and gives the message back with `:e23:` in its text and the stable name as the
// `name` of each emoji, sticker and custom reaction. The live events (src/core.ts) and the reads that answer messages
// (src/interface/reads.ts) both pass through it, so no text she reads holds a token or a platform name.

import { nameEmojiTokens } from './emoji.ts';
import type { MediaName, MediaNameItem } from '../memory/store-media-names.ts';

/** The store's issuer of stable names. */
export type MediaNamer = {
  nameMedia(iface: string, kind: 'emoji' | 'sticker', items: ReadonlyArray<MediaNameItem>): Array<MediaName>;
};

type Loose = Record<string, unknown>;
/** The parts of a message or a forwarded snapshot that carry names. */
type Part = { content?: string; emojis?: Array<object>; stickers?: Array<object> };
type Named = Part & { id: string; reactions?: Array<object>; forwarded?: Array<object> };

const looseOf = (value: object): Loose => value as Loose;
const itemOf = (value: object): MediaNameItem => {
  const { id, name, animated } = looseOf(value);
  return { nativeId: String(id), platformName: String(name), animated: animated === true };
};

/** `part` with its emoji tokens and its emoji and stickers under their stable names. */
function namePart<TPart extends Part>(part: TPart, iface: string, names: MediaNamer): TPart {
  const emojis = part.emojis ?? [];
  const stickers = part.stickers ?? [];
  const named = names.nameMedia(iface, 'emoji', emojis.map(itemOf));
  const stuck = names.nameMedia(iface, 'sticker', stickers.map(itemOf));
  const byId = new Map(named.map((row) => [row.nativeId, row.name]));
  const listed = emojis.map((emoji) => ({ id: String(looseOf(emoji).id), name: String(looseOf(emoji).name) }));
  return {
    ...part,
    ...(typeof part.content === 'string'
      ? { content: nameEmojiTokens(part.content, (id) => byId.get(id) ?? null, listed) }
      : {}),
    ...(part.emojis ? { emojis: emojis.map((emoji, at) => ({ ...emoji, name: named[at].name })) } : {}),
    ...(part.stickers ? { stickers: stickers.map((sticker, at) => ({ ...sticker, name: stuck[at].name })) } : {}),
  };
}

/** `message` with every custom emoji, sticker and custom reaction under its stable name (see the head of this file). */
export function nameMessageMedia<TMessage extends Named>(
  message: TMessage,
  iface: string,
  names: MediaNamer
): TMessage {
  const reactions = message.reactions ?? [];
  // A reaction with a custom emoji carries its platform name; a unicode one carries none.
  const custom = reactions.filter((reaction) => typeof looseOf(reaction).name === 'string');
  const issued = names.nameMedia(
    iface,
    'emoji',
    custom.map((reaction) => {
      const { emoji, name, animated } = looseOf(reaction);
      return {
        nativeId: String(emoji).slice('<emoji:'.length, -1),
        platformName: String(name),
        animated: animated === true,
      };
    })
  );
  const reactionName = new Map(custom.map((reaction, at) => [reaction, issued[at].name]));
  return {
    ...namePart(message, iface, names),
    ...(message.reactions
      ? {
          reactions: reactions.map((reaction) => {
            const name = reactionName.get(reaction);
            return name === undefined ? reaction : { ...reaction, name };
          }),
        }
      : {}),
    ...(message.forwarded ? { forwarded: message.forwarded.map((part) => namePart(part, iface, names)) } : {}),
  };
}

/** A message event, its message and the message before an edit, under stable names. */
export function nameEventMedia<TEvent extends { iface: string; message: Named; previous?: Named | null }>(
  event: TEvent,
  names: MediaNamer
): TEvent {
  return {
    ...event,
    message: nameMessageMedia(event.message, event.iface, names),
    ...(event.previous ? { previous: nameMessageMedia(event.previous, event.iface, names) } : {}),
  };
}
