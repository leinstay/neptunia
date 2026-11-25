// Shared by tests/agent-backend-*.test.ts: the stub binary (tests/fixtures/fake-cli.ts), a scratch directory and the
// report the stub writes about what it was given.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The stub that mimics `codex exec` and `claude -p`. */
export const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.ts');

/** What the stub reports in mode `report`. */
export type StubReport = {
  argv: Array<string>;
  stdin: string;
  last: string;
  cwd: string;
  env: Record<string, string>;
};

/** A fresh scratch directory, removed by the caller's `cleanup`. */
export function scratch(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'backend-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Parses the final message of a stub run in mode `report`. */
export function reportOf(text: string): StubReport {
  return JSON.parse(text) as StubReport;
}

/** True while a process with `pid` is alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
