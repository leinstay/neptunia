// The whole test run's guard against the machine's service manager, loaded with `--test-global-setup` by `npm test` and
// CI. A test reaching the real `sudo` or `systemctl` moves the units of the server it runs on, so a refusing script of
// each name goes first on the PATH every test process inherits. Each call is recorded, and the run fails at its end when
// the record is not empty, naming the argv and the test file that made the call. A test with a manager of its own injects
// it, or sets a PATH of its own holding a fake.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANAGER_COMMANDS = ['sudo', 'systemctl'] as const;
const RECORD = 'calls.log';

let folder: string | null = null;

/** A script that records its name, its argv and the command line of the process that called it, and refuses. */
const refusing = (name: string, record: string): string => `#!/bin/sh
printf '%s\\n' "${name} $* | called by: $(tr '\\0' ' ' < /proc/$PPID/cmdline 2>/dev/null)" >> '${record}'
echo "${name}: refused by tests/fixtures/refuse-manager.ts, inject a fake manager" >&2
exit 1
`;

export function globalSetup(): void {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-refuse-manager-'));
  const record = path.join(folder, RECORD);
  for (const name of MANAGER_COMMANDS)
    fs.writeFileSync(path.join(folder, name), refusing(name, record), { mode: 0o755 });
  process.env.PATH = `${folder}${path.delimiter}${process.env.PATH ?? ''}`;
}

export function globalTeardown(): void {
  if (folder === null) return;
  const record = path.join(folder, RECORD);
  const calls = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim() : '';
  fs.rmSync(folder, { recursive: true, force: true });
  if (calls !== '') {
    // The runner swallows the message of a throw here, and the exit code is what fails the run.
    console.error(`a test reached the machine's service manager; inject a fake one:\n${calls}`);
    process.exitCode = 1;
  }
}
