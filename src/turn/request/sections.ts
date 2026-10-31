// The budget sections of a turn's request in their priority order: the fixed part that is never cut, the
// interlocutor, what was looked up, what the server's memory offers, the chat, and the lists fitted last. The block
// builders of src/turn/request/ fill them, and buildRequest (src/behavior/prompt.js) has the budget fit them.

import { fitSections } from '../../llm/budget.js';
import { emojiCaption, emojiItems, seenEmoji } from './emoji-gifs.ts';
import { lookupCandidates, prefetchText } from './recall.ts';
import { aboutChatItems, learnedConfig, loreItems, serverItems } from './server.ts';
import { sensesWhole } from './senses.ts';
import { resolveChatText } from './text.ts';
import type { DiaryParts } from './diary.ts';
import type { Base, Room } from './head.ts';
import type { MemorySections } from './memory.ts';
import type { InterlocutorBlocks, PeopleOffered, Placed } from './people.ts';
import type { PulledFits, PulledView } from './pulled.ts';
import type { SensesOf } from './senses.ts';
import type { Task } from './task.ts';
import type { Fit, RequestInput, Section } from './types.ts';
import type { WakeTexts } from './wake.ts';

/** The sections fitted ahead of the chat, the chat's, and what memory each memory section offered with its ids. */
export type HeadSections = {
  fixedSection: Section;
  interlocutorSection: Section;
  aboutIds: Array<string | null>;
  aboutOffered: Array<string>;
  loreIds: Array<string | null>;
  loreOffered: Array<string>;
  serverIds: Array<string | null>;
  serverOffered: Array<string>;
  head: Array<Section>;
  chatSection: Section;
};

/**
 * The fixed part (the system prompt, the task, the clock, the senses, the tempo and every block never cut), the
 * interlocutor, `<lookup>` as the first candidate that fits, the prefetch, a diary post's find, the skills catalogue,
 * `<about_chat>`, `<self_facts>`, `<lore>` and `<server>`, then the chat.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function headSections(
  given: RequestInput &
    Base &
    PulledView &
    Task &
    SensesOf &
    DiaryParts &
    WakeTexts &
    Room &
    InterlocutorBlocks & { tempoText: string }
): HeadSections {
  const { config, now, history, trigger, channels, currentChannelId, lookup, tempoText } = given;
  const { labels, privateChat, nameOf, timezone, frozen, loreOn, system, nowText, chatItems } = given;
  const { directoryText, channelDirectoryText, fittedTask, senses, toolsText, inventoryText } = given;
  const { planText, seedsText, diaryIntro, foundText, peopleNowFixed, interlocutorShown } = given;
  const { errandsText, intentionsText, wakeText, placesText, previousThinkText } = given;
  const { caps, cost, limit, offeredNeighbors, pulledChannelIds, readOnlyIds } = given;
  const fixedSection: Section = {
    name: 'fixed',
    required: true,
    // Her tools in text (the text transport), the channel and people directories, a diary post's plan, its seeds, its `<diary>` intro, the
    // interlocutor's `<people_now>` entry, her errands' blocks and her intentions are never cut.
    items: [
      system,
      fittedTask,
      nowText,
      sensesWhole(senses),
      tempoText,
      ...[
        toolsText,
        channelDirectoryText,
        directoryText,
        planText,
        seedsText,
        diaryIntro,
        peopleNowFixed,
        errandsText.list,
        errandsText.result,
        intentionsText,
        wakeText,
        placesText,
        previousThinkText,
      ].filter(Boolean),
    ],
  };
  const interlocutorSection: Section = {
    name: 'interlocutor',
    cap: caps.interlocutor,
    items: [interlocutorShown.text].filter(Boolean),
  };
  // `<lookup>`: one piece. With both a web and a server part, the first candidate that fits the
  // room the two sections ahead of it leave (the whole block, else the web part alone, else the
  // server part alone); so a server part never costs the web part its place, and the block as a
  // whole stays one item the main pass keeps or drops like before.
  const lookupOptions = lookupCandidates(lookup, labels, timezone);
  let lookupItem = lookupOptions[0] ?? '';
  if (lookupOptions.length > 1) {
    const room = limit - fitSections([fixedSection, interlocutorSection], limit, cost).used;
    lookupItem = lookupOptions.find((text) => cost(text) <= room) ?? lookupItem;
  }
  // The memory-read collector: the offered items of three sections with the ids they carry (kept ones read at the end).
  const aboutIds: Array<string | null> = [];
  const aboutOffered = aboutChatItems(given.guildMemory, labels, nameOf, learnedConfig(config), aboutIds);
  const loreIds: Array<string | null> = [];
  const loreOffered = loreOn
    ? loreItems(given.loreEntries, history, trigger, labels, config.lore, nameOf, loreIds)
    : [];
  const serverIds: Array<string | null> = [];
  const serverOffered = privateChat
    ? []
    : serverItems(
        channels,
        currentChannelId,
        // A pulled channel's note right after the current channel's, then the neighbours'
        // (each once). Fitted ahead of the pulled block, so it cannot hang on its cut.
        [...pulledChannelIds, ...offeredNeighbors.map((n) => n.channelId).filter((id): id is string => Boolean(id))],
        history,
        now,
        config.context.channelActivity,
        labels,
        nameOf,
        readOnlyIds,
        new Set(given.diaryChannelIds ?? []),
        serverIds
      );
  // The sections fitted ahead of the chat, in priority order.
  const head: Array<Section> = [
    fixedSection,
    interlocutorSection,
    // One piece, never split: already bounded by web.search.summaryChars and
    // recall.answerChars / recall.stretchChars, and ahead of the chat so a
    // tight budget trims old messages first.
    { name: 'lookup', items: [lookupItem].filter(Boolean) },
    // The automatic memory prefetch (features.coreTools): one piece, bounded by recall.prefetch.maxTokens.
    ...(given.prefetch
      ? [{ name: 'prefetch', items: [prefetchText(given.prefetch, labels, timezone)].filter(Boolean) }]
      : []),
    // A diary post's search result: one piece, bounded by web.search.summaryChars.
    { name: 'found', items: [foundText].filter(Boolean) },
    // The skills catalogue, asked for: one piece, ahead of the chat like what was looked up.
    { name: 'skills', items: [inventoryText].filter(Boolean) },
    {
      name: 'aboutChat',
      cap: caps.aboutChat,
      items: aboutOffered,
    },
    {
      name: 'self',
      cap: caps.aboutChat,
      // As they were at the start of this cache bucket (frozen): a batch's new fact shows at the next edge.
      items: frozen('self', '', () =>
        (given.guildMemory?.self ?? []).map((fact) => `- ${resolveChatText(fact, nameOf)}`)
      ),
    },
    {
      name: 'lore',
      cap: caps.lore,
      keep: 'first',
      items: loreOffered,
    },
    {
      name: 'server',
      cap: caps.server ?? 4000,
      keep: 'first',
      items: serverOffered,
    },
  ];
  const chatSection: Section = { name: 'chat', keep: 'newest', items: chatItems.map((item) => item.text) };
  return {
    fixedSection,
    interlocutorSection,
    aboutIds,
    aboutOffered,
    loreIds,
    loreOffered,
    serverIds,
    serverOffered,
    head,
    chatSection,
  };
}

/** The sections ahead of `<recent>`, and those ahead of `<people>` for a given `<recent>` section. */
export type Ahead = {
  aheadOfRecent: Array<Section>;
  aheadOfPeopleWith: (recentSec: Section | null) => Array<Section>;
};

/**
 * The sections fitted ahead of `<people>`, in priority order: the one list both the main pass and the room of the
 * asked-about members' episodes are measured on. The pulled block right after the chat; ahead of it on a routed
 * turn, whose call lives there; then the anchors, the last hours and the persona's exchanges elsewhere.
 */
export function aheadOf(given: PulledView & HeadSections & PulledFits & MemorySections): Ahead {
  const { routed, head, chatSection, pulledSection, earlierSection, participationSection } = given;
  const aheadOfRecent = [
    ...head,
    ...(routed ? [pulledSection, chatSection] : [chatSection, pulledSection]),
    ...(earlierSection ? [earlierSection] : []),
  ];
  const aheadOfPeopleWith = (recentSec: Section | null) => [
    ...aheadOfRecent,
    ...(recentSec ? [recentSec] : []),
    ...(participationSection ? [participationSection] : []),
  ];
  return { aheadOfRecent, aheadOfPeopleWith };
}

/** Everything the budget fits, in priority order, below the people: the lists it may cut last. */
export function fitAll(
  given: RequestInput &
    Base &
    Room &
    PulledView &
    DiaryParts &
    Placed &
    PeopleOffered & { neighborItems: Array<string>; attitudesText: string; gifList: { items: Array<string> } }
): Fit {
  const { config, history, descriptions, labels, customEmoji, emojiOnce, caps, cost, limit } = given;
  const { pulledChannels, offeredNeighbors, worldItem, diaryLines, aheadOfPeople, peopleSection, voiceRows } = given;
  const { neighborItems, attitudesText, gifList } = given;
  const aroundMax = config.context.around?.maxTokens;
  const budgetFit = fitSections(
    [
      ...aheadOfPeople,
      peopleSection,
      // One piece, kept or dropped whole: right below the people it leaves out.
      { name: 'attitudes', cap: caps.attitudes ?? 400, items: [attitudesText].filter(Boolean) },
      // A diary post: the persona's world whole, then its past posts, the oldest cut first.
      { name: 'world', items: [worldItem].filter(Boolean) },
      { name: 'diary', keep: 'newest', items: diaryLines },
      { name: 'neighbors', cap: caps.neighbors, items: neighborItems },
      // Lowest priority: a list to pick from, trimmed from the bottom (least used last).
      {
        name: 'emoji',
        cap: caps.emoji ?? 800,
        keep: 'first',
        items: emojiItems(
          customEmoji,
          given.guildMemory?.emojiUsage,
          given.mediaCache ?? null,
          labels,
          config.context.customEmoji,
          {
            seen: emojiOnce
              ? seenEmoji([
                  history,
                  ...pulledChannels.map((channel) => channel.messages),
                  ...offeredNeighbors.map((neighbor) => neighbor.messages),
                ])
              : [],
            describe: (id) =>
              emojiCaption(`emoji:${id}`, [
                descriptions,
                given.neighborDescriptions,
                ...pulledChannels.map((channel) => channel.entry.descriptions),
              ]),
          }
        ),
      },
      // Below even the emoji: the GIF library, trimmed the same way (least used last).
      {
        name: 'gifs',
        cap: caps.gifs ?? 900,
        keep: 'first',
        items: [...gifList.items],
      },
      // Last of all: the people in voice the request has no profile for, by name.
      { name: 'around', cap: Number.isFinite(aroundMax) ? aroundMax : 400, keep: 'first', items: voiceRows },
    ],
    limit,
    cost
  );
  return budgetFit;
}
