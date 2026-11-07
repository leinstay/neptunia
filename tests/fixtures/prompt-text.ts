// Readers of a built request's text for the prompt tests: the user message, one block's body, the `<people>` bodies,
// the top-level tags and the tempo lines at the foot of `<chat>`.

import { userText as contentText } from '../../src/behavior/prompt.ts';
import type { Built } from './built-request.ts';
import { labels } from './labels.ts';

/** The whole text of a request's user message. */
export function userText(request: Built): string {
  return contentText(request.messages[1].content);
}

/** The body of `<tag>` in `text`, or null when the block is absent. */
export function bodyOf(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return match ? match[1] : null;
}

/** Every `<people>` body of `text` (the interlocutor's cached one, then the tail's) joined as one block was; null when none. */
export function allPeopleOf(text: string): string | null {
  const bodies = [...text.matchAll(/^<people>\n([\s\S]*?)\n<\/people>$/gm)].map((match) => match[1]);
  return bodies.length > 0 ? bodies.join('\n\n') : null;
}

/** The opening tags of the top-level blocks of `text`, in order. */
export function blockTags(text: string): Array<string> {
  return [...text.matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1]);
}

/** The tempo lines at the foot of `<chat>` (src/format.ts#renderTempo), from its counts line on; null without them. */
export function tempoOf(text: string): string | null {
  const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
  const at = chat.lastIndexOf(String(labels.tempo.counts).split('{')[0]);
  return at === -1 ? null : chat.slice(at);
}
