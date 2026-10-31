// The config cut of plan section 4.5 (2026-10-31): the keys that left the settings and what each became. A knob nobody
// changed is a named constant in the module that reads it, a completed rollout flag is code that always runs, a flag
// that was off went with the code it switched, and a daily cap went with its counter. The Discord keys belong to the
// Discord package (interfaces/discord/config.json), the two privacy switches live on under `private`, and the per-wake
// budgets are kept as one `innerLife.wakes.*.<field>` entry each. `cutConfigKeys` takes all of them out of a local
// layer written before the cut: the loader (src/config.js#readConfig) applies it at each load, and
// tools/config-migrate.mjs writes it into the file and reports each live value that differs from its constant.

export type CutFate = 'constant' | 'code' | 'gone' | 'cap' | 'discord' | 'rename' | 'wildcard';
/** One key the cut took out of the settings; `value` is the constant (true for code, the off value for gone), null for a cap. */
export type CutKey = { key: string; becomes: CutFate; value: unknown; to?: string };

type Tree = Record<string, unknown>;

/** The keys that became a named constant in their reader, with the production value of 2026-10-31. */
const CONSTANTS: Readonly<Record<string, unknown>> = {
  'llm.temperature': 1,
  'llm.safetyMargin': 0.9,
  'llm.cache.profilesTtl': '1h',
  'llm.cache.promptIncludesCached': true,
  'memoryDb.diaryAudioMaxBytes': 8388608,
  'memoryDb.session.settleMinutes': 10,
  'capture.ancestors': 2,
  'capture.before': 3,
  'capture.after': 3,
  'capture.pageLines': 60,
  'capture.watch': [15, 120, 1440],
  'capture.watchSameAuthor': 20,
  'graph.maxDepth': 6,
  'graph.maxRows': 2000,
  'focus.policyVersion': 1,
  'focus.size': 24,
  'focus.exploring': 4,
  'focus.exploringShare': 0.15,
  'focus.entryAffinity': 0.6,
  'focus.margin': 0.08,
  'focus.confirmHours': 24,
  'focus.maxMovesPerWeek': 2,
  'focus.settleDays': 21,
  'focus.weights.affinity': 0.55,
  'focus.weights.reciprocity': 0.15,
  'focus.weights.sharedInterest': 0.1,
  'focus.weights.recency': 0.1,
  'focus.weights.consistency': 0.1,
  'focus.noveltyMax': 0.12,
  'focus.noveltyHalfLifeDays': 14,
  'focus.recencyHalfLifeDays': 60,
  'focus.consistencyDays': 28,
  'focus.consistencyCap': 8,
  'embed.batch': 64,
  'embed.flushSeconds': 180,
  'embed.queueMax': 2000,
  'embed.catchUpHours': 72,
  'embed.catchUpEveryMinutes': 60,
  'context.deletedLinesMax': 10,
  'context.fetchReplyParents': true,
  'context.replyParentsFor': 3,
  'context.replyParentsMax': 4,
  'context.neighborMessages': 5,
  'context.neighborMessageChars': 300,
  'context.neighborMaxAgeMinutes': 60,
  'context.neighborMaxChannels': 8,
  'context.maxMessageChars': 2000,
  'context.gapMarkerMinutes': 20,
  'context.ageAfterMinutes': 60,
  'context.reactionsPerMessage': 6,
  'context.reactions.maxMessages': 500,
  'context.reactions.maxNames': 5,
  'context.reactions.fetchUsers': 10,
  'context.replyQuoteChars': 80,
  'context.otherProfiles': 6,
  'context.failedTurnsKept': 3,
  'context.askedAboutProfiles': 3,
  'context.askedAboutEpisodes': 3,
  'context.attitudes': 6,
  'context.tempo.liveMessages10min': 4,
  'context.tempo.deadSilenceMinutes': 45,
  'context.places': false,
  'context.previousThink.minutes': 30,
  'context.pull.windowMinutes': 60,
  'context.pull.minMessages': 5,
  'context.pull.maxMessages': 60,
  'context.pull.maxPictures': 10,
  'context.pull.maxNewDescriptions': 8,
  'context.pull.scanMessages': 20,
  'context.pull.maxChannels': 1,
  'context.pull.maxAgeDays': 0,
  'context.pull.seenTtlMinutes': 120,
  'context.pull.keepMinutes': 10,
  'context.pull.keepTurns': 3,
  'context.customEmoji.max': 30,
  'context.customEmoji.storeMax': 200,
  'context.customEmoji.halfLifeDays': 30,
  'context.customEmoji.backfillMessages': 500,
  'context.channelActivity.liveMessagesPerDay': 20,
  'context.channelActivity.deadAfterDays': 7,
  'context.vision.tokensPerImage': 400,
  'context.vision.maxBytes': 1500000,
  'mention.spamThreshold': 50,
  'mention.spamIgnoreChance': 0.9,
  'mention.nameTriggerChance': 1,
  'mention.affinityLikeBonus': 0.08,
  'mention.oneAtATime': true,
  'mention.pendingSameChannel': true,
  'mention.classifyWhileBusy': true,
  'mention.pendingOverheard': true,
  'mention.switchDelayMs': [2000, 9000],
  'mention.followUpMinutes': 15,
  'mention.followUpClassifyReplies': true,
  'mention.followUpOverheard': true,
  'mention.followUpContext': 15,
  'mention.followUpNoStreak': 5,
  'mention.followUpAliases': 5,
  'mention.failOpenMinutes': 3,
  'mention.pauseNoticeMinutes': 10,
  'missed.sweepDelaySeconds': 90,
  'missed.sweepMaxDelaySeconds': 240,
  'missed.questionExpireMinutes': 15,
  'missed.channelCooldownMinutes': 5,
  'missed.contextMessages': 20,
  'pace.unpromptedWaits': true,
  'split.minChars': 80,
  'split.maxTasks': 4,
  'split.contextMessages': 6,
  'split.minPartChars': 20,
  'route.contextMessages': 20,
  'route.maxChannels': 40,
  'route.purposeChars': 80,
  'elsewhere.settleSeconds': 90,
  'elsewhere.settleMaxSeconds': 300,
  'elsewhere.rememberPings': 20,
  'elsewhere.pingMaxAgeDays': 7,
  'memory.fieldChars': 1000,
  'memory.maxDetails': 15,
  'memory.maxSelfFacts': 20,
  'memory.maxEpisodes': 20,
  'memory.keepNewestEpisodes': 5,
  'memory.recentHours': 72,
  'memory.maxRecentStored': 150,
  'memory.maxNewRecent': 3,
  'memory.recentChars': 160,
  'memory.recentShown': 12,
  'memory.channelWritersStored': 20,
  'memory.channelWritersHalfLifeDays': 30,
  'memory.maxInterests': 12,
  'memory.maxInterestsStored': 40,
  'memory.interestHalfLifeDays': 180,
  'memory.maxDetailsStored': 40,
  'memory.detailHalfLifeDays': 720,
  'memory.maxLearned': 20,
  'memory.maxLearnedStored': 60,
  'memory.learnedChars': 160,
  'memory.learnedHalfLifeDays': 720,
  'memory.maxAliases': 5,
  'memory.maxAliasesStored': 15,
  'memory.aliasHalfLifeDays': 365,
  'memory.addressHalfLifeDays': 30,
  'memory.maxClosedStored': 40,
  'memory.supersededShownDays': 7,
  'memory.confirmAfter': 2,
  'memory.confirmGapHours': 12,
  'memory.interestStaleDays': 90,
  'memory.clampTolerance': 1.25,
  'lore.maxEntries': 500,
  'lore.scanMessages': 30,
  'lore.maxMatches': 8,
  'lore.textChars': 600,
  'relationships.maxDeltaPerUpdate': 15,
  'relationships.historySize': 10,
  'relationships.shownMoves': 4,
  'relationships.damping': true,
  'relationships.dampingPower': 1,
  'relationships.decayPerDay': 0.04,
  'relationships.decayPower': 1,
  'relationships.rewriteOnBandChange': true,
  'relationships.rewriteOnDrift': 8,
  'relationships.rewriteAfterMoves': 6,
  'relationships.bandHysteresis': 2,
  'relationships.textChars': 800,
  'media.descriptionChars': 500,
  'media.imageSize': 512,
  'media.maxPerTurn': 6,
  'media.prefillPerMessage': 5,
  'media.cacheEntries': 5000,
  'media.filePreviewChars': 10000,
  'media.recacheIntervalMs': 3000,
  'media.gif.watch': true,
  'media.gif.maxSeconds': 15,
  'media.video.summaryChars': 1500,
  'media.video.maxSeconds': 300,
  'media.video.directUrlMaxSeconds': 3600,
  'media.video.maxBytes': 14500000,
  'media.video.maxPerTurn': 5,
  'media.video.tokensPerSecond': 120,
  'media.video.directUrlTokensPerSecond': 10,
  'media.video.directUrlSites': ['youtube.com', 'youtu.be'],
  'media.video.directUrlUnknownDuration': false,
  'media.video.canaryUrl': 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  'media.video.audioMap.noiseDb': -50,
  'media.video.audioMap.minSilenceSeconds': 0.5,
  'media.video.audioMap.mapBelowShare': 0.8,
  'media.video.audioMap.maxSpans': 20,
  'media.video.urlProcessing': 'agentic',
  'media.video.reasoning.effort': 'low',
  'media.video.prefill': true,
  'media.video.prefillPerMessage': 5,
  'media.video.rewatch.answerChars': 1200,
  'media.video.rewatch.recentMessages': 60,
  'media.video.rewatch.maxCandidates': 6,
  'media.video.rewatch.contextMessages': 50,
  'media.look.maxPerTurn': 2,
  'web.links.enabled': true,
  'web.links.prefill': true,
  'web.links.maxPerTurn': 2,
  'web.links.maxBytes': 1500000,
  'web.links.textChars': 6000,
  'web.links.summaryChars': 700,
  'web.links.previewChars': 700,
  'web.links.readChars': 4000,
  'web.links.skipSites': [
    'cdn.discordapp.com',
    'media.discordapp.net',
    'tenor.com',
    'giphy.com',
    'klipy.com',
    'imgur.com',
    'i.redd.it',
    'v.redd.it',
    'pbs.twimg.com',
  ],
  'web.search.maxPerTurn': 1,
  'web.search.results': 5,
  'web.search.summaryChars': 900,
  'web.search.snippetChars': 400,
  'web.search.resultsChars': 3000,
  'web.search.contextMessages': 50,
  'participation.hours': 72,
  'participation.linesBefore': 3,
  'participation.linesAfter': 1,
  'participation.followMinutes': 10,
  'participation.mergeGapMinutes': 10,
  'participation.contextMinutes': 30,
  'participation.maxMessages': 32,
  'participation.maxStored': 120,
  'participation.maxTextChars': 400,
  'participation.shown': 4,
  'participation.perChannel': 2,
  'participation.episodeChars': 1800,
  'participation.contextMessages': 6,
  'participation.earlierHours': 3,
  'participation.earlierShown': 3,
  'recall.maxForms': 8,
  'recall.maxPeople': 2,
  'recall.dateSamples': 4,
  'recall.clusterGapMinutes': 30,
  'recall.maxClusters': 5,
  'recall.keepOldest': 0,
  'recall.rareHits': 5,
  'recall.windowMessages': 16,
  'recall.followMessages': 24,
  'recall.followGapMinutes': 5,
  'recall.answerChars': 1200,
  'recall.stretchChars': 1500,
  'recall.quoteWindowChars': 1500,
  'recall.quoteMaxChars': 9000,
  'recall.minSummaryMs': 2500,
  'recall.memoryItems': 6,
  'recall.selfBonus': 1,
  'recall.selfExtra': 2,
  'recall.contextMessages': 6,
  'recall.traceMaxLines': 500,
  'recall.recordContext': 3,
  'recall.archiveMonths': 6,
  'recall.fallbackOnClassifierFailure': true,
  'recall.meaningCandidates': 80,
  'recall.meaningWithReply': false,
  'recall.locatorBonus': 2,
  'recall.locatorDecayDays': 7,
  'recall.locatorBroadShare': 0.5,
  'recall.db.gateShare': 0.5,
  'recall.db.candidates': 40,
  'recall.db.wordPool': 400,
  'recall.db.minMeaning': 0.35,
  'recall.prefetch.candidates': 20,
  'recall.prefetch.maxExcerpts': 5,
  'recall.prefetch.excerptChars': 1200,
  'recall.prefetch.contextLines': 3,
  'recall.prefetch.shortWords': 4,
  'recall.prefetch.minFormsMatched': 2,
  'recall.prefetch.minMeaningScore': 0.35,
  'recall.prefetch.strongMeaningScore': 0.55,
  'recall.prefetch.singleTermScore': 0.45,
  'recall.prefetch.maxTermShare': 0.002,
  'recall.prefetch.maxPhraseDf': 20,
  'recall.prefetch.minPhraseShare': 0.2,
  'recall.prefetch.rareTermDf': 30,
  'image.referenceMaxBytes': 4000000,
  'image.outputFormat': 'png',
  'image.aspectRatio': 'auto',
  'image.openai.background': 'auto',
  'tools.markTextMaxChars': 200,
  'diary.hungerBoost': 0.5,
  'diary.quietCarry': 0.25,
  'diary.minGapMinutes': 90,
  'diary.slotGraceMinutes': 30,
  'diary.maxMessages': 3,
  'diary.historyPosts': 150,
  'diary.gistChars': 200,
  'diary.seedSets': 2,
  'diary.kinds.selfPicture': 3,
  'diary.kinds.picture': 2,
  'diary.kinds.meme': 1,
  'diary.kinds.thought': 2,
  'diary.kinds.people': 2,
  'diary.kinds.news': 2,
  'diary.kinds.facts': 1,
  'diary.kinds.status': 3,
  'diary.kinds.photoset': 1,
  'diary.kinds.randomSet': 1,
  'diary.searchKinds': ['news', 'facts'],
  'diary.pictureKinds': ['selfPicture', 'picture', 'meme', 'photoset', 'randomSet'],
  'diary.setKinds': ['photoset', 'randomSet'],
  'diary.set.pictures': [4, 6],
  'diary.set.minPosted': 2,
  'diary.set.seedSets': 6,
  'diary.set.maxMessageBytes': 8000000,
  'avatars.intervalMs': 20000,
  'avatars.descriptionChars': 200,
  'gifs.max': 25,
  'gifs.reactionChars': 40,
  'gifs.actionChars': 70,
  'gifs.ownMarkHours': 24,
  'gifs.storeMax': 300,
  'gifs.halfLifeDays': 30,
  'gifs.backfillMessages': 500,
  'gifs.backfillDescribe': 20,
  'gifs.recachePerRun': 50,
  'gifs.pick.maxChars': 160,
  'gifs.pick.contextMessages': 4,
  'gifs.pick.graceMs': 1000,
  'errands.recentLines': 6,
  'errands.unreadShown': 5,
  'errands.resultCooldownSeconds': 60,
  'intentions.maxCandidates': 5,
  'intentions.waitHours': 2,
  'intentions.expiryNoticeDays': 2,
  'innerLife.queueMax': 20,
  'innerLife.chatMessages': 30,
  'innerLife.review.enabled': true,
  'innerLife.review.expiredMax': 5,
  'innerLife.heartbeat.people': 8,
  'innerLife.heartbeat.filteredShown': 10,
  'innerLife.heartbeat.closedShown': 10,
  'innerLife.heartbeat.placesHours': 6,
  'innerLife.heartbeat.placesShown': 6,
  'innerLife.heartbeat.placeLines': 2,
  'innerLife.heartbeat.intentionsOnly': true,
  'innerLife.heartbeat.maxOpen': 3,
  'innerLife.heartbeat.maxRecurring': 1,
  'innerLife.heartbeat.dueJitterMinutes': 20,
  'innerLife.attention.settleSeconds': 90,
  'innerLife.attention.pageSize': 12,
  'innerLife.attention.placesInWake': 8,
  'innerLife.attention.lookbackHours': 24,
  'appendStore.fsyncMs': 500,
  'journal.thinkChars': 4000,
  'journal.offWindowHours': 24,
};

/** The switches whose behaviour always runs, with the value that behaviour has. */
const CODE: Readonly<Record<string, unknown>> = {
  'features.mentions': true,
  'features.replies': true,
  'features.nameTriggers': true,
  'features.followUp': true,
  'features.splitTasks': true,
  'features.memory': true,
  'features.relationships': true,
  'features.episodes': true,
  'features.lore': true,
  'features.reactions': true,
  'features.customEmoji': true,
  'features.gifs': true,
  'features.embedUpdates': true,
  'features.seeReactions': true,
  'features.reactionNames': true,
  'features.triggerMarkers': true,
  'features.callMarkers': true,
  'features.previousThink': true,
  'features.multiMessage': true,
  'features.mediaDescriptions': true,
  'features.videoDescriptions': true,
  'features.videoRewatch': true,
  'features.imageRelook': true,
  'features.webLookup': true,
  'features.recall': true,
  'features.recallTrace': true,
  'features.journal': true,
  'features.offPeriods': true,
  'features.record': true,
  'features.archive': true,
  'features.meaningSearch': true,
  'features.embedIndex': true,
  'features.imageGeneration': true,
  'features.speech': true,
  'features.gifPicker': true,
  'features.versions': true,
  'features.recent': true,
  'features.participation': true,
  'features.anchoredWindow': true,
  'features.promptCache': true,
  'features.channelPull': true,
  'features.pullSeenMarker': true,
  'features.channelRoute': true,
  'features.channelLinks': true,
  'features.messageLinks': true,
  'features.mentionHandles': true,
  'features.elsewhere': true,
  'features.diary': true,
  'features.typingSimulation': true,
  'features.pauseNotice': true,
  'features.memberCommands': true,
  'features.tools': true,
  'features.toolsDiscovery': true,
  'features.coreTools': true,
  'features.memoryPrefetch': true,
  'features.missedAnswers': true,
  'features.missedRecovery': true,
  'features.offlineCatchUp': true,
  'features.around': true,
  'features.avatars': true,
  'features.intentions': true,
  'features.innerLife': true,
  'memoryDb.turnReads': true,
  'memoryDb.audienceColumn': true,
  'memoryDb.diaryMedia': true,
  'memoryDb.focus.enabled': true,
  'memoryDb.wakeRuns': true,
  'innerLife.heartbeat.focusSource': 'db',
};

/** The switches and knobs that went with their code, with the value production ran with. */
const GONE: Readonly<Record<string, unknown>> = {
  'features.dryRun': false,
  'features.spontaneous': false,
  'features.eavesdrop': false,
  'features.turnPlanner': false,
  'bot.dryRunChannelId': '',
  'mention.ignoreChance': 0,
  'mention.followUpIgnoreChance': 0,
  'mention.emptyMentionIgnoreChance': 0,
  'mention.repeatWindowMinutes': 10,
  'mention.repeatPenalty': 0,
  'mention.affinityIgnoreBonus': 0,
  'pace.typingWhilePreparing': false,
  // The re-watch classifier's budget went with the classifier (no live turn asked it).
  'media.video.rewatch.classifierMaxOutputTokens': 2000,
  'spontaneous.channels': [],
  'spontaneous.minIntervalMinutes': 45,
  'spontaneous.maxIntervalMinutes': 420,
  'spontaneous.burstChance': 0.15,
  'spontaneous.burstMinutes': [3, 15],
  'spontaneous.activeHours.from': 10,
  'spontaneous.activeHours.to': 3,
  'spontaneous.liveWindowMinutes': 15,
  'spontaneous.liveMinMessages': 4,
  'spontaneous.deadAfterMinutes': 90,
  'spontaneous.initiateChance': 0.1,
  'spontaneous.initiateCooldownHours': [24, 48],
  'spontaneous.eavesdropChance': 0.02,
  'spontaneous.roomQuestionChance': 0.04,
  'spontaneous.eavesdropDelayMs': [5000, 40000],
  'spontaneous.minGapMinutes': 12,
  'spontaneous.maxChannelSilenceHours': 6,
  'spontaneous.someoneAroundMinutes': 120,
};

/** The daily caps of plan section 4.5, gone with their counters. */
const CAPS: ReadonlyArray<string> = [
  'media.gif.maxPerDay',
  'media.video.maxPerDay',
  'media.video.rewatch.maxPerDay',
  'web.maxPerDay',
  'web.links.prefillPerUserPerDay',
  'recall.maxPerDay',
  'image.maxPerDay',
  'image.maxPerUserPerDay',
  'speech.maxPerDay',
  'diary.maxPerDay',
  'diary.maxPicturesPerDay',
  'avatars.maxPerDay',
  'gifs.maxPerDay',
  'private.maxPerUserPerDay',
  'private.maxPerOwnerPerDay',
  'innerLife.attention.perDayDefault',
];

/** The keys of the Discord package, by the dotted path they keep in its settings. */
const DISCORD_KEYS: ReadonlyArray<string> = [
  'discord.intents.presences',
  'discord.intents.members',
  'context.maxUrlChars',
  'media.embedTextChars',
];

/** The two privacy switches, kept as keys under `private`. */
const RENAMES: ReadonlyArray<[string, string]> = [
  ['features.privateMessages', 'private.enabled'],
  ['features.privateLikeServer', 'private.likeServer'],
];

/** The per-wake budgets: each kind's field is now one `innerLife.wakes.*.<field>` entry. */
const WAKE_KINDS = ['intention_due', 'review', 'errand_deadline', 'attend', 'feedback', 'heartbeat'];
const WAKE_FIELDS = ['tools', 'maxActs', 'maxTasks', 'inputTokens'];

export const CUT_KEYS: ReadonlyArray<CutKey> = [
  ...Object.entries(CONSTANTS).map(([key, value]) => ({ key, becomes: 'constant' as const, value })),
  ...Object.entries(CODE).map(([key, value]) => ({ key, becomes: 'code' as const, value })),
  ...Object.entries(GONE).map(([key, value]) => ({ key, becomes: 'gone' as const, value })),
  ...CAPS.map((key) => ({ key, becomes: 'cap' as const, value: null })),
  ...DISCORD_KEYS.map((key) => ({
    key,
    becomes: 'discord' as const,
    value: null,
    to: 'interfaces/discord/config.json',
  })),
  ...RENAMES.map(([key, to]) => ({ key, becomes: 'rename' as const, value: null, to })),
  ...WAKE_KINDS.flatMap((kind) =>
    WAKE_FIELDS.map((field) => ({
      key: `innerLife.wakes.${kind}.${field}`,
      becomes: 'wildcard' as const,
      value: null,
      to: `innerLife.wakes.*.${field}`,
    }))
  ),
];

export type CutConfig = {
  config: Record<string, unknown>;
  /** The dotted keys of fate constant, code, gone or cap the layer set, now removed. */
  cut: Array<string>;
  /** The removed keys whose live value is not the constant (a cap is never here). */
  differs: Array<{ key: string; live: unknown; constant: unknown }>;
  /** The two privacy switches written under `private`. */
  renamed: Array<{ from: string; to: string }>;
  /** The Discord keys, by interface name, as a tree to merge into config.local/interfaces/<name>.json. */
  interfaces: Record<string, Record<string, unknown>>;
};

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether `tree` holds a value at the dotted `key`. */
function has(tree: Tree, key: string): boolean {
  let node: unknown = tree;
  for (const segment of key.split('.')) {
    if (!isTree(node) || !Object.hasOwn(node, segment)) return false;
    node = node[segment];
  }
  return true;
}

/** The value at the dotted `key`, removed from `tree` with every section it leaves empty. */
function take(tree: Tree, key: string): unknown {
  const segments = key.split('.');
  const parents: Array<Tree> = [];
  let node: Tree = tree;
  for (const segment of segments.slice(0, -1)) {
    parents.push(node);
    node = node[segment] as Tree;
  }
  const last = segments[segments.length - 1] ?? '';
  const value = node[last];
  delete node[last];
  for (let depth = segments.length - 2; depth >= 0; depth -= 1) {
    const parent = parents[depth];
    const name = segments[depth] ?? '';
    if (parent === undefined || !isTree(parent[name]) || Object.keys(parent[name]).length > 0) break;
    delete parent[name];
  }
  return value;
}

/** `value` written at the dotted `key` of `tree`, creating the sections on the way; a value already there stays. */
function put(tree: Tree, key: string, value: unknown): void {
  const segments = key.split('.');
  let node: Tree = tree;
  for (const segment of segments.slice(0, -1)) {
    if (!isTree(node[segment])) node[segment] = {};
    node = node[segment] as Tree;
  }
  const last = segments[segments.length - 1] ?? '';
  if (!Object.hasOwn(node, last)) node[last] = value;
}

/** The same JSON whatever the order of an object's keys, so equal values compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) =>
    isTree(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  );
}

const REMOVED: ReadonlyArray<CutFate> = ['constant', 'code', 'gone', 'cap'];

/** Pure; the argument is not changed. An emptied section goes. A second run returns empty lists and `interfaces: {}`. */
export function cutConfigKeys(config: Record<string, unknown>): CutConfig {
  const next = structuredClone(config);
  const report: CutConfig = { config: next, cut: [], differs: [], renamed: [], interfaces: {} };
  for (const row of CUT_KEYS) {
    if (!has(next, row.key)) continue;
    if (REMOVED.includes(row.becomes)) {
      const live = take(next, row.key);
      report.cut.push(row.key);
      if (row.becomes !== 'cap' && stable(live) !== stable(row.value))
        report.differs.push({ key: row.key, live, constant: row.value });
    } else if (row.becomes === 'rename' && row.to !== undefined) {
      put(next, row.to, take(next, row.key));
      report.renamed.push({ from: row.key, to: row.to });
    } else if (row.becomes === 'discord') {
      report.interfaces.discord ??= {};
      put(report.interfaces.discord, row.key, take(next, row.key));
    }
  }
  return report;
}
