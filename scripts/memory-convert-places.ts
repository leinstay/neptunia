// The one offline rebuild of a closed v28 memory database into neutral places. Stop every writer first, and run it over a
// copy when you can. Exit 0 converted, 1 refused (see `failures` in the report, no output is left), 2 usage.
//
//   node scripts/memory-convert-places.ts --input <memory.db> --output <new memory.db> \
//     --config-in <dir> --config-out <dir> --report <json> --now <iso>

import { convertFile } from '../src/memory/migration/convert.ts';

const NAMES = ['input', 'output', 'config-in', 'config-out', 'report', 'now'] as const;

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? '' : (process.argv[at + 1] ?? '');
}

const missing = NAMES.filter((name) => argument(name) === '');
if (missing.length > 0) {
  process.stderr.write(
    `usage: memory-convert-places --${NAMES.join(' <value> --')} <value>; missing ${missing.join(', ')}\n`
  );
  process.exit(2);
}
process.exit(
  convertFile({
    input: argument('input'),
    output: argument('output'),
    configIn: argument('config-in'),
    configOut: argument('config-out'),
    report: argument('report'),
    now: argument('now'),
  })
);
