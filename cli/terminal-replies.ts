// What the terminal answers about itself, and the pictures drawn over Ink's frame. The chat asks once a session, when the
// first picture is to be shown: kitty's graphics query, the cell size in pixels and DA1. Every terminal answers DA1, so its
// reply ends the wait: a kitty `OK` before it means the kitty protocol, a `4` among its numbers means Sixel, and
// `TERM_PROGRAM` or `LC_TERMINAL` names iTerm2. The replies come on stdin, and `replyFilter` takes them out before Ink
// sees them, so none reaches the draft. Ink writes the whole frame again on each change, which wipes a Sixel or iTerm2
// picture, so `graphicsOverlay` draws the placed picture again after each write, at its screen position, with the cursor
// saved and restored. cli/index.ts wires both, and cli/chat-controller.ts places the picture.
import { Readable } from 'node:stream';
import { DEFAULT_CELL, kittyDelete } from './terminal-graphics.ts';
import type { Size } from './terminal-graphics.ts';

export type GraphicsProtocol = 'kitty' | 'iterm2' | 'sixel' | 'none';
export type GraphicsSupport = { protocol: GraphicsProtocol; cell: Size };

/** kitty's graphics query, the cell size in pixels, then DA1, which every terminal answers. */
export const GRAPHICS_QUERY = '\u001b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\u001b\\\u001b[16t\u001b[c';
/** How long the chat waits for DA1 before it takes the terminal for one that draws no picture. */
const PROBE_MS = 1000;

// eslint-disable-next-line no-control-regex
const REPLIES = /\u001b_G[^\u001b]*\u001b\\|\u001b\[\?[\d;]*c|\u001b\[6;\d+;\d+t/g;
// eslint-disable-next-line no-control-regex
const PARTIAL = /\u001b(?:_[^\u001b]*\u001b?|\[\??[\d;]*)$/;
// eslint-disable-next-line no-control-regex
const DA1 = /\u001b\[\?([\d;]*)c/;
// eslint-disable-next-line no-control-regex
const CELL = /\u001b\[6;(\d+);(\d+)t/;
/** As long as the mouse filter waits for the rest of a split sequence (cli/mouse.ts). */
const PARTIAL_WAIT_MS = 20;

/** What the replies say the terminal draws with. kitty first, as it takes a PNG at once; Sixel last. */
export function graphicsOf(replies: string, env: Readonly<Record<string, string | undefined>>): GraphicsSupport {
  const cell = CELL.exec(replies);
  const size = cell === null ? DEFAULT_CELL : { width: Number(cell[2]), height: Number(cell[1]) };
  const usable = size.width > 0 && size.height > 0 ? size : DEFAULT_CELL;
  const isKitty = replies.includes('\u001b_Gi=31;OK');
  const isIterm = env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2';
  const isSixel = (DA1.exec(replies)?.[1] ?? '').split(';').includes('4');
  const protocol: GraphicsProtocol = isKitty ? 'kitty' : isIterm ? 'iterm2' : isSixel ? 'sixel' : 'none';
  return { protocol, cell: usable };
}

export type ReplySource = { onReply(listener: (reply: string) => void): () => void };

/** A stdin for the next reader with the terminal's replies taken out and given to listeners, whatever the chunks split. */
export function replyFilter(source: NodeJS.ReadStream): {
  input: NodeJS.ReadStream;
  answers: ReplySource;
  close(): void;
} {
  const listeners = new Set<(reply: string) => void>();
  const input = Object.assign(new Readable({ read() {} }), {
    isTTY: source.isTTY,
    setRawMode(mode: boolean) {
      source.setRawMode?.(mode);
      return input;
    },
    ref() {
      source.ref?.();
      return input;
    },
    unref() {
      source.unref?.();
      return input;
    },
  });
  let pending = '';
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    if (pending !== '') input.push(Buffer.from(pending, 'latin1'));
    pending = '';
  };
  const onData = (chunk: Buffer | string): void => {
    clearTimeout(timer);
    const text = pending + (typeof chunk === 'string' ? Buffer.from(chunk) : chunk).toString('latin1');
    pending = '';
    for (const found of text.match(REPLIES) ?? []) for (const listener of listeners) listener(found);
    const rest = text.replace(REPLIES, '');
    const partial = PARTIAL.exec(rest);
    const whole = partial === null ? rest : rest.slice(0, partial.index);
    if (whole !== '') input.push(Buffer.from(whole, 'latin1'));
    if (partial !== null) {
      pending = partial[0];
      timer = setTimeout(flush, PARTIAL_WAIT_MS);
    }
  };
  source.on('data', onData);
  return {
    input: input as unknown as NodeJS.ReadStream,
    answers: {
      onReply(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    close() {
      clearTimeout(timer);
      source.off('data', onData);
      // The listener set the stream flowing: paused, it holds the process no longer.
      source.pause();
    },
  };
}

/** Asks the terminal once, on the first call, and gives every call the same answer. */
export function graphicsProbe({
  write,
  replies,
  env,
}: {
  write: (text: string) => void;
  replies: ReplySource;
  env: Readonly<Record<string, string | undefined>>;
}): () => Promise<GraphicsSupport> {
  let asked: Promise<GraphicsSupport> | null = null;
  return () =>
    (asked ??= new Promise((resolve) => {
      let heard = '';
      let stop = (): void => {};
      const finish = (): void => {
        clearTimeout(timer);
        stop();
        resolve(graphicsOf(heard, env));
      };
      const timer = setTimeout(finish, PROBE_MS);
      stop = replies.onReply((reply) => {
        heard += reply;
        if (DA1.test(reply)) finish();
      });
      write(GRAPHICS_QUERY);
    }));
}

/**
 * A picture placed over the frame: the screen row and column of its top left cell, one-based, what draws it there, and
 * what must reach the terminal once before, under `key`. `kittyId` names a kitty image, which outlives the frame and is
 * taken off when the placement goes.
 */
export type Placement = { key: string; row: number; column: number; draw: string; prepare?: string; kittyId?: number };

/** `target` with each write followed by the placed picture, and the way to place or remove it. */
export function graphicsOverlay(target: NodeJS.WriteStream): {
  stdout: NodeJS.WriteStream;
  place(placement: Placement | null): void;
} {
  let current: Placement | null = null;
  const prepared = new Set<string>();
  const raw = (text: string): void => void target.write(text);
  const drawn = (): void => {
    if (current === null) return;
    if (current.prepare !== undefined && !prepared.has(current.key)) {
      raw(current.prepare);
      prepared.add(current.key);
    }
    raw(`\u001b7\u001b[${current.row};${current.column}H${current.draw}\u001b8`);
  };
  const write = (...args: Parameters<NodeJS.WriteStream['write']>): boolean => {
    const done = (target.write as (...given: Parameters<NodeJS.WriteStream['write']>) => boolean)(...args);
    drawn();
    return done;
  };
  const stdout = new Proxy(target, {
    get(stream, property) {
      if (property === 'write') return write;
      const value: unknown = Reflect.get(stream, property);
      return typeof value === 'function' ? (value as (...given: Array<unknown>) => unknown).bind(stream) : value;
    },
  });
  return {
    stdout,
    place(placement) {
      const old = current;
      if (old?.kittyId !== undefined && old.kittyId !== placement?.kittyId) {
        raw(kittyDelete(old.kittyId));
        prepared.delete(old.key);
      }
      current = placement;
    },
  };
}
