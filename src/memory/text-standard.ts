// The check behind the English standard of stored text (docs/prompt-contract.md): whether the letters of a think or a media
// description are mostly of another script. What stands in quotes is left out, because speech, captions and on-screen text
// are quoted in their original language. Pure and with no model: code counts and marks, and nothing here decides what she
// says or edits a word.

/** A closed pair of quotes, with what it holds. An apostrophe is no quote mark, and a mark with no partner hides nothing. */
const QUOTED = /"[^"]*"|«[^»]*»|“[^”]*”|„[^“”]*[“”]|‘[^’]*’|「[^」]*」|『[^』]*』/gu;

/**
 * Whether more than half of the letters of `text` outside quotes are of a script other than Latin. A text with no letters is
 * on script, and so is an even mix.
 */
export function isOffScript(text: string): boolean {
  const unquoted = text.replace(QUOTED, ' ');
  const letters = unquoted.match(/\p{L}/gu)?.length ?? 0;
  const latin = unquoted.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return letters - latin > latin;
}
