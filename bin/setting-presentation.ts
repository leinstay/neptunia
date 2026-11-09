// Owner-facing names for the settings panel. Storage keys stay unchanged and remain searchable through row ids.
// Schema descriptions supply the reference detail; these explanations replace terms that need implementation knowledge.
const WORDS: Record<string, string> = {
  interfaces: 'Connections',
  bot: 'General',
  models: 'Models',
  llm: 'Model requests',
  memoryDb: 'Memory storage',
  embed: 'Meaning search',
  context: 'Chat context',
  mention: 'Mentions',
  missed: 'Missed messages',
  typing: 'Typing',
  pace: 'Reply timing',
  format: 'Message formatting',
  split: 'Message splitting',
  route: 'Chat routing',
  memory: 'Memory',
  media: 'Media understanding',
  web: 'Web',
  participation: 'Participation',
  recall: 'Memory recall',
  image: 'Image generation',
  speech: 'Voice messages',
  tools: 'Tools',
  skills: 'Skills',
  watcher: 'Project watcher',
  selfimprovement: 'Self-development',
  development: 'Development worker',
  selfreflection: 'Diary',
  gifs: 'GIF selection',
  dm: 'Direct messages',
  private: 'Direct message rules',
  errands: 'Agent tasks',
  agents: 'Agent settings',
  board: 'Task board',
  intentions: 'Plans',
  wakes: 'Autonomous turns',
  heartbeat: 'Heartbeat',
  appendStore: 'Write recovery',
  archive: 'Archive',
  base: 'Default models',
  session: 'Memory processing',
  caps: 'Token budgets',
  loop: 'Tool calls',
  prefetch: 'Automatic recall',
  db: 'Search index',
  pull: 'Related chats',
  around: 'Nearby chats',
  hedge: 'Parallel requests',
  rewatch: 'Follow-up viewing',
  autoTriage: 'Default task estimates',
  mode: 'Operating mode',
  enabled: 'Enabled',
  maxOutputTokens: 'Response token limit',
  maxRequestTokens: 'Request token limit',
  timeoutMs: 'Timeout (milliseconds)',
  maxTokens: 'Token limit',
  maxSteps: 'Follow-up step limit',
  maxActs: 'Action limit',
  maxTasks: 'Agent task limit',
  inputTokens: 'Input token budget',
  maxCallsPerStep: 'Tool calls per step',
  timeBudgetMs: 'Time budget (milliseconds)',
  ttl: 'Cache lifetime',
  msPerChar: 'Typing time per character (milliseconds)',
  everyMinutes: 'Interval (minutes)',
  schedule: 'Schedule',
  jitterMinutes: 'Timing variation (minutes)',
  minMs: 'Minimum duration (milliseconds)',
  maxMs: 'Maximum duration (milliseconds)',
  usdPerMillionChars: 'Cost per million characters (USD)',
  ytdlpPath: 'Video downloader executable',
  ffmpegPath: 'Video converter executable',
  opencodePath: 'OpenCode executable',
  byPurpose: 'Models for specific tasks',
  abilities: 'Model capabilities',
  providerByModel: 'Provider preferences by model',
  reasoningByRole: 'Reasoning effort by role',
  leaseTtlMinutes: 'Task claim lifetime (minutes)',
  deictic: 'References to earlier chat',
  trivial: 'Greetings that skip recall',
  reembed: 'Restore recalled search vectors',
  vectorEviction: 'Prune old search vectors',
  interlocutor: 'Current speaker',
  aboutChat: 'Chat background',
  pulled: 'Retrieved chats',
  neverIgnore: 'Always answer these accounts',
  ownerPerson: 'Owner identity',
  placeId: 'Home root',
  likeServer: 'Group chat features',
  minAffinity: 'Minimum relationship score',
  drainMs: 'Shutdown grace period (milliseconds)',
  closeTimeoutMs: 'Shutdown timeout (milliseconds)',
  observeTimeoutMs: 'Message save timeout (milliseconds)',
  ingestKeepDays: 'Duplicate detection history (days)',
  vectorDays: 'Search vector retention (days)',
  touchDays: 'Retention after recall (days)',
  selfMax: 'Facts about the persona',
  episodesMax: 'Remembered events',
  since: 'Start date',
  sweepsPerScopePerDay: 'Daily processing limit per chat',
  minLines: 'Small session threshold (lines)',
  batchLines: 'Batch size (lines)',
  failuresPerShape: 'Repeated failures before review',
  quietDayChance: 'Chance of a quiet day',
  world: 'Include world background',
  windows: 'Posting windows',
  at: 'Daily time (UTC)',
  baseUrl: 'API endpoint',
  safeMode: 'Reply-only mode',
};

const EXPLANATIONS: Record<string, string> = {
  'interfaces.mode':
    'Use inprocess to run Discord with the core, or units to run each connection separately. Restart to apply.',
  'interfaces.drainMs': 'Time to allow ongoing actions to finish when disabling a connection, in milliseconds.',
  'interfaces.*.enabled': 'Allow this connection to connect to the core.',
  'bot.ownerPerson':
    'The owner meta-person, whose linked accounts have owner rights. The first line of the command line sets it on a new install, or /memory bind while it is empty.',
  'bot.placeId': 'Limit the home connection to this root. Detected automatically when there is only one.',
  'bot.access': 'Permissions granted to other people. Manage them with /tools grant and /tools revoke.',
  'models.base.core': 'The model that speaks as the persona.',
  'models.base.memory':
    'The model that writes memories and reviews profiles. It needs its own configured memory binding.',
  'models.base.analyzer': 'The helper model that interprets chats, chooses actions and summarizes sources.',
  'models.base.vision': 'The model that describes pictures. Set null to disable.',
  'models.base.video': 'The model that watches videos and GIFs. Set null to disable.',
  'models.base.embedding': 'The model that makes text searchable by meaning.',
  'models.base.speech': 'The model that generates voice messages. Set null to disable.',
  'models.base.drawing': 'The model that generates pictures. Set null to disable.',
  'llm.providerByModel': 'Override provider preferences for individual models.',
  'memoryDb.file': 'The memory database filename inside the persona data folder.',
  'memoryDb.session.minMessages': 'Wait until a chat has this many new messages before processing it.',
  'memoryDb.session.minLines':
    'Combine sessions this small with the next batch. Set 0 to process every session immediately.',
  'memoryDb.session.batchLines': 'Process waiting sessions once their combined messages reach this count.',
  'memoryDb.session.maxWaitHours': 'Process a waiting session after this many hours even if its batch is still small.',
  'memoryDb.session.sweepsPerScopePerDay': 'Maximum memory processing passes for one chat per UTC day.',
  'memoryDb.session.retryLimit': 'How many passes retry a batch whose proposed memory changes were all rejected.',
  'context.turnLeaseMs': 'Time reserved for an autonomous turn before another worker may take over, in milliseconds.',
  'context.pull.sameAudience': 'Only retrieve chats visible to everyone who can see the destination chat.',
  'recall.prefetch.deictic': 'Words such as this or earlier that signal a reference to the surrounding chat.',
  'recall.prefetch.trivial': 'Greetings that do not need an automatic memory search.',
  'recall.db.reembed': 'Recreate search vectors when older messages without an indexed vector are recalled.',
  'recall.db.vectorEviction':
    'Remove older vectors from the search index daily. Stored messages remain in the archive.',
  'tools.transport': 'Use native for structured tool calls, or text for tool calls written inside the model response.',
  'selfreflection.placeId':
    'Legacy selfreflection destination used during migration. Manage current destinations through mirrors.',
  'selfimprovement.checkout': 'Absolute path of the development checkout where self-development tasks run.',
  'selfimprovement.repository':
    'GitHub repository for self-development, written as owner/name. Configure access through setup.',
  'board.reapSeconds': 'How often to release expired task claims so the tasks can be picked up again, in seconds.',
  'board.briefWaitMs': 'Time to wait for review before offering a completed task again, in milliseconds.',
  'wakes.mode': 'Use shadow to record proposed actions without executing them, or live to allow permitted actions.',
  'wakes.review.historyDays': 'How many days of the persona’s messages are used when deciding whether a review is due.',
  'appendStore.retryMax': 'Maximum queued records held in memory while writes fail.',
  'archive.drainMs': 'Interval between attempts to save pending archive records, in milliseconds.',
  'archive.holdMaxMs': 'Maximum wait for pending archive writes during shutdown, in milliseconds.',
};

function words(key: string): string {
  if (WORDS[key] !== undefined) return WORDS[key];
  const text = key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\bmax\b/gi, 'maximum')
    .replace(/\bmin\b/gi, 'minimum')
    .replace(/\bms\b/gi, '(milliseconds)')
    .replace(/\bchars\b/gi, 'characters')
    .replace(/\bdir\b/gi, 'folder')
    .replace(/\bid\b/gi, 'ID')
    .replace(/\bids\b/gi, 'IDs');
  return (
    text.charAt(0).toUpperCase() +
    text
      .slice(1)
      .toLowerCase()
      .replace(/\bid(s?)\b/g, 'ID$1')
  );
}

/** Friendly text only changes presentation. The caller keeps the original key for command execution. */
export function settingPresentation(
  key: string,
  description: string
): { label: string; detail: string; group: string } {
  const [section = '', ...path] = key.split('.');
  const normalized = key.replace(/^(interfaces)\.[^.]+\.enabled$/, '$1.*.enabled');
  const detail = EXPLANATIONS[normalized] ?? description.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`/g, '');
  return {
    group: words(section),
    label: (path.length === 0 ? [section] : path).map(words).join(' · '),
    detail,
  };
}
