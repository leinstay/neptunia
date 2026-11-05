// The self-development step of `neptunia setup` (src/setup/run.ts, docs/setup.md): the repository her pull requests go
// to. While `selfimprovement.checkout` is unset the step is skipped and asks nothing. A stored `selfimprovement.repository` that still
// passes the push-right check (src/selfimprovement/repository.ts) is `already`. Otherwise the owner is asked at the terminal,
// with the `owner/name` of the dev checkout's `origin` offered, and the answer is checked through the system's gh login. A
// repository she can push to is written into `<private>/config.local/config.json`, every other key kept. A refused one
// writes nothing, and the step's detail is the check's line.

import { readConfig } from '../config.ts';
import { localConfigPath } from '../config/files.ts';
import { readLabels } from '../hot.ts';
import { checkRepository, repositoryOfRemote } from '../selfimprovement/repository.ts';
import type { GhRunner, RepositoryFailure } from '../selfimprovement/repository.ts';
import { selfimprovementSettings } from '../selfimprovement/settings.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../tools/impl/shared.ts';
import type { RunResult } from './install.ts';

export type SelfimprovementStepDeps = {
  run(command: string, args: ReadonlyArray<string>): Promise<RunResult>;
  /** asks the owner at the terminal; `offered` is shown as the default and an empty answer takes it */
  ask(question: string, offered: string | null): Promise<string>;
  gh: GhRunner;
};
export type SelfimprovementStepOutcome = {
  state: 'done' | 'already' | 'skipped' | 'refused';
  /** the check's line when refused */
  detail: string;
  /** the check's code, null when skipped */
  code: 'ok' | RepositoryFailure | null;
};

/** The question of the step. */
const QUESTION = 'The GitHub repository her pull requests go to, as owner/name:';

export async function selfimprovementStep(
  options: { rootDir: string; privateDir: string },
  deps: SelfimprovementStepDeps
): Promise<SelfimprovementStepOutcome> {
  const settings = selfimprovementSettings(readConfig(options.rootDir, { privateDir: options.privateDir }));
  if (settings.checkout === null) return { state: 'skipped', detail: 'selfimprovement.checkout is unset', code: null };
  const labels = readLabels(options.rootDir, options.privateDir);
  if (settings.repository !== null) {
    const stored = await checkRepository(settings.repository, deps.gh, labels);
    if (stored.code === 'ok')
      return { state: 'already', detail: `her pull requests go to ${stored.repository}`, code: 'ok' };
  }
  const origin = await deps.run('git', ['-C', settings.checkout, 'remote', 'get-url', 'origin']);
  const offered = origin.code === 0 ? repositoryOfRemote(origin.stdout) : null;
  const answer = (await deps.ask(QUESTION, offered)).trim();
  const chosen = answer === '' ? offered : answer;
  const check = await checkRepository(chosen, deps.gh, labels);
  if (check.code !== 'ok') return { state: 'refused', detail: check.line, code: check.code };
  const file = localConfigPath(options.privateDir);
  writeLocalConfig(file, setPath(readLocalConfig(file), ['selfimprovement', 'repository'], check.repository));
  return { state: 'done', detail: `her pull requests go to ${check.repository}`, code: 'ok' };
}
