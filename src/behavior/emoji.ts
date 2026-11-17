// The custom emoji in text. An incoming line carries the protocol token `<emoji:ID>` per custom emoji, and
// `nameEmojiTokens` turns each into the engine's stable name `:e23:`. The persona writes `:e23:` (the way she reads
// them), and the interface shows a custom emoji as `<:name:id>` or `<a:name:id>`. The pure functions below turn her
// form into the markup through a `lookup(stableName)`; src/behavior/emoji-index.ts#createEmojiIndex is the core's
// index over the interface's list of the root's emoji that backs that lookup.

/**
 * The custom emoji markup `<:name:id>` / `<a:name:id>` as a regex
 * source: the one copy every markup regex here and in the interface packages
 * is built from. Group 1 is `a` for an animated emoji (else empty), group 2
 * the name (2-32 letters, digits or underscores, the platform's rule), group 3 the
 * id (a snowflake). Unanchored and without flags: each user adds its own.
 */
export const CUSTOM_EMOJI_MARKUP = /<(a?):([A-Za-z0-9_]{2,32}):(\d{1,25})>/.source;

// Skipped as a whole, never scanned for tokens: code blocks, inline code,
// custom emoji markup already well formed, timestamps, bracketed and bare URLs.
// The second alternative is a `:name:` token; a name followed by `//` is a URL scheme.
const SKIPPED = [
  /```[\s\S]*?```|``[^`]*?``|`[^`\n]*`/.source,
  // The markup's own groups made non-capturing, so the token below stays group 2.
  CUSTOM_EMOJI_MARKUP.replace(/\((?!\?)/g, '(?:'),
  /<t:-?\d+(?::[A-Za-z])?>|<https?:\/\/[^>\s]*>|https?:\/\/\S+/.source,
].join('|');
const SCAN_RE = new RegExp(`(${SKIPPED})|${/:([A-Za-z0-9_]{2,32}):(?!\/\/)/.source}`, 'g');
const NAME_TOKEN_RE = /^:([A-Za-z0-9_]{2,32}):$/;
const MARKUP_RE = new RegExp(`^${CUSTOM_EMOJI_MARKUP}$`);
/** The protocol token an interface writes for a custom emoji in a line's content, its group 1 the platform id. */
const EMOJI_TOKEN_RE = /<emoji:([^<>\s]+)>/g;

/** An emoji as the lookup answers it: the stable name, the current platform name and the platform id. */
export type NamedEmoji = { id: string; name: string; platformName: string; animated: boolean };
type EmojiLookup = (name: string) => NamedEmoji | null;

/** `<:name:id>` or `<a:name:id>` for one emoji, with its platform name. */
function markup(emoji: { id: string; platformName: string; animated: boolean }): string {
  return `<${emoji.animated ? 'a' : ''}:${emoji.platformName}:${emoji.id}>`;
}

/**
 * `text` with every `<emoji:ID>` token as `:stableName:` through `nameOf`. A token with no stable name reads as the
 * platform name `emojis` gives its id, between colons.
 */
export function nameEmojiTokens(
  text: string,
  nameOf: (nativeId: string) => string | null,
  emojis: ReadonlyArray<{ id: string; name: string }>
): string {
  return text.replace(EMOJI_TOKEN_RE, (_token, id: string) => {
    const name = nameOf(id) ?? emojis.find((emoji) => emoji.id === id)?.name ?? id;
    return `:${name}:`;
  });
}

/**
 * `text` with every `:name:` token outside code, markup, timestamps and URLs given to `replace`, which answers its
 * replacement or null to keep it. A kept token gives back its closing colon, which may open the next token.
 */
export function replaceNameTokens(text: string, replace: (name: string) => string | null): string {
  const re = new RegExp(SCAN_RE.source, 'g');
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    out += text.slice(last, match.index);
    if (match[1] !== undefined) {
      out += match[1];
      last = re.lastIndex;
      continue;
    }
    const replaced = replace(match[2]);
    if (replaced !== null) {
      out += replaced;
      last = re.lastIndex;
    } else {
      out += ':';
      last = match.index + 1;
      re.lastIndex = last;
    }
  }
  return out + text.slice(last);
}

/**
 * Replace every `:stableName:` the lookup knows with its custom emoji markup. Unknown names, code (inline and blocks), markup already well formed,
 * timestamps and URLs are left as they are, so the result is idempotent.
 */
export function renderCustomEmoji(text: string, lookup: EmojiLookup | null): string {
  const source = String(text ?? '');
  if (typeof lookup !== 'function' || !source.includes(':')) return source;
  return replaceNameTokens(source, (name) => {
    const emoji = lookup(name);
    return emoji ? markup(emoji) : null;
  });
}

/**
 * The body of a `<react>` as something `message.react()` accepts. A unicode
 * emoji passes through; `:stableName:` resolves through `lookup`; `<:name:id>` /
 * `<a:name:id>` keeps its own name and id. Without a lookup (the switch off, no index)
 * or for an unknown `:stableName:` the result is null: the reaction is dropped.
 */
export function resolveReactionEmoji(raw: string, lookup: EmojiLookup | null): string | null {
  const body = String(raw ?? '').trim();
  if (!body) return null;
  const token = NAME_TOKEN_RE.exec(body);
  const given = token ? null : MARKUP_RE.exec(body);
  if (!token && !given) return body;
  if (typeof lookup !== 'function') return null;
  if (given) return markup({ animated: given[1] === 'a', platformName: given[2], id: given[3] });
  const found = token ? lookup(token[1]) : null;
  return found ? markup(found) : null;
}
