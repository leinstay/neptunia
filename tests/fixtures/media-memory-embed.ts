// The fake embedder of the media memory tests and the embedding queue of media rows over it. One axis per concept, an English
// word and its Russian word on one axis, so a Russian query reaches an English text form by meaning and by nothing else.
import { applyMediaEmbed, embedMedia } from '../../src/memory/db/media-store.ts';
import { quantize } from '../../src/memory/vectors.ts';
import { KINDS, NOW, SETTINGS } from './media-memory.ts';
import type { Env } from './media-memory.ts';

export const MODEL = 'test/embedder';
const CONCEPTS = KINDS.map((kind) => [kind.first.word, kind.first.query]);

export const embedWords = (text: string): Float32Array => {
  const low = text.toLowerCase();
  const vector = new Float32Array(CONCEPTS.length + 1);
  CONCEPTS.forEach((words, i) => {
    if (words.some((word) => low.includes(word))) vector[i] = 1;
  });
  vector[CONCEPTS.length] = 0.01;
  return vector;
};

/** One run of the embedding queue over the fake embedder: what it did and the texts it asked for. */
export async function embedLines(
  env: Env
): Promise<{ embedded: number; written: number; skipped: number; asked: Array<string> }> {
  const asked: Array<string> = [];
  const done = await embedMedia({
    db: env.db,
    write: (update) => Promise.resolve(applyMediaEmbed(env.handle, update)),
    embed: (texts) => {
      asked.push(...texts);
      return Promise.resolve(texts.map(embedWords));
    },
    config: {},
    now: NOW,
    quantize,
    model: MODEL,
    limit: 50,
  });
  return { ...done, asked };
}

/** What `search` is asked for a query by meaning alone. */
export const byMeaning = (
  query: string
): { plan: object; now: number; settings: typeof SETTINGS; vector: Float32Array; model: string } => ({
  plan: { forms: [], who: [], from: null, to: null },
  now: NOW,
  settings: SETTINGS,
  vector: embedWords(query),
  model: MODEL,
});
