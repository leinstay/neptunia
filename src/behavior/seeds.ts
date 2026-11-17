// The seeds files of the prompts: families of short lines under `# name` headings, and the draw of a few lines from
// them. The diary's planner and writer draw from `prompts/diary-seeds.md` (src/turn/diary.ts), a heartbeat from
// `prompts/heartbeat-seeds.md` (src/turn/phases/request/build.ts). Pure: the random source is injected.

import { shuffled } from './random.ts';

/** The family of the lines a file holds before its first heading. */
const DEFAULT_FAMILY = 'seed';

/** How many families a heartbeat's fragments come from, and how many lines of each. */
const FRAGMENT_FAMILIES = 2;
const FRAGMENT_LINES = 2;

/**
 * The families of a seeds file: a `# name` line starts a family, every other non-blank line (trimmed) is one seed of
 * the current family; lines before the first header belong to the family `seed`. Families keep their header order; a
 * header with no lines is an empty family.
 */
export function parseSeedFamilies(text: unknown): Record<string, Array<string>> {
  const families: Record<string, Array<string>> = {};
  if (typeof text !== 'string') return families;
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^#+\s*(.+)$/.exec(line);
    if (header) {
      current = header[1].trim();
      families[current] ??= [];
      continue;
    }
    if (current === null) {
      current = DEFAULT_FAMILY;
      families[current] ??= [];
    }
    families[current].push(line);
  }
  return families;
}

/**
 * `sets` (diary.seedSets) seed combinations from `families` (parseSeedFamilies): each one random line of every
 * non-empty family, in the families' order. A line in `used` (usedSeedLines) is left out while its family has another
 * line; a family whose every line is used is drawn from whole. The combinations of one draw share no line of a family
 * while the family has a line left for each of them; a family with fewer lines than combinations repeats once its lines
 * are taken. [] when no family has a line or `sets` is not a positive count.
 */
export function pickSeeds(
  families: unknown,
  sets: unknown,
  rng: () => number,
  used: ReadonlySet<string> = new Set()
): Array<Array<unknown>> {
  const source: object = families && typeof families === 'object' ? families : {};
  const values: Array<unknown> = Object.values(source);
  const lists = values
    .filter((lines): lines is Array<unknown> => Array.isArray(lines) && lines.length > 0)
    .map((lines) => {
      const fresh = lines.filter((line) => typeof line !== 'string' || !used.has(line));
      return fresh.length > 0 ? fresh : lines;
    });
  const count = typeof sets === 'number' && Number.isFinite(sets) && sets > 0 ? Math.floor(sets) : 0;
  if (lists.length === 0 || count === 0) return [];
  // One draw takes a line out of its family for each combination, so the combinations differ while a line is left.
  const left = lists.map((lines) => [...lines]);
  const result: Array<Array<unknown>> = [];
  for (let i = 0; i < count; i += 1) {
    result.push(
      lists.map((lines, family) => {
        const rest = left[family].length > 0 ? left[family] : (left[family] = [...lines]);
        const [line] = rest.splice(Math.min(rest.length - 1, Math.floor(rng() * rest.length)), 1);
        return line;
      })
    );
  }
  return result;
}

/**
 * A heartbeat's fragments from the text of a seeds file: `FRAGMENT_FAMILIES` families drawn with `rng` among those with
 * a line, `FRAGMENT_LINES` different lines of each drawn as pickSeeds draws them, all of them in one shuffled list that
 * names no family. [] for a missing or empty file.
 */
export function drawFragments(text: unknown, rng: () => number): Array<string> {
  const families = Object.entries(parseSeedFamilies(text)).filter(([, lines]) => lines.length > 0);
  const chosen = Object.fromEntries(shuffled(families, rng).slice(0, FRAGMENT_FAMILIES));
  const lines = pickSeeds(chosen, FRAGMENT_LINES, rng).flat();
  return shuffled([...new Set(lines.filter((line): line is string => typeof line === 'string'))], rng);
}
