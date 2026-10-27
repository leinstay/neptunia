// The settings of tests/tools-impl-diary.test.ts: her grant on `message.create`, the diary's caps, and the prompts an
// inner turn and a diary turn read. `diary-tool.json` beside this file holds what the code of main gave for the diary
// turn under these settings, run in the diary channel `d1`: the tools its writer request offered, and how it answered
// a `message.create` call with `diary` there (`writerHasTools`, `writerTools`, `called`). Synthetic text only.
import { hotWith, personaGrants } from './turn-harness.js';

/** The settings, with the diary's daily cap `maxPerDay`. */
export function diaryToolHot({ maxPerDay }: { maxPerDay: number }): ReturnType<typeof hotWith> {
  const hot = hotWith({
    features: { coreTools: true, innerLife: true, diary: true },
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['message.create']),
    config: {
      diary: {
        maxPerDay,
        maxMessages: 3,
        world: false,
        kinds: { status: 1 },
        historyPosts: 40,
        gistChars: 60,
        seedSets: 1,
        planMaxOutputTokens: 250,
        planTimeoutMs: 15000,
      },
    },
  });
  Object.assign(hot.prompts, {
    inner: 'Nobody wrote to you; read the wake block.',
    diary: 'Write your diary.',
    'diary-plan': 'Plan the entry.',
    'diary-seeds': '# place\na pier',
    world: 'The world.',
  });
  return hot;
}
