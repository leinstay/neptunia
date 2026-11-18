// Where custom emoji leave the core's text: the shipped pick prompt and what the Discord interface declares and
// renders in their place. The request's legend of custom emoji is tested in tests/prompt-emoji.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDiscordAdapter } from '../interfaces/discord/index.ts';
import { applyEmojiPick } from '../src/behavior/media-pick.ts';
import { portMediaPick } from '../src/interface/capabilities.ts';
import { fakeClient } from './fixtures/turn-kit.ts';

const shipped = (name: string): string => fs.readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');

test('the pick prompt names the emoji block and the answers of the emoji forms', () => {
  const prompt = shipped('classify/pick');
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  for (const word of ['<emoji>', '`emoji`', '`replace`']) assert.ok(prompt.includes(word), word);
});

test('the Discord interface declares GIF links and files, both emoji actions and its text', () => {
  const declared = portMediaPick(createDiscordAdapter({ client: fakeClient() }));
  assert.ok(declared);
  assert.deepEqual([...declared.gifForms].sort(), ['file', 'link']);
  assert.deepEqual([...(declared.emoji?.actions ?? [])].sort(), ['append', 'replace']);
  assert.ok(typeof declared.text === 'string' && declared.text.trim() !== '');
});

// The owner on 2026-11-17: an emoji and a sticker go by a stable name of the engine.
test('the Discord interface renders its own emoji markup', () => {
  const declared = portMediaPick(createDiscordAdapter({ client: fakeClient() }));
  assert.ok(declared?.emoji);
  const { render } = declared.emoji;
  const still = { id: '42', name: 'e1', platformName: 'wave', animated: false };
  assert.equal(applyEmojiPick('', { action: 'replace', emoji: still }, render), '<:wave:42>');
  assert.equal(applyEmojiPick('', { action: 'replace', emoji: { ...still, animated: true } }, render), '<a:wave:42>');
});
