# 配置

`config.json` 中所有键及其默认值，按节分组。

## `features`

| 键 | 默认值 | 说明 |
|---|---|---|
| `dryRun` | `false` | 完整流程运行但不发送。见[试运行](README.md#试运行) |
| `mentions` | `true` | 响应 @提及 |
| `replies` | `true` | 响应回复 |
| `nameTriggers` | `true` | 响应消息中的名字提及 |
| `spontaneous` | `true` | 随机定时器触发的主动消息 |
| `eavesdrop` | `true` | 随机概率对任意消息插话 |
| `memory` | `true` | 构建档案、追踪服务器规律、记录自述 |
| `relationships` | `true` | 每成员态度分数（-100..100） |
| `episodes` | `true` | 每人的长期回忆（时刻、引言、恩怨） |
| `lore` | `true` | 服务器级世界书 |
| `reactions` | `true` | 表情反应（角色放置反应） |
| `seeReactions` | `true` | 在对话记录中显示消息上的反应。缺失的键视为开启。与 `reactions`（控制角色是否放置反应）不同，此项控制角色是否看到它们 |
| `customEmoji` | `true` | 列出服务器自定义表情（按使用率排名），使角色可以通过 `:name:` 使用它们。缺失的键视为开启 |
| `gifs` | `true` | 从成员分享的内容构建 GIF 库，让角色通过 handle 发送。缺失的键视为开启 |
| `gifPicker` | `true` | 当角色的第一条消息不超过 `gifs.pick.maxChars` 个字符且自己没选 GIF 时，分类器从完整库中挑选合适的 GIF。匹配时 GIF 替换第一条消息；其余消息照常发布。缺失的键视为开启。需要 `features.gifs` 开启且库非空 |
| `embedUpdates` | `true` | 当 Discord 在消息本体之后才附加链接的嵌入内容时（Tenor 的 GIF 就是这样到达的），将其纳入记忆缓冲区，使 GIF 库和分析器能看到该 GIF。缺失的键视为开启 |
| `multiMessage` | `true` | 允许连续发 2–3 条消息 |
| `vision` | `true` | 处理附加图片 |
| `mediaDescriptions` | `true` | 为图片、GIF、视频帧和链接缩略图生成单行描述 |
| `attachedDescriptions` | `true` | 描述器同时为附加到请求的图片运行。角色仍然直接看到图片；辅助的注释帮助发现一眼容易错过的内容。需要同时开启 `vision` 和 `mediaDescriptions` |
| `videoDescriptions` | `false` | 通过支持视频的模型观看短视频片段；需同时开启 `mediaDescriptions`。在 `config.local.json` 中开启；还需要支持视频的模型，以及站点链接需要 `yt-dlp`/`ffmpeg` |
| `videoRewatch` | `true` | 被呼叫时重看视频以回答相关问题；需要 `videoDescriptions` |
| `imageRelook` | `true` | 被呼叫时再看一次图片以回答问题或核实被声称的细节；需要 `vision`。与视频重看共享每日 `media.video.rewatch.maxPerDay` 计数器。缺失的键视为开启 |
| `webLookup` | `false` | 阅读聊天中发布的链接并在被问到事实性问题时搜索网络。与其他功能不同，缺失的键视为关闭。搜索需要 `.env` 中的 `BRAVE_SEARCH_API_KEY`；没有密钥时只有链接阅读可用。参见[媒体：链接与搜索](media.md#链接) |
| `imageGeneration` | `false` | 允许角色通过绘画子进程绘制图片。缺失的键视为开启。在 `config.local.json` 中启用；需要 `image.model` 中配置支持图像生成的模型。参见[媒体：绘画](media.md#绘画) |
| `privateMessages` | `false` | 回复公会成员的私信。需要已存储的公共档案且 `affinity.score >= private.minAffinity`。参见[消息与记忆：私有层](messages-and-memory.md#私有层) |
| `privateLikeServer` | `true` | 私聊像服务器频道一样运作：路由分类器、频道拉取、服务器搜索（recall）和被问及成员的回忆均在 DM 中运行。仅当伙伴拥有该频道的 View Channel 权限时才拉取。缺失键 = 开。`false` 恢复旧的 DM 行为（无拉取、路由、recall 和回忆） |
| `channelPull` | `true` | 当最近的消息或触发器包含真实的频道提及时，将该频道拉入回合请求。缺失键 = 开。参见 `context.pull.*` |
| `elsewhere` | `true` | 响应机器人可读但不可写的频道中的呼叫（@提及、回复、名字）。回复发送到 `memory.mainChannelIds` 中第一个可用的频道。缺失键 = 开 |
| `portraitRefresh` | `true` | 根据消息计数器定期刷新成员画像。缺失键 = 开 |
| `notesRefresh` | `true` | 定期从近期消息的分散样本中重新检查频道和服务器笔记。缺失键 = 开。参见 `memory.notesRefreshDays*` 和[预热：保持笔记更新](warmup.md#保持笔记更新) |
| `versions` | `true` | 当散文记忆字段的文本被替换时保留版本历史。旧文本保存在 `data/guilds/<id>/versions/`。`/nep memory forget` 和 `/nep memory wipe` 会删除版本文件。缺失键 = 开 |
| `memoryTwoStage` | `false` | 将记忆分析器拆分为两个阶段：中性 GPT 模型判定变更（阶段 A），然后语音模型撰写角色文本（阶段 B）。必须严格为 `true` 才能启用；缺失键 = 关。参见 `memory.voice.*` |
| `promptCache` | `true` | 为系统消息添加提供商的提示缓存标记。缓存读取仅为正常输入成本的一小部分；某些提供商不将缓存读取计入 token 配额。必须严格为 `true` 才能启用；缺失的键视为关闭。参见 `llm.cache.*` |
| `recall` | `true` | 当问题需要时，在网络搜索之外同时搜索服务器自身的消息历史。缺失的键视为开启。参见[媒体：搜索](media.md#搜索)和 `recall.*` |
| `recent` | `true` | 在请求中显示一个 `<recent>` 块，呈现服务器最近几天发生的事情。缺失的键视为开启。参见 `memory.recentHours` 和 `context.caps.recent` |
| `channelRoute` | `true` | 分类器在回合前选出对话中提及的频道，以便将其拉入请求。缺失的键视为开启。参见 `route.*` |
| `channelLinks` | `true` | 角色在消息中写服务器频道的 `#频道名` 时，发送的消息包含真实的频道链接而非文字。名称按最长匹配；已有的链接保持不变。关闭时文本原样发送。缺失的键视为开启 |
| `pauseNotice` | `true` | 角色在暂停时被呼叫会发布一条简短通知。缺失的键视为开启。参见 `mention.pauseNoticeMinutes` 和 `labels.limits.paused` |
| `diary` | `true` | 角色在拥有者选择的频道中按随机时间表自发发帖。缺失的键视为开启。未设置 `diary.channelId` 时不生效。参见[日记](diary.md) |
| `splitTasks` | `true` | 将长且有结构的直接呼叫拆分为多个部分，每个部分在自己的回合中回答。缺失的键视为开启。需要 `prompts/split.md` 和 `labels.task.part` |
| `followUp` | `true` | 角色回复后对未标记消息进行分类以延续对话 |
| `typingSimulation` | `true` | 模拟输入速度 |
| `adminCommands` | `true` | 所有者斜杠命令；设为 `false` 时注销命令 |
| `memberCommands` | `true` | `/nep pings` 命令，所有成员可用；`false` 仅限所有者 |

## `bot`

| 键 | 默认值 | 说明 |
|---|---|---|
| `timezone` | `"UTC"` | 模型时间戳的时区 |
| `owners` | `[]` | 所有者命令的用户 ID |
| `commandName` | `"nep"` | 斜杠命令名称（小写 `a-z 0-9 _ -`，最多 32 字符；更改后重新注册） |
| `nameTriggers` | `[]` | 除 @提及外的额外触发字符串 |
| `guildId` | `""` | 锁定的服务器；若只在一个服务器中则自动检测 |
| `dryRunChannelId` | `""` | 试运行镜像频道。见[试运行](README.md#试运行) |
| `channels.allow` | `[]` | 允许的频道（空 = 所有可见频道） |
| `channels.deny` | `[]` | 忽略的频道 |
| `access` | `{}` | 除所有者外谁可运行哪些命令（由 `/nep access` 管理） |

## `llm`

| 键 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | 聊天补全端点 |
| `model` | `"anthropic/claude-opus-4.6"` | 模型 ID |
| `temperature` | `1` | 采样温度 |
| `maxOutputTokens` | `2000` | 最大输出 token 数 |
| `maxRequestTokens` | `50000` | 每请求硬性 token 上限 |
| `safetyMargin` | `0.9` | `maxRequestTokens` 的预算比例 |
| `timeoutMs` | `300000` | 请求超时（毫秒） |
| `probeTimeoutMs` | `30000` | 所有者的 `/nep status` 卡片对每个模型探测的超时（毫秒） |
| `helperTimeoutMs` | `30000` | 与回合并行运行的辅助任务（路由分类器、搜索分类器和 recall 摘要）的超时。超时的辅助任务被放弃，回合在没有其结果的情况下继续 |
| `retries` | `2` | 临时 HTTP 错误（408/429/5xx）和网络故障的重试次数。提供商账户的日配额 429 不重试：一次尝试后直接抛出 |
| `maxRequestsPerDay` | `5000` | 每日请求上限 |
| `provider` | `null` | OpenRouter `provider` 路由对象，原样传递；`null` 表示不发送该字段 |
| `providerByModel` | `{}` | 按模型路由 provider；详见下文 |
| `cache.ttl` | `"1h"` | 标记上发送的缓存 TTL: `"1h"` 或 `"5m"` |
| `cache.roles` | `["voice"]` | 系统消息会获得缓存标记的请求角色。记忆语音请求不参与，因此只有回复被缓存 |
| `cache.models` | `["anthropic/"]` | 提供商接受 `cache_control` 标记的模型 id 前缀（区分大小写）。列表外的模型发送时不带标记 |
| `cache.promptIncludesCached` | `true` | 提供商报告的 `prompt_tokens` 是否已包含缓存读取和缓存写入的 token。通过一次实际探测设定。token 校准和每请求上限始终使用完整计数 |
| `hedge.roles` | `["classifier.text"]` | 对冲的请求角色（两个并发尝试，先完成的获胜） |
| `hedge.afterMs` | `2500` | 第二次尝试在第一次之后多少毫秒启动。`0` 或以下对所有角色关闭对冲 |
| `hedge.timeoutMs` | `8000` | 从第一次尝试开始，两者均未返回时中止的毫秒数 |
| `hedge.longTimeoutMs` | `20000` | 当调用方标记请求为 `long: true` 时使用的超时（路由分类器在频道列表较大时使用此值） |

`llm.provider` 为聊天请求设置默认的 OpenRouter provider 路由字段，例如 `{ "ignore": ["some-provider"] }` 或 `{ "order": ["anthropic"], "allow_fallbacks": true }`。`llm.providerByModel` 按模型添加覆盖：每个键是模型 id 前缀（匹配任意角色）或 `<prefix>@<role>`（仅匹配一个角色），值为原样传递的 OpenRouter 路由对象。

单个请求的 provider 按以下顺序解析：每次调用的固定路由（视频描述器的直接 URL 路径使用 `media.video.provider`），然后是 `providerByModel` 中与该请求角色匹配的最长前缀，然后是无角色键中匹配的最长前缀，然后是 `llm.provider`（图像请求使用 `image.provider`），最后是无路由（由 OpenRouter 选择）。角色专用键始终优先于同一模型的无角色键。角色名称：`voice`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`image`。为兼容性，路由键或角色列表中仍写 `talk` 的会被读取为 `voice`，附带一条日志（`config: role talk is now voice`）。

示例：`"google/": { "only": ["google-vertex"], "allow_fallbacks": false }` 将所有 Google 模型路由到 Vertex，而 `"google/@classifier.video": { "only": ["google-ai-studio"], "allow_fallbacks": false }` 将视频分类器发送到 AI Studio。包含点号的路由键（如 `google/@classifier.video`）无法通过 `/nep set` 编辑，因为它会按点号拆分路径；请使用 `/nep route set` 和 `/nep route remove`。

如果 OpenRouter 账户本身限制了允许的 provider，忽略仅剩的那个会导致每个请求失败并报错 "No endpoints found"。更改 provider 设置后，检查 `/nep status` 验证每个模型角色是否可达；每个角色遵循其 `llm.providerByModel` 路由，因此显示的 provider 就是该路由选定的。

启用 `features.promptCache` 后，当请求的角色在 `llm.cache.roles` 中且模型以 `llm.cache.models` 中的前缀开头时，系统消息会被标记为提供商的提示缓存。标记在 token 估算之后添加，因此每请求 50k 上限和校准不受影响。`llm.cache.promptIncludesCached` 告诉引擎提供商如何报告缓存 token；通过一次实际探测设定。`llm: usage` 日志行新增 `cache` 字段: `write`、`read`、`none` 或 `off`。

`llm: usage` 日志行还包含 `ms`（请求的耗时）、`purpose`（一个短字符串说明请求用途，例如 `route-channel`、`recall-summary`、`address`）、`origin`（例如 `tools/replay.mjs` 的请求为 `replay`）、`hedged`（请求被对冲时为 true）和 `attempt`（对冲请求为 1 或 2，否则不存在）。

配置了 `llm.hedge` 后，其列出的角色的请求会被对冲：第二次尝试在第一次之后 `llm.hedge.afterMs` 启动，先完成的获胜。两者在 `llm.hedge.timeoutMs`（`long: true` 请求使用 `longTimeoutMs`）时中止。这为每个在第二次启动前未完成的对冲调用增加一次额外请求；两者都计入 `llm.maxRequestsPerDay`。

## `classifier`

三个辅助模型角色，统一归入一个键下。每个独立设置，因此辅助工具可以使用低成本模型，而语音使用高端模型。

| 键 | 默认值 | 说明 |
|---|---|---|
| `text` | `"anthropic/claude-sonnet-4.6"` | 文本分类器：地址分类器（`features.followUp`）、搜索分类器、链接阅读器、搜索浓缩器和 recall 摘要（`features.webLookup`、`features.recall`）、重看分类器（`features.videoRewatch`）、房间分类器（`spontaneous.roomQuestionChance`）和频道路由分类器（`features.channelRoute`） |
| `media` | `"anthropic/claude-haiku-4.5"` | 图片描述器（`features.mediaDescriptions`）：为图片、GIF 帧、视频封面、贴纸、自定义表情和链接缩略图生成单行描述 |
| `video` | `"google/gemini-3.8-flash"` | 视频描述器（`features.videoDescriptions`）：观看短片段，基于问题重看，按请求重试。必须同时接受视频和音频输入 |

**从旧键迁移。**已废弃的键 `llm.classifierModel`、`mention.followUpModel`、`media.model` 和 `media.video.model` 不再读取。如果 `config.local.json` 中存在这些键，机器人会在启动时记录一条警告（`index: deprecated model key ignored`），指出该键及其替代键。请将值分别移至 `classifier.text`、`classifier.media` 或 `classifier.video`。

## `context`

| 键 | 默认值 | 说明 |
|---|---|---|
| `channelMessages` | `100` | 当前频道消息数 |
| `fetchReplyParents` | `true` | 当窗口内的回复指向早于窗口的消息时，拉取父消息并放在窗口之前，让模型读到被回复的内容。先检查 discord.js 缓存，缓存命中不产生 API 请求。缺失的键视为开启 |
| `replyParentsFor` | `3` | 窗口末尾多少条回复早于窗口之消息的行也会拉取其父消息。触发消息始终检查，可拉取父消息和祖父消息 |
| `replyParentsMax` | `4` | 每轮放在窗口前的父消息行数上限 |
| `neighborMessages` | `5` | 每个相邻频道的消息数 |
| `neighborMaxAgeMinutes` | `60` | 相邻频道消息最大时效（分钟） |
| `neighborMaxChannels` | `8` | 最大相邻频道数 |
| `neighborMessageChars` | `300` | 每条相邻频道消息保留的字符数（`<other_channels>`） |
| `maxMessageChars` | `2000` | 超出此长度的消息会被截断（字符） |
| `gapMarkerMinutes` | `20` | 时间间隔标记阈值（分钟） |
| `ageAfterMinutes` | `60` | 角色读取聊天时，凡发出已满此分钟数的消息，时间旁还会显示距今多久，例如 `[14:32 · 2 h 58 min ago]`；更新的消息只显示 `[14:32]`。适用于当前频道以及拉取的频道和相邻频道。在 `prompts.local/labels.json` 中把 `transcript.timeAged` 设为空字符串即可关闭 |
| `reactionsPerMessage` | `6` | 对话记录中每条消息列出的最大反应数，按频率降序 |
| `replyQuoteChars` | `80` | 回复标签中显示的父消息文本字符数。引用在词边界截断。`0` 显示全文 |
| `otherProfiles` | `6` | 显示的其他档案最大数量 |
| `askedAboutProfiles` | `3` | 在近期消息中被提及的成员以完整档案显示，排在其他参与者之前 |
| `askedAboutEpisodes` | `3` | 被问及的成员显示的回忆数。`0` 隐藏被问及成员的回忆。私聊中当 `features.privateLikeServer` 开启时（默认）显示，否则隐藏 |
| `attitudes` | `6` | `<attitudes>` 块中显示的成员数，按态度评分强度排序，好感与反感混合。`0` 关闭该块 |
| `tempo.liveMessages10min` | `4` | 10 分钟内的消息数 = “活跃” |
| `tempo.deadSilenceMinutes` | `45` | 沉默分钟数 = “沉寂” |
| `caps.interlocutor` | `6000` | Token 上限：呼叫者的档案与回忆 |
| `caps.aboutChat` | `2500` | Token 上限：服务器习惯/自述事实 |
| `caps.lore` | `1500` | Token 上限：世界书条目 |
| `caps.people` | `9000` | Token 上限：其他档案 |
| `caps.attitudes` | `400` | Token 上限：态度列表 |
| `caps.neighbors` | `3000` | Token 上限：相邻频道 |
| `caps.server` | `4000` | Token 上限：频道地图 |
| `caps.emoji` | `800` | Token 上限：自定义表情 |
| `caps.gifs` | `900` | Token 上限：GIF 库 |
| `caps.pulled` | `4000` | Token 上限：拉取的频道块（`<channel_view>`） |
| `channelActivity.liveMessagesPerDay` | `20` | 每日消息数 = “活跃”频道 |
| `channelActivity.deadAfterDays` | `7` | 无消息天数 = “沉寂”频道 |
| `vision.maxImages` | `4` | 每请求最大图片数 |
| `vision.tokensPerImage` | `400` | 每张图片的 token 预算 |
| `vision.imageSize` | `512` | 通过 Discord 媒体代理缩放的目标像素 |
| `vision.recentImages` | `3` | 包含的近期频道图片数 |
| `vision.recentImageMinutes` | `30` | 近期图片最大时效（分钟） |
| `vision.maxBytes` | `1500000` | 图片文件大小上限（字节）；更大的图片会被跳过 |
| `vision.fetchTimeoutMs` | `10000` | 每张图片下载超时（毫秒） |

### `context.customEmoji`

自定义表情块（`features.customEmoji`）的设置。记忆分析器追踪成员使用了哪些自定义表情以及频率。

| 键 | 默认值 | 说明 |
|---|---|---|
| `max` | `30` | `<emoji>` 块中显示的自定义表情数，按成员使用率排名；排名不足 `max` 时从服务器表情按顺序补齐 |
| `storeMax` | `200` | 使用排名中保留的自定义表情数；显示排名前 `max` 个 |
| `halfLifeDays` | `30` | 使用排名的近期半衰期（天）；rank = log2(count + 0.5) + last / halfLife；最近不用的表情排名低于常用的 |
| `backfillMessages` | `500` | 启动时从每个频道历史中读取的消息数以初始化排名。在 `features.customEmoji` 开启且该服务器尚未运行过回填时运行一次；结果标记在 `guild.json` 中。`0` 禁用回填 |

## `context.pull`

将另一个频道拉入回合请求的设置（`features.channelPull`）。当近期消息或触发器包含真实的 Discord 频道提及（`<#id>`）时，被提及频道的最新消息会渲染为 `<channel_view>` 块。窗口止于该频道的最新消息。

| 键 | 默认值 | 说明 |
|---|---|---|
| `windowMinutes` | `60` | 拉取的消息窗口（分钟），止于该频道最新消息 |
| `minMessages` | `5` | 窗口内的最少消息数；不足时窗口向前扩展 |
| `maxMessages` | `60` | 每个频道拉取的最大消息数 |
| `maxPictures` | `10` | 包含说明的图片数；已缓存的说明免费，新的仅在回合确定运行时请求 |
| `maxNewDescriptions` | `8` | 每回合为拉取频道中的图片发起的新描述请求数 |
| `describeTimeoutMs` | `15000` | 新说明请求的超时（毫秒） |
| `scanMessages` | `20` | 扫描频道提及的当前频道近期消息数 |
| `maxChannels` | `1` | 每回合可拉取的频道数 |
| `maxAgeDays` | `0` | 当频道最新消息超过此天数时拒绝拉取。`0` = 无限制 |
| `sameAudience` | `true` | 检查目标频道的所有可查看角色是否也能查看来源频道。同时控制 `<other_channels>` 中显示哪些相邻频道，以及 recall 运行保留哪些服务器搜索窗口。关闭时，受限频道的内容可能到达更广泛的受众 |

## `elsewhere`

响应机器人可读但不可写的频道中的呼叫的设置（`features.elsewhere`）。呼叫在对话稳定后在 `memory.mainChannelIds` 中的第一个可用频道中回复，附带跳转链接。

| 键 | 默认值 | 说明 |
|---|---|---|
| `settleSeconds` | `10` | 呼叫后等待频道对话稳定的秒数 |
| `settleMaxSeconds` | `60` | 等待稳定的最长秒数 |
| `rememberPings` | `20` | 每个频道的呼叫记录环中记忆的呼叫数 |
| `pingMaxAgeDays` | `7` | 记忆的呼叫在环中保留的天数 |

## `pace`

有人等待回答时回合各阶段的时间限制。全部热重载。未在截止时间内完成的辅助任务被丢弃，回合在没有其结果的情况下继续。在 `dropAfterMs` 前未拿到回答的回合会被完全丢弃（记录为 `turn: dropped`）。每个请求在 `turn: timings` 中记录各阶段的耗时。

| 键 | 默认值 | 说明 |
|---|---|---|
| `prepareMs` | `6000` | 回合开始到发出对话请求前的毫秒数。LLM 调用前运行的所有任务（历史、说明、路由和搜索分类器）必须在此窗口内完成。`0` 或非数字移除此限制 |
| `prepareSearchMs` | `18000` | 搜索分类器决策期间以及分类器请求的搜索执行期间，截止时间延长到此值。「无需搜索」的判定立即释放持有。不会短于 `prepareMs`。`0` 或非数字移除此限制 |
| `prepareMediaMs` | `20000` | 直接呼叫的触发消息（或其回复的消息）包含描述器或视频阶段将处理的图片、GIF 或视频时的延长截止时间。不会短于 `prepareMs`；当搜索延长也适用时，取较大值。`0` 或非数字移除此延长 |
| `dropAfterMs` | `120000` | 从回合开始计的毫秒数。如果到此时完成的回答仍未到手，回合被丢弃不发布（`turn: dropped`）。`0` 或非数字移除此限制 |
| `replyHedgeMs` | `30000` | 在回答直接呼叫的回合中，如果回复请求在此毫秒数后仍无结果，发送第二个相同的请求。先完成的获胜，另一个中止。第二次尝试计入 `llm.maxRequestsPerDay`。`dropAfterMs` 限制仍然终止一切。`0` 或非数字 = 仅一次尝试。非呼叫回合（`unpromptedWaits`）不发送第二次尝试 |
| `typingWhilePreparing` | `false` | 从回答直接呼叫（提及、回复、名字、跟进、私信）的回合开始就显示输入指示器，而非仅在打字阶段显示。必须严格为 `true` 才能启用 |
| `unpromptedWaits` | `true` | 非呼叫回合（插话、发起话题、注意到的评论、全体提问、旁听）等待所有阶段完成后再发布，忽略 `prepareMs`、`prepareSearchMs` 和 `dropAfterMs`。`false` 对所有回合施加相同截止时间。缺失的键视为开启 |

## `format`

模型输出发送至 Discord 前的后处理。所有设置均热重载。

| Key | Default | Meaning |
|---|---|---|
| `stripDashes` | `true` | 发送前移除 `<msg>` 文本中的全角破折号和半角破折号。破折号及其周围的空格变为一个空格。尖角引号（`«`、`»`）替换为普通 `"`。清除后变空的消息不发送。连字符保留。`<draw>`、`<react>`、`<gif>` 和回复 id 不受影响。缺失键视为开启；仅 `false` 关闭 |

## `route`

频道路由分类器（`features.channelRoute`）的设置。当对话提到或引用了另一个频道时，分类器（`prompts/route-channel.md`，使用 `classifier.text` 角色）从列表中选出频道号。选中的频道作为 `<channel_view>` 块拉入请求，与显式频道提及并列。记录为 `route: classified`、`route: skipped` 或 `route: failed`。

| 键 | 默认值 | 说明 |
|---|---|---|
| `contextMessages` | `20` | 为分类器渲染的近期频道消息数 |
| `maxChannels` | `40` | 列给分类器选择的频道数 |
| `purposeChars` | `80` | 列表中每个频道已存储用途显示的字符数 |
| `maxOutputTokens` | `120` | 分类器的最大输出 token 数 |

## `split`

任务分拆器（`features.splitTasks`）的设置。当直接呼叫（提及、回复、名字、跟进、私信）足够长且有结构（`split.minChars`，至少两个分隔符）时，分类器（`prompts/split.md`，使用 `classifier.text` 角色）判断其中是否包含多个独立请求。每个部分在自己的回合中回答；第一个回复消息，其余发布为普通消息。分拆器与回合的准备过程并行运行，不会延迟单个请求。记录为 `split: verdict`、`split: skipped` 或 `split: failed`；每个部分记录 `turn: part`。

| 键 | 默认值 | 说明 |
|---|---|---|
| `minChars` | `80` | 询问分拆器前需要的最少字符数（链接和 Discord token 排除在外） |
| `minPartChars` | `20` | 分类器返回的部分如果短于此值（字符数，排除链接和 Discord token，与 `minChars` 相同），则折叠到下一个部分（最后一个折叠到前一个）。当剩余不足两个部分时视为单个请求。`0` = 不折叠 |
| `maxTasks` | `4` | 分拆器可返回的最大部分数。小于 2 时分拆器关闭 |
| `contextMessages` | `6` | 与候选一起渲染给分类器的近期频道消息数 |
| `maxOutputTokens` | `300` | 分类器的最大输出 token 数 |

## `recall`

服务器消息历史搜索（`features.recall`）的设置。当查询分类器（`prompts/lookup.md`）回答 `server:` 词形、`who:` 名称词形或 `when:` 日期范围时，引擎通过 Discord 搜索 API 搜索服务器消息历史，将命中项分组为聚类，获取每个聚类周围的消息窗口，并让摘要辅助（`prompts/recall-summary.md`，使用 `classifier.text` 角色）回答历史中的答案。摘要可能指出一段最佳回答问题的原文；如果是，角色将在 `<lookup>` 块中看到该段原文和浓缩笔记。记录为 `recall: searched`、`recall: summary`、`recall: skipped` 或 `recall: failed`。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxForms` | `8` | 分类器在每个 `server:` 行中列出的搜索词形（词的变体）数 |
| `maxPeople` | `2` | `who:` 行可列出的人数 |
| `dateSamples` | `4` | 仅给出 `when:` 范围而无内容词形时跨范围采样的仅日期查询数 |
| `clusterGapMinutes` | `30` | 将命中项分入不同聚类的时间间隔 |
| `maxClusters` | `5` | 保留的聚类数。按主题得分排名（聚类中每个有命中的不同 `server:` 词形，稀有的计 2 分，其余计 1 分），其次按所有不同查询的命中数，再按最新优先。仅有名称或作者命中的聚类排在任何有主题命中的聚类之后 |
| `keepOldest` | `0` | 排名前 `maxClusters` 个聚类中，为主题得分至少为 2 的最旧聚类保留此数量的槽位。得分低于 2 的聚类不获得保留槽位。`0` = 仅按排名顺序 |
| `rareHits` | `5` | 在整个服务器上搜索结果不超过此数的 `server:` 词形在聚类的主题得分中计为双倍。`0` = 无稀有加成 |
| `windowMessages` | `16` | 每个聚类中心周围获取的消息数 |
| `answerChars` | `1200` | 摘要笔记的最大字符数；填充 `recall-summary.md` 中的 `{{answerChars}}` |
| `stretchChars` | `1500` | 向角色展示的原文段的最大字符数 |
| `maxPerDay` | `100` | 每日 recall 运行次数（在 `state.json` 中存储为 `recallDay` / `recallCount`） |
| `timeoutMs` | `15000` | recall 运行的总时间（搜索、窗口、摘要）。一半时间过后不再发新搜索；只有剩余 `minSummaryMs` 时才询问摘要 |
| `minSummaryMs` | `2500` | 询问摘要辅助的最低剩余时间。不足时返回排名最高窗口的原文段，不附笔记 |
| `memoryItems` | `6` | 将分类器的词形和名称词形与已存储记忆（回忆、世界书、所学、近期行，不含私有层）匹配的条目数，作为 `<memory>` 块发送给摘要。`0` 关闭匹配 |
| `maxOutputTokens` | `500` | 摘要辅助的最大输出 token 数 |

## `gifs`

GIF 库（`features.gifs`）的设置。使用次数在每条消息到达时统计（仅成员，排除机器人和角色）。启动时通过频道历史一次性回填来初始化排名。

| 键 | 默认值 | 说明 |
|---|---|---|
| `max` | `25` | `<gifs>` 块中显示的 GIF 数，按近期加权使用排名 |
| `reactionChars` | `40` | `<gifs>` 列表和库 GIF 的对话记录行中每条反应标签保留的字符数。`0` 显示完整文本 |
| `actionChars` | `70` | `<gifs>` 列表和库 GIF 的对话记录行中每条动作行保留的字符数，在词边界处截断。`0` 显示完整行 |
| `storeMax` | `300` | 库中保留的 GIF 数；显示排名前 `max` 个 |
| `halfLifeDays` | `30` | 使用排名的近期半衰期（天）；与自定义表情使用相同公式 |
| `maxPerDay` | `40` | 角色每天可发送的 GIF 数 |
| `backfillMessages` | `500` | 启动时从每个频道历史中读取的消息数以初始化库 |
| `backfillDescribe` | `20` | 回填后立即获取说明的排名最高 GIF 数 |
| `recachePerRun` | `50` | 每次 `/nep media kind:gifs action:recache` 运行时重新描述的库 GIF 数量。库外的单帧说明立即删除；旧格式的已观看条目（无 `reaction` 字段）与未完成的一起排队，从最旧的开始。每次运行最多观看此数量，受 `media.gif.maxPerDay` 限制 |
| `ownMarkHours` | `24` | 角色发送 GIF 后该条目在 `<gifs>` 列表中显示标记的时间（小时）。`0` 关闭标记 |

### `gifs.pick`

GIF 挑选器（`features.gifPicker`）的设置。当角色的第一条发出消息较短（不超过 `gifs.pick.maxChars` 个字符）且自己没选 GIF 时，分类器（`classifier.text`，提示 `prompts/gif-pick.md`）接收最近几行聊天（标明所回复的消息）、该第一条消息以及带说明的完整库（每条记录附说明，适用时附自用标记），返回一个 handle 或 `none`。返回 handle 时 GIF 替换第一条消息；其余消息按原顺序跟随。分类器在第一条消息的打字模拟期间运行；每日 GIF 限额 `gifs.maxPerDay` 生效。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxChars` | `160` | 第一条消息上限：角色的第一条发出消息不超过此字符数时挑选器才运行 |
| `contextMessages` | `4` | 与回复和库一起发送给分类器的近期聊天行数 |
| `maxOutputTokens` | `60` | 挑选器分类器的最大输出 token 数 |

## `media`

媒体描述器（`features.mediaDescriptions`）的设置。描述器模型为 `classifier.media`。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxOutputTokens` | `2000` | 每次描述的最大输出 token 数；推理模型的思考计入此上限时需调高 |
| `descriptionChars` | `500` | 图片描述的最大字符数；保留第一行并在词边界截断。当 `describe.md` 中存在 `{{maxChars}}` 占位符时填充其值 |
| `imageSize` | `512` | 缩放目标像素 |
| `maxPerTurn` | `6` | 每回合生成的最大描述数 |
| `prefillPerMessage` | `5` | 一条观察到的消息中立即发送给描述器的图片、贴纸和自定义表情数；`0` 关闭图片预填 |
| `cacheEntries` | `5000` | 描述缓存大小，以附件为键 |
| `filePreviewChars` | `10000` | 文本文件开头显示的字符数 |
| `embedTextChars` | `200` | 链接嵌入文本显示的字符数 |

### `media.gif`

将 GIF 作为短视频片段观看（`media.gif.watch`）的设置。启用后，GIF 的动画被转换为短 mp4 并发送给 `classifier.video` 模型，而非描述单帧。观看后的说明替代单帧描述。无法观看的 GIF（无动画来源、日限额耗尽、转换失败）回退到单帧描述。

| 键 | 默认值 | 说明 |
|---|---|---|
| `watch` | `true` | 将 GIF 作为短视频片段观看而非描述单帧。需同时开启 `features.mediaDescriptions` 和 `features.videoDescriptions`。缺失的键视为开启 |
| `maxSeconds` | `15` | 发送给视频模型的动画秒数；片段通过 ffmpeg 转换 |
| `maxPerDay` | `200` | 每日 GIF 观看上限，独立于 `media.video.maxPerDay`。耗尽后 GIF 获得单帧描述 |

### `media.video`

视频描述器（`features.videoDescriptions`）的设置。视频视觉需要同时开启 `features.mediaDescriptions` 和 `features.videoDescriptions`。视频模型为 `classifier.video`。一个独立的支持视频的模型观看短视频片段：Discord 视频附件和 `media.video.sites` 中站点的链接。结果与图片描述一起缓存在媒体缓存中；重复发布不产生额外开销。

| 键 | 默认值 | 说明 |
|---|---|---|
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | 直接 URL 路径（在长度限制内的 YouTube）的 OpenRouter provider 路由。覆盖 `llm.providerByModel` 和 `llm.provider`；`null` 按正常解析顺序处理 |
| `maxOutputTokens` | `800` | 每个视频摘要的最大输出 token 数 |
| `summaryChars` | `1500` | 视频描述的最大字符数；填充 `describe-video.md` 中的 `{{maxChars}}` |
| `maxRequestTokens` | `60000` | 每次视频请求的 token 上限（输入 + 输出），替代 `llm.maxRequestTokens`。agentic 模式下公开 URL 视频使用 `directUrlTokensPerSecond`（10）估算: 一小时 YouTube 为 36 000 token。下载的片段使用 `tokensPerSecond`（120）估算: 三分钟为 21 600 token |
| `maxSeconds` | `180` | 附件和下载的站点视频的最大片段时长（秒）；更长的附件由 `ffmpeg` 裁剪，更长的站点视频由 `yt-dlp` 截取前 `maxSeconds`。直接 URL 站点使用 `directUrlMaxSeconds` |
| `directUrlMaxSeconds` | `3600` | 公开 URL 视频（YouTube 及其他 `directUrlSites`）的最大时长（秒），当 `urlProcessing` 为 `agentic` 时生效。其他模式下有效上限为此值与 `maxRequestTokens / tokensPerSecond` 中较小者。超长视频走下载路径（通过 yt-dlp 取前 `maxSeconds`），但 YouTube 在服务器上经常以 bot 验证阻止下载 |
| `maxBytes` | `12000000` | 附件和下载的站点片段的最大文件大小（字节）；下载本身最大可达此值的 4 倍。超限的文件先由 `ffmpeg` 重编码为 360p；仅重编码后仍超限的片段才被拒绝为永久未命中 |
| `maxPerTurn` | `5` | 每回合最大新视频数；每次获取尝试都计数，无论成功与否 |
| `maxPerDay` | `40` | 每日视频请求上限（在 `state.json` 中存储为 `videoDay`/`videoCount`） |
| `tokensPerSecond` | `120` | 视频每秒的 token 估算，用于预算检查。适用于下载的片段和非 agentic 模式的公开 URL 视频；agentic 模式下使用 `directUrlTokensPerSecond` 替代 |
| `directUrlTokensPerSecond` | `10` | agentic 模式下公开 URL 视频预检 token 预算的每秒估算值（模型按需加载，视频本身不计为提示 token）。缺失或无效时回退到 `tokensPerSecond`。`tokensPerSecond`（120）仍适用于下载的片段和非 agentic 模式的 URL |
| `timeoutMs` | `90000` | 视频的 LLM 请求超时（毫秒） |
| `toolTimeoutMs` | `60000` | `yt-dlp` 和 `ffmpeg` 子进程的超时（毫秒） |
| `sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | 其链接被视为视频的主机名 |
| `directUrlSites` | `["youtube.com", "youtu.be"]` | 可将公开 URL 直接传递给提供商（由提供商自行获取视频）的站点 |
| `directUrlUnknownDuration` | `false` | 即使所有探测均未获取到时长，仍将 directUrlSites 站点的链接发送给提供商；token 估算使用 `maxSeconds`。参见下方的时长探测链 |
| `canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | 启动时探测的固定 YouTube 视频，用于测试 YouTube API key 和时长来源 |
| `ytdlpPath` | `"yt-dlp"` | `yt-dlp` 二进制文件的路径；站点视频链接和探测时长需要此工具 |
| `ffmpegPath` | `"ffmpeg"` | `ffmpeg` 的路径；裁剪和缩小过长或过大的附件需要此工具 |
| `proxy` | `""` | `yt-dlp` 的代理 URL，接受其支持的任何格式（`socks5h://user:pass@host:port`、`http://host:port`）；`""` = 无代理。当站点拒绝服务器自身 IP 时使用（YouTube 对数据中心 IP 返回"请确认您不是机器人"）。仅 `proxySites` 中的站点链接通过代理。值可能包含密码，永不写入日志。通过代理下载时会下载整个视频，再由 `ffmpeg` 在本地截取前 `maxSeconds`，因为 yt-dlp 的分段下载模式会启动 ffmpeg，而 ffmpeg 不能使用 SOCKS 代理；因此下载上限（4x `maxBytes`）决定了长视频能否下载 |
| `proxySites` | `["youtube.com", "youtu.be"]` | 使用 `proxy` 进行时长探测和下载的站点。主机名等于列出的站点或以 `.<站点>` 结尾时匹配。其他站点的链接直接连接。`[]` 关闭代理 |
| `proxyRetryMinutes` | `10` | 通过代理的下载或探测失败后，机器人检查代理是否仍接受连接。如果接受，说明是视频本身的问题，链接报告为无法加载。如果代理已停机，该链接立即不经代理重试，之后的所有链接在此分钟数内跳过代理（`fetch-video: proxy failed`，窗口内记录一次 `fetch-video: proxy skipped`）。仅存于内存；重启后清除 |
| `errorRetryMinutes` | `60` | 错误缓存视频自动重试前的等待分钟数；重看分类器的强制重试忽略此值 |
| `urlProcessing` | `"agentic"` | 公开 URL 视频部分发送的 OpenRouter 处理模式；缺少时某些提供商只能看到单帧。`null` 省略该字段 |
| `reasoning` | `{ "effort": "low" }` | 每个视频请求的 OpenRouter `reasoning` 设置；防止推理占用输出预算。非对象值省略该字段 |
| `prefill` | `true` | 视频到达时立即观看，以便下次回合时已有缓存 |
| `prefillPerMessage` | `5` | 一条观察到的消息中立即观看的视频数（`prefill` 开启时）；`0` 关闭视频预填 |

`yt-dlp` 和 `ffmpeg` 均为可选的系统二进制文件。没有它们时，在限制内的附件仍然可用（直接发送）。更长的附件和所有站点链接会回退到静帧或预览图，角色会被告知原因。每个视频请求都计入 `llm.maxRequestsPerDay` 和视频 token 上限（`maxRequestTokens`）。

YouTube 链接的时长通过以下链式探测获取：首先尝试 yt-dlp，然后尝试 YouTube Data API（需在 `.env` 中设置 `YOUTUBE_API_KEY`），最后尝试抓取观看页面。如果所有探测均失败且 `directUrlUnknownDuration` 处于关闭状态（默认），链接将报告为"无法加载"。开启该开关后，URL 仍会发送给提供商，token 估算按 `maxSeconds` 计费。Data API 密钥免费获取：在 Google Cloud 控制台中启用 YouTube Data API v3 并创建密钥；免费配额为每天 10,000 个单位，一次时长查询消耗 1 个单位。启动时机器人探测 `canaryUrl` 并报告 API key 状态（如 `youtube: API key — ok`）。缓存的长度限制结果会记录视频时长，当上限提高后会重新尝试。

### `media.video.rewatch`

重看分类器（`features.videoRewatch`）的设置。当角色被呼叫且近期对话记录中有已观看的视频时，一个低成本分类器判断消息是否在询问其中某个视频；如果是，视频模型再次观看片段，回答追加到对话记录中。分类器使用 `classifier.text`。重看始终使用 `classifier.video`。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxPerDay` | `20` | 每日重看上限（独立于 `media.video.maxPerDay`） |
| `maxOutputTokens` | `600` | 重看回答的最大输出 token 数（视频模型的再看响应，非分类器的选择） |
| `classifierMaxOutputTokens` | `2000` | 重看分类器的最大输出 token 数（选择/重试/none 决定）。推理型模型需要更大的上限 |
| `answerChars` | `1200` | 回答的最大字符数；填充 `rewatch-answer.md` 中的 `{{maxChars}}` |
| `recentMessages` | `60` | 扫描已观看或错误状态视频的近期消息数 |
| `maxCandidates` | `6` | 从近期窗口中提供给分类器的最大视频数，按最新排序 |
| `contextMessages` | `50` | 作为 `<transcript>` 块渲染给分类器的近期频道消息数（不含触发消息）；`0` 省略该块 |

每回合最多一次重看或重试。回答按问题缓存一小时。分类器和重看各自计入 `llm.maxRequestsPerDay`；重看还计入 `media.video.maxPerDay`。

## `mention`

| 键 | 默认值 | 说明 |
|---|---|---|
| `ignoreChance` | `0` | 消息正文 @提及角色时的基础忽略概率；调高可使角色跳过部分提及 |
| `followUpIgnoreChance` | `0` | 角色不回应跟进消息、把最后一句话留给对方的概率。跟进消息指地址分类器判定为对角色说的未标记消息，以及对角色消息的 Discord 回复中回复者没有亲自输入角色 @提及的那些；Discord 自动给回复加上的提醒不算 @提及。对这些消息，此概率取代 `ignoreChance`，重复惩罚、垃圾消息判定和态度修正照常生效；被跳过的跟进不计入 `followUpNoStreak` |
| `emptyMentionIgnoreChance` | `0` | 空 @提及的忽略概率；调高可使角色跳过部分空提及 |
| `repeatWindowMinutes` | `10` | 重复追踪窗口（分钟） |
| `repeatPenalty` | `0` | 每次重复增加的忽略概率；调高可惩罚重复 |
| `spamThreshold` | `50` | 窗口内的呼叫次数达到此值视为垃圾消息 |
| `spamIgnoreChance` | `0.9` | 被刷屏时的忽略概率 |
| `nameTriggerChance` | `1` | 名字触发的响应概率 |
| `neverIgnore` | `[]` | 永不忽略的用户 ID |
| `affinityIgnoreBonus` | `0` | 态度 -100 时增加的最大忽略概率；调高可使不喜欢的成员更易被忽略 |
| `affinityLikeBonus` | `0.08` | 态度 +100 时减少的最大忽略概率 |
| `oneAtATime` | `true` | 全服务器同一时间只处理一条回复 |
| `pendingSameChannel` | `true` | 当同一频道中正在执行回合时挂起该频道的直接提及；回合结束后以通常的忽略概率回复。缺失键 = 开启 |
| `classifyWhileBusy` | `true` | 在回合执行期间仍将后续候选发送给地址分类器。候选通过相同的窗口、no-streak 和预过滤检查；每个频道同时最多一个分类器调用，较新的候选替换等候中的。遇到繁忙注意力的 `yes` 在挂起队列中等候（每频道一个）；`overheard` 在 `mention.pendingOverheard` 未开启时作为 `busy` 丢弃。关闭该开关时，候选跳过分类器调用。当 `mention.pendingSameChannel` 关闭且候选自身频道繁忙时也跳过。每次调用计为 `llm.maxRequestsPerDay` 下的一次 `classifier.text` 请求。缺失键 = 开启 |
| `pendingOverheard` | `true` | 角色繁忙时，将分类器判断为谈论角色（而非对角色说话）的行挂起到等候队列中。角色在当前回合结束后做出反应。等候中的跟进不会被后来的 overheard 行挤出；等候中的 overheard 行会被后来的跟进、后来的 overheard 行或直接提及、回复或名字呼叫挤出。等候中的 overheard 行不计入垃圾消息限制，也不作为频道中等候的呼叫报告给其他回合。关闭时：繁忙期间的行被丢弃。缺失键 = 开启 |
| `maxPending` | `6` | 跨所有频道和作者挂起的呼叫总数。满员时淘汰最早的一个（`mention: dropped`，原因 `full`） |
| `pendingMinutes` | `10` | 挂起的提及过期时间（分钟） |
| `switchDelayMs` | `[2000, 9000]` | 在下一个频道回复前的暂停时间（毫秒） |
| `followUpMinutes` | `15` | 角色最后一条回复后的后续窗口（分钟） |
| `followUpClassifyReplies` | `true` | 将对另一成员消息的回复发送给分类器而非自动 `no`。缺失键 = 开启。关闭时，任何回复在询问模型之前即为 `no` |
| `followUpContext` | `15` | 发送给分类器的对话记录行数 |
| `followUpMaxOutputTokens` | `2000` | 分类器的最大输出 token 数 |
| `followUpOverheard` | `true` | 开启时，地址分类器的 `overheard` 回答启动使用 `prompts/overheard.md` 的独立回合。关闭时 `overheard` 回答视为普通 `yes`（跟进回合）。缺失的键视为开启 |
| `followUpAliases` | `5` | 与角色名称一起发送给地址分类器的角色已存储别名数，以便分类器将其识别为呼叫。`0` 不发送 |
| `followUpNoStreak` | `5` | 连续 `no` 判定次数达到此值关闭窗口 |
| `pauseNoticeMinutes` | `10` | 同一频道两次暂停通知之间的最短间隔（分钟）。`0` 对每次呼叫都发通知 |

后续窗口保存在 `data/state.json` 的 `followUpWindows` 中，启动时恢复；过期的窗口会被丢弃。

## `typing`

| 键 | 默认值 | 说明 |
|---|---|---|
| `reactionDelayMs` | `[800, 4000]` | 反应延迟范围（毫秒） |
| `msPerChar` | `[35, 75]` | 每字符输入速度（毫秒） |
| `minMs` | `900` | 最短输入持续时间（毫秒） |
| `maxMs` | `12000` | 最长输入持续时间（毫秒） |
| `betweenMessagesMs` | `[700, 3500]` | 消息之间的暂停（毫秒） |

## `spontaneous`

| 键 | 默认值 | 说明 |
|---|---|---|
| `channels` | `[]` | 允许的频道 |
| `maxChannelSilenceHours` | `6` | 阻止主动消息的频道沉默时长（小时）；0 = 无限制 |
| `someoneAroundMinutes` | `120` | 当所有可读频道的最后一条消息都超过此时长（分钟）时，不触发自发回合。角色自身在频道的最后发言不计入；其他机器人的消息计入。`0` = 无门控 |
| `initiateCooldownHours` | `[24, 48]` | 发起话题后的冷却时间（小时）；冷却期间不再自行发起新话题。插话、全体提问、窃听、注意到的评论和 `/nep talk action:initiate` 不受影响。存储在 `state.json` 中，重启后保留；`/nep status` 在冷却期显示结束时间。`[0, 0]` = 无冷却 |
| `minIntervalMinutes` | `45` | 最短检查间隔（分钟） |
| `maxIntervalMinutes` | `420` | 最长检查间隔（分钟） |
| `burstChance` | `0.15` | 连发追加消息的概率 |
| `burstMinutes` | `[3, 15]` | 连发时间范围（分钟） |
| `activeHours` | `{ from: 10, to: 3 }` | 活跃时段（跨午夜） |
| `liveWindowMinutes` | `15` | 活跃窗口（分钟） |
| `liveMinMessages` | `4` | “活跃”所需最少消息数 |
| `deadAfterMinutes` | `90` | 沉默达此时长视为“沉寂”（分钟） |
| `initiateChance` | `0.1` | 发起话题（而非插话）的概率 |
| `roomQuestionChance` | `0.04` | 面向全体（而非面向特定人）的消息被角色接听的概率。分类器（`prompts/room.md`）预先过滤。`0` 关闭此功能 |
| `eavesdropChance` | `0.02` | 逐消息插入概率 |
| `eavesdropDelayMs` | `[5000, 40000]` | 窃听延迟范围（毫秒） |
| `minGapMinutes` | `12` | 动作之间的最短间隔（分钟） |

## `memory`

| 键 | 默认值 | 说明 |
|---|---|---|
| `model` | `null` | 分析器模型（`null` = `llm.model`） |
| `temperature` | `0.3` | 所有 analyzer 角色请求的采样温度：流分析器批次（服务器和私有）、预热的频道/档案/服务器请求和画像刷新 |
| `mainChannelIds` | `[]` | 人们相互交流的频道；成员性格和风格的画像取自这些频道；为空表示所有频道均计入。也是只读频道呼叫响应的目标频道（`features.elsewhere`）：使用列表中第一个可用的频道 |
| `portraitRefreshHours` | `24` | 每成员画像刷新最短间隔（小时） |
| `portraitRefreshMessages` | `300` | 自上次画像以来的成员自身消息数达到此值时触发代码刷新。也是采样大小 |
| `portraitRefreshDays` | `3` | 自上次成功刷新以来经过此天数后触发代码刷新 |
| `portraitRefreshPerDay` | `3` | 每服务器每天最大画像刷新次数（代码触发、分析器提示和 `/nep memory refresh` 共享此限额）。日计数器存储在 `state.json` 中（`portraitDay` / `portraitCount`），`/nep warmup reset` 不会清除它 |
| `portraitRetryHours` | `24` | 失败的刷新尝试后等待多少小时再重试同一成员 |
| `portraitCheckMinutes` | `60` | 画像调度器检查需要刷新的成员的频率（分钟） |
| `analyzerEpisodes` | `8` | 分析器 `<existing_profiles>` 中每个作者显示的回忆数。只发送按权重和近期排名的前几个；存储列表保留全部。`0` 不发送 |
| `keepNewestEpisodes` | `5` | 最新添加的情节（按添加时间）免于淘汰。`0` = 旧规则：先淘汰最轻的，再淘汰最老的 |
| `recentHours` | `72` | 保留并在 `<recent>` 块中显示的近期记事的小时数。降低此值会立即缩小视野，下次写入时删除更旧的行 |
| `maxRecentStored` | `150` | 磁盘上保留的行数。写入超过此上限时，先淘汰最轻的，再淘汰最老的 |
| `maxNewRecent` | `3` | 分析器每批次可添加的行数 |
| `recentChars` | `160` | 每条近期记事的最大字符数 |
| `recentShown` | `12` | 在 `<existing_recent>` 中向分析器展示的实时近期行数，避免重复 |
| `notesStaleDays` | `7` | 自上次有效检查或文本变更以来经过此天数后，频道或服务器笔记在下一个合格批次中被标记为待复审。标记仅在此后累积了足够的消息（频道为 `notesMinMessages`，服务器为 `notesGuildMinMessages`）且批次中包含该频道至少 `notesBatchLines` 行时才发送。`0` 关闭标记 |
| `notesBatchLines` | `8` | 当前批次中来自某频道的消息数，达到此值时才考虑该频道的过时标记。批次提供本地证据；累积计数（`notesMinMessages`）追踪自上次检查以来是否有足够活动 |
| `notesMinMessages` | `30` | 自频道笔记的上次文本变更和上次有效检查中较晚者算起，频道需要累积的消息数，之后才有资格被标记为过时 |
| `notesGuildMinMessages` | `100` | 自服务器笔记的上次文本变更和上次有效检查中较晚者算起，所有已存储频道的累积消息数总和需要达到此值，之后服务器笔记才有资格被标记 |
| `notesRetryHours` | `24` | 标记发送后，同一频道或服务器再次被标记前需等待的小时数。同时适用于流分析器标记和采样刷新尝试 |
| `notesRefreshDaysMain` | `7` | `mainChannelIds` 中的频道自上次文本变更或采样复审以来经过此天数后，进入采样刷新等待队列（`features.notesRefresh`） |
| `notesRefreshDays` | `21` | 同 `notesRefreshDaysMain`，用于不在 `mainChannelIds` 中的频道 |
| `notesServerRefreshDays` | `7` | 服务器笔记自上次文本变更或采样复审以来经过此天数后进入采样刷新。服务器在循环中排在频道之后，不计入频道的每日限额 |
| `notesRefreshPerDay` | `4` | 每 UTC 天成功刷新的频道笔记数。失败的请求不占用名额。日计数器存储在 `state.json` 中（`notesRefreshDay` / `notesRefreshCount`） |
| `notesCheckMinutes` | `60` | 笔记刷新调度器检查逾期频道和服务器的频率。上次检查时间存储在 `state.json` 中（`notesRefreshLookAt`） |
| `notesSampleDays` | `30` | 采样刷新时读取的频道历史天数 |
| `notesSampleMessages` | `160` | 分散样本的目标消息数。消息按天分散（最新一天优先，每轮每天一条），避免仅采样最近的对话 |
| `notesSampleMaxAuthorShare` | `0.35` | 单个作者在样本中最多占此比例；主导作者的多余消息用其他作者的行替换 |
| `versionsKept` | `20` | 版本历史中每个字段保留的旧文本数量。超过上限时删除最旧的条目。仅散文字段被版本化：成员 `character`、`style`、`relationship`；频道 `purpose`、`topics`、`tone`；服务器 `patterns`、`starters`；传说 `text` |
| `overLimitRetries` | `1` | 当模型回答的散文字段超出字符限制时的重试次数。重试将模型自身的回答连同准确的字段名、字符数和限制值一起发回，要求缩短。`0` 关闭重试；任何正值意味着恰好一次重试。适用于语音模型、画像刷新和笔记刷新。流分析器不重试（超出的字段从该批次的写入中排除） |
| `portraitMaxAgeDays` | `21` | 画像超过此天数（且此后至少有 `portraitMinMessages` 条自身消息）时，即使未达到 `portraitRefreshMessages` 也会进入刷新队列 |
| `portraitMinMessages` | `60` | 年龄路径（`portraitMaxAgeDays`）触发刷新所需的自上次画像以来的自身消息数 |
| `privateMaxAgeMinutes` | `360` | 安静的私聊缓冲区在未达到 `minBatchMessages` 时多少分钟后仍进行分析 |
| `channelWritersStored` | `20` | 每个频道保留的最活跃作者数，按衰减计数排名 |
| `channelWritersHalfLifeDays` | `30` | 每频道作者计数的半衰期（天）；停止发言的作者排名会低于活跃的 |
| `reasoning` | `null` | 在分析器的阶段 A 请求和预热的中性路径上发送的 OpenRouter `reasoning` 对象。`null` 省略该字段。示例：`{ "effort": "low" }` |
| `batchMessages` | `60` | 理想批次大小 |
| `minBatchMessages` | `15` | 更新前的最少消息数 |
| `maxBatchAgeMinutes` | `180` | 超过此时长强制更新（分钟） |
| `maxOutputTokens` | `20000` | 分析器最大输出 token 数 |
| `fieldChars` | `1000` | 档案散文字段（`character`、`style`）和频道笔记字段（`purpose`、`topics`、`tone`）的字符限制。服务器级 `patterns` 和 `starters` 使用 `fieldChars * 2`。超出限制的改写被拒绝，已存储文本保持不变；只有空字段的首次写入才会截断到限制（参见 `clampTolerance`） |
| `clampTolerance` | `1.25` | 首次写入允许超出限制的程度。仅在字段为空时适用：文本被接受到 `limit * clampTolerance`，在句或词边界截断，不在成员引用内部截断。改写时（字段已有文本）不应用容差：文本必须在精确限制内，否则被拒绝 |
| `maxDetails` | `15` | 每档案向角色和分析器展示的细节条目数 |
| `maxDetailsStored` | `40` | 每档案保存的细节条目数；按频率和近期程度排名最高的会被展示 |
| `maxInterests` | `12` | 每档案向角色和分析器展示的兴趣条目数 |
| `maxInterestsStored` | `40` | 每档案保存的兴趣条目数；按频率和近期程度排名最高的会被展示 |
| `interestTopicChars` | `40` | 兴趣主题最大字符数 |
| `interestNoteChars` | `120` | 兴趣备注最大字符数 |
| `confirmAfter` | `2` | 兴趣或细节被确认所需的观察次数 |
| `confirmGapHours` | `12` | 计为新一次观察所需的间隔小时数 |
| `interestStaleDays` | `90` | 未被观察到多少天后兴趣标记为过时 |
| `interestHalfLifeDays` | `180` | 兴趣的权重半衰期（天）；未被观察的条目权重每个周期减半，新爱好可以超过旧的 |
| `detailHalfLifeDays` | `720` | 细节的权重半衰期（天） |
| `maxLearned` | `20` | 向分析器和聊天模型展示的所学条目数 |
| `maxLearnedStored` | `60` | 磁盘上保存的所学条目数；按频率和近期程度排名最高的会被展示 |
| `learnedChars` | `160` | 每条所学内容的最大字符数 |
| `learnedHalfLifeDays` | `720` | 所学条目的权重半衰期（天） |
| `maxAliases` | `5` | 每档案向角色和分析器展示的别名数 |
| `maxAliasesStored` | `15` | 每档案保存的别名数；按频率和近期程度排名最高的会被展示 |
| `aliasRosterSize` | `40` | 服务器分析器批次 `<known_members>` 块中的成员：未作为批次作者的已存储档案，使分析器能为其记录别名。`0` 关闭名册。私聊批次不包含名册 |
| `aliasHalfLifeDays` | `365` | 别名的权重半衰期（天） |
| `maxInjokes` | `15` | 服务器内部梗最大数量 |
| `maxSelfFacts` | `20` | 自述事实最大数量 |
| `maxEpisodes` | `20` | 每人保存的最大回忆数 |
| `maxNewEpisodes` | `3` | 每人每批次的最大新回忆数 |
| `timeoutMs` | `900000` | 分析器超时（毫秒），独立于 `llm.timeoutMs` |

分析器提示通过占位符读取这些限制，因此调高某个值会在下一批次生效。更大的档案会消耗更多上下文 token（`context.caps.people`、`context.caps.interlocutor`）和分析器输出（`memory.maxOutputTokens`）。

**迁移。**`memory.voiceModel` 不再读取；仍然设置它的配置会记录一条警告，值被忽略。回复和记忆撰写都使用 `llm.model`。

### `memory.voice`

两阶段分析器（`features.memoryTwoStage`）阶段 B 的设置。阶段 A 把要用角色声音撰写的条目排入队列；阶段 B 在下一次成功的阶段 A 批次后和每个找到待处理条目的 tick 运行。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxItems` | `24` | 每次语音请求携带的条目数，控制在 50k token 限制内 |
| `maxPerDay` | `100` | 每 UTC 天的语音请求数。`0` 阻止发送（可用于仅阶段 A 的模拟运行） |
| `maxOutputTokens` | `3000` | 每次语音请求的最大输出 token 数 |
| `retryMinutes` | `15` | 语音回答遗漏条目后的退避时间；每次遗漏后延迟翻倍 |
| `maxAttempts` | `4` | 条目被回答遗漏多少次后走降级路径。失败的请求（错误 JSON、超时）不计入 |
| `queueMax` | `100` | 队列中保留的条目数；最旧的非角色条目溢出到降级路径 |
| `queueHours` | `24` | 排队条目在走降级路径前的过期小时数。角色条目永不过期 |
| `timeoutMs` | `120000` | 语音请求的请求超时（毫秒） |

## `relationships`

| 键 | 默认值 | 说明 |
|---|---|---|
| `damping` | `true` | 阻尼推离零点的分数变化；趋向零的变化全额应用 |
| `dampingPower` | `1` | 阻尼因子的指数；值越高两端越难达到 |
| `maxDeltaPerUpdate` | `15` | 每次更新的最大分数变化 |
| `historySize` | `10` | 每成员保留的态度变化记录数 |
| `shownMoves` | `4` | 档案中分数后显示的态度变动条数，按绝对变动量从大到小。`0` 隐藏 |
| `directTriggerCount` | `6` | 强制提前更新的直接互动次数 |
| `decayPerDay` | `0.04` | 每日向零漂移；每天损失 `decayPerDay * |score| * (|score| / 100) ^ decayPower`。`0` 或缺失 = 关 |
| `decayPower` | `1` | 衰减曲线的指数；值越高，接近零的分数衰减越慢。非正数 = 1 |
| `rewriteOnBandChange` | `true` | 当态度区间与写入时不同时，标记已存储的 `relationship` 文本需要重写。缺失键 = 开 |
| `rewriteOnDrift` | `8` | 当分数自写入以来偏移了这么多点时标记重写，即使在同一区间内。`0` = 关 |
| `rewriteAfterMoves` | `6` | 自写入以来产生了这么多条态度历史记录时标记重写。`0` = 关 |
| `bandHysteresis` | `2` | 超过旧区间边界多少点才将区间变化视为重写原因。防止在区间边界附近波动时的无谓重写 |
| `textChars` | `800` | relationship 文本的最大字符数。填充分析器提示词中的 `{{relationshipChars}}`。超出限制的改写被拒绝，已存储文本保持不变；只有空字段的首次写入才会截断 |

启用 `damping` 后，推离零点的分数变化会按 `(1 - |score| / 100) ^ dampingPower` 缩放，因此极端值需要持续努力才能达到；趋向零的变化全额应用。分数以小数精度存储，以整数显示；`/nep memory affinity` 可直接设置分数，不受阻尼影响。

设置 `decayPerDay` 后，所有已存储的态度分数（公共和私有）每天向零漂移。使用默认设置时，分数 100 的每日损失为 4；64 时约 1.6；30 时约 0.36。扫描在启动时和每小时运行，从档案上的时间戳（`affinity.decayedAt`）按整天数应用，因此停机时间会被追上。暂停期间和预热期间不运行。不写入态度历史条目。

## `lore`

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxEntries` | `500` | 每服务器最大世界书条目数 |
| `scanMessages` | `30` | 扫描关键词匹配的消息数 |
| `maxMatches` | `8` | 每请求显示的最大条目数 |
| `textChars` | `600` | 世界书条目文本限制（字符）。超出限制的改写被拒绝，已存储文本保持不变；只有首次写入才会截断。`/nep lore add` 写入已有标题时，所有者的文本原样保存 |

## `web`

网络查询（`features.webLookup`）的设置。链接阅读和搜索共享一个每日计数器（`web.maxPerDay`）。结果缓存在媒体缓存（`data/guilds/<id>/media.json`）中。所有模型调用通过 `classifier.text` 角色。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxPerDay` | `60` | 链接阅读和搜索请求合计的共享每日上限 |
| `acceptLanguage` | `"en,ru;q=0.8"` | 读取页面时发送的 Accept-Language 请求头；为空则不发送 |

### `web.links`

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 阅读聊天中发布的链接（仅 http/https，拒绝私有地址，排除视频站点链接） |
| `prefill` | `true` | 链接到达时立即阅读，以便下次回合时已有缓存 |
| `prefillPerUserPerDay` | `10` | 预读在到达时每个成员每天最多阅读的链接数；回合路径不受此限制 |
| `maxPerTurn` | `2` | 每回合最大新链接阅读数（每次抓取尝试都计数） |
| `maxBytes` | `1500000` | 页面大小上限（字节），超过则拒绝 |
| `textChars` | `6000` | 发送给浓缩器的页面文本最大字符数 |
| `summaryChars` | `700` | 浓缩摘要的最大字符数；填充 `read-link.md` 中的 `{{maxChars}}` |
| `maxOutputTokens` | `4000` | 浓缩器的最大输出 token 数 |
| `fetchTimeoutMs` | `10000` | 每页下载超时（毫秒） |
| `skipSites` | `["cdn.discordapp.com", "media.discordapp.net", "tenor.com", "giphy.com", "klipy.com", "imgur.com", "i.redd.it", "v.redd.it", "pbs.twimg.com"]` | 永不阅读的主机名（含子域名；在视频站点之外，视频站点始终排除） |

### `web.search`

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 分类器触发时运行搜索；需要 `.env` 中的 `BRAVE_SEARCH_API_KEY` |
| `maxPerTurn` | `1` | 每回合最大搜索次数 |
| `results` | `5` | 请求的 Brave Search 结果数 |
| `summaryChars` | `900` | 浓缩答案的最大字符数；填充 `search-summary.md` 中的 `{{maxChars}}` |
| `maxOutputTokens` | `4000` | 浓缩器的最大输出 token 数 |
| `classifierMaxOutputTokens` | `2000` | 搜索分类器的最大输出 token 数。提高以适应多行回答格式（`web:`、`server:`、`who:`、`when:`）。推理型模型需要更大的上限 |
| `cacheHours` | `24` | 缓存的搜索结果在重新搜索前服务的小时数 |
| `contextMessages` | `50` | 为搜索分类器渲染为 `<transcript>` 的近期频道消息数 |
| `timeoutMs` | `10000` | Brave Search 请求超时（毫秒） |

## `image`

绘画子进程（`features.imageGeneration`）的设置。角色输出 `<draw>` 标签后，代码通过 OpenRouter Images API 生成一张图片并作为独立消息发布。生成次数和每日计数器存储在 `data/state.json`（`imageDay`、`imageCount`、`imageUsers`）中。所有图片使用 `image.model`，不使用聊天模型或分类器模型。

| 键 | 默认值 | 说明 |
|---|---|---|
| `model` | `"openai/gpt-image-2.5-flare"` | 图像模型 ID。仅支持 `openai/*` 和 `google/*` 系列；其他系列在发送请求前即被拒绝 |
| `maxPerDay` | `50` | 整个实例的每日生成上限 |
| `maxPerUserPerDay` | `50` | 每个成员的每日生成上限；自发回合和 `/nep draw` 不计入成员配额 |
| `maxPromptChars` | `800` | `<draw>` 标签的场景文本截断至此长度 |
| `reference` | `"avatar"` | 角色出现在图片中（`self="yes"`）时发送的视觉参考。`"avatar"` 下载机器人的 Discord 头像；其他值或 `null` 不发送 |
| `referenceMaxBytes` | `4000000` | 头像最大文件大小（字节）；超过则跳过 |
| `outputFormat` | `"png"` | 请求的输出格式（`png`、`jpeg`、`webp`） |
| `aspectRatio` | `"auto"` | 宽高比（`auto`、`1:1`、`16:9`、`9:16` 等）。Google 模型中 `auto` 从请求中省略 |
| `timeoutMs` | `120000` | 请求超时（毫秒） |
| `retries` | `1` | 瞬态错误（HTTP 408/429/5xx、网络错误）的重试次数 |
| `provider` | `null` | 图像请求的 OpenRouter `provider` 路由，在 `llm.providerByModel` 无匹配时使用；`null` 不发送。系列特定的 provider 选项（如 `openai.moderation`）会合并在最终路由之上 |

### `image.openai`

`openai/*` 图像模型的特定选项。

| 键 | 默认值 | 说明 |
|---|---|---|
| `quality` | `"medium"` | 图像质量（`auto`、`low`、`medium`、`high`；2.5 模型还接受 `xhigh`、`max`） |
| `background` | `"auto"` | 背景模式（`auto`、`opaque`；2.5 模型还接受 `transparent`） |
| `moderation` | `"low"` | 作为 provider passthrough 发送到 `provider.options.openai.moderation` |

### `image.google`

`google/*` 图像模型的特定选项。

| 键 | 默认值 | 说明 |
|---|---|---|
| `resolution` | `"1K"` | 输出分辨率（`512`、`1K`、`2K`、`4K`；支持因模型而异）。`gemini-2.5-flash-image` 无分辨率设置 |

## `diary`

日记频道的设置（`features.diary`）。角色在拥有者选择的频道中，按可配置窗口的随机时间自发发帖。每篇帖子由分类器计划，再由主模型配合角色卡和所有记忆块生成。全部热重载。参见[日记](diary.md)。

| 键 | 默认值 | 说明 |
|---|---|---|
| `channelId` | `""` | 日记频道。由 `/nep diary set` 写入，每次心跳读取。空表示无日记 |
| `world` | `false` | 在日记的计划和生成请求中将 `prompts/world.md` 作为 `<world>` 块包含。必须为 `true` 才生效；缺失的键视为关闭。`/nep set diary.world true` 开启。文件描述角色的虚拟世界，仅日记使用，普通回合不用 |
| `windows` | 见下文 | `bot.timezone` 中的发帖窗口。每个窗口有 `from` 和 `to`（0–24 小时，可跨午夜）和 `posts: [min, max]`（窗口抽取的帖子数）。默认四个窗口见[日记: 窗口](diary.md#窗口) |
| `quietDayChance` | `0.3` | 一整天没有帖子的概率。创建日计划时抽取一次 |
| `hungerBoost` | `0.5` | How strongly an empty window pushes later posts. A window that drew no posts gets one extra roll per hunger point, and each roll redraws its count with chance 1 minus this value. `1` turns hunger off |
| `quietCarry` | `0.25` | After quiet days in a row the quiet chance is `quietDayChance` times this value per quiet day, so a long silence gets less likely. `1` keeps the chance flat |
| `minGapMinutes` | `90` | 两个计划时间槽之间的最小间隔（分钟）。距离上一个太近的时间槽被丢弃 |
| `maxPerDay` | `12` | 每天最大帖子数。计划器抽出超过此数的时间槽时，随机丢弃多余的。日次计数也限制 `/nep diary post` |
| `maxPicturesPerDay` | `8` | 每天日记图片最大数。与 `image.maxPerDay` 共享: 先用完的那个生效。用完后计划的 `picture` 强制为 false，感知提示不可绘画 |
| `slotGraceMinutes` | `30` | 计划时间槽过后仍可触发的宽限时间（分钟）。机器人关机期间超过此时间的时间槽被丢弃，不会延迟触发 |
| `forceWaitMs` | `120000` | `/nep diary post` 等待正在运行的回合完成的毫秒数。等待超时后命令回复 `busy`。不影响定时帖子 |
| `maxMessages` | `3` | 每篇日记帖子的最大 `<msg>` 消息数。超出部分被截断 |
| `historyPosts` | `150` | `diary.json` 中保留并在 `<diary>` 块中展示给计划器和生成器的历史帖子数。超出上限时最旧的被删除 |
| `gistChars` | `200` | 日记历史中每篇帖子摘要和图片场景的字符数 |
| `seedSets` | `2` | 从 `prompts/diary-seeds.md` 抽取并在 `<seeds>` 块中展示给计划器的随机种子组合数。`0` 省略该块 |
| `kinds` | `{ "selfPicture": 3, "picture": 2, "meme": 1, "thought": 2, "people": 2, "news": 2, "facts": 1, "status": 3, "photoset": 1, "randomSet": 1 }` | 帖子种类与权重。权重为 0 的种类永不被选择。计划器看到权重和最近帖子中每种类型的使用次数。热重载，拥有者可随时调整 |
| `searchKinds` | `["news", "facts"]` | 可触发网络搜索的种类。计划器仅为这些种类编写搜索查询 |
| `pictureKinds` | `["selfPicture", "picture", "meme", "photoset", "randomSet"]` | 日次图片上限允许时始终带图的种类，无论计划器如何回答。其余种类仅在计划器要求时绘制 |
| `setKinds` | `["photoset", "randomSet"]` | Kinds whose post is a set of pictures instead of one. Keep them in `pictureKinds` too, so they are dropped with the other picture kinds when the post cannot carry a picture |
| `set.pictures` | `[4, 6]` | How many pictures a set has: the prompt asks for between the two numbers, the bot generates at most the second (the first `<draw>` tags of the answer, the rest ignored) |
| `set.minPosted` | `2` | A set with fewer pictures generated than this is not posted at all, its messages included. Generation stops early once the pictures left cannot reach it. The pictures already generated still count against the day's picture caps |
| `set.seedSets` | `6` | Random seed combinations shown in a `<seeds>` block of the compose request of a set post (the plan request keeps `seedSets`). `0` omits the block |
| `set.maxMessageBytes` | `8000000` | The most picture bytes one Discord message carries. A set larger than this, or of more than 10 pictures, is split over several messages |
| `planMaxOutputTokens` | `2000` | 计划请求的最大输出 token 数 |
| `planTimeoutMs` | `60000` | 计划请求的超时（毫秒） |

默认的 `windows`:

```json
[
  { "from": 7,  "to": 11, "posts": [0, 0] },
  { "from": 12, "to": 16, "posts": [0, 1] },
  { "from": 18, "to": 1,  "posts": [0, 2] },
  { "from": 1,  "to": 5,  "posts": [0, 1] }
]
```

早晨（7–11）关闭。白天（12–16）抽取 0 或 1 篇帖子。晚上（18–次日 01）抽取 0、1 或 2 篇。深夜（01–05）抽取 0 或 1 篇。所有时间均为 `bot.timezone`。`to` 不大于 `from` 的窗口跨越午夜: `{ "from": 18, "to": 1 }` 从今天 18:00 到明天 01:00。

## `private`

私聊设置（`features.privateMessages`）。全部热重载。门控在无 LLM 请求的情况下本地检查。

| 键 | 默认值 | 说明 |
|---|---|---|
| `minAffinity` | `5` | 回复私信所需的最低公共好感度分数；所有者跳过此检查 |
| `maxPerUserPerDay` | `20` | 每成员每日到达模型的私信回合数（无论回复或沉默）；达到时每天发送一次限制通知 |
| `maxPerOwnerPerDay` | `200` | 所有者每日到达模型的私信回合数（无论回复或沉默） |
| `purgeMaxMessages` | `5000` | `/nep memory private purge` 单次运行扫描的最大私信消息数（从最新开始） |

当 `features.relationships` 关闭时，公共分数保持为 0，因此在默认 `minAffinity` 下只有所有者可以发送私信。

## `warmup`

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 首次启动时自动运行预热 |
| `lookbackDays` | `60` | 回溯采样天数 |
| `minMessages` | `30` | 成员入选所需的最少自身消息数 |
| `maxPeople` | `40` | 处理的成员数，按活跃度排序 |
| `messagesPerPerson` | `2000` | 每成员采样的自身消息数 |
| `contextBefore` | `1` | 每条采样消息前的上下文行数 |
| `maxChannelShare` | `0.5` | 单个频道在样本中的最大占比 |
| `messagesPerChannel` | `200` | 用于描述频道的最新消息数 |
| `serverSampleMessages` | `600` | 服务器请求使用的近期主频道消息数 |
| `fetchLimitPerChannel` | `15000` | 每频道为样本池获取的消息数 |
| `maxOutputTokens` | `6000` | 每次预热请求的最大输出 token 数 |
| `maxRequestTokens` | `120000` | 每次预热请求的最大 token 数（输入 + 输出） |
| `maxTokens` | `6000000` | 运行的总 token 预算 |
| `rateLimitWaitMinutes` | `10` | 遇到速率限制时等待的分钟数 |
| `rateLimitMaxWaits` | `36` | 连续等待次数达到此值后运行中止 |

## 模型

引擎使用七个模型角色。每个独立设置，因此语音可以使用高端模型，而辅助工具保持低成本。

### 声音（`llm.model`）

`voice` 角色。预算允许范围内最强的模型。角色扮演质量、角色一致性和自然对话均依赖于此。较小的模型会破坏角色、忽略上下文线索且语气平淡。在两阶段模式下，同一模型还负责为角色的记忆文本撰写措辞（阶段 B：关系笔记、态度原因、回忆感受、所学、自述事实、服务器规律、开场白和性格画像）。两类请求在使用日志中都携带 `voice` 角色；通过 purpose（`reply`、`memory-voice`）区分。

默认：`anthropic/claude-opus-4.6`。更便宜的选择：`anthropic/claude-sonnet-4.6`。

### 分析器（`memory.model`）

`analyzer` 角色。在长对话记录上进行推理并返回严格的 JSON。需要与语音相同级别的智能。`null`（默认）使用角色的模型。适用相同的示例。在两阶段模式（`features.memoryTwoStage`）下，此模型运行阶段 A（中性判定）。

### 文本分类器（`classifier.text`）

能可靠回答 "yes" 或 "no" 的最便宜的文本模型。运行地址分类器（`features.followUp`）、搜索分类器、链接阅读器、搜索浓缩器和 recall 摘要（`features.webLookup`、`features.recall`）、重看分类器（`features.videoRewatch`）、房间分类器（`spontaneous.roomQuestionChance`）和频道路由分类器（`features.channelRoute`）。默认：`anthropic/claude-sonnet-4.6`。

### 图片（`classifier.media`）

任何低成本的视觉模型。只需写一行描述，推理能力几乎不重要。

默认：`anthropic/claude-haiku-4.5`。最便宜的替代：`google/gemini-2.5-flash-lite`。

### 视频（`classifier.video`）

只有通过 OpenRouter 同时接受视频和音频输入的模型才能在此工作。接受帧但不接受音频的模型（Qwen VL、GLM、Seed、Gemma）无法听到语音，会遗漏大部分要点。

`google/gemini-flash-latest` 是一个浮动别名，其价格可能随时变化。批量（`:batch`）变体是异步的，不适用于实时回复。直接 URL 路径（在长度限制内的 YouTube，以公开 URL 通过 `media.video.provider` 发送）需要 Google AI Studio 作为 provider。

每分钟片段成本（美元），基于 2026-09-23 的 OpenRouter 价格：

| 模型 | ~USD / 1 min clip |
|---|---|
| `google/gemini-2.5-flash-lite` | 0.002 |
| `google/gemini-3.1-flash-lite` | 0.005 |
| `google/gemini-3.5-flash-lite` | 0.006 |
| `google/gemini-3.7-flash` | 0.014 |
| `google/gemini-3.8-flash` (default) | 0.014 |

`qwen/qwen3.8-omni-flash` 同样接受视频和音频。价格会变化；上表是截至上述日期的快照。

### 图片输出（`image.model`）

与 `classifier.media`（描述输入图片的模型）分开。此模型通过 OpenRouter Images API（`POST /api/v1/images`）生成图片。仅支持两个系列：`openai/*` 和 `google/*`。不支持的系列在发送请求或计数前即被拒绝。

**OpenAI 模型。** 使用 `image.openai.quality`、`image.openai.background`、`image.openai.moderation`、`image.aspectRatio`、`image.outputFormat` 和 `input_references`。

| 模型 | 备注 |
|---|---|
| `openai/gpt-image-2.5-flare` (default) | 快速层 |
| `openai/gpt-image-2.5-sunburst` | 高精度层 |
| `openai/gpt-image-2` | |
| `openai/gpt-image-1` | |
| `openai/gpt-image-1-mini` | |

**Google 模型。** 使用 `image.google.resolution`、`image.aspectRatio`、`image.outputFormat` 和 `input_references`。`image.aspectRatio` 为 `auto` 时从 Google 请求中省略。

| 模型 | 备注 |
|---|---|
| `google/gemini-3.1-flash-image` | Nano Banana 2 |
| `google/gemini-3-pro-image-preview` | |
| `google/gemini-2.5-flash-image` | 无分辨率设置 |

按输出 token 计费，而非按图片计费；provider 的 `usage.cost` 由 `/nep draw` 报告并记入日志。引擎在发送前拒绝的请求（每日或每人上限、不支持的模型系列）不产生费用；provider 拒绝的生成通常不计费；超时或图片生成后上传失败的情况仍可能产生费用。
