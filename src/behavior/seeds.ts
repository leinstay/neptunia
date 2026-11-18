// The seeds files of the prompts: one file per family, one seed per line, and the draw of a few lines from them. The
// diary's director draws its sets from the files of `prompts/diary/seeds/` (src/behavior/diary-scene.ts) and a heartbeat
// from those of `prompts/heartbeat/seeds/` (src/turn/phases/request/build.ts). Pure: the random source is injected.

import { shuffled } from './random.ts';

/** How many families a heartbeat's fragments come from, and how many lines of each. */
const FRAGMENT_FAMILIES = 2;
const FRAGMENT_LINES = 2;

/** The seeds of one family's file: every non-blank line, trimmed, is one seed. [] for a missing file. */
export function seedLines(text: unknown): Array<string> {
  return typeof text === 'string' ? text.split(/\r?\n/).flatMap((raw) => (raw.trim() ? [raw.trim()] : [])) : [];
}

/**
 * `sets` seed combinations from `families` (`{ name: seeds }`): each one random line of every
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
 * A heartbeat's fragments from the texts of its seeds files by name (`files`, one family each, taken in name order):
 * `FRAGMENT_FAMILIES` families drawn with `rng` among those with a line, `FRAGMENT_LINES` different lines of each drawn
 * as pickSeeds draws them, all of them in one shuffled list that names no family. [] when no file holds a line.
 */
export function drawFragments(files: Readonly<Record<string, unknown>>, rng: () => number): Array<string> {
  const families = Object.keys(files)
    .sort()
    .map((name): [string, Array<string>] => [name, seedLines(files[name])])
    .filter(([, lines]) => lines.length > 0);
  const chosen = Object.fromEntries(shuffled(families, rng).slice(0, FRAGMENT_FAMILIES));
  const lines = pickSeeds(chosen, FRAGMENT_LINES, rng).flat();
  return shuffled([...new Set(lines.filter((line): line is string => typeof line === 'string'))], rng);
}
