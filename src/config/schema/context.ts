// The settings schema of `context` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const CONTEXT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'context.channelMessages',
    'types': ['number'],
    'reader': 'src/turn/tool-round.ts',
    'default': 100,
    'text': 'Messages of the current chat in the window',
  },
  {
    'key': 'context.chatHeadStep',
    'types': ['number'],
    'reader': 'src/turn/history.ts',
    'default': 0,
    'text':
      'How far the first line of `<chat>` moves at a time, for a prompt cache that reuses the start of the user message between turns. With `L` the number of the newest line, the window starts at the largest multiple of this step not above `L - channelMessages + 1`, line 1 at the least, so it holds from `channelMessages` lines to one step less one more and only gains lines between two moves. `0`, a missing value and a broken one move the first line with every new line, the window of `channelMessages` lines',
  },
  {
    'key': 'context.chatSteps',
    'types': ['array'],
    'reader': 'src/turn/request/reader.ts',
    'default': [100, 60, 30, 10],
    'text':
      'The line counts `<chat>` may be cut to when the budget cannot keep the whole window: the largest step that fits, so two turns with nothing new between them send the same lines. Below the smallest step it keeps what fits. An empty list cuts to whatever fits',
  },
  {
    'key': 'context.reactions.fetchTimeoutMs',
    'types': ['number'],
    'reader': 'src/turn/tool-round.ts',
    'default': 2000,
    'text': 'How long a turn waits for those fetches',
  },
  {
    'key': 'context.myDay.lines',
    'types': ['number'],
    'reader': 'src/turn/phases/request/build.ts',
    'default': 12,
    'text': 'How many of her actions of today `<my_day>` lists, the newest kept. `0` leaves the block out',
  },
  {
    'key': 'context.myDay.people',
    'types': ['number'],
    'reader': 'src/turn/phases/request/build.ts',
    'default': 3,
    'text':
      'How many people other than the one she answers `<my_day>` names a line for, the ones she made the most for today first. `0` names none; her own day line stays',
  },
  {
    'key': 'context.lessons.budgetTokens',
    'types': ['number'],
    'reader': 'src/turn/request/lessons.ts',
    'default': 1200,
    'text':
      'Token budget of `<lessons>` in `<self>`, what people taught her from every place she may read. The lowest ranked lessons leave first. `0` leaves the block out',
  },
  {
    'key': 'context.attitudes.shown',
    'types': ['number'],
    'reader': 'src/turn/request/attitudes.ts',
    'default': 6,
    'text':
      'How many people `<attitudes>` in `<self>` lists, the ones she feels most strongly about, warm and cool together, the strongest first. A person at the band `neutral` is never listed. `0` leaves the block out',
  },
  {
    'key': 'context.names.emoji',
    'types': ['boolean'],
    'reader': 'src/turn/request/text.ts',
    'default': false,
    'text':
      "Whether a request keeps the emoji in the names of places and people. `false` leaves them out and trims the name: the links of a place reference, and a person's heading, account names and aliases. A name of nothing but emoji and a custom emoji written `:name:` stay. The stored name never changes",
  },
  {
    'key': 'context.memory',
    'types': ['map'],
    'reader': 'src/memory/db/mind-read.ts',
    'default': {
      'windowMessages': 100,
      'serviceMessages': 100,
      'maxHops': 2,
      'maxNodesRead': 2000,
      'budgetTokens': 10000,
      'budgetShare': 0.1,
      'shares': { 'people': 0.4, 'places': 0.3, 'lore': 0.15, 'recent': 0.1, 'found': 0.05 },
      'counterpartTokens': 1500,
      'candidatesMax': 3,
      'commonWordEntries': 3,
      'attitudeMoves': 2,
      'interests': 5,
      'fanOut': { 'accounts': 10, 'memberships': 20, 'rooms': 10, 'members': 8, 'replies': 5, 'about': 30 },
    },
    'text':
      'The graph reader (`mindOf`): the lines of the window that seed it, her last lines over the rooms of every group that a service shows in `<meanwhile>` and seeds `<memory>` from (`serviceMessages`, read by `src/turn/request/meanwhile.ts`), the counted hops, the rows read, the token budget (`budgetTokens`, lowered to `budgetShare` of `llm.maxRequestTokens` when that is set) and its shares per kind of entry, the part kept for the person she answers, the candidates of an ambiguous word, the word that names too many entries, how many of her latest attitude changes toward a person an entry carries (`attitudeMoves`, `0` for none), how many interests of a person an entry lists (`interests`, `0` for none), and the rows read per path. Each key is described in `docs/memory.md`, "How a turn remembers". A missing or broken key counts as its default',
  },
  {
    'key': 'context.find',
    'types': ['map'],
    'reader': 'src/memory/db/graph-find.ts',
    'default': { 'candidates': 5, 'lines': 100, 'deadlineMs': 1000 },
    'text':
      'The finder of a place or a person named in words that name none (`placesFound`, `peopleFound`): how many candidates a tool result lists at most, how many of a place\'s last lines are read for its people and its words, and how long a call waits for the embedding of words that fit no candidate in full before it answers with the words alone (`deadlineMs`). Described in `docs/memory.md`, "Finding a place or a person". A missing or broken key counts as its default',
  },
  {
    'key': 'context.meanwhile.messages',
    'types': ['number'],
    'reader': 'src/turn/request/meanwhile.ts',
    'default': 8,
    'text':
      'How many of her last lines in other places `<meanwhile>` shows on a reply, each with the lines around it. `0` leaves the block out',
  },
  {
    'key': 'context.meanwhile.around',
    'types': ['number'],
    'reader': 'src/turn/request/meanwhile.ts',
    'default': 2,
    'text':
      'How many lines before and after each of her lines `<meanwhile>` shows. Windows of one place that overlap merge',
  },
  {
    'key': 'context.recall.extractChars',
    'types': ['number'],
    'reader': 'src/turn/calls.ts',
    'default': 1200,
    'text': "How long the extract of one lookup's result is that `<recall>` keeps (characters)",
  },
  {
    'key': 'context.recall.maxItems',
    'types': ['number'],
    'reader': 'src/turn/calls.ts',
    'default': 6,
    'text': 'How many of her lookups one place keeps for `<recall>`. The one noted earliest leaves first',
  },
  {
    'key': 'context.turnLeaseMs',
    'types': ['number'],
    'reader': 'src/behavior/attention.ts',
    'default': 300000,
    'text':
      "How long an inner turn's claim on its wakes lasts (milliseconds). The inner life renews it at every tick while the turn runs; a start takes over a claim a stopped process left",
  },
  {
    'key': 'context.caps.aboutChat',
    'types': ['number'],
    'reader': 'src/turn/request/reader.ts',
    'default': 2500,
    'text': 'Token cap: her facts about herself in `<self>`',
  },
  {
    'key': 'context.caps.intentions',
    'types': ['number'],
    'reader': 'src/intentions/blocks.ts',
    'default': 600,
    'text': 'Token cap: `<intentions>`',
  },
  {
    'key': 'context.pull.sameAudience',
    'types': ['boolean'],
    'reader': 'src/behavior/snapshot.ts',
    'default': true,
    'text':
      'Check that every role allowed to view the place she speaks in can also view a place she reads. Also governs the windows of a search of the message history',
  },
  {
    'key': 'context.vision.fetchTimeoutMs',
    'types': ['number'],
    'reader': 'src/media/fetch-image.ts',
    'default': 10000,
    'text': 'Download timeout per picture (ms)',
  },
];
