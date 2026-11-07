// The command line's chat over its stored lines (plan 2026-11-06-turn-frame, slice 4 "Done"): a fresh chat draws the
// newest stored lines of `cli:dm:owner`, and Page Up at the top of the transcript loads the page before the oldest line
// shown. The chat asks through one function of its env, the shape the specifier chose:
//   ChatEnv.storedPage?: (before: string | null) => Promise<ReadonlyArray<ChatEntry & { id: string }>>
// `before` null asks for the newest page, an id for the page that ends just before that stored line, oldest first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatEntry } from '../cli/index.ts';
import { KEY, chatEnv, shows, until, withChat } from './fixtures/chat-rig.ts';

type Stored = ChatEntry & { id: string };

const PAGES: Record<string, ReadonlyArray<Stored>> = {
  newest: [
    { id: 's3', who: 'owner', text: 'ΓΡΑΜΜΗ-ΤΡΙΤΗ' },
    { id: 's4', who: 'her', text: 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ' },
  ],
  s3: [
    { id: 's1', who: 'owner', text: 'ΓΡΑΜΜΗ-ΠΡΩΤΗ' },
    { id: 's2', who: 'her', text: 'ΓΡΑΜΜΗ-ΔΕΥΤΕΡΗ' },
  ],
};

function pager(): {
  asked: Array<string | null>;
  storedPage: (before: string | null) => Promise<ReadonlyArray<Stored>>;
} {
  const asked: Array<string | null> = [];
  return {
    asked,
    storedPage: (before) => {
      asked.push(before);
      return Promise.resolve(PAGES[before ?? 'newest'] ?? []);
    },
  };
}

test('a fresh chat shows the newest stored lines', async () => {
  // Bug: the chat opens empty after a restart, though the core keeps every line of the session.
  const { asked, storedPage } = pager();
  const { env } = chatEnv({ storedPage });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
    assert.ok(rig.screen().join('\n').includes('ΓΡΑΜΜΗ-ΤΡΙΤΗ'));
    assert.ok(rig.screen().join('\n').includes('ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
  });
  assert.deepEqual(asked.slice(0, 1), [null]);
});

test('Page Up at the top asks for the page before the oldest line shown and draws it above', async () => {
  // Bug: the second page starts again from the newest line, or from a line the screen already holds.
  const { asked, storedPage } = pager();
  const { env } = chatEnv({ storedPage });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
    rig.type(KEY.pageUp);
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΠΡΩΤΗ'));
    const screen = rig.screen().join('\n');
    assert.ok(
      screen.indexOf('ΓΡΑΜΜΗ-ΔΕΥΤΕΡΗ') >= 0 && screen.indexOf('ΓΡΑΜΜΗ-ΔΕΥΤΕΡΗ') < screen.indexOf('ΓΡΑΜΜΗ-ΤΡΙΤΗ')
    );
  });
  assert.deepEqual(asked.slice(0, 2), [null, 's3']);
});
