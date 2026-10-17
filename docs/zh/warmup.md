# 预热

预热从近期消息样本中构建角色对服务器的记忆。它是运维工具 `tools/warmup.mjs`，在机器人停止的状态下从服务器上的代码目录运行，在首次启动之前使用（参见[运行方式](#运行方式)）。没有对应的斜杠命令。

机器人不会运行预热。工具自行恢复未完成的运行。

## 阶段

完整运行按固定顺序进行：频道、人物、服务器。

### 频道

每个可读频道生成一个请求，从最新的 `warmup.messagesPerChannel`（默认 200）条消息中描述，不限消息时效。如果频道历史消息少于该数量，会尝试更深入地抓取。完全没有历史的频道仅从其名称、分类和话题描述。结果是一组频道笔记（用途、话题、氛围）和代码维护的数据（消息计数、最活跃作者、30 天活跃度直方图）。

### 人物

最活跃的成员入选：在最近 `warmup.lookbackDays` 天内至少有 `warmup.minMessages` 条自身消息，最多 `warmup.maxPeople` 人，按活跃度排序。`node tools/warmup.mjs people` 列出当前设置下符合条件的成员。

对于每个符合条件的成员，引擎采样最多 `warmup.messagesPerPerson` 条其消息，附带 `warmup.contextBefore` 行上下文。单个频道在样本中的占比不超过 `warmup.maxChannelShare`。大样本按时间顺序分成适合 `warmup.maxRequestTokens` 的块；第一块之后的每个块都会收到前一个回答作为 `<draft>` 块，以便模型保留有效内容、纠正变化并用新证据扩展。最终回答存储性格、风格、兴趣、细节、回忆和别名；消息计数和首次/末次出现时间戳由代码计算。

### 服务器

一个请求包含所有频道笔记、每个已建档成员的单行摘要（名称、主要习惯、主要兴趣）以及主频道（`memory.mainChannelIds`；为空时所有频道均计入）的最新 `warmup.serverSampleMessages`（默认 600）行。输出存储为服务器级规律、对话开场白、内部梗和世界书条目。

## 范围

预热写入：频道笔记（用途、话题、氛围）、成员档案（性格、风格、兴趣、细节、回忆、别名）、服务器习惯（规律、开场白、内部梗）和世界书。

态度和关系永远不会被预热。它们仅通过流分析器从实时对话中增长。

`character` 和 `style` 是自由文本字段，仅由档案提示（`profile.md`）撰写，包括预热期间和画像刷新期间。流分析器不会直接编辑它们。数据模型和输出格式请参阅[提示契约](prompt-contract.md)。

## 进度

每次请求后进度持久化到 `data/state.json` 的 `state.warmup`，重启后仍保留。因 Ctrl+C、token 预算、速率限制或连续三次请求失败中断的运行，在再次执行 `node tools/warmup.mjs run` 时从中断处恢复。`node tools/warmup.mjs reset` 仅清除进度，不清除已存储的记忆。

## 限制

运行的总 token 预算为 `warmup.maxTokens`（默认 6,000,000）。每个请求上限为 `warmup.maxRequestTokens`（默认 120,000 输入加输出）和 `warmup.maxOutputTokens`（默认 6,000 输出）。构建样本池的频道获取每个频道最多读取 `warmup.fetchLimitPerChannel`（默认 15,000）条消息。

当 provider 返回 HTTP 429 时，预热等待 `warmup.rateLimitWaitMinutes`（默认 10）分钟后重试。连续等待 `warmup.rateLimitMaxWaits`（默认 36）次后运行中止；进度保留，可以恢复运行。

## 画像刷新

预热完成后，流分析器从实时批次中保持记忆更新。画像通过两种方式刷新。

**按计数器**（`features.portraitRefresh`）。定期调度器每 `memory.portraitCheckMinutes`（默认 60）分钟检查一次，寻找自上次画像以来写了至少 `memory.portraitRefreshMessages`（默认 300）条自身消息，且上次成功刷新距今至少 `memory.portraitRefreshDays`（默认 3）天的成员。每天最多刷新 `memory.portraitRefreshPerDay`（默认 3）人，按活跃度排序。没有画像时间戳的成员会计入所有消息，因此部署后会有多人同时符合条件；日限额将其分散。失败的尝试等待 `memory.portraitRetryHours`（默认 24）小时。采样量被控制在 50k token 限制以内。

**按分析器提示。** 当流分析器检测到存储画像遗漏的反复习惯或写作方式的变化时，返回一行提示，代码将刷新排队。此路径使用现有的每成员冷却时间 `memory.portraitRefreshHours`（默认 24 小时）。流分析器不再能直接覆写 `character` 或 `style`。

在两阶段模式中，当成员的角色文本正在等待语音模型（`voice-pending`）时不执行画像刷新。强制刷新（`/nep memory refresh`）绕过此检查。`/nep memory refresh` 会告知所有者该成员是否有排队的角色条目。

两种路径共享日限额。`/nep memory refresh <user>` 无视计时器强制刷新，但仍计入限额。每次刷新计入 `llm.maxRequestsPerDay`。

刷新时以存储的画像为 `<draft>`、分析器笔记为 `<hint>`（如有）调用 `profile.md`。草稿是合并基础：与采样一致的保留（压缩腾出空间），矛盾的修改，新的反复习惯添加，采样中未出现的不删除。新的性格和风格替换存储的版本；回答中的兴趣、细节、回忆和别名被忽略。

## 运行方式

从机器人的代码目录，以服务用户身份，在机器人停止的状态下运行：

```bash
sudo systemctl stop neptunia-bot
cd /opt/neptunia/app
sudo -u neptunia-bot node tools/warmup.mjs run --guild <server id> --dry-run
sudo -u neptunia-bot node tools/warmup.mjs run --guild <server id> --spend <usd>
sudo systemctl start neptunia-bot
```

当 `data/guilds/` 只有一个服务器或设置了 `bot.guildId` 时，可以省略 `--guild`。工具从代码目录读取 `config.json`、`config.local.json`、`prompts/`、`prompts.local/` 和 `.env`，通过 bot token 以 REST 方式读取 Discord 历史（无 gateway 会话，不发布任何内容），通过 OpenRouter 密钥发送模型请求。

| 子命令 | 功能 | 消耗 |
|---|---|---|
| `run` | 按顺序处理进度尚未完成的所有可读频道、符合条件的成员和服务器笔记 | 是 |
| `users [--user <id>]` | 为指定成员或所有符合条件的成员生成档案（忽略进度） | 是 |
| `channels [--channel <id>]` | 描述指定频道或所有可读频道 | 是 |
| `server` | 重建服务器笔记和世界书 | 是 |
| `people` | 列出符合条件的成员 | 否 |
| `status` | 阶段、进度、相对于 `warmup.maxTokens` 的 token 使用量 | 否 |
| `reset` | 仅清除进度，不清除已存储的记忆 | 否 |

**消耗说明。** `run`、`users`、`channels` 和 `server` 先打印计划（频道、成员、服务器笔记）和估算，若 `--spend <usd>` 未能覆盖估算则以退出码 2 拒绝。估算按 `warmup.maxRequestTokens` 计算每个请求，在 `warmup.maxTokens` 剩余额度和 `--max-usd <n>` 的范围内，按 `--usd-per-ktok`（默认每千 token 0.005 USD）定价。运行以该估算为预算：到达时停止（可恢复），绝不超出。样本无法放入单个请求的成员可能提前消耗预算；再次运行即可继续。`--dry-run` 仅打印计划和估算，不发送请求。请求不计入 `llm.maxRequestsPerDay`。

**安全性。** `run`、`users`、`channels`、`server` 和 `reset` 在机器人使用同一 `data/`（日志的 `.running` 标记存在）时拒绝，并提示 `sudo systemctl stop neptunia-bot`。消耗子命令在删除进行中、记忆暂停时也会拒绝，并在 `data/` 仍包含删除台账要移除的内容时先应用台账。`people`、`status` 和试运行不写入任何内容。Ctrl+C 取消当前请求并停止运行；进度保留。工具退出前将记忆刷写到磁盘，包括归档副本。

**写入内容。** 频道笔记和事实写入 `data/guilds/<id>/channels/`，成员档案写入 `data/guilds/<id>/users/`，服务器笔记写入 `data/guilds/<id>/guild.json`，世界书写入 `data/guilds/<id>/lore.json`，进度写入 `data/state.json`；当 `features.archive` 启用时，被重写覆盖的内容先归档。

**之后。** 启动机器人。此后记忆由机器人维护：流分析器处理实时批次，画像刷新以及下文的笔记刷新。`/nep memory refresh kind:user <user>` 立即重写某成员的画像。`kind:channel <channel>` 和 `kind:server` 从新鲜样本重写频道笔记或服务器笔记（与下文笔记刷新相同的请求，在实时限制下，角色继续对话）。尚无笔记的频道和世界书仍由此工具处理：`channels --channel <id>` 和 `server`。

如需完全重新开始，先使用 `/nep memory wipe`：它会清除成员档案及其态度和回忆、服务器习惯、频道地图、世界书条目和预热进度。

## 保持笔记更新

频道和服务器笔记在预热期间写入，之后由流分析器在批次包含足够证据时更新。但随着时间推移，短批次难以捕捉人们聊天方式或频道主题的渐进变化。笔记刷新（`features.notesRefresh`）通过定期从近期消息的完整样本中重新检查笔记来弥补这一不足，方法与预热最初描述频道时相同。

### 发生了什么

调度器每 `memory.notesCheckMinutes`（默认 60）分钟检查一次哪些频道和服务器笔记已逾期。频道被视为逾期的条件：已有笔记文本（预热未描述的频道留给预热处理）；自上次文本变更或采样复审以来已过足够天数（`memory.notesRefreshDaysMain`，`memory.mainChannelIds` 中的频道默认 7，其余 `memory.notesRefreshDays`，默认 21）；此后累积了至少 `memory.notesMinMessages`（默认 30）条消息；该频道在 `warmup.lookbackDays`（默认 60）天内有消息；且 `memory.notesRetryHours`（默认 24）内没有失败的尝试。

对于逾期频道，引擎读取 `memory.notesSampleDays`（默认 30）天的历史，去除角色和其他机器人的行，选取 `memory.notesSampleMessages`（默认 160）条消息分散在各天中。分散避免了仅采样最近对话的偏差：引擎每轮每天取一条消息，最新一天优先，单个作者最多占样本的 `memory.notesSampleMaxAuthorShare`（默认 0.35）。如果可用消息少于 `notesMinMessages`，频道被跳过（`too-few`）。

请求使用与预热相同的 `channel.md`（服务器用 `server.md`），额外附加一个 `<existing_notes>` 块，以 JSON 形式展示已存储笔记及 `writtenDaysAgo`（距上次变更的整天数，未知时为 null）。提示指示模型将它们视为待评估的主张，而非证据。回答替换已存储的 purpose、topics、tone（服务器则为 patterns、starters、injokes）。如果在读取历史到收到回答之间频道文本发生了变化（另一个批次更新了它），回答被丢弃（`conflict`）。无论哪种情况，有效回答都会盖 `notesSampleReviewedAt` 戳。文本的 `updatedAt` 仅在实际发生变化时才移动。

服务器遵循相同规则：`memory.notesServerRefreshDays`（默认 7），全频道合计至少 `memory.notesGuildMinMessages`（默认 100）条消息。服务器在循环中排在频道之后，不计入频道的每日限额。

### 频率和成本

每 UTC 天最多 `memory.notesRefreshPerDay`（默认 4）次成功的频道刷新。失败的请求不占用名额。日计数器存储在 `state.json` 中（`notesRefreshDay` / `notesRefreshCount`）。服务器刷新不计入频道限额。

每次刷新请求计入 `llm.maxRequestsPerDay` 和 50k token 上限，但不计入预热的 `warmup.maxTokens`。刷新期间角色不会被静默。预热运行中拒绝刷新。

### 日志行

`warmup: notes refreshed`，携带 `{ target: "channel" | "server", channelId, changed, sample, authors, days }`。

`warmup: notes refresh failed`，携带 `{ target, channelId, reason }`。原因：`running`（预热运行中）、`paused`、`gone`（频道已不存在）、`too-few`（可用消息太少）、`conflict`（读取历史和回答之间文本已变更）、`bad-json`、`llm-error`、`token-limit`、`daily-cap`、`no-prompt`。

`notes refresh: look`，携带 `{ due, started, refreshed, changed, skipped }` 和 `buckets { neverReviewed, fresh, due, few, quiet, retryWait }`（全频道计数）。

没有任何东西仅为看起来更新而被重写。当样本无法判断某个表述是否仍然成立时，已存储文本保持原样。

预热配置键的完整列表见[配置：`warmup`](configuration.md#warmup)。
