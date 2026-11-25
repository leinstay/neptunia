// Tests for src/turn/request/server.ts: the <server> block of a request when nothing is known of the place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText as contentText } from '../../../../src/behavior/prompt.ts';
import { buildRequest } from '../../../fixtures/built-request.ts';
import { MIN, NOW, baseInput, makeMessage } from '../../../fixtures/prompt-rig.ts';

// --- tempo thresholds come from config, not hardcoded in the renderer -------

// --- <server>: the channel map -----------------------------------------------

test('buildRequest: with no stored note and no channel facts anywhere in history, <server> stays empty', () => {
  const history = [makeMessage(1, NOW - MIN)];
  const request = buildRequest(baseInput({ history, channels: [], currentChannelId: 'c1' }));
  const messages = request.messages;
  assert.ok(!contentText(messages[1].content).includes('<server>'));
});
