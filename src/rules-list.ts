// The rules list of the rules prompt file: the `- ` bullets `/rules` lists, adds to and removes from. A rules file
// reaches a request only while this list holds a rule, so an empty list costs a request nothing.

/**
 * Locate the bullet lines (`- …`) that belong to the rules list: those under
 * the LAST `## ` heading of the file, in whatever language it is written.
 * When the file has no `## ` heading at all, every top-level bullet counts.
 */
export function locateBullets(text: string): { lines: Array<string>; indices: Array<number> } {
  const lines = text.split('\n');
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^## /.test(lines[i] ?? '')) {
      headingIdx = i;
      break;
    }
  }

  let start = 0;
  let end = lines.length;

  if (headingIdx !== -1) {
    start = headingIdx + 1;
    end = lines.length;
    for (let i = start; i < lines.length; i += 1) {
      if (/^#/.test(lines[i] ?? '')) {
        end = i;
        break;
      }
    }
  }

  const indices: Array<number> = [];
  for (let i = start; i < end; i += 1) {
    if (/^- /.test(lines[i] ?? '')) indices.push(i);
  }
  return { lines, indices };
}

/**
 * Bullet texts (lines starting with `- `) under the last `## ` heading of the
 * file, in order. When the file has no `## ` heading at all, every top-level
 * `- ` bullet in the file is returned instead.
 */
export function listRules(rulesText: string | null | undefined): Array<string> {
  const { lines, indices } = locateBullets(rulesText ?? '');
  return indices.map((i) => (lines[i] ?? '').slice(2).trimEnd());
}

/** The rules file as a system text carries it: whole while its list holds a rule, else nothing. */
export function rulesPromptOf(rulesText: unknown): string {
  return typeof rulesText === 'string' && listRules(rulesText).length > 0 ? rulesText : '';
}
