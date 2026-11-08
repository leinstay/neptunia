// The chat's images at the process edge: the clipboard's and the viewer's processes, staging in the data root, and what
// happens to a file the persona sends. bin/neptunia.ts hands these to the chat (cli/) and to `-p --attach`.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAttachmentActions } from '../cli/attachment-actions.ts';
import type { AttachmentActions } from '../cli/attachment-actions.ts';
import { createClipboard } from '../cli/clipboard.ts';
import { assembleDraft, draftFromText } from '../cli/composer.ts';
import { editExternally } from '../cli/editor-actions.ts';
import type { ProcessRun } from '../cli/clipboard.ts';
import type { ChatAttachment, ChatImages, LineFiles } from '../cli/index.ts';
import { keptLocation, keptReference, openableLine } from '../src/media/kept-files.ts';
import { openImageStaging, stagedIdOf, stagingDir } from '../src/media/staging.ts';
import type { StagedImage, StageRefusal } from '../src/media/staging.ts';
import type { Attachment } from '../src/protocol/actions.ts';

/** A clipboard read waits this long for its tool; decided 2026-11-05, a clipboard answers at once or hangs. */
const TOOL_TIMEOUT_MS = 5000;
/** The most a clipboard read collects: past the staging limit anyway, and a hung tool cannot fill the memory. */
const TOOL_OUTPUT_BYTES = 32 * 1024 * 1024;
/** What the persona may send: one file of the socket's frame, as src/protocol/wire.ts sizes it. */
export const RECEIVED_FILE_BYTES = 10 * 1024 * 1024;

/** An editor owns the terminal until it ends. */
const runEditor = (argv: ReadonlyArray<string>): Promise<{ code: number }> =>
  new Promise((resolve, reject) => {
    const [command = '', ...args] = argv;
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1 }));
  });

const homePath = (file: string): string =>
  file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file;

const STAGE_REFUSALS: Readonly<Record<StageRefusal, string>> = {
  'invalid-image': 'it is not a PNG, JPEG, GIF or WebP image',
  'too-large': 'it is larger than the image reader takes',
  vanished: 'the file cannot be read',
  failed: 'it could not be kept in the staging folder',
};

/** Stages the files of `-p --attach` in order. A refusal frees what came before it and names the file and the reason. */
export async function stageForPrompt(
  dataDir: string,
  files: ReadonlyArray<string>
): Promise<{ ok: true; staged: Array<StagedImage> } | { ok: false; reason: string }> {
  const staging = openImageStaging(dataDir);
  const staged: Array<StagedImage> = [];
  for (const file of files) {
    const result = await staging.stageAttachment(homePath(file));
    if (!result.ok) {
      for (const one of staged) await staging.release(one.id);
      return { ok: false, reason: `cannot attach ${path.basename(file)}: ${STAGE_REFUSALS[result.code]}` };
    }
    staged.push(result.staged);
  }
  return { ok: true, staged };
}

const runTool: ProcessRun = (argv) =>
  new Promise((resolve) => {
    const [command = '', ...args] = argv;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: TOOL_TIMEOUT_MS });
    const chunks: Array<Buffer> = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= TOOL_OUTPUT_BYTES) chunks.push(chunk);
      else child.kill();
    });
    child.once('error', (err: NodeJS.ErrnoException) =>
      resolve({ code: 127, stdout: new Uint8Array(), missing: err.code === 'ENOENT' })
    );
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks) }));
  });

/** The chat's way to acquire and stage an image. Each staging also removes what outlived its lifetime. */
export function chatImages(dataDir: string): ChatImages {
  const staging = openImageStaging(dataDir);
  const clipboard = createClipboard({ platform: process.platform, env: process.env, run: runTool });
  const swept = (): void => void staging.sweep();
  return {
    clipboard: () => clipboard.read(),
    stageBytes: (bytes, details) => {
      swept();
      return staging.stageBytes(bytes, details);
    },
    stageFile: (file) => {
      swept();
      return staging.stageAttachment(homePath(file));
    },
    release: (id) => staging.release(id),
  };
}

/**
 * Open, save and the text alternative of a received image, and open and save of a kept file of a numbered line. A viewer's
 * file lives in the staging folder, and goes with its sweep. A saved kept file never replaces a file already there.
 */
export function receivedActions(dataDir: string): AttachmentActions {
  const staging = openImageStaging(dataDir, RECEIVED_FILE_BYTES);
  return createAttachmentActions({
    read: (attachment) => {
      const id = stagedIdOf(attachment.reference);
      return id === null ? Promise.resolve(null) : staging.read(id);
    },
    writeFile: (file, bytes) => fs.writeFile(homePath(file), bytes, { mode: 0o600 }),
    run: runTool,
    platform: process.platform,
    tempDir: stagingDir(dataDir),
    copyFile: (from, to) => fs.copyFile(from, homePath(to), constants.COPYFILE_EXCL),
  });
}

/** The files of a numbered line as the core's `session.line` answers them, each kept path made absolute in `dataDir`. */
export function lineFilesOf(
  dataDir: string,
  answer: { text: string; status: string; code?: string },
  number: number
): LineFiles {
  if (answer.status !== 'ok')
    return {
      ok: false,
      reason:
        answer.code === 'unknown-line'
          ? `No line #${number} in this chat.`
          : `The files of line #${number} could not be read (${answer.status}).`,
    };
  const { files } = JSON.parse(answer.text) as { files: Array<{ name: string; kind: string; path: string | null }> };
  return {
    ok: true,
    files: files.map((file) => ({
      name: file.name,
      kind: file.kind,
      path: file.path === null ? null : keptLocation(dataDir, keptReference(file.path)),
    })),
  };
}

/** The chat's external editor: `$VISUAL` or `$EDITOR` split on spaces with no shell, and the draft in a private temporary file. */
export function draftEditor(
  env: Readonly<Record<string, string | undefined>>
): (text: string) => Promise<{ status: 'edited' | 'cancelled' | 'failed'; text: string }> {
  return async (text) => {
    const command = (env.VISUAL ?? env.EDITOR ?? '').split(' ').filter((word) => word !== '');
    if (command.length === 0) return { status: 'failed', text };
    const result = await editExternally(draftFromText('editor', text, text.length), {
      command,
      tempDir: os.tmpdir(),
      run: runEditor,
    });
    const assembled = assembleDraft(result.draft);
    return { status: result.status, text: assembled.ok ? assembled.text : text };
  };
}

/**
 * What a chat shows for a file the persona sent: a kept image, or a line with the path of the copy the core kept in the
 * data folder (src/chat/kept-media.ts) for a file the terminal cannot show, or a line saying what could not be kept.
 */
export async function keepReceived(
  dataDir: string,
  file: Attachment
): Promise<{ attachment: ChatAttachment } | { note: string }> {
  const openable = openableLine(dataDir, file);
  if (file.data === undefined) return { note: openable ?? `[file ${file.name}] ${file.url ?? ''}`.trim() };
  const staging = openImageStaging(dataDir, RECEIVED_FILE_BYTES);
  const kept = await staging.stageBytes(file.data, { name: file.name });
  if (kept.ok) return { attachment: kept.staged };
  return { note: openable ?? `[file ${file.name}] not kept: ${STAGE_REFUSALS[kept.code]}` };
}
