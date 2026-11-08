// Reading an image from the clipboard of the machine this process runs on, through the platform's own tool with literal
// argv. Over SSH that machine is the server, so the clipboard is unavailable and no process starts: the owner's laptop is
// out of reach and `/attach <file>` is the way in. bin/chat-images.ts gives it the runner; cli/app.ts calls it on Ctrl+V.
// Copying goes the other way, through the terminal itself (`osc52`), so it works over SSH.

/**
 * The OSC 52 sequence that puts `text` on the clipboard of the terminal that draws the chat. The terminal does the copy,
 * so it reaches the owner's own machine over SSH. A terminal that does not support it ignores the sequence.
 */
export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
}

export type ProcessResult = { code: number; stdout: Uint8Array; missing?: boolean };
export type ProcessRun = (argv: ReadonlyArray<string>) => Promise<ProcessResult>;

export type ClipboardResult =
  | { status: 'image'; bytes: Uint8Array; contentType: string }
  | { status: 'empty' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/** The tool of this session, or why there is none. */
function toolFor(
  platform: string,
  env: Readonly<Record<string, string | undefined>>
): { argv: ReadonlyArray<string> } | { reason: string } {
  if (env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined || env.SSH_CLIENT !== undefined)
    return { reason: 'this chat runs over SSH, so the clipboard of your own machine is out of reach' };
  if (platform === 'darwin') return { argv: ['pngpaste', '-'] };
  if (platform !== 'linux') return { reason: `no clipboard adapter for ${platform}` };
  if (env.WAYLAND_DISPLAY !== undefined) return { argv: ['wl-paste', '--type', 'image/png', '--no-newline'] };
  if (env.DISPLAY !== undefined) return { argv: ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o'] };
  return { reason: 'this session has no display' };
}

export function createClipboard({
  platform,
  env,
  run,
}: {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  run: ProcessRun;
}): { read(): Promise<ClipboardResult> } {
  return {
    async read() {
      const tool = toolFor(platform, env);
      if ('reason' in tool) return { status: 'unavailable', reason: tool.reason };
      const name = tool.argv[0] ?? '';
      const result = await run(tool.argv);
      if (result.missing === true) return { status: 'unavailable', reason: `${name} is not installed` };
      if (result.code !== 0) return { status: 'failed', reason: `${name} exited with ${result.code}` };
      const isPng = PNG_SIGNATURE.every((byte, index) => result.stdout[index] === byte);
      return isPng ? { status: 'image', bytes: result.stdout, contentType: 'image/png' } : { status: 'empty' };
    },
  };
}
