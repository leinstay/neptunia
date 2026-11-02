// What the engine of a runner (src/agent-runner/backend.ts) shares: the prompt file of a profile with its override, the
// task's brief, the process-group kill, and the files an agent leaves in its working directory with the check that
// drops what carries a secret. The OpenCode binary's default path lives here too.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { log } from '../log.ts';
import { errorFields } from '../error-fields.ts';
import { objOf, scalarText } from '../tools/types.ts';
import { containsSecret, isFiltered } from './policy.ts';
import type { RunnerTask, RunOutcome } from './protocol.ts';
import type { Profile } from './profiles.ts';

/** The OpenCode binary by default. */
export const DEFAULT_OPENCODE_PATH = '/opt/opencode/bin/opencode';
/** A file's content type by extension (the result's `contentType`). */
const CONTENT_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
]);

/** The read errors that make an override (any file but the last) count as absent. */
const UNREADABLE_CODES = new Set(['EACCES', 'EPERM']);
/** The overrides already reported unreadable (one warning per file per process). */
const warnedUnreadable = new Set<string>();

/**
 * The text of the first existing file of `paths` (a local override first,
 * then the tracked file). An override that exists but this process may not
 * read (EACCES, EPERM: the runner's user lacks access to the private
 * directory) counts as absent, with one `profiles: override unreadable`
 * warning per file per process; the last file's read errors, and any other
 * error, still throw. Throws naming the paths when none exists, or when the
 * chosen file is empty. `read` is injectable for tests.
 */
export function readPromptFile(
  paths: Array<string>,
  { read = (file: string) => fs.readFileSync(file, 'utf8') }: { read?: (file: string) => string } = {}
): string {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p);
  for (const [index, file] of list.entries()) {
    let text: string;
    try {
      text = read(file);
    } catch (err) {
      const { code } = errorFields(err);
      if (code === 'ENOENT') continue;
      if (index < list.length - 1 && typeof code === 'string' && UNREADABLE_CODES.has(code)) {
        if (!warnedUnreadable.has(file)) {
          warnedUnreadable.add(file);
          log.warn('profiles: override unreadable', { file, reason: code });
        }
        continue;
      }
      throw err;
    }
    const trimmed = text.replace(/^﻿/, '').trim();
    if (!trimmed) throw new Error(`agent-runner: prompt file empty: ${file}`);
    return trimmed;
  }
  throw new Error(`agent-runner: prompt file missing: ${list.join(', ') || '(none given)'}`);
}

/** The task prompt: the goal and, when present, the context as JSON. */
export function taskPrompt(goal: unknown, context: unknown): string {
  const parts = [`<goal>\n${scalarText(goal ?? '').trim()}\n</goal>`];
  const ctx = objOf(context);
  const shown = Object.fromEntries(Object.entries(ctx).filter(([key]) => key !== 'scope'));
  if (Object.keys(shown).length) parts.push(`<context>\n${JSON.stringify(shown, null, 1)}\n</context>`);
  return parts.join('\n');
}

/** Kill `child` and its process group. */
export function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** A file of a task's result. */
type ResultFile = { path: string; name: string; contentType: string; bytes: number };

/** OpenCode's own files in the task directory (its HOME): never a result. */
const NOT_A_RESULT = /^(\.|opencode\.db)/;

/** The files the agent saved under `dir` (recursively), as result file handles; OpenCode's own files skipped. */
export async function collectFiles(dir: string, id: string): Promise<Array<ResultFile>> {
  const base = path.join(dir, id);
  const out: Array<ResultFile> = [];
  async function walk(current: string): Promise<void> {
    let entries: Array<Dirent>;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (NOT_A_RESULT.test(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        let bytes = 0;
        try {
          bytes = (await fsp.stat(full)).size;
        } catch {
          continue;
        }
        out.push({
          path: full,
          name: entry.name,
          contentType: CONTENT_TYPES.get(path.extname(entry.name).toLowerCase()) ?? '',
          bytes,
        });
      }
    }
  }
  await walk(base);
  return out;
}

/** The bytes read to tell a text file from a binary one (a NUL in them = binary). */
const SNIFF_BYTES = 8 * 1024;
/** The largest file scanned for secrets (2 MB). A binary file or a bigger one is delivered unscanned:
 * the scan guards against a copied secret file (.env, a key file), which is small text. */
const SCAN_MAX_BYTES = 2 * 1024 * 1024;

/** Whether the file at `file` is text no larger than SCAN_MAX_BYTES and carries a secret
 * (src/agent-runner/policy.ts#containsSecret). An unreadable file counts as carrying one. */
async function fileCarriesSecret(file: ResultFile): Promise<boolean> {
  if (file.bytes > SCAN_MAX_BYTES) return false;
  let content: Buffer;
  try {
    content = await fsp.readFile(file.path);
  } catch {
    return true;
  }
  if (content.subarray(0, SNIFF_BYTES).includes(0)) return false;
  return containsSecret(content.toString('utf8'));
}

/**
 * The result files actually delivered, and the ones dropped with their reason. In a filtered scope a
 * run that reached a withheld path delivers no file (reason `withheld`): a `cp` that slipped past the
 * rules could have copied the withheld file whole. In every scope, `core` included, a text file that
 * carries a secret is dropped (reason `secret`). Nothing of a file's content is logged.
 */
export async function deliverableFiles(
  collected: Array<ResultFile>,
  { scope, withheldCount }: { scope: string; withheldCount: number }
): Promise<{ files: Array<ResultFile>; dropped: Array<{ name: string; reason: 'withheld' | 'secret' }> }> {
  if (isFiltered(scope) && withheldCount > 0) {
    return { files: [], dropped: collected.map((f) => ({ name: f.name, reason: 'withheld' as const })) };
  }
  const files: Array<ResultFile> = [];
  const dropped: Array<{ name: string; reason: 'withheld' | 'secret' }> = [];
  for (const file of collected) {
    if (await fileCarriesSecret(file)) dropped.push({ name: file.name, reason: 'secret' });
    else files.push(file);
  }
  return { files, dropped };
}

/** What `createAgentEngine` (src/agent-runner/backend.ts) takes besides the subharness. */
export type RunnerDeps = {
  profile: Profile;
  outDir: string;
  env?: Record<string, string | undefined>;
  opencodePath?: string;
  openrouterKeyEnv?: string;
  searchKeyEnv?: string;
  proxyEnv?: string;
  getConfig?: () => unknown;
  now?: () => number;
  spawnImpl?: typeof spawn;
};

/** The task engine the runner server calls, and the check of its prompt file. */
export type Runner = { run: (task: RunnerTask) => Promise<RunOutcome>; checkPrompt: () => string };
