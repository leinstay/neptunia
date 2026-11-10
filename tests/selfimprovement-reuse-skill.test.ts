// The selfimprovement wake asks her to reuse a skill she already has before she proposes a new one, and the request it
// builds carries her skills so the instruction has something to point at. Read through `buildRequest` with the tracked
// prompt file and the `<work>` body the turn renders (`workLines`) on the service frame, on the shipped settings and labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSelfimprovementFacts } from '../src/behavior/selfimprovement-view.ts';
import { workLines } from '../src/behavior/selfimprovement-text.ts';
import { frameOf } from '../src/turn/request/frame.ts';
import { joinLabels } from '../src/config/labels.ts';
import { createCalibrator } from '../src/llm/tokens.ts';
import { buildRequest } from './fixtures/built-request.ts';
import { PROMPT_MARK, WAKE_NOW, requestText } from './fixtures/wake-turn.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: Array<string>): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const labels = JSON.parse(read('config', 'labels.json')) as {
  model: { wake: { selfimprovement: { skillOff: string } } };
};

const NONE = { discovered: 0, read: 0, tried: 0, succeeded: 0, corrected: 0, declined: 0 };
const PROMPT = read('prompts', 'selfimprovement.md');

/** The request of a selfimprovement wake over her skills, with the tracked prompt file as its task. */
async function requestWith(skills: ReadonlyArray<{ name: string; active: boolean }>): Promise<string> {
  const facts = await buildSelfimprovementFacts({
    now: WAKE_NOW,
    since: null,
    journal: null,
    granted: [],
    skills: skills.map((one) => ({ ...one, counts: NONE })),
    proposals: [],
    outbox: [],
  });
  // Slice 5: `<wake>` is gone; her skills reach the request as lines of `<work>` in `<inner>`, on the service frame.
  const words = joinLabels(labels as never) as unknown as { wake: { selfimprovement: unknown } };
  const work = workLines(facts, words.wake.selfimprovement, () => '', null).join('\n');
  const config: unknown = JSON.parse(read('config', 'config.json'));
  const request = buildRequest({
    config,
    prompts: {
      'system-prompt': 'system',
      'character-card': PROMPT_MARK.card,
      format: 'format',
      inner: PROMPT_MARK.inner,
      selfimprovement: PROMPT,
      labels: joinLabels(labels as never),
    },
    calibrator: createCalibrator(),
    mode: 'inner',
    now: WAKE_NOW,
    selfName: 'Her',
    history: [],
    neighbors: [],
    trigger: null,
    triggerKind: 'inner',
    interlocutor: null,
    otherProfiles: [],
    candidateProfiles: [],
    nameOf: (id: string) => id,
    channels: [],
    loreEntries: [],
    descriptions: new Map(),
    neighborDescriptions: new Map(),
    videos: new Map(),
    reads: new Map(),
    wakeKind: 'selfimprovement',
    serviceInner: { work, board: '' },
    frame: frameOf({
      mode: 'inner',
      triggerKind: 'inner',
      wakeKind: 'selfimprovement',
      interface: 'discord',
      chain: [],
      dm: null,
      trigger: null,
      author: null,
      now: WAKE_NOW,
      timezone: 'UTC',
    }),
  });
  return requestText(request.messages as never);
}

test('the request carries her active skills by name, next to the tracked wake prompt', async () => {
  // Bug: the skills are in the facts and not in the request, so she cannot compare a need with what she already has.
  const text = await requestWith([
    { name: 'brief-the-news', active: true },
    { name: 'old-routine', active: false },
  ]);
  assert.ok(text.includes('brief-the-news'));
  assert.ok(text.includes(PROMPT.trim().slice(0, 60)), 'the tracked wake prompt');
});

test('a skill she switched off is marked off in the request and an active one is not', async () => {
  // Bug: every skill reads as available, and she reuses one that no longer runs.
  const text = await requestWith([
    { name: 'brief-the-news', active: true },
    { name: 'old-routine', active: false },
  ]);
  const line = (name: string): string => text.split('\n').find((one) => one.includes(name)) ?? '';
  // The lead: the label gets a name, so the reads stay three segments deep (R.2).
  const { wake } = labels.model;
  const { skillOff } = wake.selfimprovement;
  assert.ok(line('old-routine').includes(skillOff));
  assert.ok(!line('brief-the-news').includes(skillOff));
});
