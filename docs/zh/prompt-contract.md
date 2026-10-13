# 提示契约

提示文件与代码（`src/behavior/prompt.js`、`src/llm/parse.js`、`src/discord/format.js`、
`src/memory/update.js`、`src/memory/channels.js`、`src/memory/warmup.js`）的交汇点。修改一方时需同步修改
另一方。变更的工作流程参见 `CONTRIBUTING.md`。

## 层级

| 目录 | 受版本控制 | 内容 |
|---|---|---|
| `prompts/` | 是 | 英文引擎默认值 + 一个中性的示例角色。开箱即用 |
| `prompts.local/` | 否 | 部署的覆盖文件：一个文件替换同名的默认文件；`labels.json` 采用深度合并 |

两者均支持热重载。`/nep rule add` 写入 `prompts.local/rules.md`（从默认文件初始化），永远不写入 `prompts/`。
两层中的所有指令均为英文；角色的语音示例可以使用角色所说的语言。

## 文件

| 文件 | 必需 | 用途 | 占位符 |
|---|---|---|---|
| `system-prompt.md` | 是 | 与角色无关的规则，指导如何表现得像普通聊天成员：长度、反 AI 检测规则、上下文使用、对人的态度、边界。声明角色卡在语气上具有优先权 | `{{name}}` |
| `character-card.md` | 是 | 角色定义：身份、性格、语气和语言、元层、**什么能赢得或失去角色的好感**（分析器会读取此内容）、参考台词。部署者需要重写的唯一文件 | `{{name}}` |
| `rules.md` | 否 | 所有者的实时修正，覆盖前两个文件。**必须以最后一个 `## ` 标题下的项目列表结尾。**代码会追加 `- …` 行 | `{{name}}` |
| `format.md` | 是 | 输出协议 | 无 |
| `reply.md` | 是 | 任务：有人呼叫了角色 | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `follow-up.md` | 否 | 任务：延续与角色对话的一行消息。角色先决定是否要再发言一次；对没有向角色提出任何要求的行，默认 `<skip/>`。触发类型为 `followUp`（地址分类器的 `yes`），或为未显式 @提及角色的 `reply`（Discord 回复自带的隐式提醒不算）时，代替 `reply.md` 作为任务文本。提及、带 @提及的回复和名字呼叫仍使用 `reply.md`。文件缺失或为空时回退到 `reply.md` | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `interject.md` / `initiate.md` | 是 | 任务：插入正在进行的对话 / 在沉寂的频道中发起话题。代码在 `deadAfterMinutes` 的沉默后掷 `spontaneous.initiateChance`，因此 initiate 提示默认发言，`<skip/>` 用于新话题明显不合适的频道。频道沉寂后，即使角色自己的消息是最后一条，initiate 回合仍可触发 | `{{name}}` |
| `forced.md` | 否 | 强制回合（`/nep talk interject`、`/nep talk initiate`）时追加在模式提示之后。覆盖默认的 `<skip/>` 选项 | `{{name}}` |
| `memory.md` | 是 | 角色外提示，用于流分析器（单阶段模式和私有批次）：从实时批次中对记忆进行针对性编辑 | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` `{{relationshipChars}}` |
| `memory-decide.md` | 否 | 两阶段分析器的阶段 A（`features.memoryTwoStage`）：对变更的中性判定。与 `memory.md` 相同的输入块。返回 JSON。文件缺失时回退到单阶段模式 | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` `{{relationshipChars}}` |
| `memory-voice.md` | 否 | 两阶段分析器的阶段 B：角色用自己的声音撰写排队的条目。返回 JSON。`features.memoryTwoStage` 开启时必需。重试时，可选的 `<over_limit>` 块列出前次回答超出限制的条目 | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{relationshipChars}}` `{{learnedChars}}` |
| `portrait.md` | 否 | 两阶段画像刷新的阶段 A。重试时，可选的 `<over_limit>` 块列出前次回答超出限制的字段 | `{{name}}` `{{fieldChars}}` |
| `profile.md` | 是 | 预热 / 画像刷新：从消息样本生成一个成员的档案。重试时，可选的 `<over_limit>` 块列出前次回答超出限制的字段 | `{{name}}` `{{fieldChars}}` `{{maxInterests}}` `{{maxDetails}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{maxNewEpisodes}}` |
| `channel.md` | 是 | 预热和笔记刷新：从消息样本生成频道笔记。刷新时，可选的 `<existing_notes>` 块包含已存储笔记作为待评估的主张（而非证据）。重试时，可选的 `<over_limit>` 块列出前次回答超出限制的字段 | `{{fieldChars}}` |
| `server.md` | 是 | 预热和笔记刷新：从频道笔记和成员摘要生成服务器级笔记。刷新时，可选的 `<existing_notes>` 块包含已存储笔记作为待评估的主张。重试时，可选的 `<over_limit>` 块列出前次回答超出限制的字段 | `{{fieldChars}}` `{{maxInjokes}}` `{{loreTextChars}}` |
| `describe.md` | 是 | 角色外提示，用于媒体描述器（`features.mediaDescriptions`）：输入一张图片，输出一行描述：图中内容、可辨认的文字，使用聊天所用的语言。无评论，无 markdown | 无 |
| `describe-video.md` | 是 | 角色外提示，用于视频描述器（`features.videoDescriptions`）：输入一个视频片段（含声音），输出可配置长度的完整有序描述：谁出现了、说了什么（关键短语引用）、屏幕上的文字、视觉上发生了什么、音乐/音效。不接收角色卡 | `{{maxChars}}` |
| `describe-gif.md` | 否 | 角色外提示，用于 GIF 描述器（`media.gif.watch`）：输入一段短无声片段，输出三行标注结果：`reaction`（回复功能，数词或 `none`）、`action`（可见动作，受 `{{maxChars}}` 限制）、`text`（屏幕文字原样引用或 `none`）。始终英语。不接收角色卡。不存在时代码回退到 `describe-video.md` | `{{today}}` `{{maxChars}}` `{{seconds}}` |
| `rewatch.md` | 是 | 分类器：角色是否需要重看视频、重试未加载的视频或再看一次图片（`features.videoRewatch`、`features.imageRelook`）。接收带类型和状态的编号近期媒体列表（视频和图片）和新消息。输出为一行：`<number> \| <question>`、`<number> \| retry` 或 `none` | `{{name}}` |
| `rewatch-answer.md` | 是 | 角色外提示，用于二次查看回答：视觉或视频模型再次查看该项目并回答一个问题。类型无关（同时服务于视频和图片）。不接收角色卡 | `{{today}}` `{{question}}` `{{maxChars}}` |
| `address.md` | 是 | 分类器：未标记的消息是否在对角色说话、在谈论角色还是两者都不是。输出为一个词：`yes`、`overheard` 或 `no` | `{{name}}` |
| `overheard.md` | 否 | 任务：消息在谈论角色，而不是在对角色说话。触发类型为 `overheard` 且文件存在且非空时，代替模式提示使用；文件缺失或为空时回退到模式提示（降级） | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `lookup.md` | 否 | 分类器：角色是否需要查询某些内容（`features.webLookup`、`features.recall`）。接收一段短对话记录和一个 `<candidate>` 块。输出为 `none`，或最多四行标注行：`web:` 网络查询，`server:` 在服务器消息中搜索的词形，`who:` 找人的名称词形，`when:` 日期范围。单行无标注仍被读取为网络查询 | `{{name}}` `{{today}}` |
| `recall-summary.md` | 否 | 角色外提示，用于 recall 摘要（`features.recall`）：读取服务器搜索找到的旧聊天片段并回答问题，可选择指出一段供角色逐字看到的原文。不接收角色卡 | `{{name}}` `{{answerChars}}` |
| `room.md` | 否 | 分类器：这条消息是面向所有人还是面向特定人（`spontaneous.roomQuestionChance`）。接收一段短对话记录、作者的别名和一个 `<candidate>` 块。输出为一个词：`yes` 或 `no` | `{{name}}` |
| `route-channel.md` | 否 | 分类器：回答这条消息是否需要角色看另一个频道（`features.channelRoute`）。接收一段短对话记录、一个 `<channels>` 列表和一个 `<candidate>` 块。输出为一行：列表中的一个编号或 `none` | `{{name}}` |
| `elsewhere.md` | 否 | 任务：角色读了一个无法发言的频道，可以在主频道评论（`features.elsewhere`）。用作 noticed 回合的任务文本。`<skip/>` 是正常结果 | `{{name}}` `{{channel}}` `{{destination}}` |
| `read-link.md` | 否 | 角色外提示，用于链接阅读器（`features.webLookup`，`web.links.enabled`）：将获取的页面浓缩为一个段落。接收页面标题和正文。不接收角色卡 | `{{today}}` `{{maxChars}}` |
| `search-summary.md` | 否 | 角色外提示，用于搜索浓缩器（`features.webLookup`，`web.search.enabled`）：将编号的搜索结果浓缩为带内联来源的笔记。不接收角色卡 | `{{today}}` `{{query}}` `{{maxChars}}` |
| `private.md` | 否 | 追加在模式提示（`reply.md`）之后、`forced.md` 之前，仅在 DM 中使用（`features.privateMessages`）。这是一段私聊：此处所说的一切留在此处；角色保留其公共知识。文件不存在则不追加任何内容 | `{{name}}` `{{author}}` |
| `diary.md` | 是 | 任务：写日记帖子。角色自己的频道，无人请求。计划的种类和概要、过去的帖子、可选的世界和搜索结果在用户消息块中。输出：`<msg>`（1 至 `diary.maxMessages`）、`<draw>` 或 `<skip/>`；`<react>` 和 `<gif>` 被丢弃。无回复属性，无链接 | `{{name}}` |
| `diary-plan.md` | 是 | 计划器：选择种类、概要、是否搜索和绘画。在 `classifier.text` 上运行，无角色卡。接收 `<now>`、`<server>`、`<about_chat>`、`<recent>`、`<lore>`、`<world>`、`<diary>`、`<kinds>`、`<seeds>`、`<topic>`。回答一个 JSON 对象 | `{{name}}` |
| `world.md` | 否 | 角色的虚拟世界：聊天之外的场所和日常。仅在日记的计划和生成请求中渲染为 `<world>` 块，且仅当 `diary.world === true`。普通回合中不使用。无文件或开关关闭则无块 | `{{name}}` |
| `diary-seeds.md` | 否 | 日记计划器的随机种子族。`# name` 标题开始一个族；代码从每族选一行，组成 `diary.seedSets` 个组合。文件不存在或 `seedSets` = 0 时省略 | 无 |
| `draw.md` | 是 | 绘画子进程的角色外提示（`features.imageGeneration`）：根据场景描述生成一张图片。仅接收外貌和请求，不接收角色卡 | `{{name}}` `{{appearance}}` `{{request}}` `{{when}}` |
| `appearance.md` | 否 | 角色的视觉外貌，在 `self="yes"` 时插入 `draw.md`。一段话，无性格，无背景故事 | `{{name}}` |
| `gif-pick.md` | 否 | 分类器：从库中挑选 GIF 替代短文本回复（`features.gifPicker`）。接收最近 `gifs.pick.contextMessages` 行聊天（标明所回复的消息）、角色的回复及带说明的完整库。长度门槛为 `gifs.pick.maxChars`（默认 160）；多条发出消息时仅替换第一条。输出为库中的一个 handle 或 `none`。不接收角色卡 | `{{name}}` |
| `split.md` | 否 | 分类器：直接呼叫是否包含多个独立请求（`features.splitTasks`）。接收一段短 `<transcript>` 和新消息作为 `<candidate>`。输出为 `one`，或 2 到 `{{maxTasks}}` 行，每行以 `- ` 开头，用作者自己的话表述一个部分。不接收角色卡。没有此文件时分拆器关闭 | `{{name}}` `{{maxTasks}}` |
| `merge.md` | 否 | 分类器：已有等候条目的作者的新消息是否属于其中一个。接收编号的 `<waiting>` 列表和新消息作为 `<candidate>`。输出为一行：列表中的一个编号或 `new`。不接收角色卡。没有此文件时新呼叫始终作为独立条目排队 | `{{name}}` |
| `labels.json` | 是 | 代码插入提示中的所有字符串。键在下方固定，值由编写者决定 | 见下文 |

`{{name}}` 机器人的显示名称 · `{{author}}` 呼叫者的显示名称 · `{{trigger}}` `labels.triggers.*` 之一 ·
`{{target}}` 呼叫消息的索引（`#87`）。
`{{today}}` 在 `lookup.md` 中为 `bot.timezone` 中的日期；在描述器（`describe.md`、`describe-video.md`、`describe-gif.md`）和 `search-summary.md` 中为 UTC 日期。
系统消息 = `system-prompt` + `character-card` + `rules` + `format`。分析器则单独使用 `memory.md`。
在强制回合（`/nep talk interject`、`/nep talk initiate`）中，如果 `forced.md` 存在，则追加在模式提示之后。
在 `overheard` 回合中，`overheard.md` 替代模式提示（它是任务文本本身，而非追加）。当 `overheard.md` 缺失或为空时，使用模式提示代替（降级：模式提示将消息描述为对角色说话，与实际不符）。
在私聊中，`private.md` 追加在模式提示之后（`forced.md` 之前），使用相同的 `{{name}}` 和 `{{author}}` 占位符。
分析器和预热的 `profile.md`、`server.md` 在用户消息中以 `<character>` 块接收角色卡和 `rules.md`。
`channel.md`、`describe.md`、`describe-video.md`、`describe-gif.md`、`draw.md`、`rewatch.md`、`rewatch-answer.md`、`address.md`、`lookup.md`、`read-link.md`、`search-summary.md`、`recall-summary.md`、`room.md`、`route-channel.md` 和 `elsewhere.md` 不接收角色卡。

`{{guildFieldChars}}` 等于 `fieldChars * 2`，是代码对服务器级规律和开场白进行截断的上限。
`{{maxEpisodes}}` 是每人保留的回忆总数上限。两者均从配置填充，但默认提示未使用；自定义的 `memory.md`
可引用它们。

## 块

用户消息的各个块。空块省略；顺序如下表所列。

| 块 | 内容 |
|---|---|
| `<now>` | 日期、星期、`config.bot.timezone` 中的时间，使用 `labels.locale` 格式化 |
| `<senses>` | 角色此刻能感知和不能感知的内容，根据实时配置生成：哪些图片由角色自己看到，哪些通过辅助描述获得，对什么视而不见、听而不闻。使角色不会假装看过视频，并能用自己的语气开玩笑 |
| `<emoji>` | 角色可以使用的自定义表情（`features.customEmoji`）：最多 `context.customEmoji.max` 条，按成员使用率排名。每条包含 `:name:` 和辅助已缓存的说明。当 `labels.emoji.seenInChat` 存在时，出现在对话记录、拉取频道或相邻频道中但不在排名列表内的已描述自定义表情会列在该小标题下；对话记录行中所有自定义表情保留为裸 `:name:`。没有该标签（或没有该块）时，行内标签 `transcript.emojiDescribed` 照旧使用 |
| `<gifs>` | 角色可以发送的 GIF（`features.gifs`）：最多 `gifs.max`（默认 40）条，按近期加权使用排名。每条包含 handle（`g1`、`g2`、…）和描述器缓存的三个字段（如有）：反应标签（受 `gifs.reactionChars` 限制，默认 40）、可见动作（受 `gifs.actionChars` 限制，默认 70）和屏幕文字。有字段的条目通过 `labels.gifs.entryFields`（`{id}`、`{reaction}`、`{action}`、`{text}`；代码去除空字段及其分隔符）渲染；无字段的条目使用 `labels.gifs.entry`（`{id}`、`{text}`），说明在词边界截断。每条还记录角色自己的发送时间和次数（`ownLast`、`ownUses`）；在 `gifs.ownMarkHours`（默认 24；`0` = 关）内发送的条目带有 `gifs.ownMark` 和简短的相对时间 |
| `<about_chat>` | 人们在这里如何交谈，如何发起和插入对话，内部梗，人们教给角色的东西 |
| `<server>` | 当前频道的完整信息（Discord 分类和话题、用途、人们写什么、氛围、活跃度、最后一条消息、最活跃作者；以 `labels.server.currentMark` 标记），加上仅限本轮向 `<other_channels>` 提供了消息的相邻频道；不包含其他频道 |
| `<lore>` | 关键词出现在近期消息中的服务器世界书条目（加上标记为 always 的条目）：事件、常驻角色、长期故事。如同世界书：可存在数百个，仅显示相关的少数 |
| `<self_facts>` | 角色声称过的关于自身的事实 |
| `<recent>` | 服务器最近 `memory.recentHours`（默认 72）小时内发生的事情：分析器写入的近期记事（短事件）和成员的窗口内回忆（按引用显示）。记事仅来自本轮自身的频道或此处所有人都能阅读的频道；私聊中仅来自所有服务器成员都能阅读的频道，不含回忆。本轮提及的人的条目排在前面；已在 `<people>` 中渲染的回忆不再出现，每人最多 2 条。从最旧到最新。标题无条目则不渲染。开关 `features.recent`（缺失 = 开）；上限 `context.caps.recent`（默认 1200） |
| `<people>` | 成员档案；呼叫者排首位，以 `labels.profile.interlocutorMark` 标记（`overheard` 回合中省略：作者在谈论角色而非对角色说话）；每个档案包含角色的态度，其后跟最多 `relationships.shownMoves` 条形成该态度的变动（按绝对变动量从大到小，块内从旧到新，正负均保留（如两者都有），不重复当前原因），呼叫者还包含**回忆**：角色记住的关于两人之间的时刻，附带日期和简短引用 |
| `<attitudes>` | 角色感受最强烈的前 `context.attitudes`（默认 6，`0` = 关）名成员，按态度评分绝对值排序，好感与反感混合。跳过呼叫者以及已在 `<people>` 中显示的成员。每人一行（`labels.attitudes.line`）：名字和态度区间。标题：`labels.attitudes.header`。上限 `context.caps.attitudes`（默认 400）。服务器回合和私聊中均显示 |
| `<other_channels>` | 每个相邻频道最多 `context.neighborMessages` 条消息，不超过 `context.neighborMaxAgeMinutes` 的时效。`features.mediaDescriptions` 开启时，相邻频道行中的图片在描述器缓存已有说明时携带说明；不为相邻频道发起新的描述请求。`<channel_view>` 中已显示其块的频道不再出现在 `<other_channels>` 中；如果预算丢弃了拉取的块，该频道重新作为普通相邻频道出现 |
| `<channel_view>` | 拉入本轮的另一个频道（`features.channelPull`）。每个拉取的频道一个条目：标题行（`labels.pull.header`）、适用时的只读标记（`labels.server.readOnly`）、窗口被截断时的"更早的未显示"行、"图片未查看"计数、角色的早期呼叫（带已回复/未回复/已跳过标记），然后是窗口行。行使用与 `<chat>` 相同的对话记录格式，但编号在对话后继续（对话为 `#1`..`#N`，拉取块从 `#N+1` 开始），因此每个 `#n` 在块间唯一。图片仅以说明或盲标签形式出现，不作为附加图片。没有 `labels.pull.header` 时块为空 |
| `<lookup>` | 角色本轮查询的内容。网络搜索（`features.webLookup`）携带 `labels.lookup.webHeader`、浓缩的答案、`labels.lookup.sources`，未找到时为 `labels.lookup.none`。服务器搜索（`features.recall`）携带 `labels.lookup.serverHeader`、摘要笔记，摘要指出一段时还有逐字原文。两者都运行时 `labels.lookup.bothNote` 位于两部分之间。`labels.lookup.stretch` 行引入一段逐字原文（`{date}` `{channel}`）。仅在搜索分类器触发且至少一项搜索完成后出现 |
| `<chat>` | 当前频道最新的 `context.channelMessages` 条消息。发出已满 `context.ageAfterMinutes`（默认 60）分钟的行还会显示距今多久（`transcript.timeAged`）。`context.fetchReplyParents` 开启时，触发消息和窗口末尾 `context.replyParentsFor` 条回复早于窗口之消息的行的父消息会被拉取并作为普通对话记录行放在窗口之前；触发消息的父消息还可拉取其自身的父消息。每轮最多 `context.replyParentsMax` 条。间隔标记和日期标题覆盖时间跳跃；回复行通过 `transcript.replyTo` 引用父消息；父消息的媒体与其他行同样处理，缓存的描述免费提供。已删除或不可访问的父消息被跳过并记录为 `collect: parent missing` |
| `<tempo>` | 10 分钟 / 1 小时 / 1 天的消息计数，不同人数，沉默时长，一个判定（活跃 / 缓慢 / 沉寂） |
| `<world>` | 角色的虚拟世界（`prompts/world.md`，`{{name}}` 已填充）。仅在日记帖子（`mode === 'diary'`）且 `diary.world === true` 时出现。预算压力下整体丢弃。无文件或开关关闭则不添加 |
| `<diary>` | 过去的日记帖子，从旧到新：`labels.diary.intro`，然后每篇帖子一行 `labels.diary.line`。在计划和生成请求中均展示。预算压力下最旧的行先被截断 |
| `<plan>` | 本篇日记帖子的计划：`labels.diary.plan`，然后一行 JSON `{"kind","brief","picture"}`，拥有者通过 `/nep diary post` 指定时附带 `"topic"`。不会被截断 |
| `<found>` | 日记搜索结果：`labels.diary.found`，然后搜索结果文本。仅在计划请求了搜索且有结果时出现。预算中紧随 `<lookup>` 之后 |
| `<kinds>` | 帖子种类与权重和使用次数：`labels.diary.kinds`，然后每个正权重种类一行 `labels.diary.kindLine`; 帖子无法包含图片时，`diary.pictureKinds` 中的种类被排除。不会被截断 |
| `<seeds>` | 随机种子组合：`labels.diary.seeds`，然后每组一行 `- a; b; c`。仅在计划请求中。文件不存在或 `diary.seedSets` = 0 时省略。不会被截断 |
| `<topic>` | 拥有者的强制帖子主题（`/nep diary post [kind] [topic]`）：`labels.diary.topic`，然后主题一行，最多 1000 个字符。仅在计划请求中，紧随 `<seeds>` 之后，仅当指定了主题时出现。不会被截断 |
| `<task>` | `reply` / `follow-up`（当 `follow-up.md` 存在时，用于 `followUp` 和未带 @提及的 `reply`）/ `interject` / `initiate` / `overheard`（当 `overheard.md` 存在时）/ `elsewhere`（当 `elsewhere.md` 存在时，用于 noticed 评论）/ `diary`（当 `diary.md` 存在时，用于日记帖子），占位符已填充。模式提示之后，当条件满足时最多追加三个 `task.*` 标签（各以空行分隔）：回合回答分拆消息的一个部分时为 `task.part`，或触发作者有其他呼叫等候时为 `task.queued`；频道中其他成员有呼叫等候时为 `task.queuedOthers`；稍后的消息被折叠进此呼叫时为 `task.added`。参见下方 `labels.task.*` |

预算优先级（区块从此列表的底部开始裁剪）：系统提示 + 任务 + 时钟 + 节奏 + 感知
（永不裁剪）-> 呼叫者的档案含回忆 -> 查询结果（整体保留或丢弃；可包含网络部分、服务器部分或两者）-> 聊天习惯 -> 自述事实 -> 世界书 -> 服务器 -> 对话记录（最新优先）->
拉取的频道（`<channel_view>`，上限 `context.caps.pulled`；回答只读频道呼叫的回合中拉取块在对话记录之前而非之后）->
近期记事（上限 `context.caps.recent`）->
其他档案 -> attitudes（上限 `context.caps.attitudes`）->
仅日记模式：`<found>`（紧随 `<lookup>` 之后）、`<world>`（整体，attitudes 之后）、`<diary>`（最旧的行先被截断）、`<plan>` + `<kinds>` + `<seeds>` + `<topic>`（不会被截断）->
相邻频道 -> 表情符号（从底部删除条目，然后删除整个块；`context.caps.emoji`）-> GIF（同样的裁剪；`context.caps.gifs`）。

GIF 挑选器（`features.gifPicker`，默认开启）。当角色写了一条短回复（不超过 `gifs.pick.maxChars` 个字符，默认 160）且自己没选 GIF 时，分类器（`classifier.text`，purpose `gif-pick`，`gifs.pick.maxOutputTokens` 60，提示 `prompts/gif-pick.md`）接收最近 `gifs.pick.contextMessages`（默认 4）行聊天（标明所回复的消息）、角色的第一条消息及带说明的完整库（每条记录附说明，角色最近发送过的附自用标记）。分类器返回一个 handle 或 `none`。返回 handle 时 GIF 替换第一条发出消息并以其原本的回复方式发送；其余消息按原顺序跟随。GIF 发送失败时，所有消息照常发布。分类器在第一条消息的打字模拟期间运行；每日 GIF 限额 `gifs.maxPerDay` 生效。日志：`gifs: picked`（handle true/false，库大小）或 `gifs: pick failed`。

对话记录行中的媒体，使用可用的最具信息量的形式：附加在当前请求上的图片 →
`transcript.imageAttached`（按图片在文本后的顺序编号）；已描述的 →
`imageDescribed` / `gifDescribed` / `videoDescribed`；其他情况使用盲形式 `image` / `gif` / `video`。
当视频视觉开启时（`features.mediaDescriptions` 和 `features.videoDescriptions` 同时启用），视频或视频站点链接
会获得一个状态：`videoWatched`（亲自观看，看到并听到）、`videoNotWatchedFrame`（未观看但静帧已描述）或
`videoNotWatched`（未观看，无帧）。原因代码（`length` / `size` / `daily` / `error` / `pending`）在进入对话记录前会被替换
为 `transcript.videoReason.*` 中的人类可读短语。链接保留其基础标签（`link` / `linkText`）并添加视频附加标签：
`linkWatched`、`linkNotWatchedFrame` 或 `linkNotWatched`。当静帧作为图片附加时，还会添加 `frameAttached`。
链接使用 `link` / `linkText`，取自 Discord 的嵌入（站点、标题、摘要）；当 `features.webLookup` 开启且链接已被阅读时，`linkRead` 追加在链接的其他附加标签（视频、缩略图）之后。文本文件通过 `filePreview` 显示开头
内容；转发消息用 `forwarded` 包裹。当 `features.seeReactions` 开启（默认）时，反应标签追加在行的
最末尾，位于媒体标签和转发包裹之后。每条消息最多列出 `context.reactionsPerMessage` 个反应，按频率降序排列；
每个条目使用 `transcript.reactionItem` 或 `transcript.reactionMine`（当角色是反应者之一时），以 ", " 连接
并包裹在 `transcript.reactions` 中。缺少 `transcript.reactions` 键的标签文件不渲染任何内容。

视频结果按附件或链接缓存在 `data/guilds/<id>/media.json` 中，键为 `video:<itemId>`（附件 id 或链接 URL 的稳定
哈希）。缓存条目：

- 已观看：`{ text, ts, watched: true }`：永久，摘要文本。
- 限制未命中（时长或大小）：`{ miss: true, ts, reason: "length"|"size" }`：永久，文件不会改变。
- 错误未命中：`{ miss: true, ts, reason: "error" }`：`media.video.errorRetryMinutes`（默认 60）分钟后重试，或在重看分类器发出强制重试时立即重试。
- 每日上限：不缓存；仅在该回合返回 `{ state: "limit", reason: "daily" }`。

重看回答缓存在键 `video:<itemId>:q:<hash>`（问题小写化并合并空白后 SHA-1 的前 16 位十六进制数字）下：`{ text, ts, answer: true }`。一小时后过期；代码在读取时删除过期条目。

图片的静帧条目保留其自身的 `<itemId>` 键。同一个条目可以同时存在两者。

已观看的 GIF 缓存在 GIF 自身的 `<itemId>` 键下（无 `video:` 前缀）：`{ text, reaction, action, screen, ts, watched: true, gif: true }`；`text` 为一行动作描述（无动作行时为反应或屏幕文字）。四个字段完整存储，仅受 `media.descriptionChars` 限制。截断在字段显示处生效，即 `<gifs>` 列表和库 GIF 的对话记录行（`transcript.gifKnownFields`）：`gifs.reactionChars` 截断 `reaction` 和 `screen`，`gifs.actionChars` 截断 `action` 和旧格式的一行说明；`0` = 不截断。单帧说明存储为 `{ text, ts, gif: true }`（尝试观看失败时附加 `watchFailed`）。两者与图片描述位于同一缓存中。

网络查询结果缓存在同一个 `data/guilds/<id>/media.json` 中，与视频和图片条目并列：

- 链接阅读：`read:<link.id>` 保存 `{ text, ts }`（浓缩摘要，永久）或 `{ miss, ts, reason }`（未命中跳过 6 小时；原因：`scheme`、`private`、`redirects`、`type`、`size`、`timeout`、`http`、`network`、`empty`、`unreadable`、`llm`）。`TokenLimitError` 或 `DailyCapError` 不缓存。
- 搜索：`search:<规范化查询 SHA-1 前缀，16 位十六进制>` 保存 `{ query, text, sources, ts }`，在 `web.search.cacheHours`（默认 24）小时内从缓存提供。空 `text` 表示无结果（渲染 `labels.lookup.none`）。失败不缓存。

对话记录行：`#87 [14:32] nick: text <replyTo> <media…> <sticker> <reactions>`；角色自身的行使用 `labels.self`；行间使用
`labels.transcript.gap` / `gapWithDate` / `date`；区块以 `labels.transcript.header` 开头。相邻频道：相同的行
格式但不含 `#n`，位于 `# channel-name` 之下。按请求时刻（与 `<now>` 相同）计算，发出已满 `context.ageAfterMinutes`（默认 60）
分钟的行，其时间部分通过 `labels.transcript.timeAged` 渲染：`#87 [14:32 · 2 h 58 min ago] nick: text …`。只有 `<chat>`、
`<channel_view>` 和 `<other_channels>` 的行显示距今时间，每次请求重新计算，从不存储；其他对话记录（分类器、服务器搜索的
逐字原文、分析器、预热）只显示时间。

## 标签

`labels.json` 的键；`{x}` 由代码填充。

```
locale                                   BCP-47 tag for dates
ping.prompt                              the user message of a model reachability probe; must make any model answer one short word. No longer used by any command
self                                     {name}
units.lessThanMinute | minute | hour | day
transcript.gap                           {duration}: 相隔至少 `context.gapMarkerMinutes` 分钟的两条相邻行之间的时间；措辞不能让人把它当成消息的距今时间
transcript.gapWithDate                   {duration} {date}: 同上，两行之间跨日时使用；date 是下方那一行的日期
transcript.date | header                 {date}
transcript.timeAged                      {clock} {age}: 替换发出已满 `context.ageAfterMinutes` 分钟的行的整个方括号时间；age 是以 `labels.units` 表示的时长；较新的行保持 `[{clock}]`；键缺失或为空时不显示距今时间
transcript.empty | replyToOld | image
transcript.replyTo                       {index} {author} {quote}: 父消息的编号、其作者（父消息为角色自己的时使用 self 标签）和父文本的引用（在词边界截断至 `context.replyQuoteChars`（默认 80；`0` = 完整）；仅含媒体的父消息引用其媒体标签）
transcript.file | sticker                {name}
transcript.stickerDescribed              {name} {text}
transcript.emojiDescribed                {name} {text}: 已描述自定义表情的行内标签，附加在聊天行上。仅在 `<emoji>` 块不存在或 `labels.emoji.seenInChat` 未设置时使用；有 `seenInChat` 时行中保留裸 `:name:`，描述移至块中
transcript.imageAttached                 {n}: this picture is attached to the request, the persona sees it
transcript.imageDescribed                {text}
transcript.gif                           {name}
transcript.gifDescribed                  {text}
transcript.gifKnown                      {id} {text}: a GIF that is in the library; id is its handle, text is the caption
transcript.gifKnownFields                {id} {reaction} {action} {screen}: 缓存中有反应或屏幕文字的库 GIF，替代 gifKnown 使用；字段由 gifs.reactionChars / gifs.actionChars 按 gifs.entryFields 同样方式截断；代码去除空字段及其分隔符；键置空时回退到 gifKnown
transcript.gifKnownNoText                {id} {name}: a library GIF without a caption; id is the handle, name is the file or link name
transcript.video                         {name} {duration}
transcript.videoDescribed                {name} {duration} {text}: text describes ONE frame
transcript.videoWatched                  {name} {duration} {text}: first-hand, the persona saw and heard the clip
transcript.videoNotWatched               {name} {duration} {reason}: reason is the human phrase from videoReason.*
transcript.videoNotWatchedFrame          {name} {duration} {reason} {text}: not watched but a still frame was described
transcript.videoAnswered                {question} {text}: extra tag after a watched video tag; the persona re-watched the clip for this question
transcript.imageAnswered                {question} {text}: extra tag under the picture's line; the persona looked at the picture again for this question
transcript.videoReason.length | size | daily | error | pending    human phrases for the five reason codes; pending = the clip was still loading when the request went out
transcript.linkWatched                   {text}: extra tag after a link tag, first-hand video summary
transcript.linkNotWatched                {reason}: extra tag after a link tag, not watched with reason
transcript.linkNotWatchedFrame           {reason} {text}: extra tag after a link tag, not watched but preview described
transcript.voice                         {duration}
transcript.audio                         {name} {duration}
transcript.link                          {site} {title}
transcript.linkText                      {site} {title} {text}
transcript.linkRead                      {text}: extra tag after a link tag; the page was fetched and condensed, first-hand
transcript.thumbnailDescribed            {text}: follows a link tag; describes the link's preview picture
transcript.filePreview                   {name} {text}
transcript.forwarded                     {text}
transcript.forwardedFrom                 {channel} {text}: used when the source channel is known; falls back to `forwarded`
transcript.frameAttached                 {n}: follows a video/gif item whose still frame is attached picture n
transcript.reactions                     OPTIONAL {list}: appended at the end of a line after all media and forwarded tags; list is items joined with ", ". A labels file without this key renders nothing
transcript.reactionItem                  {emoji} {count}: one reaction; emoji is unicode or :name: for custom
transcript.reactionMine                  {emoji} {count}: used instead of reactionItem when the persona is among the reactors; reads correctly whether count is 1 or more
transcript.unknownDuration               shown in place of {duration} when Discord gave none
senses.imageSee | imageDescribed | imageBlind        one line each; code picks the ones true under the live config
senses.gifWatched | gifDescribed | gifBlind   gifWatched replaces gifDescribed when media.gif.watch is on (needs video vision on and a describe-gif or describe-video prompt); a labels file without gifWatched falls back to gifDescribed. Both say GIF descriptions come from a helper (second-hand); without a description the persona does not infer the content
senses.videoDescribed | videoBlind
senses.videoWatch                        replaces videoDescribed when features.videoDescriptions is on (needs mediaDescriptions too); covers watched, still frame and not-watched states
senses.videoRewatch                      shown alongside videoWatch when features.videoRewatch is on; tells the persona that a second look at a watched video may appear, marked as first-hand
senses.stickerSee | stickerDescribed | stickerBlind
senses.lottie
senses.voice | links | files
senses.linksWatch                        replaces links when features.videoDescriptions is on; adds that a linked video may come watched or not watched with the reason
senses.linksRead                         shown after the links line when features.webLookup is on and web.links.enabled is not false; tells the persona that a link may come with a read excerpt, first-hand
senses.search                            shown when features.webLookup is on, web.search.enabled is not false AND a Brave Search key is configured; tells the persona that a `<lookup>` block may appear with web results
senses.recall                            shown right after the search line when the server-history search is available: on every server turn, and in a private chat when `features.privateLikeServer` is on (the default). Tells the persona that a search of the server's old messages either ran before the reply or did not, that its part of `<lookup>` is what the history holds (a helper's summary or a verbatim stretch), and that without it nothing was looked up there. An older labels file without the key renders nothing
senses.customEmoji                       shown when features.customEmoji is on and the server has at least one custom emoji; tells the persona they can use server custom emoji by writing :name:
senses.gifs                              shown when features.gifs is on and the library is not empty; tells the persona they can post one GIF per turn by handle from the list or transcript; entries give the reaction, visible action and on-screen text; recent-use marks show own posts; only listed or transcript handles; unknown handle posts nothing
senses.diary                             {channel}: 当 `diary.channelId` 已设置且 `features.diary` 不为 false 时显示。告知角色在该频道写日记
senses.draw                              shown when features.imageGeneration is on and an image client is wired; tells the persona they can draw
senses.drawSpent                         replaces draw when the daily picture quota is spent
senses.drawSpentUser                     replaces draw when this member's daily quota is spent
senses.privateChat                       shown in a DM turn: this is a one-on-one conversation, what is said here stays between the two of them
senses.privateAware                      shown on a server turn when features.privateMessages is on: the persona knows they have private chats and never repeats or hints at anything from them
senses.time                              显示在每个 `<senses>` 块中 files 行之后，私聊也包括：消息时间与 `<now>` 同一时区，较旧的行带有距今时间，间隔标记只是两条相邻行之间的沉默；某件事发生在多久以前取自它自己的行，绝不取自间隔标记或 `<tempo>`。无占位符；键缺失或为空时不渲染
lookup.header                            {query}: heading of the `<lookup>` block (web search)
lookup.sources                           {list}: site names, comma-separated by code
lookup.none                              shown in `<lookup>` when the search found nothing useful
lookup.webHeader                         heading of the web part inside `<lookup>` when both web and server searches ran
lookup.serverHeader                      heading of the server part inside `<lookup>` when both web and server searches ran
lookup.bothNote                          shown between the web and server parts when both ran
lookup.stretch                           {date} {channel}: introduces a verbatim stretch of old chat inside the server part
tempo.counts                             {last10min} {lastHour} {lastDay}
tempo.authors                            {authors}: a head count
tempo.silenceBeforeTrigger | lastMessageAgo | sinceOwn          {duration}
tempo.emptyChannel | ownUnanswered
tempo.verdict                            {verdict} = tempo.verdictLive | verdictSlow | verdictDead
profile.interlocutorMark                 appended to the caller's heading (starts with a space)
profile.formerNames                      {names}
profile.character | interests | style | details | relationship  {text}
profile.aliases                          {text}: what people in chat call this member (comma-separated by code)
profile.interestItem                     {topic} {note}: one interest with a note
profile.interestItemNoNote               {topic}
profile.unsureMark                       appended to an unconfirmed interest or detail (starts with a space, self-explanatory)
profile.staleMark                        appended to an interest not seen for memory.interestStaleDays (starts with a space)
profile.unknown
profile.messageCount                     {count}
profile.affinity                         {score} {band} {reason}
profile.affinityMove                     {delta} {date} {reason}: 态度历史中的一条变动；态度行后最多跟 `relationships.shownMoves` 条，按绝对变动量从大到小排列，块内按时间从旧到新，正负均保留（如两者都有），不重复当前原因
profile.episodes                         heading line above the caller's episodes
profile.episode                          {date} {what} {quote} {feeling}: one remembered moment
profile.episodeNoQuote                   {date} {what} {feeling}: the same without a quote
lore.entry                               {title} {text}
emoji.header                             自定义表情列表的引言
emoji.entry                              {name} {text}: 带说明的表情一条
emoji.entryNoText                        {name}: 无说明的表情一条
emoji.seenInChat                         出现在对话记录中但不在排名列表内的已描述自定义表情之前的小标题。缺少此标签时保留行内的 `transcript.emojiDescribed` 标签
gifs.header                              GIF 库列表的引言：每条包含表达的回复、可见动作、屏幕文字
gifs.entry                               {id} {text}: 单行说明的 GIF 一条（无三字段描述的条目）
gifs.entryFields                         {id} {reaction} {action} {text}: 三字段说明的 GIF 一条；代码去除空字段及其分隔符
gifs.entryNoText                         {id}: 无说明的 GIF 一条
gifs.ownMark                             {ago}: appended to an entry the persona posted within gifs.ownMarkHours
affinity.bands.hostile | dislike | cool | neutral | warm | fond | devoted
                                         thresholds in code: ≤-60 · ≤-25 · ≤-8 · <8 · <25 · <60 · ≥60
affinity.ownerSet                        reason shown when the owner set a score by hand without giving one
aboutChat.patterns | starters | injokes  {text}
aboutChat.learned                        {text}: things people taught the persona, joined by `; ` by code
aboutChat.learnedItem                    {text} {who}: one lesson with a teacher
aboutChat.learnedItemNoFrom              {text}: one lesson with no known teacher
aboutChat.unsureMark                     appended to an unconfirmed learned item (starts with a space)
server.currentMark                       appended to the current channel's heading (starts with a space)
server.category | topic | purpose | topics | tone               {text}
server.activity                          {activity} = server.activityLive | activitySlow | activityDead
server.lastMessage                       {when}: humanised age of the channel's newest message
server.topWriters                        {names}: current names of the members who write there most
server.diary                             在 `<server>` 地图中日记频道上显示。角色的日记
triggers.mention | reply | name | followUp | overheard   followUp = an untagged message the address classifier judged to be for the persona; overheard = talk about the persona, not to them. Both post plain, never as a Discord reply. overheard falls back to followUp, then reply
triggers.private                         the trigger for a private (DM) message
triggers.drawFailed                      {reason}: the drawing sub-process failed; reason is the human phrase from draw.reasons.*
draw.when                                {when}: 给图像模型的本地日期和时间，使光线和季节匹配。所有绘画请求（含日记）在时间已知时填充；否则为空
draw.reasons.moderation | daily | userDaily | timeout | error    human phrases for the five failure reasons; daily and userDaily are reserved but no longer reached by triggers.drawFailed — an image cap now posts limits.notice instead of a follow-up turn
diary.intro                              `<diary>` 块的第一行
diary.line                               {date} {kind} {gist}: 一篇过去的帖子
diary.picture                            {scene}: 帖子有图片时附加到日记行
diary.pictureUnknown                     回填帖子有图片但场景未记录时的占位
diary.kindUnknown                        回填帖子种类未记录时的占位
diary.kinds                              `<kinds>` 块的第一行
diary.kindLine                           {key} {weight} {count} {window}: 一种帖子及其权重和使用次数
diary.plan                               `<plan>` 块的第一行
diary.found                              `<found>` 块的第一行
diary.seeds                              `<seeds>` 块的第一行
diary.topic                              `<topic>` 块的第一行（拥有者的强制帖子主题）
memory.privateNote                       the <private> block content in a private analyzer batch: marks the batch as a private conversation, constrains output to users for the partner's id only
memory.privateChannel                    heading used in place of a channel name for the <new_messages> section in a private batch
limits.notice                            {limit} {used} {cap}: posted as a plain reply when a rail refuses a triggered action; limit is the config key, used/cap are the numbers
limits.paused                            posted as a plain reply when the persona is called while paused (`features.pauseNotice`). No placeholders. At most once per channel per `mention.pauseNoticeMinutes`
warmup.ownMark                           prefixed to a member's own lines in the profile.md transcript
warmup.contextMark                       prefixed to context lines in the profile.md transcript
room.focus                               {target} {author}: appended to the reply task when a room question triggers the turn
address.author                           {name} {aliases}: the candidate author's display name and known aliases, shown to the address classifier when the member has aliases
recent.header                            REQUIRED {hours}: the block's first line. A missing header or a missing `recent.line` means no `<recent>` block
recent.line                              REQUIRED {date} {time} {text}: one note from the turn's own channel or an unnamed channel
recent.lineIn                            OPTIONAL {date} {time} {channel} {text}: a note from another named channel; {channel} arrives without '#'. Without it `recent.line` is used
recent.episode                           OPTIONAL {date} {name} {what}: a moment the persona remembers with {name} on {date}; no quote, no feeling. Without it the block shows notes only
attitudes.header                         the block's first line: who these members are and how to use the list
attitudes.line                           {name} {band}: one member and their attitude band
task.part                                {index} {total} {part} {others}: this turn answers one part of a split message. {index} is 1-based, {part} is the text of this part, {others} lists the remaining parts and any queued calls as numbered items joined by `; `. Without this key the splitter is off even when the prompt file exists
task.queued                              {others}: the trigger author has other calls waiting, listed as numbered items joined by `; `. Shown only when there is no `task.part` for this turn. Without this key the waiting calls are not named and the seen-in-history drop rule applies to them
task.queuedOthers                        {others}: other members have calls waiting in this channel, listed as `<n>. <author>: <text>` items joined by `; `. Without this key those calls are not named
task.added                               {added}: later messages from the author were folded into this call while it waited, joined by `; `. Without this key the folded messages are not named
```

## 输出

模型输出中只处理以下标签：

- `<think>…</think>` 可选，位于最前，1–4 行隐藏的思考过程；未闭合表示保持沉默。
- `<msg>text</msg>` 一条聊天消息，连续最多 3 条；`reply="#87"` 使其成为对对话记录中某行的 Discord 回复。
- `<react to="#87">💀</react>` 一个 unicode 表情或一个服务器自定义表情的 `:name:`；可单独使用，也可与 `<msg>` 一起使用。
- `<gif reply="#87">g12</gif>` 从库中通过 handle 发布一个 GIF（内容 = `<gifs>` 列表或对话记录中的 handle，不是 URL）。每回合一个；`reply` 可选。可与 `<msg>`、`<react>`、`<draw>` 同时出现。未知 handle = 不发布。
- `<draw self="yes" reply="#87">scene</draw>` 提交给绘画子进程的图片。每回合一个，首个非空优先，截断至 800 字符。`self="yes"` 添加角色外貌；`reply="#87"` 与 `<msg>` 用法相同。可与 `<msg>` 和 `<react>` 同时出现。
- `<skip/>` 保持沉默。
- `@nick` 与对话记录中完全一致时转换为真实的提及。
- `#频道名` 为服务器频道时，`<msg>` 文本中会转换为真实的频道链接（`<#id>`）（`features.channelLinks` 开启时，默认 true，缺失 = 开）。名称按最长匹配。已有的链接保持不变。

`features.reactions: false` 移除 `<react>`，`features.multiMessage: false` 仅保留第一个 `<msg>`；
`features.gifs: false` 或空库移除 `<gif>`；`features.imageGeneration: false` 或无图像客户端时移除 `<draw>`；`drawFailed` 回合中 `<draw>` 也被移除。提示无需知道这些。

`format.stripDashes` 开启时（默认 true；缺失 = 开；仅 `false` 关闭），`<msg>` 文本中的所有全角破折号和半角破折号在发送前被删除，破折号及其周围的空格变为一个空格，且每个尖角引号（`«`、`»`）替换为普通 `"`。清除后变空的消息不发送。连字符保留。`<draw>`、`<react>`、`<gif>` 和回复 id 不受影响。日志记录为 `turn: dashes stripped`，包含 `channel` 和 `count`，文本本身不记录。

## 分析器

一次调用（`memory.md`）更新角色记住的所有内容。它以角色的视角评判人们，因此会接收角色卡。频道是否活跃不由它判断，
由代码计数。预热通过预热提示（`profile.md`、`channel.md`、`server.md`）输入旧历史，不通过分析器。

提示中的数值限制是占位符，在运行时从 `config.memory.*` 和 `relationships.maxDeltaPerUpdate` 填充。

输入：`<character>` · `<existing_profiles>`（按用户 id 的 JSON；每个档案为完整或简要形式。完整形式包含文本字段、态度和兴趣、细节、别名、回忆的排名前列：兴趣上限 `memory.maxInterests`，细节上限 `memory.maxDetails`，别名上限 `memory.maxAliases`，回忆上限 `memory.analyzerEpisodes`（默认 8）。简要形式仅包含 `names`、`affinity` 和 `"compact": true`。当批次过大时，消息最多的作者保留完整形式，其余为简要形式。日志字段 `profilesWhole`、`profilesCompact`、`profilesTokens`，记录在 `memory: update applied` 上）· `<existing_lore>` ·
`<existing_guild>`（JSON：规律、开场白、内部梗、学到的条目；当服务器笔记待审时可包含 `"stale": { "days": n }`）· `<existing_channels>`（按频道 id 的 JSON：`name`、Discord `category`、`topic`、已存储的
`purpose`、`topics`、`tone`；条目当笔记待审时可包含 `"stale": { "days": n }`）· `<known_members>`（仅服务器批次，私聊批次不含；可能部分或完全缺失：本批次中未写入的已存储成员，各带其显示名和别名，使分析器能为其中一人记录别名；最多 `memory.aliasRosterSize` 条，按最近可见排列，`0` = 关闭；在预算中排在对话记录之前，非必需因此不会导致请求失败）· `<new_messages>` 按 `## #channel-name (id:123)` 分组，行格式为
`[14:32] nick (id:123): text`，对角色说话的行以 `→ ` 开头，角色自身的行使用 `labels.self`。

用户消息中的区块顺序（预算从底部开始裁剪）：每个作者的简要档案、名册（`<known_members>`）、对话记录（`<new_messages>`）、完整档案（仅为有显示行的作者提供，行最多的优先）、近期记事（`<recent_notes>`）。服务器、频道和世界书块在简要档案之前。无法容纳完整形式的档案以简要形式发送；请求永远不会因为档案而失败。

输出：一个裸 JSON 对象。档案以增量方式更新：分析器返回变更内容，而非对已存储内容的重新概括，因此事实
不会因为逐批重写而退化：

```
{
  "users": { "<userId>": {
      "portrait": "",                                                // OPTIONAL: one-line cue that the stored character/style misses something
      "relationship": "",                                            // OPTIONAL: present when first written or when it must change, then the whole new text
      "aliases": { "add": [""], "remove": [""] },
      "interests": { "add": [ { "topic": "", "note": "", "sure": false } ], "update": [ { "topic": "", "note": "" } ],
                     "seen": [ "topic" ], "remove": [ "topic" ] },
      "details":   { "add": [ { "text": "", "sure": false } ], "seen": [ 3 ], "remove": [ 3 ] },   // numbers = stored detail ids
                                                                                 // "sure" is OPTIONAL everywhere, default true
      "affinity":  { "delta": 0, "reason": "" },
      "episodes":  [ { "date": "YYYY-MM-DD", "what": "", "quote": "", "feeling": "", "weight": 3 } ] } },
  "guild": { "patterns": "", "starters": "", "injokes": [""],
             "learned": { "add": [{ "text": "", "from": "<@id>" }], "seen": [3], "remove": [3] } },
  "channels": { "<channelId>": { "purpose": "", "topics": "", "tone": "" } },
  "lore": [ { "title": "", "keys": [""], "text": "" } ],
  "self": [""],
  "note_reviews": [{ "target": "", "status": "" }]
}
```

- **兴趣是独立条目**，而非文本段落：`topic`（≤ `{{interestTopicChars}}`，标识，大小写不敏感地比较）和
  `note`（≤ `{{interestNoteChars}}`，具体是关于它的什么；可为空）。两个占位符分别从
  `memory.interestTopicChars` / `memory.interestNoteChars` 填充，与其他限制类似。每人最多存储
  `memory.maxInterestsStored` 个，每个有一个权重，当分析器再次添加或更新时权重增长；排名最低的最先被淘汰。输入
  中显示已存储的条目，因此分析器仅添加新的，仅在学到新内容时更新笔记，仅移除该成员已明确放弃的。
- **细节也是独立条目**：`{ id, text, weight, firstSeen, lastSeen }`。输入中显示每个已存储细节及其数字
  `id`；`seen` 和 `remove` 通过该 id 引用细节（代码也接受完全匹配的已存储文本）。`add` 接受
  `{ text, sure? }`（也接受纯字符串）。超过 `memory.maxDetailsStored` 时，排名最低的先淘汰。
- **学到的条目是服务器级的独立条目**：`{ id, text, from, weight, firstSeen, lastSeen }`。`from` 存储教导者
  （`<@id>`，或为空）。使用与细节相同的 `add` / `seen` / `remove` 操作、相同的确认机制、相同的排名和淘汰规则。
  `memory.maxLearned` 个显示，`memory.maxLearnedStored` 个保留，`memory.learnedChars` 为每个条目的字符上限。
  聊天模型在 `<about_chat>` 中内部梗行之后按排名顺序看到它们，未确认的带有 `labels.aboutChat.unsureMark` 标记。
- **确认（"(?)" 机制），兴趣、细节和学到的条目通用。**`weight` 统计一个事物被观察到的不同场合次数。新条目起始权重为
  1，或当分析器标记 `"sure": false` 时为 0（不确定属于谁、不确定是否认真的、或分析器不认识的名称）。
  `seen`（无新内容可说，但再次出现）、对已有条目的 `add` 和 `update` 各计为一次观察；仅当该成员在此批次
  中的消息距离该条目的 `lastSeen` 至少 `memory.confirmGapHours` 时，一次观察才使权重增加 1（因此一段跨
  多个批次的长对话只计一次）。对已有条目的 `"sure": false` 操作不产生任何变化。条目在权重 ≥
  `memory.confirmAfter` 时变为已确认；在此之前，聊天模型看到的条目会带有 `labels.profile.unsureMark`。
- **存储多于显示，且排名随时间衰减。**代码为每人保留最多 `memory.maxInterestsStored` /
  `memory.maxDetailsStored` 个条目；角色和分析器仅看到排名前 `memory.maxInterests` /
  `memory.maxDetails` 个。排名 = `log2(weight + 0.5) + lastSeen / halfLife`（半衰期为
  `memory.interestHalfLifeDays`、`memory.detailHalfLifeDays`），即权重随每个半衰期的沉默减半，因此频繁且
  近期的排在最前，而新条目可以在不可见的尾部积累权重而不是一出现就被淘汰。淘汰移除排名最低的。如果分析
  器 `add` 了一个已存储但未显示的条目，代码将其计为一次观察；因此提示告知分析器添加一切对它而言是新的
  内容，不要因为列表看起来满了就有所保留。
- **日期来自消息**，而非时钟：`firstSeen` / `lastSeen` 取自产生该观察的批次中该成员最新消息的时间（取
  最小值/最大值，因此乱序输入的历史仍能正常工作）。`lastSeen` 超过 `memory.interestStaleDays` 的兴趣在
  渲染给聊天模型时会带有 `labels.profile.staleMark`，并排在新鲜条目之后。细节永远不会过时。
- 已存储条目的输入视图：兴趣 `{ topic, note, seen, last }`，细节 `{ id, text, seen, last }`
  （`seen` = 权重，`last` = `YYYY-MM-DD`，未知时省略）。
- **归属，适用于每个档案字段。**某事只从该成员自身的消息中记录：他们提起了它、再次谈论它、或有实质性地
  讨论它。仅仅在场或仅回复了一次别人的话题，不构成归属。笔记只能包含关于那个话题的内容；当不确定某个
  评论属于哪个话题或哪个人时，丢弃或标记 `"sure": false`。服务器上每个人都做的事情属于 `guild.patterns`
  或 `lore`，不属于每个人的档案。
- **各个文本字段的定义。**`character`：该成员与他人互动时的表现方式，以少量（4–7 个）具体的反复出现的
  习惯表述，使用角色的声音（"习惯胜过标签"：绝不是一行形容词或评价）；技能、知识、职业、爱好和一次性
  行为不是性格。已存储的形容词/评价文本从该批次中重写，而非修补。`character`、`relationship`、态度
  `reason` 和回忆的 `feeling` 以角色卡中的角色声音撰写（可用第一人称，不用生硬术语）。`style`：该成员
  怎么写（长度、节奏、词汇、表情使用习惯），而非他们做什么或谈什么。`relationship`：三件事，仅此而已：这个人对角色而言是谁，角色对他们有何感受，他们说过什么关于角色的话以及
  角色是否喜欢。这个人对角色而言是谁，包括此人如何对待角色、为角色做了什么或与角色一起做了什么、对角色承诺了
  什么、两人彼此是什么关系。仅保留关于这三件事的明确支持的含义。去除与两人关系无关的内容：日期和时间标记、对
  第三方说的话或关于第三方的话、仅仅讨论或分享过的话题和媒体、游戏和竞赛的结果、此人自身生活的事实。不从行为
  单独推断新的角色或感受，不将单一事件概括为持久的习惯。混合句子改写以保留关于两人关系的部分，而非整句删除。
  具体事件、游戏结果和此人自身生活的事实属于 `episodes`、`details` 或 `interests`。当限制紧迫时，删除整个条目，从最不重要的
  开始。句子永远不缩短为片段。当已存储文本为空且批次显示双方有实际互动（或已有 affinity/episodes）时首次写入，
  之后仅在三件事之一发生变化或档案携带 `relationshipStale` 时返回。当档案携带 `relationshipStale` 时，文本需要
  重写：`writtenAt` 是文本写入时所处的区间（未写入时为 `none`），`now` 是当前区间（`affinity.band`），`cause`
  是以下之一：`first`（无文本，有非零分数、原因或回忆），`band`（区间越过 `relationships.bandHysteresis` 发生
  变化），`drift`（分数在同一区间内移动了 `relationships.rewriteOnDrift` 点），`moves`（自文本写入后至少有
  `relationships.rewriteAfterMoves` 条态度历史记录），或 `rewrite`（所有者设置的一次性标志；将已存储文本改写为
  该字段的范围和完整句子风格，不暗示立场变化；阶段 A 可返回空简报，语音模型仍会改写）。代码在每次写入
  `relationship` 时在档案上标记 `relationshipScore` 和 `relationshipWrittenAt`，并比较区间和漂移以检测过期。
  开关：`relationships.rewriteOnBandChange`（默认 true，缺失键 = 开），`rewriteOnDrift`（默认 8，`0` = 关），
  `rewriteAfterMoves`（默认 6，`0` = 关）。relationship 文本 ≤ `relationships.textChars`（默认 600，占位符
  `{{relationshipChars}}`）；其他文本字段 ≤ `memory.fieldChars`；缺失的字段保持已存储的文本不变。`character` 和 `style` 仅由 `profile.md`（预热和画像刷新）撰写，流
  分析器不直接编辑。分析器在批次有必要时返回 `portrait`（一行提示，指出已存储文本遗漏了什么），代码会
  排队进行刷新。
- **成员通过 id 引用，而非昵称。**昵称随时变化，因此分析器撰写的每个自由文本字段（档案文本、兴趣笔记、
  细节文本、回忆的 `what`/`feeling`、态度原因、`guild` 字段、频道笔记、世界书 `text`、`self`）中的成员
  都写作 `<@id>` 标记（id 来自对话记录的 `nick (id:123)`、`<existing_profiles>` 或 `<known_members>`）。仅在分析器确定
  所指之人时使用；否则保留原名不变；id 绝不会被编造。逐字引用的 `quote` 和世界书 `keys`/`title` 保持
  原样。代码在使用时解析标记：对聊天模型 `<@id>` 变为该成员的当前名称（与对话记录中显示的相同，因此
  `@name` 仍然有效），对分析器则变为 `name (id:123)`；在输入端，代码将模型写回的 `name (id:123)` 转回
  标记，对未知 id 保持不变。
- **别名**是人们在聊天中实际称呼某成员的方式（一个稳定的昵称，如缩写或翻译过的名字），不是 Discord
  显示名称。`users.<id>.aliases: { "add": ["…"], "remove": ["…"] }`；存储为与兴趣类似的排名条目
  （`memory.maxAliases` 个显示，`memory.maxAliasesStored` 个保留，`memory.aliasHalfLifeDays`），对已知
  别名的 `add` 视为一次观察。输入视图将它们显示为简单列表；聊天模型通过 `labels.profile.aliases`
  `{text}` 看到它们。当前名称或别名出现在近期对话记录中的成员会被拉入 `<people>`，即使他们未发言；在
  触发消息或最近五条消息中被提及的成员（通过提及、当前名称或别名、4 个字符以上名称的前缀匹配）紧随呼叫
  者之后以完整形式显示（最多 `context.askedAboutProfiles` 个），其他近期参与者以简要形式显示（名称、
  别名、性格、态度、前 5 个话题）；预算先裁剪简要形式的档案。
  对于 `<known_members>` 中的成员（名册成员），仅应用 `aliases`；回答中的其他键被丢弃并计数。名册成员不会被创建新档案（必须已存在）。对提议别名的保护（所有成员，作者和名册共同适用）：包含 `<@` 标记或 `(id:` 标记时丢弃，与成员的任一存储显示名匹配时丢弃（不区分大小写，忽略标点）。`aliases` 下的裸数组（而非 `{ add, remove }`）被读取为仅添加尚未存储的名称（不会更新已存储的别名）。名册成员别名的 `firstSeen`/`lastSeen` 日期来自批次中最新的消息，因为该成员自己未写入任何消息。
- **主频道是画像的来源。**`memory.mainChannelIds`（默认 `[]`）列出人们相互交谈的频道；在
  `<existing_channels>` 中此类频道带有 `"main": true`（否则省略此键）。`character` 和 `style` 根据该
  成员在主频道中与他人交谈的方式来判断；日记和主题频道提供兴趣和细节，而非说话方式。在该成员没有主频道
  消息期间，画像是临时的且简短的。在包含该成员主频道消息的批次中，画像刷新会细化两个字段：返回完整的
  新文本（≤ `memory.fieldChars`），保留仍然成立的内容，添加批次中展现的新内容，让较新的证据优先于较旧
  的，丢弃不再体现的特征，使画像随着时间跟随该成员变化。当没有频道被标记为主频道时，所有频道都视为主
  频道。
- **服务器级笔记是关于服务器的。**一个人在自己频道中做的事情不是 `guild` 的规律、开场白或内部梗，也不是
  `lore`；内部梗是多人都在用的东西。
- **限制不截断直接执行。**超出字符限制的散文字段不被存储：旧文本保持不变。代码从不缩短模型的改写。提示告知模型限制；代码按精确数值（码位）校验。只有空字段的首次写入才会用 `memory.clampTolerance`（默认 1.25）截断到限制，因为没有可保留的旧文本；截断落在句子或词的边界，不会截在 `<@id>` 标记中间。流分析器不重试：超出的字段从该批次的写入中排除并计数。语音模型、画像刷新和笔记刷新重试一次（当 `memory.overLimitRetries` 大于 0 时）：模型自身的回答作为助手回合返回，随后的用户回合包含 `<over_limit>` 块，列出每个超出字段的字符数和限制。第二次超出时旧文本保持不变。可见地在词中间断开的已存储笔记或文本（被旧版本截断）会在其主题下次出现时被完整重写。
- **输出精简。**`"sure"` 仅在值为 false 时写入；`affinity` 在无变化时省略。
- **每个事实只归一处。**一个事件归入 `episodes` 或 `lore`，一个事实归入 `details`，一个消遣归入
  `interests`，对角色的教导归入 `learned`；同一事物绝不写入多个字段。
- **与模型已有知识的合理性检查。**在将一个命名事物关联到另一个（一个地区、模式、角色或物品关联到一个
  游戏；一个人关联到一个作品系列）之前，分析器检查它们确实相关。当聊天的措辞与其知识冲突，或它不认识该
  事物时，不进行关联：单独记录该事物并标记 `"sure": false`。它绝不"纠正"聊天内容。
- **笔记说明该成员对这个话题做了什么**（玩、看相关视频、仅提到过），一个人很久以前做过但已放弃的事不是
  兴趣（至多是一个细节）。脱离对话上下文就无法理解的内容不予记录。
- 刻意未设：关于反讽或讽刺的任何规则。所有类型的不确定性都通过 `"sure": false` 表达。
- 分析器的提示保持简短；每增加一条规则都需要通过收紧现有文本来支付。
- 仅包含有新内容的用户和频道。返回的频道 / `guild` / `self` 是完整的合并值，替换已存储的值；空的
  `guild` / `self` = 无新内容。频道字段（purpose、topics 或 tone）的空字符串被忽略，已存储文本保持不变。
- **过时笔记复审。** 携带 `"stale": { "days": n }` 的频道或公会条目需要在顶层 `note_reviews` 数组中恰好有一个条目：`{ "target": "<channelId>" | "guild", "status": "updated" | "confirmed" | "insufficient_evidence" }`。`updated` 表示批次证实了内容变更，通过正常的 `channels` 或 `guild` 输出返回。`confirmed` 表示分析器基于本批次的相关证据检查了已存储笔记，未发现需要变更之处（批次级复审，非全周期的认证）。`insufficient_evidence` 表示批次中的相关材料太少，无法判断。代码仅在 `confirmed` 和已存储文本确实发生变化的 `updated` 上盖 `notesCheckedAt` 戳（两阶段模式中，`patterns`/`starters` 排队的语音摘要视为变更）。`insufficient_evidence`、缺失的条目和文本相同的 `updated` 不盖戳；目标在 `memory.notesRetryHours` 之后再次被标记。每次标记都会盖 `notesFlaggedAt` 戳。
- `affinity` 是一个变化量：整数 `delta`（通常 ±1…5，重大事件时最多 ±`relationships.maxDeltaPerUpdate`），
  单行 `reason` 指明观察到的事件。代码将其限制在 ±`relationships.maxDeltaPerUpdate` 范围内，累积到
  −100…100，保留简短历史。模型永远不设置绝对分数。设置 `relationships.decayPerDay` 后，分数每天向零漂移：
  每天损失 `decayPerDay * |score| * (|score| / 100) ^ decayPower`，离零越远越快；负分数同样向零回升。
  在启动时和每小时从档案上的时间戳 `affinity.decayedAt` 按整天数应用，因此停机时间会被追上。暂停期间和预热
  期间不运行。不写入态度历史条目。
- `episodes` 是追加的，永不重写：仅返回值得记忆数月的新时刻：一次冒犯、一次善意、一个承诺、一次打赌、
  一场争执、一个共同的笑话、某人要求角色做或不做的事情。`what` 一行；`quote` 当事人的原话逐字引用，简短
  （≤ 120 字符），或为空；`feeling` 角色如何看待此事，通过角色卡判断；`weight` 1–5（5 = 永不遗忘）。
  每个用户每批次最多 `memory.maxNewEpisodes` 个；大多数批次不添加任何回忆。输入中显示已存储的回忆，因此
  不会重复记录。代码为每人保留 `memory.maxEpisodes` 个，先淘汰最轻的，然后是最旧的。
- `lore` 是服务器的世界书：跨越对话存在的事物：事件（"某某离开的那天"）、常驻角色和宠物、长期故事、
  恩怨、传统。`title` 是标识（同标题的条目视为更新，携带完整的合并文本），`keys` 2–6 个人们实际输入的词
  或短语（名称、昵称、梗的原话，使用聊天的语言，小写），`text` ≤ `lore.textChars`（`{{loreTextChars}}`）。
  输入 `<existing_lore>` 列出已存储的标题及其关键词，以及批次涉及的条目的完整文本。所有者通过
  `/nep lore add` 添加的条目永远不会被分析器修改。
- 字符串字段 ≤ `memory.fieldChars`；细节 ≤ `memory.maxDetails`，内部梗 ≤ `memory.maxInjokes`，自述 ≤
  `memory.maxSelfFacts`。笔记使用聊天所用的语言。仅记录观察到的事实；不记录敏感信息（地址、电话、证件、
  健康、财务、真实全名）。
- **`memory: update applied` 上的计数器**（每批次后记录）：`roster`（`<known_members>` 中发送的成员数）、`rosterCandidates`（提供给预算的名册条目数）、`rosterTokens`（发送的名册占用的估计 token 数）、`aliasesChanged`（作者和名册中存储别名列表实际发生变化的成员数）、`aliasOnly`（其中的名册成员数）、`droppedUsers`（既非作者也非有存储档案的名册成员的 id 条目数）、`droppedFields`（从名册成员条目中丢弃的非 `aliases` 键数）、`portraitDropped`（丢弃的作者非空 `character`/`style` 数）、`notesFlagged`（本批次中携带过时标记的频道或公会条目数）、`overLimit`（因超出限制而被拒绝的散文字段数）、`overLimitFields`（`kind.field` 名称数组，如 `['channels.topics', 'guild.patterns', 'lore.text', 'users.relationship']`；不含成员 id）。当发送了标记时，还包括：`notesUpdated`、`notesConfirmed`、`notesInsufficient`（三种复审状态）、`notesMissing`（模型未返回的已标记目标）、`notesIdentical`（文本与存储一致的 `updated`）、`notesUnflagged`（为未标记目标返回的复审）。

`memory: voice applied` 上的计数器：`overLimit`（重试后被拒绝的条目数，已存储文本保持不变）、`overLimitRetried`（使用 `<over_limit>` 块重新发送的条目数）。当重试请求本身失败时（不良 JSON、超时、提供者错误），`retryFailed` 包含原因字符串。

### 画像和笔记刷新的溢出

当画像刷新生成超出限制的 `style` 或 `character` 文本时，执行相同的重试。第二次超出时在 `warmup: portrait refresh failed` 中记录结果 `over-limit` 和 `fields`（超出的字段名）。尝试戳记被设置，当天的槽位已使用（请求已发送），但不写入任何内容。

当笔记刷新（刷新模式的 `channel.md` 或 `server.md`）生成超出限制的字段时，执行相同的重试。第二次超出时记录 `warmup: notes refresh failed`，原因 `over-limit`，`fields` 包含字段名。该频道或服务器不写入任何内容。下次尝试在 `memory.notesRetryHours` 之后。调度器移至下一个目标。

### 版本历史

当 `features.versions` 开启（默认开）时，每次散文字段的文本被替换，新文本存储前记录旧文本。旧文本存入 `data/guilds/<guildId>/versions/<kind>/<id>.json`，其中 `kind` 为 `users`、`channels`、`guild`（id `guild`）或 `lore`（id 为条目标题的 slug 加短哈希）。每个文件包含一个以字段名为键的 JSON 对象，每个值为记录数组（最新在最后）：

```
{ "<field>": [ { "at": "ISO", "by": "analyzer"|"voice"|"portrait"|"refresh"|"warmup"|"unknown", "chars": n, "before": n, "after": n, "kept": n, "removed": n, "added": n, "text": "<previous text>" } ] }
```

`before` 和 `after` 是旧文本和新文本的句子数。`kept` 是两者共有的句子数。`removed` = `before - kept`，`added` = `after - kept`。8 个句子中 `kept` 为 0 的改写表示模型替换了整个文本。每个字段最多 `memory.versionsKept`（默认 20）条记录；超出上限时删除最旧的条目。首次写入（字段为空）不记录。相同内容的改写不记录。私聊 relationship 文本不做版本记录。

`/nep memory forget` 删除该成员的版本文件。`/nep memory wipe` 删除服务器的整个 `versions/` 文件夹。

每条记录以 `store: version recorded` 记录日志，包含 `kind`、`field`、`by`、`chars`、`kept`、`removed`、`added`（频道版本包含频道 id，不包含成员 id）。

## 频道地图

`<server>` 块由已存储的频道笔记和代码维护的事实组装而成，过滤后仅包含与本轮相关的频道。当前频道排首位，
以 `labels.server.currentMark` 标记；然后仅包含本轮向 `<other_channels>` 贡献了消息的相邻频道，各自完整
显示。其他所有已存储的频道均被排除。在大型服务器上，其中大多数与当前无关，会浪费预算。

频道条目（`src/memory/channels.js` 中的 `renderChannel`）包含：

- **Discord 事实：**名称（`# heading`）、分类、话题。从首次看到该频道时即存在。
- **分析器笔记：**用途、话题、氛围。由预热期间的 `channel.md` 写入，由流分析器（`memory.md`）从实时批次
  中更新。三者均为自由文本，在渲染时进行标记解析（`<@id>` → 当前名称）。
- **代码维护的计数器：**消息数量、首条和末条消息的时间戳、30 天活跃度直方图（每 UTC 天的消息数，截取至
  最近 30 天）以及前 5 名作者（按消息数量，排除机器人和角色自身）。预热通过 `store.setChannelFacts` 从
  频道获取的历史中填充这些数据；实时流量通过 `store.touchChannel` 保持其更新。
- **活跃度判定：**`live`、`slow` 或 `dead`，由 `channelActivity` 从计数器计算，永远不由模型判定。当今日
  和昨日（UTC）消息总数达到 `context.channelActivity.liveMessagesPerDay`（默认 20）时为 `live`。当频道从
  未有过消息或最后一条消息超过 `context.channelActivity.deadAfterDays`（默认 7）天时为 `dead`。其余为
  `slow`。通过 `labels.server.activity` / `activityLive` / `activitySlow` / `activityDead` 渲染。
- **最后消息时效：**当标签存在且数据可用时，通过 `labels.server.lastMessage` 人性化显示。
- **最活跃作者：**通过 `labels.server.topWriters` 渲染，将已存储的作者 id 解析为当前名称；无档案的 id
  被跳过。

当前频道尚无存储笔记（分析器尚未处理过）时，会从对话记录中消息的 Discord 事实合成一个回退条目，使角色
仍然知道自己在哪。

## 预热

每个预热请求处理一个工作单元（一个频道、一个成员或服务器），以保持归属的清晰。`channel.md` 生成频道笔记
（用途、话题、氛围）。`profile.md` 生成成员的性格、风格、兴趣、细节、回忆和别名。`server.md` 生成服务器
级的规律、开场白、内部梗和世界书。运行顺序、采样、进度、限制和子命令见[预热](warmup.md)。

### 数据模型

`character` 和 `style` 保持自由文本形式，仅由 `profile.md` 撰写：预热和画像刷新。流分析器不直接编辑
它们：对于批次中显示出存储画像遗漏或矛盾的反复出现的习惯或写作方式变化的成员，分析器返回
`users.<id>.portrait: "一行：画像遗漏了什么"`。然后代码为该成员排队进行刷新：以已存储的性格 + 风格作为
`<draft>`，分析器的那行作为 `<hint>`，使用该成员最新的消息调用 `profile.md`，回答中的 `character` 和
`style` 替换已存储的版本（该回答中的兴趣、细节、回忆和别名被忽略；它们通过流操作持续流入）。

成员通过两条路径之一进入画像刷新队列。计数器路径：自上次画像以来至少 `memory.portraitRefreshMessages`（默认 300）条自身消息，且 `memory.portraitRefreshDays`（默认 3）天已过。年龄路径：画像距今至少 `memory.portraitMaxAgeDays`（默认 21）天，且至少 `memory.portraitMinMessages`（默认 60）条自身消息已累积。队列顺序：等待最久的成员优先（`portraitDueAt`，成员首次符合条件时盖戳，画像完成后清除），其次是画像最旧的，再次是自上次画像以来自身消息最多的。请求发送后遇到 provider 错误（HTTP 408/429/5xx 或超时）会归还当日名额并恢复之前的尝试戳，成员仍留在队列中；调度器结束该 tick 的循环。

态度和 `relationship` 不参与预热；它们仅从实时对话中增长。

`profile.md` 输出：`{ "character": "", "style": "", "interests": [{ topic, note, times }], "details": [{ text, times }],
"episodes": [...], "aliases": [""] }`；块 `<character>` `<member>` `<draft>`（可选）`<hint>`（可选，仅画像
刷新时）`<snippets>`。片段中自身的行以 `labels.warmup.ownMark` 开头；上下文行以
`labels.warmup.contextMark` 开头。别名来自其他人的行（他们如何称呼该成员），因此自身消息的归属规则不适用。一次明确的命名陈述足以作为别名的证据；随口说一次的戏谑名称不算别名
于别名。

## 地址分类器

角色回复某人后，该频道内打开一个对话窗口（`mention.followUpMinutes`，每次进一步回复时延长）。窗口内不
携带触发信号（无提及、无对角色消息的回复、无名字）的消息不会被盲目回复：代码将频道最近的
`mention.followUpContext`（默认 15）行发送给 `address.md`，角色自身的行以 `labels.self` 标记，加上以
`<candidate>` 标记的新消息，使用 `classifier.text` 模型角色（默认 `anthropic/claude-sonnet-4.6`）。输出
为一个词：当候选消息是在对角色说话或延续与角色的对话时为 `yes`，当人们在对别人或整个房间谈论角色时为 `overheard`，当对话与角色无关时为 `no`。
对另一成员的显式 @提及在询问模型之前即为 `no`；Discord 为被回复作者自动添加的隐式提醒不算作此类提及。当
`mention.followUpClassifyReplies` 开启（默认 `true`，缺失键 = 开启）时，对另一成员消息的回复会像普通文本一样发送给
分类器。关闭该开关时，对另一成员的任何回复自动为 `no`。

当 `mention.classifyWhileBusy` 开启（默认 `true`，缺失键 = 开启）时，回合执行期间到达的后续候选仍通过相同的窗口、no-streak 和预过滤检查后发送给分类器；每个频道同时最多一个分类器调用，较新的保留行替换较早的。关闭该开关时，或 `mention.pendingSameChannel` 关闭且候选自身频道繁忙时，候选不会被分类（`yes` 无论如何都会被丢弃）。每次调用计为 `llm.maxRequestsPerDay` 下的一次 `classifier.text` 请求。遇到繁忙回合的 `yes` 在挂起队列中等候（记录 `follow-up: deferred`）。队列中每个频道保留一个延迟跟进，较新的替换较早的（记录 `follow-up: dropped`，原因 `newer`）。注意力空闲后通过与提及相同的检查（过期、开关、暂停、发送权限、消息仍存在）以及两个自有检查来拾取（`follow-up: picked up`）：该频道和作者的跟进窗口仍然开启（`mention.followUpMinutes` 和 no-streak），否则丢弃 `closed`；以及该行未出现在该频道中已应答回合的历史记录中，否则丢弃 `answered`。通过这些检查后，延迟跟进与即时跟进一样计为一次呼叫，并按 `mention.followUpIgnoreChance` 进行忽略概率判定。当 `mention.pendingOverheard` 开启（默认 `true`，缺失键 = 开启）时，遇到繁忙回合的 `overheard` 在挂起队列中等候，角色在当前回合结束后做出反应。等候中的跟进不会被后来的 overheard 行挤出；等候中的 overheard 行会被后来的跟进、后来的 overheard 行或直接提及、回复或名字呼叫挤出。等候中的 overheard 行不计入垃圾消息限制，也不作为频道中等候的呼叫报告给其他回合。关闭该开关时，`overheard` 在繁忙回合中被丢弃（`busy`）。

`yes` 先经过忽略概率判定，未被忽略时启动触发类型为 `followUp` 的回复模式回合：任务文本来自 `prompts/follow-up.md`（缺失时回退到 `reply.md`），因此 `yes` 并不保证会有回答。跟进与提及一样计为作者的一次呼叫，判定以 `mention.followUpIgnoreChance`（默认 `0`）代替 `mention.ignoreChance` 作为起点；重复惩罚、垃圾消息判定和态度修正与其他呼叫一样适用。被忽略的跟进记录为 `mention: decided`，原因 `ignored:follow-up`（作者近期的呼叫算作重复或垃圾消息时为 `ignored:repeat` 或 `ignored:spam`），窗口及其 no-streak 保持不变。`overheard` 触发触发类型为 `overheard` 的回复模式回合：任务文本来自 `prompts/overheard.md`（缺失时回退到模式提示），作者档案标题无 `interlocutorMark`，纯文本发布，不计入重复惩罚，不进行忽略概率判定，限制拒绝时无通知，无搜索或重看分类器，绘画视为未请求（无图片配额通知，无用户级图片计数，无 `drawFailed` 后续）。`mention.followUpOverheard` 关闭时，`overheard` 回答启动普通跟进回合（日志中仍记录 `answer: 'overheard'`）。当 `overheard` 判定时分类器调用期间有更新的消息被搁置，先分类搁置消息：`yes` 则为其启动跟进回合，`overheard` 则为搁置消息启动 `overheard` 回合，`no` 则为原始候选启动 `overheard` 回合。

连续三个 `no`（`mention.followUpNoStreak`，默认 3）关闭窗口；`overheard` 在连续判定中视为 `yes`。开关 `features.followUp`（默认开启）。记录计数、判定结果以及 `follow-up: verdict` 上的 `answer`。
窗口状态在重启后保留：活跃窗口保存在 `data/state.json` 的 `followUpWindows` 中，启动时恢复，过期的窗口会被丢弃。

## 重看分类器

当角色被直接呼叫（回复回合，非 `overheard` 或自发回合）且频道最近 `media.video.rewatch.recentMessages`（默认 60）条消息中有视频或图片时，分类器判断
该消息是否在询问其中某个项目、声称了某张图片的具体细节，或请求重试一个未加载的视频。候选包括已观看视频、错误状态视频和已描述图片（附件图片，包括角色自己的上传；粘贴的图片链接不在范围内）。图片仅在 `features.vision` 开启时提供。分类器最多收到 `media.video.rewatch.maxCandidates`（默认 6）个项目，视频在前图片在后，各类型内按最新
消息优先排列。代码将 `rewatch.md` 作为系统提示发送到 `classifier.text` 模型角色（默认 `anthropic/claude-sonnet-4.6`），
用户消息包含三个块：一个短的 `<transcript>` 包含频道最近几条消息，角色自身的行以 `labels.self` 标记（使分类器能看到候选消息回复的对象），然后是媒体列表和候选：

```
<transcript>
...
</transcript>
<media>
<number> | <kind> | <name> | <status> | <说明或描述的开头>
...
</media>
<candidate>
<作者名>: <触发文本>
</candidate>
```

每行 `<media>` 包含五个 `|` 分隔的列：序号（1 = 类型组内最新项目）、类型（`video` 或 `picture`）、项目名称、
状态（视频为 `watched` 或 `not loaded`，图片为 `described`）和摘要或说明的前 200 个字符（未加载的视频为空）。名称和摘要的空白合并为一行。触发文本在 `context.maxMessageChars` 处截断。输出
为一行：

- `<number> | <question>`：消息询问已观看视频或已描述图片（包括需要核实的声称细节），需要描述未涵盖的细节。编号从列表原样复制。
- `<number> | retry`：消息关于未加载的视频，请求再试或询问其内容。编号从列表原样复制。重试仅适用于视频。
- `none`：不需要重看或重试。

视频的问题命中时，视频模型使用 `rewatch-answer.md`（`{{question}}` 和 `{{maxChars}}` = `rewatch.answerChars`，默认
1200）再次观看片段，回答以 `transcript.videoAnswered`（`{question}`、`{text}`）的形式追加在已观看标签之后。

图片的问题命中时，视觉模型（`classifier.media`，`purpose: relook`，提示 `rewatch-answer.md`，类型无关）带着该问题再次查看图片。回答不存储为说明（缓存一小时），对话记录在图片行下方携带 `transcript.imageAnswered`（`{question}`、`{text}`）。

当功能开启时，`<senses>` 块包含 `senses.videoRewatch`。

重试命中时，视频模型使用 `force`（忽略错误缓存）观看片段，使用与首次观看相同的 `describeVideo` 路径。如果重试成功，
视频状态从错误变为已观看，对话记录中显示的摘要为第一手内容。重试计为 `media.video.maxPerTurn` 和
`media.video.maxPerDay` 的新视频尝试。

限制：每回合最多一次重看或重试；分类器和重看各自计入 `llm.maxRequestsPerDay`；重看还计入
`media.video.maxPerDay`；`media.video.rewatch.maxPerDay`（默认 20）同时限制视频重看和图片二次查看（共享计数器）。回答按问题缓存一小时（参见
上方视频缓存部分）。开关 `features.videoRewatch`（缺失 = 开启，需要 `videoDescriptions`）。开关 `features.imageRelook`（缺失 = 开启，需要 `vision`）。

## 搜索与 recall 分类器

当角色被直接呼叫（回复回合，非 `overheard` 或自发回合）且 `lookup.md` 提示文件存在时，分类器判断触发消息是否需要网络搜索、服务器历史搜索或两者兼有。代码将 `lookup.md` 作为系统提示，使用 `classifier.text` 模型角色，用户消息包含一个短的 `<transcript>`（与重看分类器相同，角色自身的行以 `labels.self` 标记）和一个 `<candidate>` 块：

```
<transcript>
...
</transcript>
<candidate>
<作者名>: <触发文本>
</candidate>
```

对话记录在可用时携带描述、视频摘要和链接阅读内容。触发文本在 `context.maxMessageChars` 处截断。输出为 `none`，或以任意顺序最多四行标注行：

- `web: <搜索查询>`（纯文字，无引号，无操作符，最多 12 个词）：消息需要聊天之外的事实，或明确要求搜索网络。仅在 `features.webLookup` 开启、`web.search.enabled` 不为 false、`web.search.maxPerTurn` 至少为 1、且配置了 `BRAVE_SEARCH_API_KEY` 时触发。
- `server: <词形>, <词形>, ...`：消息问到了这个服务器上说过或做过的不在对话记录中的事。每个词形是一个词或短语的变体形式。仅在 `features.recall` 开启时触发。
- `who: <名称词形>, <名称词形>, ...`：问题涉及对话记录中不明显的某个人。词形帮助通过昵称、用户名或标签找到此人。
- `when: <from> .. <to>`：问题指向一个时间（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM`，`..` 两侧各一个；单个日期表示全天）。

单行无标注（旧格式）仍被读取为网络查询。空白或空的回答为失败调用（`reason: empty`），不是安静的 `none`。

`web:` 命中时，Brave Search 运行查询（`web.search.results` 个结果，默认 5），编号的结果通过 `classifier.text` 经 `search-summary.md`（`{{today}}`、`{{query}}`、`{{maxChars}}` = `web.search.summaryChars`，默认 900）浓缩，网络部分渲染在 `<lookup>` 块中：`labels.lookup.header` 附带查询词，浓缩文本，以及 `labels.lookup.sources` 附带不同的站点名称。搜索无结果或浓缩器未找到有用内容时，显示 `labels.lookup.none`。

`server:` 命中（可附带 `who:` 和 `when:` 行）时，引擎通过 Discord 搜索 API 搜索服务器消息历史。词形成为有序的搜索查询列表（内容词形轮转，然后作者名），仅有 `when:` 时为日期范围采样。命中项经过过滤（排除其他机器人和受众规则拒绝的频道），按频道和时间分组为聚类（`recall.clusterGapMinutes`），按主题得分排名（聚类中每个有命中的不同 `server:` 词形，若其在整个服务器上的命中数不超过 `recall.rareHits` 则计 2，否则计 1），其次按所有不同查询的命中数，再按最新优先，保留排名前 `recall.maxClusters` 个聚类。仅有名称或作者命中的聚类排在任何有主题命中的聚类之后。`recall.keepOldest` 为主题得分至少为 2 的最旧聚类保留槽位。每个保留的聚类获取 `recall.windowMessages` 条消息的窗口。分类器的词形和名称词形还会与已存储记忆匹配（不含私有层）：成员的回忆、世界书条目、所学内容和近期行。每个匹配的条目成为 `<memory>` 块中的一行：`kind | date | name | text`，kind 为 `episode`、`lore`、`learned`、`recent`。`when:` 日期范围排除无日期的种类（lore、learned）。最多 `recall.memoryItems`（默认 6）条，按匹配的词形数和权重排名。`<memory>` 块在 `<people>` 之后、`<found>` 之前；其条目不能被指定为 `stretch`。有记忆匹配但无聊天命中的运行仍会询问摘要。日志记录在 `recall: searched` 行的 `stats.memory` 上。

摘要辅助（`recall-summary.md`，使用 `classifier.text`，块 `<people>`、`<memory>`、`<found>`、`<question>`）读取窗口、已存储记忆和问题并写出笔记。摘要可以指出最佳回答问题的一段原文（`stretch: <n>`）；如果是，该段的逐字内容（上限 `recall.stretchChars`）与笔记一起出现。摘要说 `nothing` 时，`<lookup>` 块无服务器部分。摘要失败或超时时回退到排名最高窗口的逐字原文段，不附笔记。

两者都运行时，`<lookup>` 块在网络部分上方携带 `labels.lookup.webHeader`，服务器部分上方携带 `labels.lookup.serverHeader`，两者之间携带 `labels.lookup.bothNote`。

`<lookup>` 块遵循与 `<other_channels>` 相同的受众规则（`context.pull.sameAudience`）：当服务器搜索窗口来自的频道并非目标所有可读者都能阅读时，该窗口被拒绝。

限制：每回合最多一次网络搜索和一次服务器搜索。分类器、网络浓缩器和 recall 摘要各自计入 `llm.maxRequestsPerDay`；网络搜索计入 `web.maxPerDay`（与链接阅读共享）；recall 运行计入 `recall.maxPerDay`（存储在 `state.json` 中的 `recallDay` / `recallCount`）。网络结果按规范化查询缓存 `web.search.cacheHours`（默认 24）小时。分类器在 `features.webLookup` 或 `features.recall` 任一开启时触发。开关：`features.webLookup`（缺失 = 关闭）、`features.recall`（缺失 = 开启）。

## 任务分拆器

足够长且有结构的直接呼叫（提及、回复、名字、跟进、私信）（`split.minChars` 字符，排除链接和 Discord token，至少两段分隔符）会在回合准备过程中一并交给分类器（`prompts/split.md`，使用 `classifier.text`，用途标记 `split`）。分类器读取最近 `split.contextMessages` 条消息的短 `<transcript>`（角色自身的行以 `labels.self` 标记），然后是新消息作为 `<candidate>`（`<作者名>: <文本>`）。回答为 `one`，或 2 到 `split.maxTasks`（默认 4）行，每行以 `- ` 开头，用作者自己的话表述一个部分。解析后，短于 `split.minPartChars`（默认 20）字符的部分（排除链接和 Discord token，与 `minChars` 相同）折叠到下一个部分（最后一个折叠到前一个）；当剩余不足两个部分时视为单个请求（`folded`）。空白、无法解析或迟到的回答（回合准备先完成）视为单个请求，记录 `split: failed`。开关 `features.splitTasks`（缺失 = 开启）。

各部分成为同一消息上的普通回合链（`turn: part`）。每个部分的辅助（搜索分类器、recall、路由、重看）以该部分的文本为判断对象，请求中指出正在回答的部分和其余部分（`labels.task.part`，含 `{index}`、`{total}`、`{part}`、`{others}`）。第一个部分复用整条消息的回合已获取的历史记录并回复消息；后续部分重新获取历史记录并发布为普通消息。每个部分有自己的截止时间和丢弃限制；失败或被拒绝的部分不会阻止下一个。忽略概率、私聊每日上限和环标记在每条消息上只计一次。暂停或预热在下一个部分前结束链（`turn: chain stopped`）。链运行期间，未开始的部分是作者的等候条目（回合执行器上的 `waitingParts`）；作者稍后的消息折叠进其中一个（`addToPart`）会通过 `tasks.added` 到达该部分的请求。注意力从第一个回合到结束一直保持；空闲通知在结束时只触发一次。

没有 `prompts/split.md` 时分拆器关闭（`split: skipped`，`no-prompt`）。没有 `labels.task.part` 时分拆器也关闭：解析出的回答被丢弃。设置：`split.minChars`（默认 80）、`split.minPartChars`（默认 20）、`split.maxTasks`（默认 4）、`split.contextMessages`（默认 6）、`split.maxOutputTokens`（默认 300）。

## 合并分类器

当有呼叫来自在该频道已有等候条目的作者时（分拆消息中尚未处理的部分，或待处理列表中排队的呼叫），分类器（`prompts/merge.md`，使用 `classifier.text`，用途标记 `merge`）判断新消息是否属于其中一个。分类器读取编号条目的 `<waiting>` 块（`1. <文本>`，每个等候条目一行）和新消息作为 `<candidate>`（`<作者名>: <文本>`）。回答为一行：等候列表中的一个编号或 `new`。被折叠的消息不会获得自己的回合；它通过 `labels.task.added`（`{added}`）出现在其条目的回合中。被路由的呼叫不会被折叠。没有提示文件时，每个呼叫都作为独立条目排队（`merge: failed`，`no-prompt`）。记录为 `merge: verdict` 或 `merge: failed`。无自己的配置设置；输出上限为 `mention.followUpMaxOutputTokens`。

## 绘画

角色可以通过绘画子进程（`features.imageGeneration`，默认开启）生成图片。当模型输出 `<draw>` 标签时，
`src/behavior/turn.js` 从 `draw.md` 组装图像提示，通过 OpenRouter Images API（`src/llm/images.js`）生成一张图片。
图片作为独立消息发布在角色的文本消息之后，不会内联。

### 提示组装

`buildDrawPrompt`（`src/behavior/prompt.js`）用三个占位符填充 `draw.md`：

- `{{name}}` — 机器人的显示名称。
- `{{appearance}}` — 填充了 `{{name}}` 的 `appearance.md`，仅在 `self="yes"` 时包含。否则为空。
- `{{request}}` — `<draw>` 标签的场景文本，截断至 `image.maxPromptChars`（默认 800）。

绘画子进程不接收角色卡、`rules.md` 或系统提示。它遵循 `draw.md` 内的独立风格部分。

### 参考图

当角色出现在图片中（`self="yes"`）且 `image.reference` 为 `'avatar'`（默认）时，机器人的 Discord 头像被下载并作为
`input_references` 条目发送，使图像模型能看到角色的外观。如果无法获取头像，则不带参考图继续生成。

### 感知

当图像客户端已连接且 `features.imageGeneration` 不为 false 时，`<senses>` 块包含一行绘画信息：

- `senses.draw` — 角色可以绘画。
- `senses.drawSpent` — 每日配额（`image.maxPerDay`）已用完。
- `senses.drawSpentUser` — 该成员的每日配额（`image.maxPerUserPerDay`）已用完。

没有 `senses.draw` 的旧版 `labels.json` 不会显示任何内容。

### 失败回合

当有人请求的回合（提及、回复、名字触发或跟进，非 `overheard` 或自发回合）中生成失败时，自动触发第二个回合：

- `triggerKind: 'drawFailed'`，失败原因通过 `labels.draw.reasons.*` 渲染到 `labels.triggers.drawFailed` 的
  `{reason}` 占位符中。
- 模式为 `reply`，同一触发消息，允许回复。
- 第二个回合自身的 `<draw>` 被移除，因此模型无法重试生成。
- 频道的空闲通知被保留到第二个回合结束，因此挂起的 ping 仅在后续回合完成后才被排空。

自发或 `overheard` 回合（无人请求）中，失败仅记录日志，不触发后续回合。

图片配额超限（`ImageCapError`，原因 `daily` 或 `userDaily`）不会触发失败回合。代之以限制通知（`labels.limits.notice`）作为普通回复发布。`draw.reasons.daily` 和 `draw.reasons.userDaily` 保留在 `labels.json` 中，但不再通过 `triggers.drawFailed` 到达。

### 限制

- 每回合一个 `<draw>`；首个非空优先，截断至 `image.maxPromptChars`（默认 800）。
- `image.maxPerDay`（默认 50）和 `image.maxPerUserPerDay`（默认 50）在请求前检查和计数；超限抛出 `ImageCapError`（原因 `daily` 或 `userDaily`）。
- 不支持的模型系列（非 `openai/*` 或 `google/*`）以 `UnsupportedImageModelError` 拒绝。
- 生成失败抛出 `ImageGenError`（原因 `moderation`、`timeout`、`error` 或 `empty`）。
- 瞬态 HTTP 错误（408、429、5xx）和网络故障重试最多 `image.retries`（默认 1）次。
- 内容审核拒绝（HTTP 400/403 带审核标记）不重试。
- 日志记录模型、计数、费用和失败原因，不记录提示（因为可能引用成员）。
- 试运行中，完整的图像提示（提示文件 + 角色的请求）被记录并镜像，但不生成任何图片。

## 日记

`features.diary`（默认开启，但无 `diary.channelId` 时什么都不运行）。角色在拥有者选择的频道中按 `bot.timezone` 窗口的随机时间自发发帖。每篇帖子是两个模型请求：计划步骤和生成步骤。计划请求搜索时增加第三个。

两个请求、计划 JSON 格式、验证与回退、输出规则、`{{when}}` 占位符、记录、数据文件、回填、服务器地图中的展示、日志的详细说明参见英文版 `docs/en/prompt-contract.md` 的「Diary」部分。

日志：`diary: plan`、`diary: planned`、`diary: due`、`diary: post`、`diary: skip`（原因：`no-channel`、`off`、`paused`、`warmup`、`not-writable`、`cap`、`grace`、`busy`）、`diary: backfill`、`diary: plan failed`、`diary: search failed`、`diary: backfill failed`。

## 私聊

`features.privateMessages`（默认关闭）允许所服务公会的成员通过 Discord 私信与角色交谈。角色不变，公共记忆不变；私信中说的话存储在每个成员的私有层中，其他对话不可见。

### 门控

当以下所有条件均满足时（本地零 token 检查），私信才会得到回复：

1. `features.privateMessages` 为 `true`。
2. 发送者是所服务公会的成员。
3. 角色拥有该发送者的公共档案。
4. 公共 `affinity.score >= private.minAffinity`（默认 5）。机器人所有者跳过此检查。
5. 今日回复数未超过上限（所有者使用 `private.maxPerOwnerPerDay`，其余使用 `private.maxPerUserPerDay`）。

达到每日上限时（步骤 5），机器人每人每天发送一次限制通知（`labels.limits.notice`）。

### DM 回合的内容和省略

- `<server>`（频道地图）和 `<other_channels>` 被省略。
- 当 `features.privateLikeServer` 开启时（默认 `true`，缺失键 = 开），频道路由分类器、频道拉取和服务器搜索（recall）均在 DM 中运行。仅当 DM 伙伴对该频道拥有 View Channel 权限时，频道才会被拉入 DM（`context.pull.sameAudience` 不会放宽此限制）。recall 搜索对每个频道应用相同的伙伴规则。DM 中提及的成员会显示其回忆（`context.askedAboutEpisodes`）。DM 拉取的内容不会在服务器上标记为已读或已回答。关闭此开关时，无路由、无拉取、无 recall、无被问及成员的回忆。
- `prompts.private`（如果存在）追加在模式提示（`reply.md`）之后、`forced.md` 之前，填充 `{{name}}` 和 `{{author}}`。
- `{{trigger}}` 取自 `labels.triggers.private`。
- `<senses>` 包含 `senses.privateChat`。
- 服务器回合中，当 `features.privateMessages` 开启时，`<senses>` 改为包含 `senses.privateAware`。
- 对话伙伴的档案为 `mergeProfiles(publicProfile, privateProfile)`。其他档案仅公共。

### 私有层

`data/guilds/<guildId>/private/<userId>.json` 存储角色从私信中了解到的内容。拥有自己的 `relationship`、`interests`、`details`、`episodes` 和 `affinity`（初始分数 0）。私信中角色看到公共和私有数据的合并：兴趣按主题合并（私有笔记优先），细节连接，回忆按日期排序，`relationship` 段落拼接。

### DM 中的好感度

公共分数仅由服务器批次改变。私有层有自己的分数（初始 0），仅由 DM 批次改变。DM 中角色感受到 `clamp(公共 + 私有, -100, 100)`；服务器上仅有公共分数。门控仅使用公共分数。

### 私有模式的分析器

`analyzePrivate` 构建与相同 `memory.md` 格式的请求，加上 `<private>` 块（`labels.memory.privateNote`）。`<existing_profiles>` 仅包含伙伴。回答中仅 `users[<partnerId>]` 通过私有存储方法应用。`portrait`、`aliases`、`guild`、`channels`、`lore`、`self` 被丢弃。

## 限制通知

当限制（rail）拒绝了被请求的操作（提及、回复、名字触发、follow-up 或私信，非 `overheard` 或自发回合）时，机器人发布 `labels.limits.notice` 的一行，填充 `{limit}`（配置键）、`{used}` 和 `{cap}`。自发和 `overheard` 回合保持沉默。试运行中通知被记录并镜像。

`{limit}` 中可能出现的配置键：`llm.maxRequestsPerDay`、`llm.maxRequestTokens`、`image.maxPerDay`、`image.maxPerUserPerDay`、`private.maxPerUserPerDay`、`private.maxPerOwnerPerDay`。
