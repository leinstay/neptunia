<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../.github/assets/banner-dark.png">
    <img src="../../.github/assets/banner.png" width="700" alt="Neptunia - Discord AI 角色引擎">
  </picture>
</p>
<p align="center"><a href="../../README.md">English</a> | 中文 | <a href="../ja/README.md">日本語</a> | <a href="../ru/README.md">Русский</a></p>
<p align="center">
  <a href="https://github.com/leinstay/neptunia/stargazers"><img src="https://img.shields.io/github/stars/leinstay/neptunia" alt="GitHub stars"></a>
  <a href="https://github.com/leinstay/neptunia/forks"><img src="https://img.shields.io/github/forks/leinstay/neptunia" alt="GitHub forks"></a>
  <a href="https://github.com/leinstay/neptunia/issues"><img src="https://img.shields.io/github/issues/leinstay/neptunia" alt="GitHub issues"></a>
  <a href="https://github.com/leinstay/neptunia/pulls"><img src="https://img.shields.io/github/issues-pr/leinstay/neptunia" alt="GitHub pull requests"></a>
  <a href="https://github.com/leinstay/neptunia/blob/main/LICENSE"><img src="https://img.shields.io/github/license/leinstay/neptunia" alt="License"></a>
  <a href="https://github.com/leinstay/neptunia/actions/workflows/test.yml"><img src="https://github.com/leinstay/neptunia/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
</p>

---

Neptunia 是一个本地运行的 Discord 机器人，用 LLM 扮演一个可配置的角色，看起来就像普通聊天成员。基于 Node.js 20+，唯一依赖是 discord.js，支持任何兼容 OpenRouter 的端点。角色卡无需改代码即可替换，提示词和配置热重载。具备按成员记忆（含态度和回忆）、服务器级世界书、附图识别、辅助模型的单行媒体描述、通过图像生成模型按需绘画、带独立记忆层的 Discord 私信聊天、所有者斜杠命令和试运行模式。自带可用的示例角色；换角色只需写自己的角色卡。

角色响应 @提及、回复和名字触发，有时会选择无视。它会随机插入对话，在安静的频道发起话题。它记住每个人，追踪 -100 到 100 的态度分数并体现在回复中。分数不会出现在聊天里。配置和提示词全部热重载；所有者命令可在 Discord 中实时调整。

每个实例服务一个服务器、一个机器人账号、一个角色。如需第二个服务器或角色，需运行另一个副本，各自拥有独立的 `.env`、`config.local.json`、`prompts.local/` 和 `data/`。Discord 会为机器人账号标注 APP 徽章；本引擎不会隐藏这一标识。

## 快速开始

在 [discord.com/developers](https://discord.com/developers/applications) 创建一个 Discord 应用。在 Bot 页面启用 **Message Content** 特权意图。邀请链接需要两个 scope（`scope=bot%20applications.commands`）和 `permissions=101440`（查看频道、发送消息、读取历史、添加反应、附加文件）。如果机器人加入后斜杠命令未出现，日志会说明原因；重新打开邀请链接并再次完成流程即可修复注册，无需移除机器人。

从 [OpenRouter](https://openrouter.ai/keys)（或任何兼容端点）获取 API 密钥。

```bash
git clone https://github.com/leinstay/neptunia.git
cd neptunia && npm install
cp .env.example .env
```

编辑 `.env`，填入你的 Discord token 和 API 密钥。创建 `config.local.json`，填入你的 Discord 用户 ID：

```json
{
  "bot": {
    "owners": ["YOUR_DISCORD_USER_ID"]
  }
}
```

```bash
npm start
```

当 `bot.guildId` 为空且机器人只在一个服务器中时，它会自动锁定到该服务器。如果机器人在多个服务器中，则拒绝启动。在 `config.local.json` 中设置 `bot.guildId`。

## 功能与变更

**14.10.2026**  
Recall 可以按语义搜索，而不仅仅按关键词（`features.meaningSearch`，默认关闭）。记录中的每条消息连同其上下文行一起嵌入，存储在按月的向量索引中。当有人提问时，提问者的消息被嵌入，最接近的记录行通过倒数排名融合加入关键词命中窗口。索引通过 `tools/embed-index.mjs` 构建，可选通过实时队列（`features.embedIndex`）保持最新。消息文本（含作者名）发送给嵌入提供商。

**13.10.2026**  
角色听到的每条消息和发出的每条消息都写入磁盘上的永久记录。当热记忆满了，一个回忆、兴趣或细节被挤出时，被淘汰的条目在离开前会复制到归档文件中。服务器搜索时，引擎在 Discord 自身搜索结果之外还会读取归档和最近几天的记录，使角色能找到即使已离开内存档案的信息。随时间变化的事实（正在玩的游戏、昵称、"今天是生日"的玩笑）带有日期：何时为真、何时不再为真、被什么替代。两个矛盾的开放声明并列显示，而非一个默默覆盖另一个。`/nep memory forget` 会将即将删除的所有内容复制到 `data/` 内的保险库目录，并将删除记录写入账本（`forgotten.json`），确保没有内容被不可恢复地丢失。

角色保持日志：每个回合一条记录，包含请求中包含了聊天的哪些内容、角色的隐藏推理、发布了什么以及 token 使用量，按天写入 `data/`。完整的模型请求和原始回复也会保存数天（`journal.keepRequests`），以便事后检查有问题的回复。`/nep status` 显示一张卡片，包含机器人状态、连接、模型、今日限额和记忆计数器；获授权的成员看到的卡片不含记忆字段。回填工具（`tools/backfill.mjs`）从旧消息填充角色的过去：将历史读入记录，提取回忆和教训，可选地将最重要的通过语音模型赋予角色自己的语言来表达感受。结果进入归档而非热记忆，通过 recall 浮出。

首次启动前从旧消息构建记忆的预热现已成为独立工具（`tools/warmup.mjs`），在机器人停止时运行。`/nep warmup` 已移除。`/nep memory refresh kind:channel` 和 `kind:server` 在运行中的机器人内从新鲜样本重写频道笔记或服务器笔记。

每个 `/nep` 子命令执行一个命名操作，读取和写入权限各自独立。所有者始终可以执行一切；其他人需要按名称获得操作授权，对组的授权只开放该时刻已存在的读取操作。新服务器上，成员只能使用 `/nep pings`，其余需所有者授权。仅所有者操作（访问授权、forget、wipe、日志、归档、快照和私有记忆）不会被任何授权开放。Mentor（`features.mentor`）已移除。`/nep ping` 和 `/nep reload` 已取消：连接检查在 `/nep status` 中，提示重载自动进行。

**12.10.2026**  
日记不再连续沉默几天：空窗口之后，当天晚些时候会有帖子。两种新的帖子类型一次携带四到六张图片：同一次外出的照片集（相同着装、相同时间），或 Neptunia 喜欢的任何东西的集锦（不限于自画像）。要求不被 ping 的成员会收到无通知的回复。

**11.10.2026**  
Neptunia 将自己在其他频道说过的内容周围几行保留三天。当新消息引用了其中一次交流（即使只是语义上的），它会基于实际进行过的对话来回答，而不是猜测，并且不会主动提起那些交流。

**06.10.2026**  
Neptunia 写日记: 在一个频道里自发发帖，无需任何人要求。帖子在可配置的时间窗口内随机出现，夹杂安静的日子。帖子种类多样: 场景绘画、表情包、思考、转述新闻、趣味冷知识、一行心情。每次发帖前，人格会回顾自己的历史，选择还没做过的事。部分帖子种类会触发网络搜索，用自己的话转述找到的内容。拥有者通过 `/nep diary set` 指定频道，通过配置调整时间表、帖子种类和权重。

**05.10.2026**  
Neptunia 能区分有人在和它说话还是在以第三人称谈论它。当对话中提到另一个频道时，即使是用文字提及而没有链接，它也会打开该频道并阅读包含图片在内的最新消息。如果有人在它没有发言权限的频道呼叫它，它会在主频道带着那条消息的链接回复。它还可以主动在主频道评论自己在无法发言的频道读到的内容。面向所有人的问题比针对某个特定人的问题更容易引起它的回应。它记住最近几天的重要事情: 别人送了什么或拜托了什么、自己承诺了什么、成员之间发生了什么。当有人问起某个人时，它会回忆起与那个人有关的往事。它搜索服务器旧消息的方式和搜索网络一样: 对于"我们新年做了什么"或"……是谁"之类的问题，它会找到相关的聊天记录并据此作答。

**04.10.2026**  
Neptunia 知道最近在其他频道发过的图片里有什么。

**03.10.2026**  
Neptunia 如果很久没有和某个人交流，对那个人的态度会逐渐恢复到中性。

**30.09.2026**  
Neptunia 会主动在消息中使用服务器的自定义表情。它从服务器上大家分享的 GIF 中挑选并发送。它能看懂 GIF 的内容。它知道今天的日期。

**29.09.2026**  
Neptunia 回复私信。在私信中被告知的内容不会出现在服务器频道里。它能看到消息上的表情反应。

**28.09.2026**  
Neptunia 可以应请求或主动绘画。它能画自己: 它有固定的外貌。

**26.09.2026**  
Neptunia 能看到转发消息中的图片和视频。它可以观看 YouTube 上的长视频。

**24.09.2026**  
Neptunia 会记住别人在聊天中教它的东西: 事实、规则、"我们这里是这么做的"。

**23.09.2026**  
Neptunia 观看视频: 附件和来自 YouTube、TikTok、VK、X (Twitter)、Reddit、Twitch 的链接都支持。如果有人问到它已经看过的视频中的某个细节，它会带着这个问题重看视频。它打开消息中的链接并阅读页面内容。当问题需要最新事实或有人直接让它去搜时，它会搜索网络。

**22.09.2026**  
Neptunia 即使没有 @提及或标签，也能从对话上下文判断出有人在和它说话。

**21.09.2026**  
Neptunia 能看到聊天中发送的图片。它能识别贴纸、服务器自定义表情和链接预览(站点标题和描述)。如果消息附带了它无法打开的内容，比如文件或语音消息，它知道附件存在，不会假装自己看过。它理解转发消息: 原始发送者是谁、内容是什么。它记住与人之间的具体时刻: 谁说了什么或做了什么，它对此有何想法。它记录服务器的梗和故事。它记住一个人的爱好和相关事实，但只记那些出现过不止一次的。它也记住昵称: 成员们怎么互相称呼。

**20.09.2026**  
Neptunia 在被呼叫时回答: 通过 @提及、回复它的消息、或在文本中直接叫它的名字。没人叫它时，它也可以主动在频道中发言。别人在聊天时如果它有话想说，它可以加入对方的对话。它也可以无视消息，就像一个人看到了但选择不回复。回复不是即时的: 会显示"正在输入..."，回复可能分成几条短消息，有时它会用表情反应代替文字。它记住每个成员: 他们是什么样的人、怎么说话。它对每个人的态度不同，这个态度取决于别人和它交流的方式。它能判断一个频道是正在活跃聊天还是沉寂。它知道服务器有哪些频道以及每个频道的主题。首次启动时，它会读取服务器的历史消息，构建对人和频道的初步认知，这样就不用从零开始。

## 提示层

提示从两个目录加载：

- `prompts/`：附带可用示例角色的引擎默认值（随仓库追踪）。
- `prompts.local/`：你的角色定义（已加入 gitignore）。此目录下的文件会替换 `prompts/` 中的同名文件。`labels.json` 和 `skills.json` 采用深度合并，只需覆盖需要更改的键即可。

两者均支持热重载。

你必须重写的唯一文件是 `character-card.md`。将其复制到 `prompts.local/` 并编写你的角色。其他内容可直接使用，也可按需覆盖单个文件。

提示文件、占位符、标签、上下文块和输出标签均在 [`prompt-contract.md`](prompt-contract.md) 中定义。

## 配置

`config.json` 包含所有设置及其默认值。`config.local.json`（已加入 gitignore）会深度合并覆盖。两者均支持热重载。完整配置参考请参阅 [`configuration.md`](configuration.md)。

## 预热

预热从近期消息样本构建对人、频道和服务器的记忆。在首次启动前，停止机器人后通过运维工具 `tools/warmup.mjs`（`run`、`users`、`channels`、`server`、`people`、`status`、`reset`）运行：打印估算并在未提供 `--spend` 时拒绝执行，进度保存在 `data/state.json` 中，中断的运行可恢复。总 token 消耗受 `warmup.maxTokens` 限制。机器人不会运行预热；工具自行恢复未完成的运行。之后可通过 `/nep memory refresh` 按需从新鲜样本重写成员画像、频道笔记或服务器笔记。详见 [`warmup.md`](warmup.md)。

## 试运行

设置 `features.dryRun: true` 后，机器人运行完整流程（记忆、触发、LLM 调用）但不发送任何消息或反应。输出写入日志（`dry-run: would send` / `dry-run: would react`）。将 `bot.dryRunChannelId` 设为一个私有频道以获得可读的镜像输出；该频道中的所有消息会被机器人忽略。斜杠命令在任何频道均可使用，包括镜像频道，因为它们不是消息。

在新服务器上首次运行：启用 `features.dryRun`，观察镜像频道或 `journalctl -u neptunia-bot -f`，实时调整，然后执行 `/nep set features.dryRun false`。

## 命令

Discord 斜杠命令只有一个：`/nep`（名称来自 `bot.commandName`），注册为服务器命令。所有回复仅调用者可见（ephemeral），不论在哪个频道。

19 个顶层条目：

- `status` 显示机器人状态、连接、模型、限额和记忆计数器的卡片
- `set` / `unset` 覆盖或移除 config.local.json 中的配置值
- `pause` / `resume` 停止活动并刷盘，以便手动编辑 data/
- `draw` 在当前频道画一张图
- `pings` 让成员选择是否收到角色消息的通知
- `talk` 让角色在频道中插话或发起话题
- `media` 管理自定义表情排名和 GIF 库（status、rescan、recache）
- `model` 显示或设置各角色的模型
- `route` 按模型前缀和角色管理 provider 路由
- `rule` 添加、列出或移除 `prompts.local/rules.md` 中的修正
- `access` 为身份组和用户授予或撤销操作
- `skill` 允许、禁止或列出角色的技能
- `diary` 设置、查看或关闭日记，发布条目
- `alias` 添加或移除成员昵称
- `learning` 添加或移除所学内容
- `lore` 添加、列出、查看或移除世界书条目
- `memory` 覆盖档案、频道、服务器笔记、态度、画像刷新、forget、wipe、日志、归档、恢复、快照和私有记忆

所有者（`bot.owners`）可执行一切。其他人需要对确切操作的授权；读取和写入是独立的操作，对组或 `*` 的授权只开放该时刻已存在的读取操作。新服务器上成员只能使用 `pings`，其余需所有者授权。仅所有者操作（访问授权、forget、wipe、日志、归档、快照和私有记忆）不可被任何授权开放。完整命令表和访问模型参见 [`owner-commands.md`](owner-commands.md)。

## 消息与记忆

角色响应提及、回复和名字触发，有时选择无视。随机插入对话，在安静的频道发起话题，也可能对面向全体的问题作出回应。回复某人后，通过分类器追踪该频道的后续消息。整个服务器同一时间只写一条回复；其他频道的提及挂起后依次处理，每个频道和作者可挂起任意数量，最多 `mention.maxPending`（默认 6）个。当一条消息包含多个独立的请求时，每个请求在自己的回合中回答。当有人又发了一条关于仍在等候的内容的消息时，它会被折叠进那个条目而非单独排队。当有人提到另一个频道时，分类器会选出该频道，使角色能够阅读它。

独立的记忆分析器在消息累积到一定量时运行。它为每个成员建立档案，包含兴趣、细节、别名、回忆和态度，以及服务器级的习惯、内部梗、事件故事的世界书，还有人们直接教给角色的东西（词语、事实、请求）。档案增量更新；已存储的事实不会被重新概括。角色还会学习人们怎么互称，通过名字或别名认出成员。所学内容存储在服务器级别（`memory.maxLearned` 个显示，`memory.maxLearnedStored` 个保留在磁盘上，`memory.learnedChars` 字符/条目），始终出现在提示中。

详见 [`messages-and-memory.md`](messages-and-memory.md)。

## 媒体

角色可以看到附加图片、观看短视频片段、阅读链接后的页面、搜索网络和服务器自身的消息历史以获取它没有的事实、应请求通过图像生成模型绘制图片，以及从聊天中大家分享的 GIF 中挑选并发送。每种能力是一个独立的功能开关，默认关闭或有上限，各自有每日限制。每个请求中的 `<senses>` 块告知角色当前什么是开启的；它不会声称感知了超出此块描述的任何东西。详见 [`media.md`](media.md)：图片、视频视觉、链接阅读、搜索、绘画、工具、成本和隐私。

## 私聊

`features.privateMessages`（默认关闭）允许公会成员通过 Discord 私信与角色交谈。角色不变，公共记忆不变；私信中说的话记忆在每成员的私有层中，其他对话不可见。私信需要同一服务器成员身份，无需邀请 URL 已授予权限之外的额外权限。门控、私有记忆层和所有者命令的详情参见 [`messages-and-memory.md`](messages-and-memory.md#私有层)。

## 成本

每个回合消耗一次 LLM 请求；记忆更新再加一次。分拆消息分类器和合并分类器在条件满足时各可增加一次 `analyzer` 角色请求。成本取决于模型和端点；`roles.*` 和 `llm.baseUrl` 接受任何兼容值。每日上限（`llm.maxRequestsPerDay`）防止超支。视频描述每个片段向更便宜的独立模型发一次请求（`media.video.maxPerDay` 限制每日数量）；`yt-dlp` 和 `ffmpeg` 在本地运行，只消耗带宽。链接阅读和网络搜索（`features.webLookup`，默认关闭）向文本分类器发请求，受 `web.maxPerDay` 限制；网络搜索还需要 Brave Search API 密钥（免费层：每月 2,000 次查询）。服务器消息历史搜索（`features.recall`，默认开启）使用 Discord 内置的搜索 API，只增加分类器和摘要请求。图像生成（`features.imageGeneration`，默认关闭）通过 `image.model` 按输出 token 计费；`image.maxPerDay` 独立于聊天请求限制每日数量。私聊（`features.privateMessages`，默认关闭）使用同样的 LLM 和上限；每条 DM 回复是一次请求，每个私有分析器批次是另一次。启用 `features.webLookup` 后，机器人会发出 HTTP 请求获取页面和访问 Brave Search API；私有地址拒绝访问。

`data/` 存储成员档案、关系分数、频道观察、服务器规律、媒体描述和网页摘要的缓存。全部保留在你的机器上，已加入 gitignore，仅作为上下文发送给 LLM。分析器被指示不存储敏感信息。`/nep memory forget` 可完全删除某人的档案。

请告知服务器成员。他们应该知道自己的消息会被 LLM 处理，且机器人会保留笔记。

## 服务

示例 systemd 单元文件在 `deploy/neptunia-bot.service`。调整 `WorkingDirectory` 和 `User`，然后安装：

```bash
sudo cp deploy/neptunia-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now neptunia-bot
```

私有层与代码放在一起：`.env`、`config.local.json`、`prompts.local/`、`data/`。更新方法：

```bash
git pull && sudo systemctl restart neptunia-bot
```

重启不会丢失任何数据；所有状态都在磁盘上。仅在 `src/` 下的代码变更后才需要重启。提示和配置的编辑会实时生效。

记忆保存在进程中并写入 `data/`；运行时直接编辑这些文件不安全，下一次写入会覆盖更改。手动编辑记忆的方法：`/nep pause`，编辑文件，`/nep resume`。暂停会停止所有活动，将记忆刷入磁盘并卸载。状态会被持久化：重启后仍保持暂停状态。`/nep resume` 会验证 `data/` 下的每个 JSON 文件，如果有任何文件无法解析则拒绝恢复并指出哪些文件有问题；否则重新加载记忆并继续。暂停期间只读和配置命令仍可使用；写入记忆的命令会被拒绝。`/nep status` 会显示暂停状态。

## 参与贡献

欢迎提交 issue 和 pull request；请先阅读 `CONTRIBUTING.md`。目标分支为 `main`，每个 pull request 只包含一项变更，`npm test` 测试通过，仅限英语。提示文件与代码之间的契约在 `docs/zh/prompt-contract.md` 中。一方的变更需要在同一个 pull request 中同步另一方。引擎保持角色中立；特定角色的行为属于该部署的 `prompts.local/`。安全报告通过 `SECURITY.md` 提交，不使用公开 issue。

## 测试

```bash
npm test
```

使用 `node --test` 运行。无需网络或 Discord 连接。同一命令在每次 pull request 时在 CI 中运行。

## 结构

```
config.json                所有设置及其默认值，热重载
.env.example               DISCORD_TOKEN、OPENROUTER_API_KEY 和可选的 YOUTUBE_API_KEY、BRAVE_SEARCH_API_KEY 的模板
prompts/
  system-prompt.md         如何表现得像普通聊天成员
  character-card.md        角色定义（可用示例）
  rules.md                 所有者的实时修正
  format.md                模型使用的输出标签
  reply.md                 任务：有人呼叫了你
  interject.md             任务：插入对话
  initiate.md              任务：发起话题
  forced.md                强制回合（/nep talk interject、/nep talk initiate）时追加
  private.md               私信回合（features.privateMessages）时追加
  memory.md                记忆分析器的提示
  diary.md                 任务: 写日记帖子
  diary-plan.md            日记计划器: 选择下一篇帖子的种类和主题
  world.md                 角色的虚拟世界（仅用于日记帖子）
  diary-seeds.md           日记计划器的随机种子族
  draw.md                  绘画子进程的提示（图像生成）
  appearance.md            自画像用的角色外貌
  describe.md              媒体描述器的提示
  describe-video.md        视频描述器的提示
  describe-gif.md          GIF 描述器的提示
  rewatch.md               分类器：是否需要重看视频
  rewatch-answer.md        重看回答的提示
  address.md               后续消息分类器
  lookup.md                分类器：问题是否需要网络或服务器搜索
  read-link.md             浓缩获取的页面
  search-summary.md        浓缩网络搜索结果
  recall-summary.md        浓缩服务器消息历史搜索结果
  room.md                  分类器：这条消息是面向所有人还是面向特定人
  route-channel.md         分类器：回答是否需要查看另一个频道
  planner.md               回合规划器：回复前的一次辅助调用 (features.turnPlanner)
  elsewhere.md             任务：在主频道评论只读频道中的内容
  split.md                 分类器：直接呼叫是否包含多个独立请求
  merge.md                 分类器：新消息是否属于已在等候的条目
  profile.md               预热：从消息样本生成一个成员的档案
  channel.md               预热：从消息样本生成频道笔记
  server.md                预热：从频道笔记和成员摘要生成服务器级笔记
  labels.json              代码插入提示中的所有字符串
  skills.json              角色的技能文本（title、whenToUse、whenNotToUse）
prompts.local/             你的角色定义（已加入 gitignore）
interfaces/
  discord/                 the Discord interface (@neptunia/interface-discord): the Discord adapter of the interface port, message normalization, history, permissions, searches and slash commands
    guild.js               单服务器解析
    commands.js            斜杠命令，注册，交互适配器
    collect.js             频道历史，相邻频道，权限
    search.js              Discord 消息搜索和成员搜索
    pull-fetch.js          受众检查，拉取频道获取
docs/
  en/
    prompt-contract.md     提示文件与代码之间的契约
    configuration.md       所有配置键的完整参考
    owner-commands.md      所有子命令和访问授权
    warmup.md              预热：阶段、进度、限制、命令
    media.md               图片、视频、链接、搜索、工具、成本
    messages-and-memory.md 流程、分析器、档案、回忆、世界书
    diary.md               日记功能: 设置、窗口、成本、调优
  zh/                      中文
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
    diary.md
  ja/                      日文
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
    diary.md
  ru/                      俄文
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
    diary.md
src/
  index.js                 入口，组装，定时器，关闭
  config.js                .env 解析器，配置加载器，deepMerge
  hot.js                   通过 fs.watch 实时更新的配置和提示
  log.js                   结构化 JSON 日志
  format.js                对话记录行，时间间隔，节奏
  admin.js                 所有者命令
  ops/
    grants.js              非所有者的按命令访问授权
  llm/
    tokens.js              带自校准的 token 估算
    budget.js              按优先级裁剪区块
    openrouter.js          聊天补全，安全限制
    parse.js               输出标签转为动作
  media/
    classify.js            媒体分类，标签选择，代理 URL
    video-sites.js         视频站点匹配、URL 缓存键、yt-dlp/ffmpeg 参数
    fetch-image.js         下载并缓存图片供 LLM 内联请求使用
    fetch-video.js         下载、探测和裁剪视频供视频描述器使用
  web/
    readable.js            HTML 转文本，付费墙检测
    fetch-page.js          SSRF 防护的页面抓取器
    brave.js               Brave Search 客户端
    lookup.js              链接阅读和网络搜索
  behavior/
    pipeline.js            消息流水线
    mention.js             呼叫检测，忽略启发式
    prompt.js              带 token 预算的请求构建器
    turn.js                一个回合：收集、构建、调用、执行
    diary.js               日记调度器、日计划、回填
    spontaneous.js         混沌定时器，窃听，面向全体的问题
    split.js               纯函数：任务分拆预过滤和回答解析
    pending.js             挂起的呼叫，合并回答解析，折叠
    private.js             纯函数：DM 门控，合并档案，有效好感度
    limits.js              纯函数：限制和暂停通知
    recall.js              纯函数：服务器历史搜索决策
    recall-run.js          recall 执行器：Discord 搜索，窗口，摘要
    route.js               纯函数：频道路由决策
    route-channel.js       频道路由分类器：为回合选择频道
    elsewhere.js           纯函数：只读频道中的注意到的评论
  memory/
    store.js               JSON 文件持久化，原子写入
    update.js              批量记忆更新
    affinity.js            关系分数逻辑
    interests.js           记住的兴趣：观察、确认、淘汰
    details.js             记住的细节：观察、确认、淘汰
    aliases.js             记住的别名：观察、确认、淘汰
    episodes.js            记住的回忆：追加、按权重淘汰
    channels.js            频道地图渲染，活跃度判定
    mentions.js            存储文本中的成员 id 标记：toTokens 和 fromTokens
    clamp.js               文本截断：软限制、句子边界、完整的成员标记
    ranking.js             兴趣和细节的共享排名：频率、近期程度、衰减
    lore.js                世界书逻辑：关键词匹配、条目选择
    recent.js              近期记事：最近几天的短事件
    describe.js            媒体描述器：一张图片进，一条缓存的描述出
    portrait.js            定期画像刷新调度器
    youtube-check.js       YouTube 时长探测和 API 密钥检查
    warmup.js              基于样本的记忆预热
tests/                     node --test，纯函数单元测试
deploy/
  neptunia-bot.service     systemd 单元示例
data/                      持久状态（已加入 gitignore，运行时创建）
  state.json               调度时间、token 校准、每日计数器、预热进度、发布账本
  guilds/<id>/guild.json   服务器习惯、内部梗、角色的自述
  guilds/<id>/buffer.json  自上次记忆更新以来观察到的消息
  guilds/<id>/media.json   媒体描述缓存
  guilds/<id>/gifs.json    GIF 库：handle、URL、使用计数
  guilds/<id>/diary.json   日记帖子历史（一行摘要）
  guilds/<id>/recent.json  分析器的近期记事
  guilds/<id>/users/       每成员档案和关系
  guilds/<id>/private/     每成员私聊记忆
  guilds/<id>/channels/    分析器的频道观察
  guilds/<id>/lore.json    世界书条目
```
