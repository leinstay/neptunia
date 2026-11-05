// A deployment's preamble has no length cap: how much to write is the deployment's choice. The runner protocol
// (src/agent-runner/protocol.ts#validateRequest) takes a preamble of any length whole, and the composition of the
// preamble files (src/errands/preambles.ts#composePreamble) keeps every matching file and names none as dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestLine, validateRequest } from '../src/agent-runner/protocol.ts';
import { composePreamble } from '../src/errands/preambles.ts';

test('validateRequest: a preamble of 100000 characters is accepted and kept whole', () => {
  // Catches: the old 8000-character cap still refuses a long preamble with preamble-too-long, or the text is cut.
  const long = `START ${'p'.repeat(100_000)} END`;
  const checked = validateRequest({ op: 'run', id: 'a', goal: 'x', preamble: long });
  const kept = checked.ok && checked.message.op === 'run' ? (checked.message.preamble ?? '') : '';
  assert.deepEqual(
    { ok: checked.ok, chars: kept.length, whole: kept === long },
    { ok: true, chars: long.length, whole: true }
  );
});

test('parseRequestLine: a run line with a preamble of 300000 two-byte characters arrives whole', () => {
  // Catches: a cap counted in bytes or characters anywhere on the way in from the socket line.
  const long = 'é'.repeat(300_000);
  const parsed = parseRequestLine(JSON.stringify({ op: 'run', id: 'task-long', goal: 'g', preamble: long }));
  const kept = parsed.ok && parsed.message.op === 'run' ? (parsed.message.preamble ?? '') : '';
  assert.deepEqual(
    { ok: parsed.ok, chars: kept.length, whole: kept === long },
    { ok: true, chars: long.length, whole: true }
  );
});

test('composePreamble: every matching file goes in whole however long, and no file is named as dropped', () => {
  // Catches: the composition still drops a file that does not fit a cap, so a deployment's long preamble loses its
  // agent or model part without anyone deciding it.
  const all = 'a'.repeat(60_000);
  const scout = 's'.repeat(60_000);
  const out = composePreamble({ prompts: { preambles: { all, scout } }, agent: 'scout' });
  assert.equal(out.text === `${all}\n\n${scout}`, true, 'both files, whole, in order');
  assert.deepEqual(out.files, ['preambles/all.md', 'preambles/scout.md']);
  assert.equal(out.chars, 120_002);
  assert.equal(Object.hasOwn(out, 'dropped'), false, 'the result names no dropped files');
});
