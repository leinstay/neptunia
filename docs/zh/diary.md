# 日记

角色在一个频道中按随机时间自发发帖，无需任何人要求。帖子形式类似个人动态: 角色世界中的场景绘画、表情包、思考、转述新闻、趣味冷知识、一行心情。每次发帖前角色会回顾自己的历史，选择还没做过的事。拥有者指定频道，通过配置调整时间表和种类。

## 设置

1. 在服务器上创建一个频道。机器人需要 View Channel、Send Messages、Read Message History 和 Attach Files 权限。
2. 执行 `/nep diary set <channel>`。命令会检查权限，将 `diary.channelId` 写入 `config.local.json`，历史为空时从角色在该频道的过去帖子中回填。
3. 日记从下一次心跳（每 30 秒）开始发帖。首篇帖子可能需要几分钟，取决于下一个时间槽何时到来。

`/nep diary show` 显示今日计划: 频道、`bot.timezone` 中的时间槽、今日已用帖子和图片数、历史大小。

`/nep diary off` 清除频道。历史文件保留，重新启用时保持对过去帖子的记忆。

`/nep diary post [kind] [topic]` 在计划外立即强制发布一篇帖子。如有回合正在运行，命令等待 `diary.forceWaitMs`（120000 ms，两分钟）至其完成；超时后回复 `busy`。日次上限仍然适用。可选种类键（如 `selfPicture`, `thought`）覆盖计划器的选择；未知种类会列出所有种类后拒绝。可选自由文本主题将帖子引向该题材。

## 窗口

发帖时间从窗口中抽取: 每个窗口是 `bot.timezone` 中的时间范围，带 `[min, max]` 帖子数。`to` 不大于 `from` 的窗口跨越午夜。对于每个窗口，调度器在 `min` 和 `max` 之间抽取一个整数，在窗口内的随机时间放置相应数量的时间槽。距离小于 `diary.minGapMinutes`（90）的时间槽被丢弃，超过 `diary.maxPerDay`（3）时随机丢弃多余的。

默认的四个窗口（均为 `bot.timezone`）:

| 窗口 | 时间 | 帖子 |
|---|---|---|
| 早晨 | 07–11 | `[0, 0]`（关闭） |
| 白天 | 12–16 | `[0, 1]` |
| 晚上 | 18–01 | `[0, 2]` |
| 深夜 | 01–05 | `[0, 1]` |

`diary.quietDayChance`（0.3）的概率使一整天没有时间槽。计划在每个本地日（`bot.timezone` 的日期）创建一次，存储在 `data/state.json` 中。新的一天创建新计划；重启保留现有计划。

超过 `diary.slotGraceMinutes`（30）分钟未触发的时间槽（机器人关机期间）被丢弃，不会延迟触发。被忙碌注意力阻塞的时间槽在宽限期内下次心跳重试。

## 帖子成本

每篇日记帖子由两个模型请求组成:

1. `reasoner` 角色上的计划请求: 选择种类、一行简述、是否搜索、是否绘画。
2. `voice` 角色上配合角色卡和所有记忆块的生成请求。

当计划要求网络搜索时（仅限 `diary.searchKinds`，默认 `news` 和 `facts`），Brave 搜索先运行，增加第三个请求（`reasoner` 角色上的浓缩器）。搜索计入 `web.maxPerDay`。

帖子包含图片时，图像模型按自身价格生成。日记图片同时计入 `image.maxPerDay` 和 `diary.maxPicturesPerDay`（2）。

日记帖子的所有模型请求计入 `llm.maxRequestsPerDay`。默认设置下（每天 1–3 篇帖子，每篇 2–3 个请求，最多 2 张图片），一天大约花费 3–9 个聊天请求加上图片生成。

## 种类与种子

`diary.kinds` 将每个种类键映射到权重。计划器看到权重和最近 `diary.historyPosts` 篇帖子中每种类型的使用次数，因此偏好使用较少的种类。权重为 0 的种类永不被选择。键和默认值:

| 种类 | 权重 | 含义 |
|---|---|---|
| `selfPicture` | 3 | 角色在场景中，每次新场景 |
| `picture` | 2 | 没有角色的绘画: 地点、动物、关于某人的事 |
| `meme` | 1 | 角色画的表情包 |
| `thought` | 2 | 较长的思考、评论、观点 |
| `people` | 2 | 关于服务器某个人的帖子: 最近做了什么或说了什么，角色对此人的看法 |
| `news` | 2 | 在互联网上找到的服务器成员感兴趣的内容 |
| `facts` | 1 | 趣味冷知识、冰山条目、以阴谋论方式讲述的阴谋论 |
| `status` | 3 | 一行: 心情、计划、无聊 |

`diary.searchKinds`（默认 `["news", "facts"]`）决定哪些种类可以触发搜索。`diary.pictureKinds`（默认 `["selfPicture", "picture", "meme"]`）决定哪些种类在日次图片上限允许时始终带图，无论计划器如何回答。其余种类仅在计划器要求时才绘制。帖子无法包含图片时（日次图片上限已用尽、绘画关闭、无图像模型、或机器人在日记频道缺少 Attach Files 权限），计划器只看到文本种类。通过 `/nep diary post` 强制图片种类会在任何请求前被拒绝: 上限导致时回复中列出上限及其数量，否则显示 `pictures`。

`prompts/diary-seeds.md` 包含按 `# family` 标题（place, setting, detail, activity, subject, twist）分组的随机种子。代码从每个族中抽取一行，组成 `diary.seedSets`（2）个组合，通过 `<seeds>` 块传给计划器。组合数量几乎无限；计划器从中构建日记历史中没有的内容，或在服务器生活提供更好想法时忽略它们。

要自定义种子，将 `prompts/diary-seeds.md` 复制到 `prompts.local/diary-seeds.md` 并编辑行。标题下的每行是一个种子；空行被忽略。

## 角色的世界

`prompts/world.md` 描述角色的虚拟世界: 聊天之外的地点和日常。跟踪文件是一个中性示例。要写自己的，创建 `prompts.local/world.md`（像 `appearance.md` 一样完全替换跟踪文件）。

世界块仅在日记的两个请求（计划和生成）中出现，且仅当 `diary.world === true`（默认 `false`）。通过 `/nep set diary.world true` 开启。没有它，角色没有固定住所，也不会声称有。

世界文件不会出现在普通聊天回合中。角色在 `<draw>` 标签中写的场景文本承载了图像模型需要看到的信息。

## 配置参考

所有键列在[配置: diary](configuration.md#diary)中。
