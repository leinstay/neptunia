// The cleanup of a final media description: the describer runs it on the text it stores or returns, so the persona
// reads what was seen and no layout marks of the model. Emphasis around words, backticks, a heading mark and a list
// bullet at a line start are dropped, and an em dash becomes a comma. A lone asterisk or an underscore inside a word
// stays, because a sign or a name may hold one.

/** `text` with markdown emphasis, code marks, headings and bullets dropped and each em dash turned into a comma. */
export function plainDescription(text: string): string {
  return text
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/`/g, '')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/\s*—\s*/g, ', ');
}
