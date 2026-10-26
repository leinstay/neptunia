// Tests for src/speech/convert.js: the waveform over synthetic PCM (pure) and the conversion of
// a one-second tone made with the system ffmpeg (skipped without it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { SpeechConvertError, ffmpegAvailable, toVoiceNote, waveformOf } from '../src/speech/convert.js';

const haveFfmpeg = ffmpegAvailable();

function pcmOf(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, at) => buffer.writeInt16LE(value, at * 2));
  return buffer;
}

test('waveformOf: 256 bytes, the loudest window is 255, silence is 0', () => {
  const samples = [];
  for (let i = 0; i < 2560; i += 1) samples.push(i < 1280 ? 1000 : 4000);
  const bytes = Buffer.from(waveformOf(pcmOf(samples)), 'base64');
  assert.equal(bytes.length, 256);
  assert.equal(bytes[255], 255);
  assert.equal(bytes[0], 64);
  const silent = Buffer.from(waveformOf(pcmOf(new Array(512).fill(0))), 'base64');
  assert.equal(silent.length, 256);
  assert.ok(silent.every((byte) => byte === 0));
});

test('waveformOf: a clip shorter than 256 samples still gives 256 bytes', () => {
  assert.equal(Buffer.from(waveformOf(pcmOf([100, -100, 100])), 'base64').length, 256);
});

test('ffmpegAvailable: false for a binary that does not exist', () => {
  assert.equal(ffmpegAvailable('/nonexistent/ffmpeg-for-test'), false);
});

test('toVoiceNote: a missing ffmpeg is a typed error', async () => {
  await assert.rejects(
    toVoiceNote(Buffer.from('x'), { ffmpeg: '/nonexistent/ffmpeg-for-test' }),
    (err) => err instanceof SpeechConvertError && err.reason === 'not-found'
  );
});

test(
  'toVoiceNote: a one-second tone becomes an OGG/Opus note of about a second with a 256-byte waveform',
  { skip: !haveFfmpeg && 'ffmpeg is not installed' },
  async () => {
    const made = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'mp3', 'pipe:1'],
      { maxBuffer: 1 << 24 }
    );
    assert.equal(made.status, 0);
    const note = await toVoiceNote(made.stdout);
    assert.equal(note.ogg.subarray(0, 4).toString('latin1'), 'OggS');
    assert.ok(note.durationSecs > 0.9 && note.durationSecs < 1.3, `duration ${note.durationSecs}`);
    assert.equal(Buffer.from(note.waveform, 'base64').length, 256);
  }
);

test(
  'toVoiceNote: bytes that are not audio fail with a typed error',
  { skip: !haveFfmpeg && 'ffmpeg is not installed' },
  async () => {
    await assert.rejects(toVoiceNote(Buffer.from('not audio at all')), (err) => err instanceof SpeechConvertError);
  }
);
