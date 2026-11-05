// What the merge gate of the development worker (src/development/worker.ts) reads a diff for: the one list of paths that
// hold a task at risk `high` whatever its thinker said, the reading of `git diff` that feeds it, and the answer of why
// `auto` may not merge. The list names folders and files, each with its category, and a reason shown to the persona is
// only ever a category, never a path.

/** Each category with the patterns of its paths, relative to the repository's root. */
export const DANGER_PATHS = [
  { category: 'deploy', paths: [/^deploy\//] },
  { category: 'keys', paths: [/^src\/keys\//] },
  { category: 'subharness', paths: [/^src\/subharness\//] },
  { category: 'board', paths: [/^src\/board\//] },
  // The whole folder but its reads, so a new file there counts as a write.
  { category: 'memory-db', paths: [/^src\/memory\/db\/(?!recall\.ts$|readers\/)/] },
  {
    category: 'permissions',
    paths: [
      /^src\/tools\/(?:access|gateway)\.ts$/,
      /^src\/tools\/impl\/(?:access|grants|rights|effects)\.ts$/,
      /^src\/interface\/principals\.ts$/,
      /^src\/agent-runner\/policy\.ts$/,
      /^agents\/[^/]+\/profile\.json$/,
      // The gate's own files: a change to them could open the gate it passes through.
      /^src\/development\/(?:worker|risk|changes|settings)\.ts$/,
      /^bin\/development\.ts$/,
      /^src\/selfimprovement\/settings\.ts$/,
      /^src\/config\/schema\/selfimprovement\.ts$/,
    ],
  },
  { category: 'ci', paths: [/^\.github\//] },
  {
    category: 'dependencies',
    paths: [/(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/],
  },
] as const;

export type DangerCategory = (typeof DANGER_PATHS)[number]['category'];

/** Why `auto` leaves a task waiting: a category of the list, the level on the board, or a diff nobody could read. */
export type Hold = DangerCategory | 'assessed' | 'unreadable';

/** Each category the paths touch, once, in the order of the list. */
export function dangerOf(paths: ReadonlyArray<string>): Array<DangerCategory> {
  const touched = DANGER_PATHS.filter((entry) =>
    paths.some((one) => entry.paths.some((pattern: RegExp) => pattern.test(one)))
  );
  return touched.map((entry) => entry.category);
}

/**
 * The paths of `git diff --name-status --no-renames -z`, which is a run of status and path fields, each ended by a NUL.
 * Null for anything else: with `--no-renames` no rename or copy row with its two paths can appear.
 */
function pathsOfNameStatus(stdout: string): Array<string> | null {
  const fields = stdout.split('\0');
  if (fields.pop() !== '' || fields.length % 2 !== 0) return null;
  const paths = fields.filter((_, at) => at % 2 === 1);
  const isRead = fields.every((field, at) => (at % 2 === 0 ? /^[ADMTUXB]$/.test(field) : field !== ''));
  return isRead ? paths : null;
}

/**
 * The categories of the diff of `range`, read from both sides of every rename. Null when git refuses it or its answer
 * holds no path, because a diff with no paths must not read as a harmless one.
 */
export async function readDanger(
  git: (args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string }>,
  range: string
): Promise<Array<DangerCategory> | null> {
  const diff = await git(['diff', '--name-status', '--no-renames', '-z', range, '--']);
  const paths = diff.code === 0 ? pathsOfNameStatus(diff.stdout) : null;
  return paths === null || paths.length === 0 ? null : dangerOf(paths);
}

/** Why `auto` may not merge a green pull request with this diff and this level; null when it may. */
export function holdOf(
  danger: ReadonlyArray<DangerCategory> | null,
  level: string,
  isUnassessed: boolean
): Hold | null {
  if (danger === null) return 'unreadable';
  const [first] = danger;
  if (first !== undefined) return first;
  return level !== 'low' || isUnassessed ? 'assessed' : null;
}
