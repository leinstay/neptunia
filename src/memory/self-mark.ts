// The marker a stored media description names the persona by. The vision model writes it for a figure that matches
// her appearance (prompts/describe-self.md), and every reader that hands a description to a model fills it with her
// name in that place, so one stored description serves every root and survives a rename.

/** The marker a stored description holds where it means the persona. */
export const SELF_MARK = '@self';

const MARK = new RegExp(`(?<![\\w@.])${SELF_MARK}(?![\\w@-])`, 'g');

/** `text` with every whole `SELF_MARK` token replaced by `name`; a longer word that contains the marker stays. */
export function fillSelfMark(text: string, name: string): string {
  return text.replace(MARK, () => name);
}

/**
 * `text` with every whole-word `name` replaced by `SELF_MARK`, the inverse of `fillSelfMark`; a longer word that
 * contains the name stays, and an empty name leaves `text` as it is.
 */
export function markSelf(text: string, name: string): string {
  if (!name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), SELF_MARK);
}
