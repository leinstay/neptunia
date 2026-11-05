// The clip that carries a sound ends with the sound. Measured on a 74.006 s voice message: with the encoder's look-ahead the
// picture ran to 93 s, because the frames it held back outlived `-shortest`. Runs the real ffmpeg over `ffmpegAudioArgs`, so it is
// skipped on a machine without one. A frame of the picture is the one slack left: the mux can only stop on a frame's end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ffmpegAudioArgs } from '../src/media/video-sites.ts';
import { tempDir } from './fixtures/tmp.ts';

const FRAME_SECONDS = 0.1;
const NO_TOOLS = ['ffmpeg', 'ffprobe'].some((tool) => spawnSync(tool, ['-version']).status !== 0);

function soundOf(seconds: number): string {
  const file = path.join(tempDir('nep-clip-'), 'voice.ogg');
  const made = spawnSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=300:duration=${seconds}`,
    '-c:a',
    'libopus',
    file,
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  return file;
}

function clipOf(sound: string, maxSeconds: number): string {
  const out = path.join(path.dirname(sound), 'out.mp4');
  const { command, args } = ffmpegAudioArgs(sound, out, { ffmpegPath: 'ffmpeg', maxSeconds });
  const run = spawnSync(command, args);
  assert.equal(run.status, 0, String(run.stderr));
  return out;
}

function lengthOf(file: string, stream: 'v' | 'a'): number {
  const probe = spawnSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    stream,
    '-show_entries',
    'stream=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number(String(probe.stdout).trim());
}

test('the picture of a clip ends with its sound', { skip: NO_TOOLS }, () => {
  const clip = clipOf(soundOf(30.006), 300);
  const sound = lengthOf(clip, 'a');
  assert.ok(Math.abs(sound - 30.006) < 0.05, `sound ${sound}`);
  const picture = lengthOf(clip, 'v');
  assert.ok(Math.abs(picture - sound) <= FRAME_SECONDS, `picture ${picture}, sound ${sound}`);
});

test('a sound over the cap makes a clip of the cap, picture and sound alike', { skip: NO_TOOLS }, () => {
  const clip = clipOf(soundOf(12), 5);
  assert.ok(Math.abs(lengthOf(clip, 'a') - 5) <= FRAME_SECONDS);
  assert.ok(Math.abs(lengthOf(clip, 'v') - 5) <= FRAME_SECONDS);
});
