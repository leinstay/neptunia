// mp3 -> a voice note for a chat platform, with the system ffmpeg (spawned directly, no shell): OGG/Opus at
// 48 kHz mono for the attachment, and from the decoded PCM the duration in seconds and the
// 256-byte waveform the platform draws (one byte per equal window of the clip, the window's RMS scaled
// so that the loudest window is 255; base64). The duration comes from the PCM, not ffprobe: the
// probe cannot read an Ogg stream's length from a pipe.

import { spawn, spawnSync } from 'node:child_process';

import { errorFields } from '../error-fields.ts';

const SAMPLE_RATE = 48000;
const WAVEFORM_BYTES = 256;

/** The error of a failed conversion; `reason` is 'not-found' (no ffmpeg), 'failed' or 'empty'. */
export class SpeechConvertError extends Error {
  reason: 'not-found' | 'failed' | 'empty';

  constructor(reason: 'not-found' | 'failed' | 'empty', message?: string, { cause }: { cause?: unknown } = {}) {
    super(message ?? `voice conversion failed (${reason})`, cause === undefined ? undefined : { cause });
    this.name = 'SpeechConvertError';
    this.reason = reason;
  }
}

/** Run `binary args`, feed it `input`, collect stdout. Resolves `{ code, stdout }`; rejects on a spawn error. */
function run(binary: string, args: Array<string>, input?: Buffer): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Array<Buffer> = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks) }));
    // The process may exit before reading all of stdin (a broken clip): that is the exit code's to report.
    child.stdin.on('error', () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Whether the system ffmpeg runs. False on a missing binary or a failing `-version`. */
export function ffmpegAvailable(ffmpeg: string = 'ffmpeg'): boolean {
  const result = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/**
 * The waveform of 16-bit little-endian mono PCM: `WAVEFORM_BYTES` bytes, the RMS of each equal
 * window scaled to 0..255 against the loudest window (silence is all zeros), base64. Pure.
 */
export function waveformOf(pcm: Buffer): string {
  const samples = Math.floor(pcm.length / 2);
  const rms: Array<number> = new Array<number>(WAVEFORM_BYTES).fill(0);
  for (let i = 0; i < WAVEFORM_BYTES; i += 1) {
    const from = Math.floor((i * samples) / WAVEFORM_BYTES);
    const to = Math.floor(((i + 1) * samples) / WAVEFORM_BYTES);
    if (to <= from) continue;
    let sum = 0;
    for (let at = from; at < to; at += 1) {
      const value = pcm.readInt16LE(at * 2);
      sum += value * value;
    }
    rms[i] = Math.sqrt(sum / (to - from));
  }
  const peak = Math.max(...rms);
  const bytes = Buffer.alloc(WAVEFORM_BYTES);
  if (peak > 0) for (let i = 0; i < WAVEFORM_BYTES; i += 1) bytes[i] = Math.min(255, Math.round((rms[i] / peak) * 255));
  return bytes.toString('base64');
}

/** Convert an mp3 to a voice note. */
export async function toVoiceNote(
  mp3: Buffer,
  { ffmpeg = 'ffmpeg' }: { ffmpeg?: string } = {}
): Promise<{ ogg: Buffer; durationSecs: number; waveform: string }> {
  const quiet = ['-v', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE)];
  let ogg: { code: number | null; stdout: Buffer };
  let pcm: { code: number | null; stdout: Buffer };
  try {
    [ogg, pcm] = await Promise.all([
      run(ffmpeg, [...quiet, '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', 'pipe:1'], mp3),
      run(ffmpeg, [...quiet, '-f', 's16le', 'pipe:1'], mp3),
    ]);
  } catch (err) {
    throw new SpeechConvertError(
      errorFields(err).code === 'ENOENT' ? 'not-found' : 'failed',
      errorFields(err).code === 'ENOENT' ? 'ffmpeg is not installed' : 'ffmpeg could not run',
      { cause: err }
    );
  }
  if (ogg.code !== 0 || pcm.code !== 0)
    throw new SpeechConvertError('failed', `ffmpeg exited with ${ogg.code !== 0 ? ogg.code : pcm.code}`);
  if (ogg.stdout.length === 0 || pcm.stdout.length < 2) throw new SpeechConvertError('empty', 'the clip has no audio');
  const durationSecs = Math.round((pcm.stdout.length / 2 / SAMPLE_RATE) * 100) / 100;
  return { ogg: ogg.stdout, durationSecs, waveform: waveformOf(pcm.stdout) };
}
