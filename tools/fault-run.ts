// The fault run: the real core over a scripted model and the fake interface, and simulated weeks over a fake clock,
// with every side effect counted by its effect key (tools/lib/fault-run.ts). The run passes when no key repeats and
// every expected effect happened once. Nothing leaves the process: no provider, no platform, no real data folder.
//
// Usage (from the checkout):
//   node tools/fault-run.ts [--rounds <n>] [--repeats <n>] [--weeks all|<name>,<name>] [--short]
//
// The default is the long run: 10 rounds of the live-core scenarios, 50 deliveries of each repeated event, every week
// fixture of tools/fixtures/inner-week/. `--short` is the run the suite makes (tests/fault-run.test.ts). The other
// flags override one number of the chosen plan. The exit code is 0 when the run passed and 1 when a key repeated or an
// expected effect is missing. The table goes to stdout.
import { CliError, parseFlags, runCli } from './lib/cli.mjs';
import { LONG_PLAN, SHORT_PLAN, faultRun, tableOf } from './lib/fault-run.ts';
import type { Plan } from './lib/fault-run.ts';

const USAGE = 'usage: node tools/fault-run.ts [--rounds <n>] [--repeats <n>] [--weeks all|<name>,<name>] [--short]';

/** A positive whole number, or a CliError naming `flag`. */
function countOf(flag: string, value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new CliError(`fault-run: ${flag} must be a whole number of 1 or more`);
  return number;
}

/** The plan the arguments ask for. */
export function parseArgs(argv: ReadonlyArray<string>): Plan {
  const flags: object = parseFlags([...argv], {
    values: ['--rounds', '--repeats', '--weeks'],
    switches: ['--short'],
    usage: USAGE,
  });
  const rest: unknown = Reflect.get(flags, '_');
  if (Array.isArray(rest) && rest.length > 0) throw new CliError(USAGE);
  const base = Reflect.get(flags, '--short') === true ? SHORT_PLAN : LONG_PLAN;
  const rounds: unknown = Reflect.get(flags, '--rounds');
  const repeats: unknown = Reflect.get(flags, '--repeats');
  const weeks: unknown = Reflect.get(flags, '--weeks');
  return {
    rounds: typeof rounds === 'string' ? countOf('--rounds', rounds) : base.rounds,
    repeats: typeof repeats === 'string' ? countOf('--repeats', repeats) : base.repeats,
    weeks:
      typeof weeks === 'string'
        ? weeks === 'all'
          ? 'all'
          : weeks.split(',').filter((name) => name !== '')
        : base.weeks,
  };
}

export async function main(argv: ReadonlyArray<string>): Promise<string> {
  const plan = parseArgs(argv);
  const report = await faultRun(plan, (row) => process.stderr.write(`fault-run: ${row.scenario} done\n`));
  const table = tableOf(report);
  if (!report.ok) throw new CliError(table);
  return table;
}

runCli(import.meta.url, main);
