// The labels file split in two (PR 7c of stage 7): `config/labels.json` holds `model`, the wording her requests and the
// analyzer's requests carry, and `owner`, the strings of the owner's answers. `joinLabels` gives the flat object the
// engine reads as `hot.prompts.labels`, every key at the path it has under its section, so no reader changes and her
// requests stay byte-identical. `splitLabels` sorts a flat file, such as a deployment's old `prompts.local/labels.json`,
// by the tracked split. The tests assert on keys and on the strings they put in, never on the shipped wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { joinLabels, splitLabels } from '../src/config/labels.ts';
import type { LabelsFile } from '../src/config/labels.ts';
import { ROOT } from './fixtures/private-layer.ts';

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every leaf path of `tree`, dotted; an array is a leaf. */
function leafPaths(tree: Tree, prefix = ''): Array<string> {
  return Object.entries(tree).flatMap(([key, value]) => {
    const at = prefix === '' ? key : `${prefix}.${key}`;
    return isTree(value) ? leafPaths(value, at) : [at];
  });
}

/** `value` as JSON with every object's keys sorted, so equal content gives equal text. */
function trackedLabels(): LabelsFile {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'));
  assert.ok(isTree(parsed) && isTree(parsed.model) && isTree(parsed.owner), 'config/labels.json is { model, owner }');
  return { model: parsed.model, owner: parsed.owner };
}

const SPLIT: LabelsFile = {
  model: { transcript: { gap: 'G {duration}', edited: 'E' }, locale: 'xx-XX' },
  owner: { status: { probe: 'P', costs: { keyLead: 'K' } } },
};

test('joins the two sections into one flat object with every key at its path under its section', () => {
  assert.deepEqual(joinLabels(SPLIT), {
    transcript: { gap: 'G {duration}', edited: 'E' },
    locale: 'xx-XX',
    status: { probe: 'P', costs: { keyLead: 'K' } },
  });
});

test('joins two sections that share a top-level section but no key', () => {
  const file: LabelsFile = { model: { status: { probe: 'P' } }, owner: { status: { costs: { keyLead: 'K' } } } };
  assert.deepEqual(joinLabels(file), { status: { probe: 'P', costs: { keyLead: 'K' } } });
});

test('refuses to join when the same key is in both sections, naming the key', () => {
  const file: LabelsFile = { model: { status: { probe: 'P' } }, owner: { status: { probe: 'Q' } } };
  assert.throws(() => joinLabels(file), /status\.probe/);
});

test('joins an empty file into an empty object', () => {
  assert.deepEqual(joinLabels({ model: {}, owner: {} }), {});
});

test('splits a flat file by the tracked split: a key the tracked file holds under owner goes to owner', () => {
  const flat = { transcript: { gap: 'mine' }, status: { costs: { keyLead: 'my lead' } } };
  assert.deepEqual(splitLabels(flat, SPLIT), {
    model: { transcript: { gap: 'mine' } },
    owner: { status: { costs: { keyLead: 'my lead' } } },
  });
});

test('splits a key the tracked file does not know into model', () => {
  const flat = { custom: { thing: 'only here' }, status: { inner: { extra: 'new line' } } };
  assert.deepEqual(splitLabels(flat, SPLIT), {
    model: { custom: { thing: 'only here' }, status: { inner: { extra: 'new line' } } },
    owner: {},
  });
});

test('gives back the flat file when a split is joined again', () => {
  const flat = { transcript: { gap: 'mine', edited: 'e' }, status: { probe: 'p', costs: { keyLead: 'k' } } };
  assert.deepEqual(joinLabels(splitLabels(flat, SPLIT)), flat);
});

test('the tracked labels file holds exactly the two sections, and they share no key', () => {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'));
  assert.ok(isTree(parsed));
  assert.deepEqual(Object.keys(parsed).sort(), ['model', 'owner']);
  const tracked = trackedLabels();
  const modelPaths = new Set(leafPaths(tracked.model));
  assert.deepEqual(
    leafPaths(tracked.owner).filter((one) => modelPaths.has(one)),
    []
  );
});

// The contract marks the costs and the inner-life lines of the status card as read by the owner and never sent to a
// model (docs/prompt-contract.md, "Labels"): a split that left them under `model` did not split.
test('the tracked labels keep the status card costs and inner-life lines under owner', () => {
  const tracked = trackedLabels();
  const status = tracked.owner.status;
  assert.ok(isTree(status), 'owner.status exists');
  assert.ok(isTree(status.costs) && Object.keys(status.costs).length > 0, 'owner.status.costs holds the costs lines');
  assert.ok(isTree(status.inner) && Object.keys(status.inner).length > 0, 'owner.status.inner holds the inner lines');
  const model = tracked.model.status;
  assert.equal(isTree(model) && Object.hasOwn(model, 'costs'), false, 'no costs line stays under model');
});
