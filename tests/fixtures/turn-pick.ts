// The media pick in a turn test (plan 2026-11-04-cli-and-memory, stage B7): one captioned GIF in a store, an interface that
// declares the pick, and a hot config that runs it.
import { findGif } from '../../src/memory/gifs.ts';
import { NOW, fakeStore } from './turn-kit.ts';
import { world } from './turn-world.ts';
import type { FakeHot } from './turn-kit.ts';

/** A fake store with one GIF the search can find by a word of the replies these tests write. */
export function gifStore(): ReturnType<typeof fakeStore> & { getGifs: () => object; findGif: (id: string) => object | null } {
  const library = {
    nextId: 2,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: 'https://tenor.com/view/chat-qui-danse-1',
        itemId: 'k1',
        count: 1,
        last: NOW,
        caption: 'χα κοίτα ναι',
      },
    },
  };
  return { ...fakeStore(), getGifs: () => library, findGif: (id: string) => findGif(library, id) };
}

/** Whether the pick runs is what the interface declares; the world's port declares it here. */
export function declarePick(mediaPick: object = { gifForms: ['file', 'link'] }): void {
  const port = world().port as unknown as { capabilities: () => object };
  const declared = port.capabilities.bind(port);
  port.capabilities = () => ({ ...declared(), mediaPick });
}

/** A hot config that runs the media pick, on an interface that declares it. */
export function withPick(hot: FakeHot): FakeHot {
  declarePick();
  Object.assign(hot.prompts, { 'media-pick': 'Pick a GIF for what {{name}} wrote.' });
  Object.assign(hot.config, { models: { base: { analyzer: 'cheap/classifier' } } });
  return hot;
}

/** Two captioned GIFs for a pick that says `oui`, the second posted by her an hour ago in `place`. */
export function twoCaptionedGifs(place: string, seenIn: string, now: number, hour: number, day: number): object {
  return {
    nextId: 3,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: 'https://tenor.com/view/chat-qui-danse-1',
        itemId: 'gif-item-1',
        messageId: 'm1',
        placeId: seenIn,
        count: 3,
        last: now - hour,
        caption: 'oui un chat qui danse',
      },
      k2: {
        id: 'g2',
        kind: 'link',
        url: 'https://tenor.com/view/haussement-2',
        itemId: 'gif-item-2',
        messageId: 'm2',
        placeId: seenIn,
        count: 1,
        last: now - day,
        ownLast: now - hour,
        caption: "oui un haussement d'épaules",
        places: { [place]: { count: 1, last: now - day, ownLast: now - hour, ownUses: 1 } },
      },
    },
  };
}

// The calls a test reads back whole, as the tests of the turn have always read their fake LLM's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PickCall = { messages: any; options: any };

/** A fake LLM answering the turn with `reply` and the pick with `pick` (a function may wait or throw). */
export function pickLlm({ reply, pick = 'none' }: { reply: unknown; pick?: unknown }): {
  calls: Array<PickCall>;
  complete: (messages: never, options: Record<string, never>) => Promise<object>;
} {
  const calls: Array<PickCall> = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      const answer: unknown = options?.purpose === 'media-pick' ? pick : reply;
      const text: unknown = typeof answer === 'function' ? await (answer as () => unknown)() : answer;
      return { text, usage: {}, estimated: 10 };
    },
  };
}
