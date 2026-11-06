// A fake terminal for the leave specs of the owner chat: it keeps, in order, everything the chat did to the terminal
// when it left. Raw mode is the sequence of `setRawMode` calls, the stream's hold on the process the sequence of
// `ref` and `unref` calls, and the screen every byte written. No core, no provider. Shared by tests/cli-leave.test.ts
// and the child process of tests/fixtures/chat-leave-harness.ts.
import { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

/** What the chat did to the terminal, as plain data (it crosses a process boundary as JSON). */
export type LeaveReport = {
  raw: Array<boolean>;
  holds: Array<'ref' | 'unref'>;
  writes: string;
  dataListeners: number;
  paused: boolean;
};

export type LeaveRig = {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  type: (text: string) => void;
  /** The chat has drawn its first frame. */
  drawn: () => boolean;
  report: () => LeaveReport;
};

export function leaveRig(): LeaveRig {
  const raw: Array<boolean> = [];
  const holds: Array<'ref' | 'unref'> = [];
  let writes = '';
  const out = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        writes += String(chunk);
        done();
      },
    }),
    { columns: 80, rows: 24, isTTY: true }
  );
  const input = Object.assign(new Readable({ read() {} }), {
    isTTY: true,
    setRawMode(mode: boolean) {
      raw.push(mode);
      return input;
    },
    ref() {
      holds.push('ref');
      return input;
    },
    unref() {
      holds.push('unref');
      return input;
    },
  });
  return {
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: out as unknown as NodeJS.WriteStream,
    type: (text) => void input.push(text),
    drawn: () => stripVTControlCharacters(writes).trim() !== '',
    report: () => ({
      raw,
      holds,
      writes,
      dataListeners: input.listenerCount('data'),
      paused: input.isPaused(),
    }),
  };
}

const ESC = String.fromCharCode(27);

/** Whether the terminal mode `code` (`?25` for the cursor) was last switched on (`h`), off (`l`), or never touched. */
export function lastSwitch(writes: string, code: string): 'on' | 'off' | null {
  const on = writes.lastIndexOf(`${ESC}[${code}h`);
  const off = writes.lastIndexOf(`${ESC}[${code}l`);
  if (on === off) return null;
  return on > off ? 'on' : 'off';
}

/** The screen's text without its escape sequences. */
export const visible = (writes: string): string => stripVTControlCharacters(writes);
