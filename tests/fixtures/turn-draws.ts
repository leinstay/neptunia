// A turn whose model can draw: the drawing prompts, a fake image client that records its calls and answers
// (or throws) from a script, and drawTurn, the turn harness (tests/fixtures/turn-harness.ts) with both wired in.
import { coreTurn } from './turn-harness.ts';

export const DRAW_PROMPTS = { draw: 'A drawing by {{name}}.\n\n{{appearance}}\n\n{{when}}\n\nScene: {{request}}', appearance: '{{name}} has silver hair.' };
export const DRAW_CONFIG = { image: { maxPromptChars: 1000, reference: 'none' }, models: { base: { analyzer: 'x/text', drawing: 'openai/image-model' } } };

/** The fake image client: every call it got and the three methods the runner uses. */
type FakeImages = {
  calls: Array<unknown>;
  familyOf: () => string;
  quota: () => Record<string, unknown>;
  generate: (args: unknown) => Promise<Record<string, unknown>>;
};

/** An image client whose generate() answers from `outcomes` in turn (an error is thrown, null is the picture), every call recorded. */
export function fakeImages(outcomes: Array<Error | null> = [null]): FakeImages {
  const calls: Array<unknown> = [];
  return {
    calls,
    familyOf: () => 'openai',
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async (args: unknown) => {
      calls.push(structuredClone(args));
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      if (outcome) throw outcome;
      return { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0, usage: {}, model: 'openai/image-model' };
    },
  };
}

export async function drawTurn({
  answers,
  images = fakeImages(),
  allowed = ['draw.create'],
  runner = {},
  ...rest
}: Omit<Parameters<typeof coreTurn>[0], 'answers' | 'allowed' | 'runner'> & {
  answers: ReadonlyArray<unknown>;
  images?: object | null;
  allowed?: Array<string>;
  runner?: Record<string, unknown>;
}): ReturnType<typeof coreTurn> {
  return coreTurn({
    answers,
    allowed,
    config: DRAW_CONFIG,
    prompts: DRAW_PROMPTS,
    runner: { images, imageFetcher: { fetchAsDataUrl: async () => ({ dataUrl: 'data:image/png;base64,QQ==', bytes: 1, contentType: 'image/png' }) }, ...runner },
    ...rest,
  });
}

