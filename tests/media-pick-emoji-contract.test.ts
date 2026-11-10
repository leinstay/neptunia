// Where custom emoji leave the core's text: the shipped prompts, the labels, the request a turn builds (a custom emoji
// of the chat keeps its description in the line), and what the Discord interface declares in their place. Plan
// 2026-11-04-cli-and-memory, stages B8 and B9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDiscordAdapter } from '../interfaces/discord/index.ts';
import { applyEmojiPick } from '../src/behavior/media-pick.ts';
import { userText } from '../src/behavior/prompt.ts';
import { portMediaPick } from '../src/interface/capabilities.ts';
import { buildRequest } from './fixtures/built-request.ts';
import { baseInput, makeMessage, NOW } from './fixtures/prompt-rig.ts';
import { fakeClient } from './fixtures/turn-kit.ts';

const shipped = (name: string): string => fs.readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');

test('the pick prompt names the emoji block and the answers of the emoji forms', () => {
  const prompt = shipped('media-pick');
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  for (const word of ['<emoji>', '`emoji`', '`replace`']) assert.ok(prompt.includes(word), word);
});

test('a custom emoji of the chat keeps its description in the line when the block is gone', () => {
  // Bug: the line leaves the description to `<emoji>` while the turn is offered an emoji list, so removing the block
  // alone would lose what the emoji shows.
  const history = [
    makeMessage(1, NOW - 60_000, { content: ':alpha:', emojis: [{ id: '1', name: 'alpha', animated: false }] }),
  ];
  const request = buildRequest(
    baseInput({
      history,
      customEmoji: [{ id: '1', name: 'alpha', animated: false }],
      mediaCache: { 'emoji:1': { text: 'μια μικρή αλεπού' } },
    })
  );
  assert.match(userText(request.messages[1].content), /μια μικρή αλεπού/);
  assert.ok(!userText(request.messages[1].content).includes('<emoji>'));
});

test('the Discord interface declares GIF links and files, both emoji actions and its text', () => {
  const declared = portMediaPick(createDiscordAdapter({ client: fakeClient() }));
  assert.ok(declared);
  assert.deepEqual([...declared.gifForms].sort(), ['file', 'link']);
  assert.deepEqual([...(declared.emoji?.actions ?? [])].sort(), ['append', 'replace']);
  assert.ok(typeof declared.text === 'string' && declared.text.trim() !== '');
});

test('the Discord interface renders its own emoji markup', () => {
  const declared = portMediaPick(createDiscordAdapter({ client: fakeClient() }));
  assert.ok(declared?.emoji);
  const { render } = declared.emoji;
  const still = { id: '42', name: 'wave', animated: false };
  assert.equal(applyEmojiPick('', { action: 'replace', emoji: still }, render), '<:wave:42>');
  assert.equal(applyEmojiPick('', { action: 'replace', emoji: { ...still, animated: true } }, render), '<a:wave:42>');
});
