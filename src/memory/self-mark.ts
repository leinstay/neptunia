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
