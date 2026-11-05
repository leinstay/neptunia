// The rig of the transcript tests (tests/format.test.ts): labels with Greek values, the message lines a transcript is
// built from, and the scene that tests which message started a turn. Synthetic data only.
import type { Untyped } from '../../src/tools/types.ts';
import { labels } from './labels.ts';

const MIN = 60_000;

/** A line of the transcript as the format functions take it: the fields the tests read, and what they add. */
export type Line = Record<string, Untyped>;

// A handful of non-Latin (Greek) values proves the code never assumes
// English/labels language; only the values differ, the code path is identical.
export const grLabels = {
  ...labels,
  locale: 'el-GR',
  self: '{name} (εσύ)',
  units: { lessThanMinute: 'λιγότερο από ένα λεπτό', minute: 'λεπτό', hour: 'ώρα', day: 'μέρα' },
  transcript: {
    ...labels.transcript,
    gap: '--- πέρασαν {duration} ---',
    empty: '(κενό)',
  },
};

/** One message line of channel c1 by Nick; `overrides` replace any field. */
export function msg(id: string, ts: number, overrides: Record<string, unknown> = {}): Line {
  return {
    id,
    ts,
    authorId: 'u1',
    authorName: 'Nick',
    content: 'text',
    placeId: 'c1',
    channelName: 'general',
    ...overrides,
  };
}

// Two questions, then the persona's lines: #3 posted by the turn #1 started, #4 a reply to #2
// posted by the same turn, #5 a reply to #2 posted by the turn #2 started.
export function triggerScene(overrides: Record<string, Record<string, unknown>> = {}): Array<Line> {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  return [
    msg('q1', t0, { authorName: 'Éloïse', content: 'tu viens ce soir ?' }),
    msg('q2', t0 + 30_000, { authorName: 'Nick', content: 'et le lapin ?' }),
    msg('a1', t0 + MIN, { self: true, authorName: 'Nept', content: 'ναι', triggerId: 'q1', ...overrides.a1 }),
    msg('a2', t0 + 2 * MIN, {
      self: true,
      authorName: 'Nept',
      content: 'κοιμάται',
      replyToId: 'q2',
      triggerId: 'q1',
      ...overrides.a2,
    }),
    msg('a3', t0 + 3 * MIN, {
      self: true,
      authorName: 'Nept',
      content: 'ακόμα',
      replyToId: 'q2',
      triggerId: 'q2',
      ...overrides.a3,
    }),
  ];
}
