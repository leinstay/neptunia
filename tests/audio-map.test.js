// Tests for src/media/audio-map.js: the measuring settings, the read-only
// silencedetect run, reading ffmpeg's stderr, the audible stretches (complement,
// merge, cap), the verdict none / map / full, the m:ss list and the note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audibleSpans,
  audioMapSettings,
  classifyAudio,
  formatSpans,
  mergeSpans,
  parseSilenceDetect,
  silenceDetectArgs,
  videoAudioNote,
  withAudioNote,
} from '../src/media/audio-map.js';

const SETTINGS = { noiseDb: -40, minSilenceSeconds: 0.5, mapBelowShare: 0.8, maxSpans: 3 };

const INPUT_WITH_AUDIO = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
  '  Duration: 00:00:20.00, start: 0.000000, bitrate: 76 kb/s',
  '  Stream #0:0(und): Video: h264 (High), yuv420p, 640x360, 31 kb/s, 25 fps (default)',
  '  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 38 kb/s (default)',
].join('\n');

const INPUT_NO_AUDIO = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
  '  Duration: 00:00:06.00, start: 0.000000, bitrate: 34 kb/s',
  '  Stream #0:0(und): Video: h264 (High), yuv420p, 160x120, 32 kb/s, 25 fps (default)',
  "Output #0, null, to 'pipe:':",
  'Output file #0 does not contain any stream',
].join('\n');

function stderrWith(...events) {
  return [
    INPUT_WITH_AUDIO,
    ...events.map((e) => `[silencedetect @ 0x5600] ${e}`),
    'size=N/A time=00:00:19.98 bitrate=N/A',
  ].join('\n');
}

test('audioMapSettings: null or false turns measuring off; missing or invalid keys take the defaults', () => {
  assert.equal(audioMapSettings(null), null);
  assert.equal(audioMapSettings(false), null);
  const defaults = { noiseDb: -50, minSilenceSeconds: 0.5, mapBelowShare: 0.8, maxSpans: 20 };
  assert.deepEqual(audioMapSettings(undefined), defaults);
  assert.deepEqual(audioMapSettings(true), defaults);
  assert.deepEqual(
    audioMapSettings({ noiseDb: 'loud', minSilenceSeconds: 0, mapBelowShare: 2, maxSpans: 0 }),
    defaults
  );
  assert.deepEqual(audioMapSettings({ noiseDb: -35, minSilenceSeconds: 1.5, mapBelowShare: 0.5, maxSpans: 7.9 }), {
    noiseDb: -35,
    minSilenceSeconds: 1.5,
    mapBelowShare: 0.5,
    maxSpans: 7,
  });
});

test('silenceDetectArgs: decodes the audio only, writes nothing', () => {
  assert.deepEqual(
    silenceDetectArgs('/tmp/d/clip.mp4', { ffmpegPath: '/usr/bin/ffmpeg', noiseDb: -45, minSilenceSeconds: 0.75 }),
    {
      command: '/usr/bin/ffmpeg',
      args: [
        '-nostats',
        '-hide_banner',
        '-i',
        '/tmp/d/clip.mp4',
        '-vn',
        '-af',
        'silencedetect=n=-45dB:d=0.75',
        '-f',
        'null',
        '-',
      ],
    }
  );
});

test('parseSilenceDetect: streams, duration and silences; an open silence runs to the end, a leading end starts at 0', () => {
  const parsed = parseSilenceDetect(
    stderrWith(
      'silence_end: 2.02 | silence_duration: 2.02',
      'silence_start: 5.0156',
      'silence_end: 8.01 | silence_duration: 2.99',
      'silence_start: -0.02'
    )
  );
  assert.equal(parsed.inputSeen, true);
  assert.equal(parsed.hasAudio, true);
  assert.equal(parsed.durationSec, 20);
  assert.deepEqual(parsed.silences, [
    { start: 0, end: 2.02 },
    { start: 5.0156, end: 8.01 },
    { start: -0.02, end: null },
  ]);

  const silentStream = parseSilenceDetect(INPUT_NO_AUDIO);
  assert.deepEqual(silentStream, { inputSeen: true, hasAudio: false, durationSec: 6, silences: [] });

  assert.deepEqual(parseSilenceDetect('clip.mp4: No such file or directory'), {
    inputSeen: false,
    hasAudio: false,
    durationSec: null,
    silences: [],
  });
  assert.equal(parseSilenceDetect(INPUT_WITH_AUDIO.replace('00:00:20.00', 'N/A')).durationSec, null);
});

test('audibleSpans: the complement of the silences inside the clip, clamped, float noise dropped', () => {
  assert.deepEqual(
    audibleSpans(
      [
        { start: 0, end: 2 },
        { start: 5, end: 8 },
      ],
      10
    ),
    [
      [2, 5],
      [8, 10],
    ]
  );
  assert.deepEqual(
    audibleSpans(
      [
        { start: 0, end: 12 },
        { start: 15, end: null },
      ],
      20
    ),
    [[12, 15]]
  );
  // A trailing silence_end past the duration and a silence starting before 0.
  assert.deepEqual(audibleSpans([{ start: -0.02, end: 10.0078 }], 10), []);
  assert.deepEqual(audibleSpans([{ start: 0, end: 9.98 }], 10), []);
  assert.deepEqual(audibleSpans([], 10), [[0, 10]]);
  assert.deepEqual(audibleSpans([{ start: 1, end: 2 }], 0), []);
});

test('mergeSpans: neighbours under the minimum gap join, then the closest pairs join until maxSpans fit', () => {
  assert.deepEqual(
    mergeSpans(
      [
        [0, 1],
        [1.2, 2],
        [5, 6],
      ],
      { minGapSeconds: 0.5, maxSpans: 10 }
    ),
    [
      [0, 2],
      [5, 6],
    ]
  );
  assert.deepEqual(
    mergeSpans(
      [
        [0, 1],
        [3, 4],
        [4.6, 5],
        [10, 11],
        [20, 21],
      ],
      { minGapSeconds: 0.5, maxSpans: 3 }
    ),
    [
      [0, 5],
      [10, 11],
      [20, 21],
    ]
  );
  assert.deepEqual(
    mergeSpans(
      [
        [0, 1],
        [3, 4],
        [9, 10],
      ],
      { minGapSeconds: 0.5, maxSpans: 1 }
    ),
    [[0, 10]]
  );
});

test('classifyAudio: no stream or nothing audible -> none; mostly silent -> map; mostly sound -> full', () => {
  assert.deepEqual(classifyAudio(parseSilenceDetect(INPUT_NO_AUDIO), SETTINGS), { kind: 'none' });
  assert.deepEqual(classifyAudio(parseSilenceDetect(stderrWith('silence_start: 0', 'silence_end: 20.01')), SETTINGS), {
    kind: 'none',
  });
  assert.deepEqual(
    classifyAudio(
      parseSilenceDetect(stderrWith('silence_start: 0', 'silence_end: 12.2', 'silence_start: 13.4')),
      SETTINGS
    ),
    { kind: 'map', spans: [[12.2, 13.4]] }
  );
  // 17 of 20 s audible: 85 % is not below 80 %.
  assert.deepEqual(classifyAudio(parseSilenceDetect(stderrWith('silence_start: 3', 'silence_end: 6')), SETTINGS), {
    kind: 'full',
  });
  assert.deepEqual(classifyAudio(parseSilenceDetect(stderrWith()), SETTINGS), { kind: 'full' });
});

test('classifyAudio: the known clip length stands in for a missing duration; unreadable output -> null', () => {
  const noDuration = parseSilenceDetect(
    INPUT_WITH_AUDIO.replace('00:00:20.00', 'N/A') + '\n[silencedetect @ 0x1] silence_start: 1'
  );
  assert.deepEqual(classifyAudio(noDuration, SETTINGS, 10), { kind: 'map', spans: [[0, 1]] });
  assert.equal(classifyAudio(noDuration, SETTINGS), null);
  assert.equal(classifyAudio(parseSilenceDetect('garbage'), SETTINGS, 10), null);
});

test('formatSpans: m:ss, start rounded down, end up, a sub-second sound gets a whole second', () => {
  assert.equal(
    formatSpans([
      [12.2, 12.9],
      [65, 80],
      [119.5, 121.01],
    ]),
    '0:12-0:13, 1:05-1:20, 1:59-2:02'
  );
  assert.equal(formatSpans([[3, 3.04]]), '0:03-0:04');
  assert.equal(formatSpans([]), '');
});

test('videoAudioNote / withAudioNote: the label for none or map, nothing for full or a blank label', () => {
  const labels = { videoAudio: { none: 'NOTE-NONE', map: 'NOTE-MAP <{spans}>' } };
  assert.equal(videoAudioNote({ kind: 'none' }, labels), 'NOTE-NONE');
  assert.equal(
    videoAudioNote(
      {
        kind: 'map',
        spans: [
          [1, 2],
          [5.5, 7.2],
        ],
      },
      labels
    ),
    'NOTE-MAP <0:01-0:02, 0:05-0:08>'
  );
  assert.equal(videoAudioNote({ kind: 'full' }, labels), '');
  assert.equal(videoAudioNote(null, labels), '');
  assert.equal(videoAudioNote({ kind: 'none' }, { videoAudio: { none: '  ' } }), '');
  assert.equal(videoAudioNote({ kind: 'map', spans: [[1, 2]] }, {}), '');
  assert.equal(withAudioNote('SYSTEM', 'NOTE'), 'SYSTEM\n\nNOTE');
  assert.equal(withAudioNote('SYSTEM', ''), 'SYSTEM');
});
