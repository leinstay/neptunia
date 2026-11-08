// The traits a tool declares once in its definition (src/tools/definitions.ts) and the lists other modules derive from
// them: `toolsWith`, `hasTrait`, and the validator's refusal of a trait it does not know.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_DEFINITIONS, hasTrait, toolsWith, validateDefinitions } from '../src/tools/definitions.ts';
import type { Definition } from '../src/tools/definitions.ts';
import { POSTING_SKILLS } from '../src/behavior/inner/settings.ts';

test('the posting tools are the text post, the picture and the voice message, and only they post', () => {
  // Catches: a posting tool dropped from the one declaration, which every posting list reads.
  assert.deepEqual([...toolsWith('posts')].sort(), ['draw.create', 'message.create', 'voice.say']);
  assert.deepEqual([...POSTING_SKILLS].sort(), ['draw.create', 'message.create', 'voice.say']);
});

test('a tool that attaches a file also posts, and edits are written but never post', () => {
  // Catches: a file post that the posting checks miss, or an edit counted as a new line of hers.
  for (const name of toolsWith('attaches')) assert.ok(hasTrait(name, 'posts'), name);
  assert.equal(hasTrait('message.edit', 'written'), true);
  assert.equal(hasTrait('message.edit', 'posts'), false);
});

test('hasTrait answers false for a name no tool has, an inherited property name included', () => {
  // Catches: a lookup through a plain object, where `constructor` would be found.
  assert.equal(hasTrait('nothing.here', 'self'), false);
  assert.equal(hasTrait('constructor', 'self'), false);
});

test('validateDefinitions refuses an unknown trait and a repeated one', () => {
  // Catches: a misspelt trait that silently drops a tool from the list it was meant to join.
  const first: Definition = SKILL_DEFINITIONS[0];
  const withTraits = (traits: ReadonlyArray<string>) => [{ ...first, traits }];
  assert.throws(() => validateDefinitions(withTraits(['postss'])), /unknown trait postss/);
  assert.throws(() => validateDefinitions(withTraits(['posts', 'posts'])), /trait posts twice/);
  assert.throws(() => validateDefinitions([{ ...first, traits: null }]), /traits must be a list/);
});
