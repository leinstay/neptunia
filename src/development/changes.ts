// What the development worker (src/development/worker.ts) reads out of git, gh and the test runner, as pure functions:
// the paths a change touched, the test files they call for, the counts of a TAP report and a pull request as gh shows it.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const firstLine = (text: string): string =>
  text
    .split('\n')
    .find((line) => line.trim() !== '')
    ?.trim() ?? '';

export const linesOf = (text: string): Array<string> => text.split('\n').filter((line) => line.trim() !== '');

/** The paths of `git status --porcelain`: the new name of a rename, a quoted name unquoted. */
export function pathsOfStatus(output: string): Array<string> {
  return linesOf(output).map((line) => {
    const named = line.slice(3);
    const arrow = named.indexOf(' -> ');
    const one = arrow < 0 ? named : named.slice(arrow + 4);
    if (!one.startsWith('"') || !one.endsWith('"')) return one;
    try {
      return String(JSON.parse(one));
    } catch {
      return one.slice(1, -1);
    }
  });
}

/** The test files a change calls for: a changed test as it is, a changed module's tests by the names of code-health. */
export function testsFor(
  changed: ReadonlyArray<string>,
  exists: (relative: string) => boolean
): { files: Array<string>; uncovered: Array<string> } {
  const files = new Set<string>();
  const uncovered: Array<string> = [];
  for (const file of changed) {
    if (/^tests\/.+\.test\.[cm]?[jt]s$/.test(file)) {
      if (exists(file)) files.add(file);
      continue;
    }
    if (file.startsWith('tests/')) continue;
    const parts = file.replace(/\.[^./]+$/, '').split('/');
    const found = parts.map((_, at) => `tests/${parts.slice(at).join('-')}.test.ts`).filter((name) => exists(name));
    for (const name of found) files.add(name);
    if (found.length === 0) uncovered.push(file);
  }
  return { files: [...files], uncovered };
}

/** The count a TAP report states on a `# <name> N` line, or 0. */
export function tapCount(output: string, name: string): number {
  const found = new RegExp(`^# ${name} (\\d+)`, 'm').exec(output);
  return found === null ? 0 : Number(found[1]);
}

/** Whether a check of `statusCheckRollup` finished successfully (a check run or a commit status). */
function succeeded(check: unknown): boolean {
  if (!isRecord(check)) return false;
  if (typeof check.state === 'string') return check.state === 'SUCCESS';
  return check.status === 'COMPLETED' && check.conclusion === 'SUCCESS';
}

export type PullRequest = {
  state: string;
  title: string;
  isDraft: boolean;
  files: Array<string>;
  /** Every check finished successfully, and there is at least one. */
  isGreen: boolean;
  branch: string;
  head: string;
};

/** `gh pr view --json ...` as the fields the worker reads, or null when the answer is not one. */
export function pullRequestOf(stdout: string): PullRequest | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.state !== 'string') return null;
  const files = Array.isArray(data.files)
    ? data.files.map((one) => (isRecord(one) ? one.path : null)).filter((one): one is string => typeof one === 'string')
    : [];
  const checks: ReadonlyArray<unknown> = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
  return {
    state: data.state,
    title: typeof data.title === 'string' ? data.title : '',
    isDraft: data.isDraft === true,
    files,
    isGreen: checks.length > 0 && checks.every(succeeded),
    branch: typeof data.headRefName === 'string' ? data.headRefName : '',
    head: typeof data.headRefOid === 'string' ? data.headRefOid : '',
  };
}

/** The first row of `gh pr list --json number,url,headRefOid`, or null when there is none. */
export function listedPullRequest(stdout: string): { number: number; url: string; head: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const row: unknown = Array.isArray(data) ? data[0] : null;
  if (!isRecord(row) || typeof row.number !== 'number') return null;
  return {
    number: row.number,
    url: typeof row.url === 'string' ? row.url : '',
    head: typeof row.headRefOid === 'string' ? row.headRefOid : '',
  };
}
