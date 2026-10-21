// A turn whose model can draw: the drawing prompts, a fake image client that records its calls and answers
// (or throws) from a script, and drawTurn, the turn harness (tests/fixtures/turn-harness.js) with both wired in.
import { coreTurn } from './turn-harness.js';

export const DRAW_PROMPTS = { draw: 'A drawing by {{name}}.\n\n{{appearance}}\n\n{{when}}\n\nScene: {{request}}', appearance: '{{name}} has silver hair.' };
export const DRAW_CONFIG = { image: { maxPromptChars: 1000, reference: 'none' }, models: { helpers: { analyzer: 'x/text' }, agents: { drawing: 'openai/image-model' } } };

/** An image client whose generate() answers from `outcomes` in turn (a function throws, anything else is the picture), every call recorded. */
export function fakeImages(outcomes = [null]) {
  const calls = [];
  return {
    calls,
    familyOf: () => 'openai',
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async (args) => {
      calls.push(structuredClone(args));
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      if (outcome) throw outcome;
      return { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0, usage: {}, model: 'openai/image-model' };
    },
  };
}

export async function drawTurn({ answers, images = fakeImages(), allowed = ['draw.create'], features = {}, runner = {}, ...rest }) {
  return coreTurn({
    answers,
    allowed,
    features: { imageGeneration: true, ...features },
    config: DRAW_CONFIG,
    prompts: DRAW_PROMPTS,
    runner: { images, imageFetcher: { fetchAsDataUrl: async () => ({ dataUrl: 'data:image/png;base64,QQ==', bytes: 1, contentType: 'image/png' }) }, ...runner },
    ...rest,
  });
}

