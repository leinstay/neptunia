// New reproductions, written from the risk the plan describes (a profile that changes between its check and its use);
// the original scenarios were not found. A personal definition is validated and consumed from one trusted snapshot, so
// swapping a file for a link to somewhere else in the gap between the check and the read gains nothing. The gap is made
// deterministic by acting at the module's own file reads: the swap happens exactly when the code reaches that file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentProfileError, listAgents } from '../src/agent-runner/profiles.ts';
import { consumerRig, consumers } from './fixtures/agent-consumers.ts';

const OUTSIDE_SECONDS = 99_999;

/** Calls `onRead(file)` before each read of a file by path, then reads it as asked; `undo` puts `fs` back. */
function atEachRead(onRead: (file: string) => void): { undo: () => void } {
  const original = fs.readFileSync;
  const wrapped = (file: unknown, ...rest: Array<unknown>): unknown => {
    if (typeof file === 'string') onRead(file);
    return Reflect.apply(original, fs, [file, ...rest]);
  };
  // The modules under test read through this object; a test replaces the one method for the length of one call.
  Object.assign(fs, { readFileSync: wrapped });
  return { undo: () => Object.assign(fs, { readFileSync: original }) };
}

test('new reproduction: a profile swapped for a link after its check does not reach the definition', () => {
  // Bug: the link check and the read are two steps, so a link placed between them feeds in limits from any file, and
  // putting the file back before the second check leaves no trace.
  const rig = consumerRig();
  const file = path.join(rig.personal, 'profile.json');
  rig.override({ limits: { seconds: 17 } });
  const regular = fs.readFileSync(file, 'utf8');
  const outside = path.join(rig.base, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ limits: { seconds: OUTSIDE_SECONDS } }));
  const original = fs.readFileSync;
  let swapped = false;
  const hook = atEachRead((read) => {
    if (read !== file || swapped) return;
    swapped = true;
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    // The read below follows the link; the file is back before anything looks again.
    queueMicrotask(() => {});
  });
  const restoring = fs.readFileSync;
  Object.assign(fs, {
    readFileSync: (given: unknown, ...rest: Array<unknown>): unknown => {
      const text = Reflect.apply(restoring, fs, [given, ...rest]) as unknown;
      if (given === file && fs.lstatSync(file).isSymbolicLink()) {
        fs.rmSync(file);
        fs.writeFileSync(file, regular);
      }
      return text;
    },
  });
  try {
    let seconds: unknown = null;
    try {
      const definition = listAgents(rig.options).find((agent) => agent.id === 'scout');
      seconds = (definition as { limits?: { seconds?: unknown } } | undefined)?.limits?.seconds;
    } catch (error) {
      assert.ok(error instanceof AgentProfileError, String(error));
    }
    assert.notEqual(seconds, OUTSIDE_SECONDS);
  } finally {
    hook.undo();
    Object.assign(fs, { readFileSync: original });
    rig.close();
  }
});

test('new reproduction: a prompt swapped for a link after the check does not reach the brief', async () => {
  // Bug: the engine validates the definition, then opens the prompt by path, so a link placed in between sends the
  // contents of any readable file to the model as its instructions.
  const rig = consumerRig();
  const prompt = path.join(rig.personal, 'prompt.md');
  fs.mkdirSync(rig.personal, { recursive: true });
  fs.writeFileSync(prompt, 'PERSONAL-PROMPT');
  const outside = path.join(rig.base, 'outside-secret.txt');
  fs.writeFileSync(outside, 'OUTSIDE-SECRET-MARKER');
  const engine = consumers.engine({
    profile: rig.profile,
    agentPaths: rig.options,
    outDir: path.join(rig.base, 'out'),
    subharness: rig.subharness,
  });
  let swapped = false;
  const hook = atEachRead((read) => {
    if (read !== prompt || swapped) return;
    swapped = true;
    fs.rmSync(prompt);
    fs.symlinkSync(outside, prompt);
  });
  try {
    await engine.run({
      id: 'swapped',
      goal: 'inspect synthetic files',
      context: {},
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    for (const call of rig.calls) assert.doesNotMatch(call.brief, /OUTSIDE-SECRET-MARKER/);
  } finally {
    hook.undo();
    rig.close();
  }
});
