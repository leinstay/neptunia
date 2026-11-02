#!/usr/bin/env node
// Copies supported personal overrides into an isolated persona root after a read-only conflict check.
import path from 'node:path';
import { applyPersonaLayers, planPersonaLayers } from '../src/config/persona-migration.ts';
import { CliError, runCli } from './lib/cli.ts';

const USAGE =
  'usage: node scripts/persona-files-move.ts --root <engine-root> --private <source-root> --data <target-root> [--apply]';

export function main(argv: Array<string>): Promise<string> {
  return Promise.resolve().then(() => {
    const flags = new Map<string, string>();
    let apply = false;
    for (let index = 0; index < argv.length; index++) {
      const flag = argv[index];
      if (flag === '--apply' && !apply) {
        apply = true;
        continue;
      }
      if (flag === undefined || !['--root', '--private', '--data'].includes(flag) || flags.has(flag))
        throw new CliError(USAGE);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new CliError(USAGE);
      flags.set(flag, value);
    }
    const root = flags.get('--root');
    const source = flags.get('--private');
    const target = flags.get('--data');
    if (!root || !source || !target) throw new CliError(USAGE);
    const options = { rootDir: path.resolve(root), privateDir: path.resolve(source), dataDir: path.resolve(target) };
    const plan = (apply ? applyPersonaLayers : planPersonaLayers)(options);
    const lines = [
      `${apply ? 'apply' : 'dry-run'} ${plan.steps.length} steps, ${plan.unchanged.length} unchanged, ${plan.held.length} held, ${plan.conflicts.length} conflicts`,
      ...plan.steps.map((step) => `${step.kind} ${step.source} -> ${step.target}`),
      ...plan.unchanged.map((file) => `unchanged ${file}`),
      ...plan.held.map((held) => `held ${held.path} ${held.reason}`),
      ...plan.conflicts.map((issue) => `${issue.path} ${issue.code}`),
    ];
    if (plan.held.length > 0) lines.push('Held items require later migration.');
    if (plan.conflicts.some((issue) => issue.code === 'legacy-tools'))
      lines.push('Run scripts/tools-file-move.ts separately.');
    const text = `${lines.join('\n')}\n`;
    if (plan.conflicts.length > 0) throw new CliError(text, { exitCode: 1 });
    return text;
  });
}

runCli(import.meta.url, main);
