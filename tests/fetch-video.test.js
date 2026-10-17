// Tests for src/media/fetch-video.js: attachment sent as-is or trimmed by
// ffmpeg, the download hard ceiling, yt-dlp probe and clip runs (an oversized
// clip re-encoded by ffmpeg), failure
// reasons, timeouts (the whole tool process tree killed, cleanup only after
// the tool closed), temp-file cleanup and logging that carries codes only,
// never tool output or a query string. Child processes, process.kill and
// fetch are fakes; temp files go to a throwaway directory.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVideoFetcher, proxyReachable } from '../src/media/fetch-video.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const OPTS = {
  maxSeconds: 60,
  maxBytes: 1000,
  toolTimeoutMs: 60_000,
  fetchTimeoutMs: 10_000,
  ytdlpPath: 'yt-dlp',
  ffmpegPath: 'ffmpeg',
};
const ATTACHMENT = 'https://cdn.discordapp.com/attachments/1/2/clip.webm?ex=deadbeef&is=cafef00d&hm=abc';
const SITE_URL = 'https://www.youtube.com/watch?v=abc123&si=secrettracking';

let tmpDir;
beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fetch-video-test-'));
});
afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function leftovers() {
  return fsp.readdir(tmpDir);
}

/** A body that yields `chunks` one by one and counts how many were pulled. */
function countingBody(chunks) {
  const body = {
    pulled: 0,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        body.pulled += 1;
        yield chunk;
      }
    },
  };
  return body;
}

function fakeResponse({ ok = true, status = 200, contentType = 'video/webm', contentLength, chunks = [Buffer.from('video-bytes')] } = {}) {
  const headers = { 'content-type': contentType, 'content-length': contentLength !== undefined ? String(contentLength) : undefined };
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: countingBody(chunks),
  };
}

function fakeFetch(response) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(url, options) : response;
    },
  };
}

// Every fake child by pid, so the fake process.kill can find the one it targets.
const children = new Map();
let nextPid = 1000;

/**
 * A spawn stub. `behave(child, command, args)` runs on the next tick and may
 * write to stdout/stderr, create files, and emit `close` / `error`.
 * Leaving it silent simulates a hung tool (for timeouts).
 */
function fakeSpawn(behave) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, 'SIGKILL'));
      return true;
    };
    children.set(child.pid, child);
    calls.push({ command, args, options, child });
    setImmediate(() => behave(child, command, args));
    return child;
  };
  return { spawnImpl, calls };
}

/** A process.kill stub: a negative pid is a process group; the target child closes on the next tick. */
function fakeKill() {
  const kills = [];
  const killProcess = (pid, signal) => {
    kills.push({ pid, signal });
    const child = children.get(Math.abs(pid));
    if (!child) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    child.killed = true;
    setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  return { killProcess, kills };
}

/**
 * createVideoFetcher on a POSIX platform with a fake process.kill and an
 * unreachable proxy (no network in tests), unless overridden.
 */
function makeFetcher(deps) {
  return createVideoFetcher({
    platform: 'linux',
    killProcess: fakeKill().killProcess,
    probeProxy: async () => false,
    ...deps,
  });
}

function enoent(child) {
  const err = new Error('spawn tool ENOENT');
  err.code = 'ENOENT';
  child.emit('error', err);
}

/**
 * Behaviour that writes `size` bytes to the path after `flag` (or the last arg), then exits 0.
 * Synchronous on purpose: the fake tool writes and exits in the callback the
 * spawn scheduled, so it has finished before the event loop can reach a tool
 * timeout, however slow the disk is under a parallel run. A test may therefore
 * give a finishing tool the short toolTimeoutMs meant for a hung one.
 */
function writesOutput(size, flag) {
  return (child, command, args) => {
    const out = flag ? args[args.indexOf(flag) + 1] : args[args.length - 1];
    writeFileSync(out, Buffer.alloc(size, 7));
    child.emit('close', 0, null);
  };
}

// --- fetchAttachment ------------------------------------------------------

test('fetchAttachment: a short small video is sent as-is with its own content type, no ffmpeg', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ contentType: 'video/webm; codecs=vp9' }));
  const { spawnImpl, calls } = fakeSpawn(() => assert.fail('ffmpeg must not run'));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 12 });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'video/webm');
  assert.equal(result.dataUrl, `data:video/webm;base64,${Buffer.from('video-bytes').toString('base64')}`);
  assert.equal(result.seconds, 12);
  assert.equal(result.bytes, Buffer.from('video-bytes').byteLength);
  assert.equal(calls.length, 0);
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a long video is trimmed by ffmpeg into an mp4 clip', async () => {
  const { fetchImpl, calls: fetchCalls } = fakeFetch(fakeResponse());
  const { spawnImpl, calls } = fakeSpawn(writesOutput(300));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 125 });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'video/mp4');
  assert.ok(result.dataUrl.startsWith('data:video/mp4;base64,'));
  assert.equal(result.seconds, 60);
  assert.equal(result.bytes, 300);
  assert.ok(fetchCalls[0].options.signal instanceof AbortSignal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ffmpeg');
  const args = calls[0].args;
  assert.equal(args[args.indexOf('-t') + 1], '60');
  assert.notEqual(args[args.indexOf('-i') + 1], args[args.length - 1], 'input and output are two different temp files');
  assert.deepEqual(await leftovers(), [], 'both temp files are removed');
});

test('fetchAttachment: an unknown duration always goes through ffmpeg; seconds falls back to maxSeconds', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl, calls } = fakeSpawn(writesOutput(100));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: null });

  assert.equal(result.ok, true);
  assert.equal(result.seconds, 60);
  assert.equal(calls.length, 1);
});

test('fetchAttachment: a short but oversized video is re-encoded; seconds keeps the real duration', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ chunks: [Buffer.alloc(1500, 1)] }));
  const { spawnImpl, calls } = fakeSpawn(writesOutput(500));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 20 });

  assert.equal(result.ok, true);
  assert.equal(result.seconds, 20);
  assert.equal(calls.length, 1);
});

test('fetchAttachment: ffmpeg missing -> tool (retryable), whether the video was too long or only too big', async () => {
  const cases = [
    [fakeResponse(), 90],
    [fakeResponse({ chunks: [Buffer.alloc(1500, 1)] }), 30],
  ];
  for (const [response, durationSec] of cases) {
    const { fetchImpl } = fakeFetch(response);
    const { spawnImpl } = fakeSpawn(enoent);
    const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

    assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec }), { ok: false, reason: 'tool' });
    assert.deepEqual(await leftovers(), []);
  }
});

test('fetchAttachment: the trimmed clip still over maxBytes -> size', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl } = fakeSpawn(writesOutput(1001));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 90 });

  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a trimmed clip over maxBytes is encoded once more at a fitted bitrate and sent when it fits', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const sizes = [1001, 800];
  const { spawnImpl, calls } = fakeSpawn((child, command, args) => writesOutput(sizes.shift())(child, command, args));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const { result, logs } = await withCapturedLogs(() => fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 90 }));

  assert.equal(result.ok, true);
  assert.equal(result.bytes, 800);
  assert.equal(result.seconds, 60);
  assert.equal(calls.length, 2);
  const trimArgs = calls[0].args;
  const fitArgs = calls[1].args;
  assert.ok(trimArgs.includes('-crf') && !trimArgs.includes('-b:v'));
  assert.ok(fitArgs.includes('-b:v') && !fitArgs.includes('-crf'));
  assert.equal(fitArgs[fitArgs.indexOf('-i') + 1], trimArgs[trimArgs.indexOf('-i') + 1], 'both encode the same download');
  assert.equal(fitArgs[fitArgs.indexOf('-t') + 1], '60');
  const refit = logs.find((l) => l.msg === 'fetch-video: refit');
  assert.ok(refit, 'the fit re-encode is logged');
  assert.equal(refit.before, 1001);
  assert.equal(refit.bytes, 800);
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a failing fit re-encode keeps its own reason (tool, timeout)', async () => {
  for (const [second, reason] of [[(child) => child.emit('close', 1, null), 'tool'], [() => {}, 'timeout']]) {
    const { fetchImpl } = fakeFetch(fakeResponse());
    const behaviours = [writesOutput(1001), second];
    const { spawnImpl } = fakeSpawn((child, command, args) => behaviours.shift()(child, command, args));
    const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, toolTimeoutMs: 50, durationSec: 90 }), { ok: false, reason });
    assert.deepEqual(await leftovers(), []);
  }
});

test('fetchAttachment: a hung ffmpeg is killed after toolTimeoutMs -> timeout', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, toolTimeoutMs: 20, durationSec: 90 });

  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(calls[0].child.killed, true);
  assert.deepEqual(await leftovers(), []);
});

// --- fetchGif --------------------------------------------------------------

const GIF_URL = 'https://cdn.discordapp.com/attachments/1/2/anim.gif?ex=deadbeef&is=cafef00d&hm=abc';
const GIF_OPTS = { ...OPTS, maxSeconds: 8, ffmpegPath: '/usr/bin/ffmpeg' };

test('fetchGif: a .gif is downloaded and always converted by ffmpeg into a short mp4 of maxSeconds', async () => {
  const { fetchImpl, calls: fetchCalls } = fakeFetch(fakeResponse({ contentType: 'image/gif' }));
  const { spawnImpl, calls } = fakeSpawn(writesOutput(300));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchGif(GIF_URL, GIF_OPTS);

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'video/mp4');
  assert.equal(result.dataUrl, `data:video/mp4;base64,${Buffer.alloc(300, 7).toString('base64')}`);
  assert.equal(result.seconds, 8);
  assert.equal(result.bytes, 300);
  assert.equal(fetchCalls[0].url, GIF_URL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/ffmpeg', 'the configured ffmpeg path is the command');
  const args = calls[0].args;
  assert.equal(args[args.indexOf('-t') + 1], '8');
  assert.ok(args.includes('-an'));
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.deepEqual(await leftovers(), [], 'both temp files are removed');
});

test('fetchGif: a content type that is neither a GIF nor a video -> download, no ffmpeg', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ contentType: 'text/html' }));
  const { spawnImpl, calls } = fakeSpawn(() => assert.fail('ffmpeg must not run'));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  assert.deepEqual(await fetcher.fetchGif(GIF_URL, GIF_OPTS), { ok: false, reason: 'download' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await leftovers(), []);
});

test('fetchGif: a download over the ceiling -> size; ffmpeg missing or failing -> tool; a clip over maxBytes -> size', async () => {
  const big = fakeFetch(fakeResponse({ contentType: 'image/gif', contentLength: 4001 }));
  const fetcherBig = makeFetcher({ fetchImpl: big.fetchImpl, spawnImpl: fakeSpawn(() => assert.fail('no ffmpeg')).spawnImpl, tmpDir });
  assert.deepEqual(await fetcherBig.fetchGif(GIF_URL, GIF_OPTS), { ok: false, reason: 'size' });

  const missing = makeFetcher({
    fetchImpl: fakeFetch(fakeResponse({ contentType: 'image/gif' })).fetchImpl,
    spawnImpl: fakeSpawn(enoent).spawnImpl,
    tmpDir,
  });
  assert.deepEqual(await missing.fetchGif(GIF_URL, GIF_OPTS), { ok: false, reason: 'tool' });

  const failing = makeFetcher({
    fetchImpl: fakeFetch(fakeResponse({ contentType: 'image/gif' })).fetchImpl,
    spawnImpl: fakeSpawn((child) => child.emit('close', 1, null)).spawnImpl,
    tmpDir,
  });
  assert.deepEqual(await failing.fetchGif(GIF_URL, GIF_OPTS), { ok: false, reason: 'tool' });

  const oversized = makeFetcher({
    fetchImpl: fakeFetch(fakeResponse({ contentType: 'image/gif' })).fetchImpl,
    spawnImpl: fakeSpawn(writesOutput(1001)).spawnImpl,
    tmpDir,
  });
  assert.deepEqual(await oversized.fetchGif(GIF_URL, GIF_OPTS), { ok: false, reason: 'size' });
  assert.deepEqual(await leftovers(), []);
});

// --- killing the tool process tree -------------------------------------------

test('kill: on POSIX a tool is spawned detached and a timeout kills its whole process group', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const { killProcess, kills } = fakeKill();
  const fetcher = createVideoFetcher({ spawnImpl, killProcess, platform: 'linux', tmpDir });

  assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason: 'timeout' });

  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(kills, [{ pid: -calls[0].child.pid, signal: 'SIGKILL' }]);
  assert.deepEqual(await leftovers(), []);
});

test('kill: the temp directory is removed only after the killed tool has closed', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  let seenBeforeClose = null;
  const killProcess = (pid) => {
    const child = children.get(Math.abs(pid));
    setTimeout(async () => {
      seenBeforeClose = await fsp.readdir(tmpDir);
      child.emit('close', null, 'SIGKILL');
    }, 30);
    return true;
  };
  const fetcher = createVideoFetcher({ spawnImpl, killProcess, platform: 'linux', tmpDir });

  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 });

  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(calls.length, 1);
  assert.equal(seenBeforeClose.length, 1, 'the work directory still exists while the tool is closing');
  assert.deepEqual(await leftovers(), [], 'and is removed once it has closed');
});

test('kill: a tool that never closes after the kill is given up on after the grace period', async () => {
  const { spawnImpl } = fakeSpawn(() => {});
  const fetcher = createVideoFetcher({ spawnImpl, killProcess: () => true, platform: 'linux', closeGraceMs: 30, tmpDir });

  assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason: 'timeout' });
  assert.deepEqual(await leftovers(), []);
});

test('kill: a failing group kill falls back to killing the child itself', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const killProcess = () => {
    throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
  };
  const fetcher = createVideoFetcher({ spawnImpl, killProcess, platform: 'linux', tmpDir });

  assert.deepEqual(await fetcher.probeSite(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason: 'timeout' });
  assert.equal(calls[0].child.killed, true);
});

test('kill: on Windows the tool is not detached and the tree is killed with taskkill /T /F', async () => {
  const { spawnImpl, calls } = fakeSpawn((child, command, args) => {
    if (command !== 'taskkill') return; // the tool itself hangs
    const target = children.get(Number(args[args.indexOf('/PID') + 1]));
    target.emit('close', 1, null);
    child.emit('close', 0, null);
  });
  const killProcess = () => assert.fail('no process-group kill on Windows');
  const fetcher = createVideoFetcher({ spawnImpl, killProcess, platform: 'win32', tmpDir });

  assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason: 'timeout' });

  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[1].command, 'taskkill');
  assert.deepEqual(calls[1].args, ['/PID', String(calls[0].child.pid), '/T', '/F']);
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: the download stops at the hard ceiling (maxBytes * 4) and deletes the partial file', async () => {
  const chunks = Array.from({ length: 100 }, () => Buffer.alloc(100, 1)); // 10 000 bytes offered
  const response = fakeResponse({ chunks });
  const { fetchImpl } = fakeFetch(response);
  const { spawnImpl, calls } = fakeSpawn(() => assert.fail('ffmpeg must not run'));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 10 });

  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.ok(response.body.pulled <= 41, `pulled ${response.body.pulled} chunks; must stop just past 4000 bytes`);
  assert.equal(calls.length, 0);
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a declared content-length over the ceiling is refused before reading the body', async () => {
  const response = fakeResponse({ contentLength: 5000 });
  const { fetchImpl } = fakeFetch(response);
  const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

  assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 10 }), { ok: false, reason: 'size' });
  assert.equal(response.body.pulled, 0);
});

test('fetchAttachment: non-video content type, non-OK status and a thrown fetch all give download', async () => {
  for (const response of [fakeResponse({ contentType: 'text/html' }), fakeResponse({ ok: false, status: 403 }), new Error('network down')]) {
    const { fetchImpl } = fakeFetch(response);
    const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 10 }), { ok: false, reason: 'download' });
  }
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a download that outlives fetchTimeoutMs is aborted -> timeout', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, fetchTimeoutMs: 20, durationSec: 10 });

  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

// --- probeSite ----------------------------------------------------------

test('probeSite: parses duration and title from yt-dlp stdout', async () => {
  const json = JSON.stringify({ duration: 213, title: 'Ἡ θάλασσα' });
  const { spawnImpl, calls } = fakeSpawn((child) => {
    const bytes = Buffer.from(json);
    child.stdout.emit('data', bytes.subarray(0, 10));
    child.stdout.emit('data', bytes.subarray(10));
    child.emit('close', 0, null);
  });
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  const result = await fetcher.probeSite(SITE_URL, OPTS);

  assert.deepEqual(result, { ok: true, durationSec: 213, title: 'Ἡ θάλασσα' });
  assert.equal(calls[0].command, 'yt-dlp');
  assert.ok(calls[0].args.includes('--dump-single-json'));
  assert.equal(calls[0].args[calls[0].args.length - 1], SITE_URL);
});

test('probeSite: ENOENT -> tool, non-zero -> download, hang -> timeout', async () => {
  const cases = [
    [enoent, 'tool'],
    [(child) => child.emit('close', 1, null), 'download'],
    [() => {}, 'timeout'],
  ];
  for (const [behave, reason] of cases) {
    const fetcher = makeFetcher({ spawnImpl: fakeSpawn(behave).spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.probeSite(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason });
  }
});

test('probeSite: a spawn that throws synchronously resolves to tool, never rejects', async () => {
  const spawnImpl = () => {
    throw Object.assign(new Error('boom'), { code: 'EACCES' });
  };
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  assert.deepEqual(await fetcher.probeSite(SITE_URL, OPTS), { ok: false, reason: 'tool' });
});

// --- fetchSiteClip -------------------------------------------------------

test('fetchSiteClip: returns the downloaded clip as an mp4 data URL and removes the temp file', async () => {
  const { spawnImpl, calls } = fakeSpawn(writesOutput(400, '-o'));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  const result = await fetcher.fetchSiteClip(SITE_URL, OPTS);

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'video/mp4');
  assert.ok(result.dataUrl.startsWith('data:video/mp4;base64,'));
  assert.equal(result.bytes, 400);
  assert.equal(result.seconds, 60);
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
  assert.equal(args[args.indexOf('--max-filesize') + 1], '4000');
  assert.equal(args.includes('--ffmpeg-location'), false, 'a bare ffmpeg name is left to PATH');
  assert.ok(args[args.indexOf('-o') + 1].startsWith(tmpDir));
  assert.deepEqual(await leftovers(), []);
});

test('fetchSiteClip: a shorter probed duration is reported as seconds and skips the cut', async () => {
  const { spawnImpl, calls } = fakeSpawn(writesOutput(10, '-o'));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: 14 });
  assert.equal(result.seconds, 14);
  const args = calls[0].args;
  assert.equal(args.includes('--download-sections'), false);
  assert.equal(args.includes('--force-keyframes-at-cuts'), false);
});

test('fetchSiteClip: a longer probed duration keeps the cut; a path ffmpeg is passed on', async () => {
  const { spawnImpl, calls } = fakeSpawn(writesOutput(10, '-o'));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, ffmpegPath: '/usr/bin/ffmpeg', durationSec: 125 });
  assert.equal(result.seconds, 60);
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
  assert.equal(args[args.indexOf('--ffmpeg-location') + 1], '/usr/bin/ffmpeg');
});

/**
 * A spawn behaviour per tool: yt-dlp (`-o` output) and ffmpeg (last-arg
 * output) act differently; any other command fails the test.
 */
function byTool({ ytdlp = () => assert.fail('yt-dlp must not run'), ffmpeg = () => assert.fail('ffmpeg must not run') }) {
  return (child, command, args) => {
    if (command === 'yt-dlp') return ytdlp(child, command, args);
    if (command === 'ffmpeg') return ffmpeg(child, command, args);
    return assert.fail(`unexpected command ${command}`);
  };
}

test('fetchSiteClip: yt-dlp gets the download ceiling (maxBytes * 4) as --max-filesize, whole or cut', async () => {
  for (const durationSec of [14, 58, 125, null]) {
    const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(10, '-o') }));
    const fetcher = makeFetcher({ spawnImpl, tmpDir });
    const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec });
    assert.equal(result.ok, true);
    const args = calls[0].args;
    assert.equal(args[args.indexOf('--max-filesize') + 1], '4000', `ceiling for duration ${durationSec}`);
  }
});

test('fetchSiteClip: a small whole download is returned as-is, without ffmpeg', async () => {
  const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(1000, '-o') }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: 58 });

  assert.equal(result.ok, true);
  assert.equal(result.bytes, 1000);
  assert.equal(result.seconds, 58);
  assert.equal(result.mimeType, 'video/mp4');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('--download-sections'), false);
  assert.deepEqual(await leftovers(), []);
});

test('fetchSiteClip: an oversized whole download is re-encoded by ffmpeg and the smaller file returned', async () => {
  const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(3000, '-o'), ffmpeg: writesOutput(600) }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: 58 });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'video/mp4');
  assert.equal(result.bytes, 600);
  assert.equal(result.dataUrl, `data:video/mp4;base64,${Buffer.alloc(600, 7).toString('base64')}`);
  assert.equal(result.seconds, 58);
  assert.equal(calls.length, 2);
  const clipPath = calls[0].args[calls[0].args.indexOf('-o') + 1];
  const ffArgs = calls[1].args;
  assert.equal(calls[1].command, 'ffmpeg');
  assert.equal(ffArgs[ffArgs.indexOf('-i') + 1], clipPath, 'ffmpeg reads the yt-dlp download');
  assert.notEqual(ffArgs[ffArgs.length - 1], clipPath, 'and writes a second file');
  assert.equal(ffArgs[ffArgs.indexOf('-t') + 1], '60');
  assert.deepEqual(await leftovers(), [], 'both temp files are removed');
});

test('fetchSiteClip: still over maxBytes after the re-encode and the fit re-encode -> size', async () => {
  const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(3000, '-o'), ffmpeg: writesOutput(1001) }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: 58 }), { ok: false, reason: 'size' });
  assert.equal(calls.length, 3);
  assert.ok(calls[2].args.includes('-b:v'), 'the third run is the fit re-encode');
  assert.deepEqual(await leftovers(), []);
});

test('fetchSiteClip: a re-encode still over maxBytes is encoded once more from the download at a fitted bitrate', async () => {
  const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(1_500_000, '-o'), ffmpeg: writesOutput(900_000) }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  const { result, logs } = await withCapturedLogs(() => fetcher.fetchSiteClip(SITE_URL, { ...OPTS, maxBytes: 1_000_000, durationSec: 58 }));
  assert.equal(result.bytes, 900_000);
  assert.equal(calls.length, 2, 'no fit run while the first re-encode is within maxBytes');
  assert.equal(logs.some((l) => l.msg === 'fetch-video: refit'), false);

  const sizes2 = [1_200_000, 900_000];
  const ffmpeg2 = (child, command, args) => writesOutput(sizes2.shift())(child, command, args);
  const second = fakeSpawn(byTool({ ytdlp: writesOutput(1_500_000, '-o'), ffmpeg: ffmpeg2 }));
  const fetcher2 = makeFetcher({ spawnImpl: second.spawnImpl, tmpDir });
  const fitted = await fetcher2.fetchSiteClip(SITE_URL, { ...OPTS, maxBytes: 1_000_000, durationSec: 58 });

  assert.equal(fitted.ok, true);
  assert.equal(fitted.bytes, 900_000);
  assert.equal(fitted.seconds, 58);
  assert.equal(second.calls.length, 3);
  const clipPath = second.calls[0].args[second.calls[0].args.indexOf('-o') + 1];
  const fitArgs = second.calls[2].args;
  assert.equal(fitArgs[fitArgs.indexOf('-i') + 1], clipPath, 'the fit re-encode reads the download, not the first re-encode');
  // 1 MB over 58 s: 1e6 * 8 * 0.9 / 58 / 1000 = 124 kbps, minus 48 for audio -> the 100k floor.
  assert.equal(fitArgs[fitArgs.indexOf('-b:v') + 1], '100k');
  assert.equal(fitArgs[fitArgs.indexOf('-b:a') + 1], '48k');
  assert.deepEqual(await leftovers(), []);
});

test('fetchSiteClip: nothing written (the ceiling was exceeded) -> size, without ffmpeg', async () => {
  const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: (child) => child.emit('close', 0, null) }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: 58 }), { ok: false, reason: 'size' });
  assert.equal(calls.length, 1);
  assert.deepEqual(await leftovers(), []);
});

test('fetchSiteClip: a failed re-encode -> tool (missing ffmpeg, non-zero exit, no output); a hung one -> timeout', async () => {
  const cases = [
    [enoent, 'tool'],
    [(child) => child.emit('close', 1, null), 'tool'],
    [(child) => child.emit('close', 0, null), 'tool'],
    [() => {}, 'timeout'],
  ];
  for (const [ffmpeg, reason] of cases) {
    const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(3000, '-o'), ffmpeg }));
    const fetcher = makeFetcher({ spawnImpl, tmpDir });
    const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 50, durationSec: 58 });
    assert.deepEqual(result, { ok: false, reason });
    assert.equal(calls.length, 2);
    assert.deepEqual(await leftovers(), [], `leftovers after ffmpeg ${reason}`);
  }
});

test('fetchSiteClip: ENOENT -> tool, non-zero -> download, hang -> timeout, oversize -> size; no leftovers', async () => {
  const cases = [
    [enoent, 'tool'],
    [(child) => child.emit('close', 2, null), 'download'],
    [() => {}, 'timeout'],
    [byTool({ ytdlp: writesOutput(1001, '-o'), ffmpeg: writesOutput(1001) }), 'size'],
  ];
  for (const [behave, reason] of cases) {
    const fetcher = makeFetcher({ spawnImpl: fakeSpawn(behave).spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason });
    assert.deepEqual(await leftovers(), [], `leftovers after ${reason}`);
  }
});

// --- logging ---------------------------------------------------------------

test('logging: one warn per failure with source, reason, a query-free location and the exit code -- never tool output', async () => {
  const stderr = `${'x'.repeat(400)} ERROR: unable to fetch https://www.youtube.com/watch?v=abc123&token=secret now`;
  const { spawnImpl } = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 1, null);
  });
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  const { logs } = await withCapturedLogs(() => fetcher.fetchSiteClip(SITE_URL, OPTS));

  const lines = logs.filter((l) => l.msg.startsWith('fetch-video:'));
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.level, 'warn');
  assert.equal(line.source, 'link', 'a video-site link logs as source link, as collectVideos names it');
  assert.equal(line.reason, 'download');
  assert.equal(line.location, 'www.youtube.com/watch');
  assert.equal(line.code, 1);
  assert.ok(!('stderr' in line));
  assert.ok(!('error' in line));
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes('unable to fetch'));
  assert.ok(!serialized.includes('xxxx'));
  assert.ok(!serialized.includes('secret'));
  assert.ok(!serialized.includes('abc123'));
  assert.ok(!serialized.includes('?'));
});

test('logging: an attachment failure logs source attachment without the signed query string', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ ok: false, status: 403 }));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

  const { logs } = await withCapturedLogs(() => fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 5 }));

  const lines = logs.filter((l) => l.msg.startsWith('fetch-video:'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].source, 'attachment');
  assert.equal(lines[0].location, 'cdn.discordapp.com/attachments/1/2/clip.webm');
  assert.equal(lines[0].status, 403, 'a non-OK download logs its HTTP status');
  const serialized = JSON.stringify(lines[0]);
  assert.ok(!serialized.includes('deadbeef'));
  assert.ok(!serialized.includes('cafef00d'));
});

test('logging: a thrown error logs its code or name only, never its message', async () => {
  const cases = [
    [Object.assign(new Error('connect ECONNREFUSED https://cdn.discordapp.com/x?hm=secret'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    [new TypeError('fetch failed for https://cdn.discordapp.com/x?hm=secret'), 'TypeError'],
  ];
  for (const [error, code] of cases) {
    const { fetchImpl } = fakeFetch(error);
    const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

    const { logs } = await withCapturedLogs(() => fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 5 }));

    const [line] = logs.filter((l) => l.msg.startsWith('fetch-video:'));
    assert.equal(line.reason, 'download');
    assert.equal(line.code, code);
    assert.ok(!('error' in line));
    const serialized = JSON.stringify(line);
    assert.ok(!serialized.includes('secret'));
    assert.ok(!serialized.includes('fetch failed'));
  }
});

// --- probeYoutube ----------------------------------------------------------

const API_KEY = 'AIzaSecretTestKey';
const WATCH_PAGE = 'https://www.youtube.com/watch?v=abc123&hl=en';
const API_URL = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=abc123&key=${API_KEY}`;

/** An HTTP response whose body is `text` (or the given chunks). */
function textResponse(text, { ok = true, status = 200, chunks } = {}) {
  return fakeResponse({ ok, status, contentType: 'text/html', chunks: chunks ?? [Buffer.from(text)] });
}

/** A fetch fake answering by URL prefix: `routes` maps a prefix to a response, an Error or a function. */
function routedFetch(routes) {
  return fakeFetch((url, options) => {
    for (const [prefix, response] of Object.entries(routes)) {
      if (!url.startsWith(prefix)) continue;
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(url, options) : response;
    }
    throw new Error(`unexpected url ${url}`);
  });
}

const API_PREFIX = 'https://www.googleapis.com/';
const PAGE_PREFIX = 'https://www.youtube.com/watch';
const API_OK = JSON.stringify({ items: [{ contentDetails: { duration: 'PT3M34S' } }] });

test('probeYoutube: with an API key the Data API answers first and the page is never fetched', async () => {
  const { fetchImpl, calls } = routedFetch({ [API_PREFIX]: textResponse(API_OK) });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });

  const result = await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: API_KEY });

  assert.deepEqual(result, { ok: true, durationSec: 214 });
  assert.deepEqual(calls.map((c) => c.url), [API_URL]);
});

test('probeYoutube: without an API key only the watch page is fetched, with a browser UA and Accept-Language', async () => {
  for (const apiKey of [undefined, null, '']) {
    const { fetchImpl, calls } = routedFetch({ [PAGE_PREFIX]: textResponse('<script>{"lengthSeconds":"42"}</script>') });
    const fetcher = makeFetcher({ fetchImpl, tmpDir });

    const result = await fetcher.probeYoutube('https://youtu.be/abc123?si=track', { fetchTimeoutMs: 10_000, apiKey });

    assert.deepEqual(result, { ok: true, durationSec: 42 });
    assert.deepEqual(calls.map((c) => c.url), [WATCH_PAGE]);
    const { headers } = calls[0].options;
    assert.equal(
      headers['User-Agent'],
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    );
    assert.equal(headers['Accept-Language'], 'en');
  }
});

test('probeYoutube: an API failure falls through to the page, logging reason api without the key', async () => {
  const apiFailures = [
    textResponse('{"error":{}}', { ok: false, status: 403 }),
    textResponse(JSON.stringify({ items: [] })),
    Object.assign(new Error(`connect ECONNRESET ${API_URL}`), { code: 'ECONNRESET' }),
  ];
  for (const apiResponse of apiFailures) {
    const { fetchImpl, calls } = routedFetch({
      [API_PREFIX]: apiResponse,
      [PAGE_PREFIX]: textResponse('{"approxDurationMs":"61500"}'),
    });
    const fetcher = makeFetcher({ fetchImpl, tmpDir });

    const { result, logs } = await withCapturedLogs(() =>
      fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: API_KEY }),
    );

    assert.deepEqual(result, { ok: true, durationSec: 62 });
    assert.deepEqual(calls.map((c) => c.url), [API_URL, WATCH_PAGE]);
    const lines = logs.filter((l) => l.msg.startsWith('fetch-video:'));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'api');
    assert.equal(lines[0].location, 'www.googleapis.com/youtube/v3/videos');
    const serialized = JSON.stringify(lines);
    assert.ok(!serialized.includes(API_KEY), 'the key is never logged');
    assert.ok(!serialized.includes('ECONNRESET https'), 'never an error message');
  }
});

test('probeYoutube: a page without a duration, a non-OK page or a thrown fetch gives download', async () => {
  for (const page of [
    textResponse('<html>Before you continue to YouTube</html>'),
    textResponse('', { ok: false, status: 429 }),
    new TypeError('fetch failed'),
  ]) {
    const { fetchImpl } = routedFetch({ [PAGE_PREFIX]: page });
    const fetcher = makeFetcher({ fetchImpl, tmpDir });
    assert.deepEqual(await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000 }), { ok: false, reason: 'download' });
  }
});

test('probeYoutube: a page that outlives fetchTimeoutMs is aborted -> timeout', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  assert.deepEqual(await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 20 }), { ok: false, reason: 'timeout' });
});

test('probeYoutube: at most 2 MB of the page is read -- a duration past the cap is never seen', async () => {
  const filler = Buffer.alloc(2 * 1024 * 1024, 'x');
  const page = textResponse('', { chunks: [filler, Buffer.from('{"lengthSeconds":"42"}'), Buffer.from('tail')] });
  const { fetchImpl } = routedFetch({ [PAGE_PREFIX]: page });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });

  const result = await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000 });

  assert.deepEqual(result, { ok: false, reason: 'download' });
  assert.ok(page.body.pulled <= 2, `pulled ${page.body.pulled} chunks`);
});

test('probeYoutube: a non-YouTube URL gives download without any request', async () => {
  const { fetchImpl, calls } = fakeFetch(textResponse('{"lengthSeconds":"42"}'));
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  const result = await fetcher.probeYoutube('https://www.tiktok.com/@someone/video/123', { fetchTimeoutMs: 10_000, apiKey: API_KEY });
  assert.deepEqual(result, { ok: false, reason: 'download' });
  assert.equal(calls.length, 0);
});

test('probeYoutube: pageFallback false stops after a failed Data API call, never fetching the page', async () => {
  const { fetchImpl, calls } = routedFetch({
    [API_PREFIX]: textResponse('', { ok: false, status: 403 }),
    [PAGE_PREFIX]: textResponse('{"lengthSeconds":"42"}'),
  });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  const { result } = await withCapturedLogs(() =>
    fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: API_KEY, pageFallback: false }),
  );
  assert.deepEqual(result, { ok: false, reason: 'download' });
  assert.deepEqual(calls.map((c) => c.url), [API_URL]);
});

test('probeYoutube: pageFallback false without a key makes no request', async () => {
  const { fetchImpl, calls } = fakeFetch(textResponse('{"lengthSeconds":"42"}'));
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  const { result } = await withCapturedLogs(() =>
    fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: null, pageFallback: false }),
  );
  assert.deepEqual(result, { ok: false, reason: 'download' });
  assert.equal(calls.length, 0);
});

// --- proxy -------------------------------------------------------------------

const PROXY = 'socks5h://user:s3cr%40t@proxy.example:1080';

test('fetchSiteClip: with a proxy and an unknown or long duration the whole download is trimmed even under maxBytes', async () => {
  for (const durationSec of [null, 125]) {
    const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(500, '-o'), ffmpeg: writesOutput(300) }));
    const fetcher = makeFetcher({ spawnImpl, tmpDir });
    const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec, proxy: PROXY });
    assert.equal(result.ok, true);
    assert.equal(result.bytes, 300, `the trimmed file is returned for duration ${durationSec}`);
    assert.equal(result.seconds, 60);
    assert.equal(calls.length, 2);
    const ytArgs = calls[0].args;
    assert.equal(ytArgs[ytArgs.indexOf('--proxy') + 1], PROXY);
    assert.equal(ytArgs.includes('--download-sections'), false);
    assert.equal(ytArgs[ytArgs.indexOf('--max-filesize') + 1], '4000');
    assert.equal(calls[1].command, 'ffmpeg');
    assert.equal(calls[1].args[calls[1].args.indexOf('-t') + 1], '60');
    assert.equal(calls[1].args.includes(PROXY), false, 'ffmpeg never gets the proxy');
    assert.deepEqual(await leftovers(), []);
  }
});

test('fetchSiteClip: with a proxy a known short video under maxBytes is returned as-is', async () => {
  const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(500, '-o') }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: 58, proxy: PROXY });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 500);
  assert.equal(result.seconds, 58);
  assert.equal(calls.length, 1);
});

test('fetchSiteClip: with a proxy the trim still ends in size when its output stays over maxBytes', async () => {
  const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(500, '-o'), ffmpeg: writesOutput(1001) }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: null, proxy: PROXY });
  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.equal(calls.length, 3);
});

test('fetchSiteClip: without a proxy an unknown duration under maxBytes is not trimmed (sections cut instead)', async () => {
  const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(500, '-o') }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: null, proxy: '' });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('--proxy'), false);
  assert.equal(calls[0].args[calls[0].args.indexOf('--download-sections') + 1], '*0-60');
});

test('probeSite: a proxy reaches yt-dlp as --proxy', async () => {
  const { spawnImpl, calls } = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('{"duration":12,"title":"t"}'));
    child.emit('close', 0, null);
  });
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  const result = await fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY });
  assert.equal(result.ok, true);
  assert.equal(calls[0].args[calls[0].args.indexOf('--proxy') + 1], PROXY);
});

test('logging: failures with a proxy never log the proxy URL or its credentials', async () => {
  // A spawn error whose message carries the proxy URL, as a careless tool might report it.
  const leaky = (child) => {
    const err = new Error(`connect failed via ${PROXY}`);
    err.code = 'ECONNREFUSED';
    child.emit('error', err);
  };
  const probe = (fetcher) => fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY });
  const clip = (fetcher) => fetcher.fetchSiteClip(SITE_URL, { ...OPTS, proxy: PROXY });
  const cases = [
    [leaky, probe],
    [leaky, clip],
    [(child) => child.emit('close', 1, null), probe],
    [(child) => child.emit('close', 1, null), clip],
    [byTool({ ytdlp: writesOutput(500, '-o'), ffmpeg: leaky }), clip],
  ];
  for (const [behave, run] of cases) {
    const fetcher = makeFetcher({ spawnImpl: fakeSpawn(behave).spawnImpl, tmpDir });
    const { result, logs } = await withCapturedLogs(() => run(fetcher));
    assert.equal(result.ok, false);
    assert.ok(logs.some((l) => l.msg === 'fetch-video: failed'), 'the failure is logged');
    const serialized = JSON.stringify(logs) + JSON.stringify(result);
    assert.equal(serialized.includes('proxy.example'), false);
    assert.equal(serialized.includes('s3cr'), false);
    assert.equal(serialized.includes('socks5h'), false);
  }
});

// --- proxy fallback ------------------------------------------------------------

const PROBE_JSON = '{"duration":12,"title":"t"}';

/** yt-dlp that fails through the proxy (exit 1) unless `proxyWorks`, and answers the probe directly. */
function proxyAware({ proxyWorks = false } = {}) {
  return (child, command, args) => {
    if (args.includes('--proxy') && !proxyWorks) return child.emit('close', 1, null);
    child.stdout.emit('data', Buffer.from(PROBE_JSON));
    return child.emit('close', 0, null);
  };
}

/** A settable clock. */
function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('proxy fallback: a failed proxied probe is retried directly and succeeds; the failure is logged without the proxy', async () => {
  const { spawnImpl, calls } = fakeSpawn(proxyAware());
  const fetcher = makeFetcher({ spawnImpl, tmpDir, now: clock().now });
  const { result, logs } = await withCapturedLogs(() => fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY }));
  assert.deepEqual(result, { ok: true, durationSec: 12, title: 't' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[calls[0].args.indexOf('--proxy') + 1], PROXY);
  assert.equal(calls[1].args.includes('--proxy'), false);
  const failed = logs.filter((l) => l.msg === 'fetch-video: proxy failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, 'warn');
  assert.equal(failed[0].stage, 'probe');
  assert.equal(failed[0].reason, 'download');
  assert.equal(failed[0].code, 1);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('proxy.example'), false);
  assert.equal(serialized.includes('s3cr'), false);
});

test('proxy fallback: a proxied spawn error or timeout is retried directly too, with its own reason', async () => {
  const cases = [
    [enoent, 'tool', 'ENOENT'],
    [() => {}, 'timeout', 'SIGKILL'],
  ];
  for (const [proxied, reason, code] of cases) {
    const { spawnImpl, calls } = fakeSpawn((child, command, args) =>
      args.includes('--proxy') ? proxied(child) : proxyAware()(child, command, args));
    const fetcher = makeFetcher({ spawnImpl, tmpDir, now: clock().now });
    const { result, logs } = await withCapturedLogs(() =>
      fetcher.probeSite(SITE_URL, { ...OPTS, toolTimeoutMs: 30, proxy: PROXY }));
    assert.equal(result.ok, true, reason);
    assert.equal(calls.length, 2);
    const [line] = logs.filter((l) => l.msg === 'fetch-video: proxy failed');
    assert.equal(line.reason, reason);
    assert.equal(line.code ?? null, code);
  }
});

test('proxy fallback: a failed direct retry is reported as before', async () => {
  const { spawnImpl, calls } = fakeSpawn((child) => child.emit('close', 1, null));
  const fetcher = makeFetcher({ spawnImpl, tmpDir, now: clock().now });
  const { result, logs } = await withCapturedLogs(() => fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY }));
  assert.deepEqual(result, { ok: false, reason: 'download' });
  assert.equal(calls.length, 2);
  assert.equal(logs.filter((l) => l.msg === 'fetch-video: failed').length, 1);
});

test('proxy fallback: within the cooldown the proxy is not tried and the skip is logged once; after it the proxy is tried again', async () => {
  const time = clock();
  const { spawnImpl, calls } = fakeSpawn(proxyAware());
  const fetcher = makeFetcher({ spawnImpl, tmpDir, now: time.now });
  await withCapturedLogs(() => fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY, proxyRetryMinutes: 10 }));
  assert.equal(calls.length, 2);

  time.t += 5 * 60_000;
  const { logs } = await withCapturedLogs(async () => {
    await fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY, proxyRetryMinutes: 10 });
    await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: null, proxy: PROXY, proxyRetryMinutes: 10 });
  });
  assert.equal(calls.length, 4, 'one yt-dlp run per call');
  assert.equal(calls[2].args.includes('--proxy'), false);
  assert.equal(calls[3].args.includes('--proxy'), false);
  assert.equal(calls[3].args[calls[3].args.indexOf('--download-sections') + 1], '*0-60', 'the direct clip keeps the cut');
  const skipped = logs.filter((l) => l.msg === 'fetch-video: proxy skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'cooldown');
  assert.equal(JSON.stringify(logs).includes('proxy.example'), false);

  time.t += 6 * 60_000;
  await withCapturedLogs(() => fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY, proxyRetryMinutes: 10 }));
  assert.equal(calls[4].args[calls[4].args.indexOf('--proxy') + 1], PROXY, 'the window passed: the proxy is tried again');
});

test('proxy fallback: the cooldown length follows proxyRetryMinutes', async () => {
  const time = clock();
  const { spawnImpl, calls } = fakeSpawn(proxyAware());
  const fetcher = makeFetcher({ spawnImpl, tmpDir, now: time.now });
  await withCapturedLogs(() => fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY, proxyRetryMinutes: 1 }));
  time.t += 61_000;
  await withCapturedLogs(() => fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY, proxyRetryMinutes: 1 }));
  assert.ok(calls[2].args.includes('--proxy'));
});

test('proxy fallback: a proxied success never opens the cooldown', async () => {
  const time = clock();
  const { spawnImpl, calls } = fakeSpawn(proxyAware({ proxyWorks: true }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir, now: time.now });
  const { logs } = await withCapturedLogs(async () => {
    await fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY });
    time.t += 60_000;
    await fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY });
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.args.includes('--proxy')));
  assert.equal(logs.some((l) => l.msg.startsWith('fetch-video: proxy')), false);
});

test('proxy fallback: a failed proxied clip is downloaded again directly with the sections cut, no local trim', async () => {
  const { spawnImpl, calls } = fakeSpawn(byTool({
    ytdlp: (child, command, args) => (args.includes('--proxy')
      ? child.emit('close', 1, null)
      : writesOutput(500, '-o')(child, command, args)),
  }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir, now: clock().now });
  const { result, logs } = await withCapturedLogs(() =>
    fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: null, proxy: PROXY }));
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 500);
  assert.equal(calls.length, 2, 'proxied yt-dlp, direct yt-dlp, no ffmpeg');
  const direct = calls[1].args;
  assert.equal(direct.includes('--proxy'), false);
  assert.equal(direct[direct.indexOf('--download-sections') + 1], '*0-60');
  assert.notEqual(direct[direct.indexOf('-o') + 1], calls[0].args[calls[0].args.indexOf('-o') + 1]);
  const [line] = logs.filter((l) => l.msg === 'fetch-video: proxy failed');
  assert.equal(line.stage, 'clip');
  assert.deepEqual(await leftovers(), []);
});

test('proxy fallback: a link without a proxy (a site outside proxySites) is untouched by the cooldown', async () => {
  const { spawnImpl, calls } = fakeSpawn(proxyAware());
  const fetcher = makeFetcher({ spawnImpl, tmpDir, now: clock().now });
  await withCapturedLogs(() => fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY }));
  const { result, logs } = await withCapturedLogs(() =>
    fetcher.probeSite('https://vk.com/video-1_2', { ...OPTS, proxy: null }));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].args.includes('--proxy'), false);
  assert.equal(logs.some((l) => l.msg.startsWith('fetch-video: proxy')), false, 'no skip line for a direct site');
});

// --- proxy liveness --------------------------------------------------------------

test('proxy liveness: a proxied failure with a reachable proxy is the video\'s own -- no direct retry, no cooldown', async () => {
  const time = clock();
  const checked = [];
  const { spawnImpl, calls } = fakeSpawn(proxyAware());
  const fetcher = makeFetcher({
    spawnImpl,
    tmpDir,
    now: time.now,
    probeProxy: async (url) => {
      checked.push(url);
      return true;
    },
  });
  const { result, logs } = await withCapturedLogs(async () => {
    const probe = await fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY });
    const clip = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, proxy: PROXY });
    return { probe, clip };
  });
  assert.deepEqual(result.probe, { ok: false, reason: 'download' });
  assert.deepEqual(result.clip, { ok: false, reason: 'download' });
  assert.equal(calls.length, 2, 'one proxied run per call, no direct retry');
  assert.ok(calls.every((c) => c.args.includes('--proxy')), 'the second call still uses the proxy: no cooldown');
  assert.deepEqual(checked, [PROXY, PROXY], 'the check runs once per failure');
  const failed = logs.filter((l) => l.msg === 'fetch-video: failed');
  assert.equal(failed.length, 2);
  assert.ok(failed.every((l) => l.proxied === true && l.reason === 'download' && l.code === 1));
  assert.equal(logs.some((l) => l.msg.startsWith('fetch-video: proxy')), false);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('proxy.example'), false);
  assert.equal(serialized.includes('s3cr'), false);
  assert.equal(serialized.includes('1080'), false);
});

test('proxy liveness: an unreachable proxy (false or a throwing check) gets the direct retry and the cooldown', async () => {
  for (const probeProxy of [async () => false, async () => { throw new Error(`down: ${PROXY}`); }]) {
    const time = clock();
    const { spawnImpl, calls } = fakeSpawn(proxyAware());
    const fetcher = makeFetcher({ spawnImpl, tmpDir, now: time.now, probeProxy });
    const { result, logs } = await withCapturedLogs(async () => {
      const first = await fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY });
      await fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY });
      return first;
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3, 'proxied, direct retry, then direct in the cooldown');
    assert.equal(calls[1].args.includes('--proxy'), false);
    assert.equal(calls[2].args.includes('--proxy'), false);
    assert.equal(logs.filter((l) => l.msg === 'fetch-video: proxy failed').length, 1);
    assert.equal(JSON.stringify(logs).includes('proxy.example'), false);
  }
});

test('proxy liveness: a proxied success never runs the check', async () => {
  let checks = 0;
  const { spawnImpl } = fakeSpawn(proxyAware({ proxyWorks: true }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir, probeProxy: async () => { checks += 1; return false; } });
  const result = await fetcher.probeSite(SITE_URL, { ...OPTS, proxy: PROXY });
  assert.equal(result.ok, true);
  assert.equal(checks, 0);
});

/** A net.connect stub: records its options and makes the socket `connect`, `error` or stay silent. */
function fakeConnect(outcome) {
  const seen = [];
  const connect = (options) => {
    seen.push(options);
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => {
      socket.destroyed = true;
    };
    if (outcome === 'connect') setImmediate(() => socket.emit('connect'));
    if (outcome === 'error') setImmediate(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    seen.socket = socket;
    return socket;
  };
  return { connect, seen };
}

test('proxyReachable: a connect is alive, an error or a timeout is down; host and port come from the URL', async () => {
  const ok = fakeConnect('connect');
  assert.equal(await proxyReachable(PROXY, { connect: ok.connect, timeoutMs: 50 }), true);
  assert.deepEqual(ok.seen[0], { host: 'proxy.example', port: 1080 });
  assert.equal(ok.seen.socket.destroyed, true, 'the socket is closed after the check');
  assert.equal(await proxyReachable(PROXY, { connect: fakeConnect('error').connect, timeoutMs: 50 }), false);
  const silent = fakeConnect('silent');
  assert.equal(await proxyReachable(PROXY, { connect: silent.connect, timeoutMs: 20 }), false);
  assert.equal(silent.seen.socket.destroyed, true);
});

test('proxyReachable: default ports per scheme; an unparsable URL or unknown scheme without a port is down', async () => {
  const cases = [
    ['socks5h://h.example', 1080],
    ['socks5://u:p@h.example', 1080],
    ['http://h.example', 80],
    ['https://h.example', 443],
    ['http://h.example:3128', 3128],
  ];
  for (const [url, port] of cases) {
    const fake = fakeConnect('connect');
    assert.equal(await proxyReachable(url, { connect: fake.connect, timeoutMs: 50 }), true, url);
    assert.equal(fake.seen[0].port, port, url);
  }
  for (const url of ['not a url', 'ftp://h.example', '']) {
    const fake = fakeConnect('connect');
    assert.equal(await proxyReachable(url, { connect: fake.connect, timeoutMs: 50 }), false, url);
    assert.equal(fake.seen.length, 0);
  }
  const throwing = () => { throw new Error('boom'); };
  assert.equal(await proxyReachable(PROXY, { connect: throwing, timeoutMs: 50 }), false);
});

// --- the audio measurement --------------------------------------------------

const AUDIO_MAP = { noiseDb: -50, minSilenceSeconds: 0.5, mapBelowShare: 0.8, maxSpans: 20 };
const STDERR_NO_AUDIO = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in':",
  '  Duration: 00:00:12.00, start: 0.000000, bitrate: 34 kb/s',
  '  Stream #0:0(und): Video: h264 (High), yuv420p, 160x120 (default)',
  'Output file #0 does not contain any stream',
].join('\n');
const STDERR_SPARSE = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'small.mp4':",
  '  Duration: 00:01:00.00, start: 0.000000, bitrate: 76 kb/s',
  '  Stream #0:0(und): Video: h264 (High), yuv420p, 640x360 (default)',
  '  Stream #0:1(und): Audio: aac (LC), 44100 Hz, mono, fltp, 96 kb/s (default)',
  '[silencedetect @ 0x1] silence_start: 0',
  '[silencedetect @ 0x1] silence_end: 12.2 | silence_duration: 12.2',
  '[silencedetect @ 0x1] silence_start: 13.4',
].join('\n');

/** Whether a fake run is the audio measurement. */
function isMeasure(args) {
  return args.some((arg) => String(arg).startsWith('silencedetect='));
}

/** A measuring ffmpeg that prints `stderr` and exits with `code`. */
function measures(stderr, code = 0) {
  return (child) => {
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code, null);
  };
}

test('fetchAttachment: with audioMap an as-is clip with no audio stream is measured read-only -> audio none', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl, calls } = fakeSpawn(measures(STDERR_NO_AUDIO, 1));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 12, audioMap: AUDIO_MAP });

  assert.equal(result.ok, true);
  assert.deepEqual(result.audio, { kind: 'none' });
  assert.equal(calls.length, 1);
  assert.ok(isMeasure(calls[0].args));
  assert.equal(calls[0].options.stdio[2], 'pipe', 'only the measurement reads stderr');
  assert.equal(calls[0].args[calls[0].args.indexOf('-f') + 1], 'null', 'nothing is written');
  assert.equal(calls[0].args.includes('-y'), false);
  assert.deepEqual(await leftovers(), []);
});

test('fetchSiteClip: with audioMap the clip sent is measured -> a mostly silent one is a map', async () => {
  const ffmpeg = (child, command, args) => (isMeasure(args) ? measures(STDERR_SPARSE)(child) : writesOutput(600)(child, command, args));
  const { spawnImpl, calls } = fakeSpawn(byTool({ ytdlp: writesOutput(3000, '-o'), ffmpeg }));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: 125, audioMap: AUDIO_MAP });

  assert.equal(result.ok, true);
  assert.deepEqual(result.audio, { kind: 'map', spans: [[12.2, 13.4]] });
  assert.equal(calls.length, 3);
  const trimOut = calls[1].args[calls[1].args.length - 1];
  assert.equal(calls[2].args[calls[2].args.indexOf('-i') + 1], trimOut, 'the re-encoded clip is the one measured');
  assert.equal(calls[1].options.stdio[2], 'ignore');
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a failed measurement is one warn line and audio null, never a failed fetch', async () => {
  for (const [behave, reason] of [[measures('garbage', 1), 'tool'], [measures('garbage', 0), 'parse'], [enoent, 'tool'], [() => {}, 'timeout']]) {
    const { fetchImpl } = fakeFetch(fakeResponse());
    const { spawnImpl } = fakeSpawn(behave);
    const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });
    const { result, logs } = await withCapturedLogs(() =>
      fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, toolTimeoutMs: 50, durationSec: 12, audioMap: AUDIO_MAP }),
    );
    assert.equal(result.ok, true, reason);
    assert.equal(result.audio, null);
    const failed = logs.filter((l) => l.msg === 'fetch-video: audio map failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason, reason);
    assert.equal(JSON.stringify(failed).includes('garbage'), false, 'tool output is never logged');
    assert.deepEqual(await leftovers(), []);
  }
});

test('fetchAttachment: an input that prints no duration is measured against the known clip length', async () => {
  const stderr = STDERR_SPARSE.replace(/Duration: [^,]+/, 'Duration: N/A').split('\n').slice(0, 4).join('\n') +
    '\n[silencedetect @ 0x1] silence_start: 3';
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl } = fakeSpawn(measures(stderr));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 12, audioMap: AUDIO_MAP });

  assert.deepEqual(result.audio, { kind: 'map', spans: [[0, 3]] });
});

test('fetchAttachment: without audioMap nothing is measured and the result has no audio field', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl, calls } = fakeSpawn(() => assert.fail('nothing runs'));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 12, audioMap: null });

  assert.equal(result.ok, true);
  assert.equal('audio' in result, false);
  assert.equal(calls.length, 0);
});
