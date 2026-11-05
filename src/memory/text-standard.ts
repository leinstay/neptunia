// The standard of a stored text form (docs/prompt-contract.md): English, with speech, captions and on-screen text quoted in
// their original language. Pure: it reads letters, never a model. A transcript or what she voiced is quoted speech as a whole,
// so only the text forms a model writes about what it sees are checked.

/** Text inside a pair of quotation marks of any common kind. */
const QUOTED = /"[^"]*"|“[^”]*”|«[^»]*»|„[^“”]*[“”]|「[^」]*」/g;
const LETTER = /\p{L}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;

/** Whether the letters outside quotation marks are mostly of a script other than Latin. */
export function offTextStandard(text: string): boolean {
  const outside = text.replace(QUOTED, ' ');
  const letters = outside.match(LETTER)?.length ?? 0;
  if (letters === 0) return false;
  const latin = outside.match(LATIN_LETTER)?.length ?? 0;
  return latin * 2 < letters;
}
