// Tests for src/llm/tokens.js: token estimation and the usage calibrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateMessages, estimateTools, createCalibrator } from '../src/llm/tokens.js';

test('estimateTokens: non-ASCII costs more tokens than the same length of ASCII', () => {
  const ascii = estimateTokens('a'.repeat(20));
  const nonAscii = estimateTokens('α'.repeat(20));
  assert.ok(nonAscii > ascii, `expected non-ASCII (${nonAscii}) > ascii (${ascii})`);
});

test('estimateMessages: sums overhead across multiple messages', () => {
  const total = estimateMessages([
    { role: 'system', content: 'a'.repeat(7) },
    { role: 'user', content: 'a'.repeat(7) },
  ]);
  assert.equal(total, 16);
});

test('estimateMessages: an image_url part is charged the flat tokensPerImage regardless of the URL length (a data: URL must not be counted as text)', () => {
  const longDataUrl = `data:image/webp;base64,${'A'.repeat(500_000)}`;
  const total = estimateMessages(
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: longDataUrl } }] }],
    400,
  );
  // overhead 6 + flat 400, NOT proportional to the ~500,000-character data URL --
  // otherwise the 50k request cap would refuse every request with a picture.
  assert.equal(total, 6 + 400);
});

test('estimateMessages: a video_url part is charged 0 tokens (its cost comes through videoSeconds)', () => {
  const total = estimateMessages(
    [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=x' } }] }],
    400,
  );
  assert.equal(total, 6);
});

test('estimateMessages: next to a video_url part, an image_url part still costs tokensPerImage', () => {
  const total = estimateMessages(
    [{
      role: 'user',
      content: [
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'x' } },
      ],
    }],
    400,
  );
  assert.equal(total, 6 + 400);
});

test('estimateMessages: custom tokensPerImage is honoured', () => {
  const total = estimateMessages(
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
    100,
  );
  assert.equal(total, 6 + 100);
});

test('createCalibrator: clamps an out-of-range initial ratio to RATIO_MIN/RATIO_MAX', () => {
  assert.equal(createCalibrator(0.1).ratio, 0.6);
  assert.equal(createCalibrator(5).ratio, 1.6);
});

test('createCalibrator: a non-finite initial ratio falls back to 1', () => {
  assert.equal(createCalibrator(NaN).ratio, 1);
  assert.equal(createCalibrator(undefined).ratio, 1);
});

test('createCalibrator: apply() multiplies and rounds up', () => {
  const cal = createCalibrator(1.5);
  assert.equal(cal.apply(10), 15);
  assert.equal(cal.apply(1), 2); // ceil(1.5)
});

test('createCalibrator: observe() ignores samples with a tiny raw estimate', () => {
  const cal = createCalibrator(1);
  cal.observe(200, 1000); // rawEstimate must be > 200, 200 is not enough
  assert.equal(cal.ratio, 1);
});

test('createCalibrator: observe() ignores samples with non-positive actual tokens', () => {
  const cal = createCalibrator(1);
  cal.observe(1000, 0);
  assert.equal(cal.ratio, 1);
});

test('createCalibrator: observe() converges toward the observed ratio over repeated samples', () => {
  const cal = createCalibrator(1);
  for (let i = 0; i < 200; i += 1) cal.observe(1000, 1300);
  assert.ok(Math.abs(cal.ratio - 1.3) < 0.01, `expected ratio close to 1.3, got ${cal.ratio}`);
});

test('createCalibrator: observe() clamps the observed sample before averaging', () => {
  const cal = createCalibrator(1);
  for (let i = 0; i < 500; i += 1) cal.observe(1000, 100000); // sample ratio 100, clamped to 1.6
  // The blended EMA result is itself re-clamped, so it must never exceed RATIO_MAX,
  // not even by floating-point noise (see the fix in createCalibrator.observe()).
  assert.ok(cal.ratio <= 1.6, `ratio must never exceed RATIO_MAX, got ${cal.ratio}`);
  assert.equal(cal.ratio, 1.6);
});

test('estimateTools: zero without tools, the JSON of the definitions otherwise', () => {
  assert.equal(estimateTools(undefined), 0);
  assert.equal(estimateTools([]), 0);
  const tools = [{ type: 'function', function: { name: 'a', description: 'x'.repeat(70), parameters: { type: 'object' } } }];
  assert.equal(estimateTools(tools), estimateTokens(JSON.stringify(tools)) + 6);
});

test('estimateMessages: tool_calls of an assistant message and a null content are counted, a message without them is unchanged', () => {
  const plain = estimateMessages([{ role: 'assistant', content: 'ab' }]);
  const calling = estimateMessages([{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'draw_create', arguments: 'a'.repeat(70) } }] }]);
  assert.ok(calling > plain + 20);
  assert.equal(estimateMessages([{ role: 'tool', tool_call_id: 'c1', content: 'a'.repeat(7) }]), 8);
});
