// The settings schema of `features` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const FEATURES: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'features.dryRun',
    'types': ['boolean'],
    'reader': 'src/behavior/limits.js',
    'default': false,
    'text': 'Full pipeline, never sends. See [Getting started](getting-started.md)',
  },
  {
    'key': 'features.mentions',
    'types': ['boolean'],
    'reader': 'src/behavior/sandbox.js',
    'default': true,
    'text': 'React to @mentions',
  },
  {
    'key': 'features.replies',
    'types': ['boolean'],
    'reader': 'src/behavior/sandbox.js',
    'default': true,
    'text': 'React to replies',
  },
  {
    'key': 'features.nameTriggers',
    'types': ['boolean'],
    'reader': 'src/behavior/sandbox.js',
    'default': true,
    'text': 'React to name mentions in messages',
  },
  {
    'key': 'features.followUp',
    'types': ['boolean'],
    'reader': 'src/behavior/pipeline.js',
    'default': true,
    'text': 'Classify untagged messages after the persona answers to continue a conversation',
  },
  {
    'key': 'features.splitTasks',
    'types': ['boolean'],
    'reader': 'src/behavior/split.js',
    'default': true,
    'text':
      'Split a long structured direct call into separate parts, each answered in its own turn. Needs `prompts/split.md`',
  },
  {
    'key': 'features.spontaneous',
    'types': ['boolean'],
    'reader': 'src/behavior/spontaneous.js',
    'default': true,
    'text': 'Unprompted messages on a random timer',
  },
  {
    'key': 'features.eavesdrop',
    'types': ['boolean'],
    'reader': 'src/behavior/spontaneous.js',
    'default': true,
    'text': 'Random chance to jump into any message',
  },
  {
    'key': 'features.memory',
    'types': ['boolean'],
    'reader': 'src/behavior/recall-run.js',
    'default': true,
    'text': 'Build profiles, track server patterns, record self-claims',
  },
  {
    'key': 'features.relationships',
    'types': ['boolean'],
    'reader': 'src/behavior/mention.js',
    'default': true,
    'text': 'Per-member attitude scores (-100 to 100)',
  },
  {
    'key': 'features.episodes',
    'types': ['boolean'],
    'reader': 'src/behavior/recall-run.js',
    'default': true,
    'text': 'Per-person long-term memories (moments, quotes, grudges)',
  },
  {
    'key': 'features.lore',
    'types': ['boolean'],
    'reader': 'src/behavior/recall-run.js',
    'default': true,
    'text': 'Server-wide lorebook',
  },
  {
    'key': 'features.reactions',
    'types': ['boolean'],
    'reader': 'src/behavior/sandbox.js',
    'default': true,
    'text': 'The persona places emoji reactions',
  },
  {
    'key': 'features.customEmoji',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': true,
    'text': "Rank the server's custom emoji by usage so the persona can use them",
  },
  {
    'key': 'features.gifs',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': true,
    'text': 'Build a GIF library from what members share',
  },
  {
    'key': 'features.embedUpdates',
    'types': ['boolean'],
    'reader': 'src/pipeline/edits.ts',
    'default': true,
    'text':
      "Fold a link's embed (Tenor GIFs arrive this way) into the memory buffer when Discord attaches it after the message",
  },
  {
    'key': 'features.seeReactions',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': true,
    'text':
      'Show reactions on messages in the transcript. Distinct from `reactions` (whether the persona places them); this one controls whether she sees them',
  },
  {
    'key': 'features.reactionNames',
    'types': ['boolean'],
    'reader': 'src/core.js',
    'default': true,
    'text':
      "On the persona's own messages, each reaction shows who put it (up to `context.reactions.maxNames` names). Process memory only, never stored",
  },
  {
    'key': 'features.triggerMarkers',
    'types': ['boolean'],
    'reader': 'src/core.js',
    'default': true,
    'text':
      'Each line the persona posted names the message that started the turn which posted it, so a late answer is not taken for an answer to a newer question',
  },
  {
    'key': 'features.callMarkers',
    'types': ['boolean'],
    'reader': 'src/behavior/sandbox.js',
    'default': true,
    'text': 'A skill call she made shows on her line in the transcript: the skill, target, outcome and link',
  },
  {
    'key': 'features.previousThink',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': true,
    'text':
      'A request carries her one previous think in a `<previous_think>` block. See `context.previousThink.minutes`',
  },
  {
    'key': 'features.multiMessage',
    'types': ['boolean'],
    'reader': 'src/behavior/sandbox.js',
    'default': true,
    'text': 'Allow 2 to 3 messages in a row',
  },
  {
    'key': 'features.mediaDescriptions',
    'types': ['boolean'],
    'reader': 'src/behavior/pipeline.js',
    'default': true,
    'text': 'One-line descriptions for pictures, GIFs, video frames and link thumbnails',
  },
  {
    'key': 'features.videoDescriptions',
    'types': ['boolean'],
    'reader': 'src/behavior/pipeline.js',
    'default': false,
    'text':
      'Watch short video clips through a video-capable model. Needs `mediaDescriptions` on, a video-capable model and `yt-dlp`/`ffmpeg` for site links',
  },
  {
    'key': 'features.videoRewatch',
    'types': ['boolean'],
    'reader': 'src/memory/describe.js',
    'default': true,
    'text': 'When addressed, re-watch a video to answer a question about it. Needs `videoDescriptions` on',
  },
  {
    'key': 'features.imageRelook',
    'types': ['boolean'],
    'reader': 'src/memory/describe.js',
    'default': true,
    'text':
      'When addressed, look at a picture again to answer a question about it. Shares the daily `media.video.rewatch.maxPerDay` counter with video re-watches',
  },
  {
    'key': 'features.webLookup',
    'types': ['boolean'],
    'reader': 'src/behavior/pipeline.js',
    'default': false,
    'text':
      'Read links posted in chat and search the web. Needs `BRAVE_SEARCH_API_KEY` in `.env` for search; without it only link reading works. See [Media](media.md)',
  },
  {
    'key': 'features.recall',
    'types': ['boolean'],
    'reader': 'src/behavior/prefetch.js',
    'default': true,
    'text': "Search the server's own message history when a question calls for it",
  },
  {
    'key': 'features.recallTrace',
    'types': ['boolean'],
    'reader': 'src/behavior/recall-run.js',
    'default': false,
    'text':
      'Write one JSON line per recall run to `data/guilds/<id>/recall-trace.jsonl` for diagnosis. Capped at `recall.traceMaxLines`',
  },
  {
    'key': 'features.journal',
    'types': ['boolean'],
    'reader': 'src/admin.js',
    'default': true,
    'text':
      "Keep the persona's journal: for every turn, one line when it starts and one when it ends (what of the chat went into the request, her hidden reasoning, what she posted, token usage), in `data/guilds/<id>/journal/<YYYY-MM-DD>.jsonl` by UTC day. Must be exactly `true` to enable. See `journal.*`",
  },
  {
    'key': 'features.offPeriods',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': true,
    'text':
      '`<now>` lists the periods of the last `journal.offWindowHours` hours when the persona was paused or the service was off, newest first, at most 3. Nothing is posted. Needs `journal`',
  },
  {
    'key': 'features.record',
    'types': ['boolean'],
    'reader': 'src/behavior/inner/deliveries.ts',
    'default': true,
    'text':
      'Keep the record: every message the memory buffer took, every edit as a new line, every deletion, each message the persona posted, in `data/guilds/<id>/record/<YYYY-MM>/<YYYY-MM-DD>.jsonl` by UTC day. Never trimmed. Must be exactly `true` to enable',
  },
  {
    'key': 'features.archive',
    'types': ['boolean'],
    'reader': 'src/core.js',
    'default': true,
    'text':
      'Keep the archive: before anything leaves hot memory, a copy goes to `data/guilds/<id>/archive/<YYYY-MM>.jsonl` by month. The item stays in memory until the archive confirms the write. Never trimmed. Must be exactly `true` to enable. See `archive.*`',
  },
  {
    'key': 'features.meaningSearch',
    'types': ['boolean'],
    'reader': 'src/behavior/recall-run.js',
    'default': false,
    'text':
      'On each recall run, embed the question and search the vector index by meaning. Needs `recall` on and the embedding model reachable',
  },
  {
    'key': 'features.embedIndex',
    'types': ['boolean'],
    'reader': 'src/core.js',
    'default': false,
    'text':
      'Keep the vector index current while the bot runs. Needs `meaningSearch` on. Without it the index is built only by `tools/memory-db.mjs`',
  },
  {
    'key': 'features.imageGeneration',
    'types': ['boolean'],
    'reader': 'src/core.js',
    'default': false,
    'text': 'Let the persona draw pictures. Needs a drawing model in `models.base.drawing`. See [Media](media.md)',
  },
  {
    'key': 'features.speech',
    'types': ['boolean'],
    'reader': 'src/core.js',
    'default': true,
    'text':
      "The persona's voice messages. Her `voice.say` skill sends text through the `speech` role and posts a voice message. See `speech.*`",
  },
  {
    'key': 'features.privateMessages',
    'types': ['boolean'],
    'reader': 'src/behavior/core-pause.ts',
    'default': false,
    'text':
      'Answer direct messages from guild members. Needs a stored public profile and `affinity.score >= private.minAffinity`',
  },
  {
    'key': 'features.privateLikeServer',
    'types': ['boolean'],
    'reader': 'src/behavior/route-channel.js',
    'default': true,
    'text':
      'A private chat works like a server channel: route classifier, channel pull, server search, asked-about episodes. `false` restores the old DM behaviour',
  },
  {
    'key': 'features.gifPicker',
    'types': ['boolean'],
    'reader': 'src/turn/draw-gif.ts',
    'default': true,
    'text':
      "When the persona's first message is short, a classifier picks a fitting GIF from the library. Needs `gifs` on and a non-empty library",
  },
  {
    'key': 'features.versions',
    'types': ['boolean'],
    'reader': 'src/memory/store.js',
    'default': true,
    'text': 'Keep a version history of every prose memory field when its text is replaced',
  },
  {
    'key': 'features.recent',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': true,
    'text': 'Show a `<recent>` block of what happened on the server in the last few days. See `memory.recentHours`',
  },
  {
    'key': 'features.participation',
    'types': ['boolean'],
    'reader': 'src/behavior/participation-pick.js',
    'default': true,
    'text': 'The persona remembers its own exchanges on other channels and sees a few of them in `<participation>`',
  },
  {
    'key': 'features.anchoredWindow',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': false,
    'text':
      "Show older lines that still matter (reply parents, the persona's recent exchanges) in an `<earlier>` block",
  },
  {
    'key': 'features.promptCache',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': true,
    'text': "Mark parts of the request for the provider's prompt cache. See `llm.cache.*`",
  },
  {
    'key': 'features.channelPull',
    'types': ['boolean'],
    'reader': 'src/behavior/pull.js',
    'default': true,
    'text':
      "Pull another channel into a turn's request when the messages contain a real channel mention. See `context.pull.*`",
  },
  {
    'key': 'features.pullSeenMarker',
    'types': ['boolean'],
    'reader': 'src/turn/pulls.ts',
    'default': true,
    'text': 'Show how many messages in a pulled channel are new since the persona last saw it',
  },
  {
    'key': 'features.channelRoute',
    'types': ['boolean'],
    'reader': 'src/behavior/route-channel.js',
    'default': true,
    'text': 'A classifier picks a channel the conversation is about before a turn, so it can be pulled. See `route.*`',
  },
  {
    'key': 'features.turnPlanner',
    'types': ['boolean'],
    'reader': 'src/behavior/planner.js',
    'default': false,
    'text':
      'One analyzer call before the reply replaces the channel router, the episode pick, the search classifier and the re-watch classifier. Needs `prompts/planner.md`',
  },
  {
    'key': 'features.channelLinks',
    'types': ['boolean'],
    'reader': 'src/turn/sends.ts',
    'default': true,
    'text': 'When the persona writes `#channel-name`, the sent message carries a real channel link',
  },
  {
    'key': 'features.messageLinks',
    'types': ['boolean'],
    'reader': 'src/format.js',
    'default': true,
    'text': 'When the persona writes `#93`, the posted text carries a Discord message link to that transcript line',
  },
  {
    'key': 'features.mentionHandles',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': true,
    'text':
      'Every member with a stored profile gets a short handle (`@u7k2f`), listed in `<directory>`. The persona mentions people by handle',
  },
  {
    'key': 'features.elsewhere',
    'types': ['boolean'],
    'reader': 'src/behavior/elsewhere.ts',
    'default': true,
    'text':
      'Answer a call from a channel where the bot can read but not send. The answer goes to the first usable channel in `memory.mainChannelIds`',
  },
  {
    'key': 'features.diary',
    'types': ['boolean'],
    'reader': 'src/behavior/diary.ts',
    'default': true,
    'text': "The persona keeps a diary on its own and posts each entry to the diary's mirrors. See [Diary](diary.md)",
  },
  {
    'key': 'features.typingSimulation',
    'types': ['boolean'],
    'reader': 'src/turn/typing.ts',
    'default': true,
    'text': 'Simulate typing speed',
  },
  {
    'key': 'features.pauseNotice',
    'types': ['boolean'],
    'reader': 'src/pipeline/pause-notice.ts',
    'default': true,
    'text': 'Post a short notice when the persona is called while paused. See `mention.pauseNoticeMinutes`',
  },
  {
    'key': 'features.memberCommands',
    'types': ['boolean'],
    'reader': 'src/tools/impl/board.ts',
    'default': true,
    'text':
      'The operations every member may have her run without a grant (`pings.*`, the `errand.*` reads and requests, `memory.search`, see [Access](cli.md#access)). `false` restricts them to owners',
  },
  {
    'key': 'features.tools',
    'types': ['boolean'],
    'reader': 'src/behavior/sandbox.js',
    'default': true,
    'text': "The persona's tool gateway. `false` refuses every tool call",
  },
  {
    'key': 'features.toolsDiscovery',
    'types': ['boolean'],
    'reader': 'src/behavior/sandbox.js',
    'default': true,
    'text':
      'The lookup classifier and the turn planner can name tools or request the full list. Off when `tools` is off',
  },
  {
    'key': 'features.coreTools',
    'types': ['boolean'],
    'reader': 'src/behavior/prefetch.js',
    'default': false,
    'text':
      'Her own tools replace the classifiers before her reply. She looks things up herself with `web.search`, `web.read`, `media.look` and `memory.search`, each granted to her by name. See [Core](core.md)',
  },
  {
    'key': 'features.memoryPrefetch',
    'types': ['boolean'],
    'reader': 'src/behavior/prefetch.js',
    'default': true,
    'text':
      'With `coreTools` on: before a turn, search the record and stored memory once with the trigger message and put the relevant excerpts in `<retrieved>`. See `recall.prefetch.*`',
  },
  {
    'key': 'features.missedAnswers',
    'types': ['boolean'],
    'reader': 'src/behavior/missed.js',
    'default': true,
    'text': 'Track messages that may have been left unanswered',
  },
  {
    'key': 'features.missedRecovery',
    'types': ['boolean'],
    'reader': 'src/behavior/missed.js',
    'default': false,
    'text':
      'When the sweep finds owed candidates, start a reply turn. Off (the default), the sweep classifies and journals only',
  },
  {
    'key': 'features.offlineCatchUp',
    'types': ['boolean'],
    'reader': 'src/behavior/catch-up.js',
    'default': true,
    'text':
      'At start, read the messages posted while the bot was down and answer recent calls. On resume, answer the recent calls among the messages the pause held. See `offlineCatchUp.*`',
  },
  {
    'key': 'features.around',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': true,
    'text':
      "The persona sees what a member sees in Discord's sidebar right now (voice channels, activities) in `<people_now>`. See `context.around.*`",
  },
  {
    'key': 'features.avatars',
    'types': ['boolean'],
    'reader': 'src/core.js',
    'default': false,
    'text':
      "The persona knows what each member's avatar looks like. Each avatar is described by the vision model. See `avatars.*`",
  },
  {
    'key': 'features.intentions',
    'types': ['boolean'],
    'reader': 'src/behavior/prompt.js',
    'default': false,
    'text':
      'The persona keeps intentions: things she means to do later. See `intentions.*` and [Inner life](inner-life.md)',
  },
  {
    'key': 'features.innerLife',
    'types': ['boolean'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': false,
    'text':
      'The persona wakes on her own for a reason (a due intention, a review, a heartbeat). See `innerLife.*` and [Inner life](inner-life.md)',
  },
];
