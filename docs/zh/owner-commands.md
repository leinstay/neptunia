# 命令

一个斜杠命令 `/nep`，含 19 个顶层条目。所有回复均为 ephemeral（仅调用者可见）。频道、身份组和用户从 Discord 自带的选择器中选取。部分选项支持自动补全：`set`/`unset` 自动补全 `path`，`access grant`/`access revoke` 自动补全 `command`，`model set` 自动补全 `id`（当前使用的模型 ID），`route set`/`route remove` 自动补全 `model`，`memory restore` 自动补全 `id`（最新的归档条目）。

## 访问控制

`/nep` 从一开始就对所有成员可见。访问权限在命令执行时按操作逐一检查，不通过 Discord 的命令可见性控制。每个命令执行一个命名操作。读取和修改是分离的：`/nep memory show` 执行 `memory.profile.read`，`/nep memory affinity <user>` 执行 `memory.affinity.read`，而 `/nep memory affinity <user> <score>` 执行 `memory.affinity.set`。

所有者（`bot.owners`）始终可以执行一切。其他人需要对确切操作的授权。`/nep access grant <operation> [role] [user]` 将一个操作（如 `memory.profile.read`）开放给所有人（不指定身份组/用户）、某个身份组或某个用户。可以指定组名（如 `memory`）或 `*`，但授权会记录为该时刻存在的各个读取操作，每个单独一条：它不会开放写入操作，后续新增的操作在按名称授权前保持关闭。`/nep access revoke` 从一个操作中移除目标，或从组或 `*` 下的所有已记录操作中移除。`/nep access list` 显示每个操作、持有者以及授权的来源（当它是组或 `*` 展开的一部分时）。没有授权的非所有者会收到 ephemeral 回复 "Not allowed"。

仅所有者操作（`access.*`、`diary.*`、`memory.private.*`、`memory.journal.read`、`memory.snapshot`、`memory.forget`、`memory.wipe`、`memory.archive.read`、`memory.restore`）不会被任何授权（包括 `*`）开放。

**从旧命令键迁移。** 在引入操作式访问控制后的首次启动时，所有已存储的授权会一次性转换：旧命令键变为它所执行的操作；旧组或 `*` 展开为它所覆盖的读取操作；仅所有者操作被移除。日志中的 `system` 记录 `access-migrated` 列出了每个旧授权现在覆盖的内容。迁移后执行：`/nep access revoke * everyone`，然后 `/nep access grant memory.profile.read everyone`，再按名称重新授权其他需要的操作（用 `/nep access list` 检查）。

## 状态

`/nep status` 显示一张包含最重要字段的卡片：机器人状态（运行中或从何时起暂停）、网关连接、长时间任务（预热、回填、归档排空）、各角色的模型、今日每日限额（请求、图片、视频、recall、lookup）和运行时长。`/nep status detail` 在卡片下方添加详细文本：模型校准、预热进度、每个已加载提示及其来源、语音队列。被授予 `status.show` 的成员看到的卡片不含记忆和日志字段，也看不到详细文本。

## 命令表

| 命令 | 操作 | 回复 | 功能 |
|---|---|---|---|
| `/nep status [detail]` | `status.show` | ephemeral | 机器人当前状态：一张卡片 |
| `/nep set <path> <value>` | `config.set` | ephemeral | 覆盖 config.local.json 中的配置值；`path` 自动补全 |
| `/nep unset <path>` | `config.unset` | ephemeral | 移除配置覆盖；`path` 自动补全 |
| `/nep pause` | `bot.pause` | ephemeral，延迟 | 暂停角色并刷盘，以便手动编辑 data/ |
| `/nep resume` | `bot.resume` | ephemeral，延迟 | 暂停后恢复；data/ 中有无效文件则拒绝 |
| `/nep draw <text> [self]` | `draw.create` | ephemeral，延迟 | 在当前频道画一张图。消耗余额 |
| `/nep talk <action:interject\|initiate> [channel]` | `talk.interject`, `talk.initiate` | ephemeral，延迟 | 让角色立即发言 |
| `/nep media <kind:emoji\|gifs> <action:status\|rescan\|recache>` | `media.status`, `media.rescan`, `media.recache` | ephemeral，`media.rescan` 延迟 | 自定义表情排名和 GIF 库 |
| `/nep model show` | `model.show` | ephemeral | 显示各角色的模型 |
| `/nep model set <role:voice\|analyzer\|classifier.text\|classifier.media\|classifier.video\|image> <id>` | `model.set` | ephemeral | 设置角色的模型；`id` 自动补全 |
| `/nep route list` | `route.list` | ephemeral | 所有路由，然后是各角色的当前模型和路由 |
| `/nep route set <model> <providers> [role:voice\|analyzer\|classifier.text\|classifier.media\|classifier.video\|image] [fallbacks]` | `route.set` | ephemeral | 将模型前缀路由到指定 provider；`model` 自动补全 |
| `/nep route remove <model> [role:voice\|analyzer\|classifier.text\|classifier.media\|classifier.video\|image]` | `route.remove` | ephemeral | 移除路由；`model` 自动补全 |
| `/nep rule add <text>` | `rule.add` | ephemeral | 添加规则 |
| `/nep rule list` | `rule.list` | ephemeral | 列出编号的规则 |
| `/nep rule remove <number>` | `rule.remove` | ephemeral | 按编号移除规则 |
| `/nep access grant <command> [role] [user]` | `access.grant` | ephemeral | 将操作、组或 * 开放给所有人、身份组或用户；`command` 自动补全 |
| `/nep access revoke <command> [role] [user]` | `access.revoke` | ephemeral | 从所有人、身份组或用户撤销操作、组或 *；`command` 自动补全 |
| `/nep access list` | `access.list` | ephemeral | 列出所有访问授权 |
| `/nep warmup run` | `warmup.run` | ephemeral，延迟 | 启动或恢复运行：频道、人物、服务器 |
| `/nep warmup users [user]` | `warmup.users` | ephemeral，延迟 | 为一个成员重新生成档案，或在后台处理所有符合条件的 |
| `/nep warmup channels [channel]` | `warmup.channels` | ephemeral，延迟 | 重新描述一个频道，或所有可读频道 |
| `/nep warmup server` | `warmup.server` | ephemeral，延迟 | 重建服务器级笔记和世界书 |
| `/nep warmup people` | `warmup.people` | ephemeral，延迟 | 当前符合采样条件的成员 |
| `/nep warmup status` | `warmup.status` | ephemeral，延迟 | 阶段、进度、token 使用量和下一目标 |
| `/nep warmup stop` | `warmup.stop` | ephemeral，延迟 | 取消预热工作（包括进行中的模型调用） |
| `/nep warmup reset` | `warmup.reset` | ephemeral，延迟 | 清除预热进度，不删除已写入的记忆；运行中拒绝 |
| `/nep diary set <channel>` | `diary.set` | ephemeral，延迟 | 设置日记频道 |
| `/nep diary show` | `diary.show` | ephemeral | 今日日记状态 |
| `/nep diary off` | `diary.off` | ephemeral | 停止日记 |
| `/nep diary post [kind] [topic]` | `diary.post` | ephemeral，延迟 | 立即发布一篇 |
| `/nep alias add <user> <name>` | `alias.add` | ephemeral | 添加或强化别名 |
| `/nep alias remove <user> <name>` | `alias.remove` | ephemeral | 移除别名 |
| `/nep learning add <text>` | `learning.add` | ephemeral | 添加或强化所学内容 |
| `/nep learning remove <number>` | `learning.remove` | ephemeral | 删除所学内容 |
| `/nep lore add <title> <keys> <text> [always]` | `lore.add` | ephemeral | 添加或覆盖世界书条目（变为所有者条目） |
| `/nep lore list [query]` | `lore.list` | ephemeral | 列出条目（可筛选） |
| `/nep lore show <id>` | `lore.show` | ephemeral | 显示完整条目 |
| `/nep lore remove <id>` | `lore.remove` | ephemeral | 删除条目 |
| `/nep memory show <user> [section:summary\|character\|style\|relationship\|affinity\|aliases\|interests\|details\|episodes\|raw] [limit] [order:rank\|recent]` | `memory.profile.read` | ephemeral | 显示成员的存储档案 |
| `/nep memory channel [channel]` | `memory.channel.read` | ephemeral | 频道笔记或所有频道列表 |
| `/nep memory server` | `memory.server.read` | ephemeral | 服务器笔记：模式、开场白、内部梗、自述事实 |
| `/nep memory recent` | `memory.recent.read` | ephemeral | 实时近期记事行（从新到旧） |
| `/nep memory refresh <user>` | `memory.refresh` | ephemeral，延迟 | 立即刷新成员画像 |
| `/nep memory forget <user>` | `memory.forget` | ephemeral，延迟 | 删除成员的档案和私有记忆 |
| `/nep memory affinity <user> [score] [reason]` | `memory.affinity.read`, `memory.affinity.set` | ephemeral | 查看或设置态度分数 |
| `/nep memory wipe <confirm>` | `memory.wipe` | ephemeral，延迟 | 删除服务器的所有记忆（档案、私有记忆、习惯、频道、世界书） |
| `/nep memory journal [day] [kind:turn\|action\|memory\|system\|all] [n]` | `memory.journal.read` | ephemeral | 日志记录 |
| `/nep memory archive [user] [kind] [n]` | `memory.archive.read` | ephemeral，延迟 | 归档的条目 |
| `/nep memory restore <id>` | `memory.restore` | ephemeral，延迟 | 恢复一个归档条目；`id` 自动补全 |
| `/nep memory snapshot` | `memory.snapshot` | ephemeral，延迟 | 为工具做 data/ 快照 |
| `/nep memory private <action:show\|forget\|purge> <user>` | `memory.private.read`, `memory.private.forget`, `memory.private.purge` | ephemeral，`memory.private.forget`、`memory.private.purge` 延迟 | 成员的私有记忆：在私信中说过什么 |

## 记忆命令

`/nep memory show` 显示成员的存储档案：紧凑摘要或特定部分（character、style、relationship、affinity、aliases、interests、details、episodes 或原始 JSON）。`/nep memory channel` 显示频道笔记或所有频道列表。`/nep memory server` 显示服务器的模式、开场白、内部梗和自述事实。

`/nep memory forget` 删除成员的公共档案、私有私信文件、语音队列条目、版本历史、记录和归档条目。删除前将所有内容复制到保险库目录（`memory.vaultDir`，默认 `data/vault/`），并将成员 ID 写入 `data/guilds/<id>/forgotten.json`。引擎不会读取保险库；要恢复成员，请手动复制文件并从 `forgotten.json` 中移除条目。`/nep memory wipe` 对整个服务器记忆做同样的事：将公会目录下的所有内容复制到保险库，然后删除档案、私有文件、频道、习惯、世界书、日志、记录、归档、语音队列、版本、日记历史和 recall 追踪。

`/nep memory journal` 显示角色按 UTC 天的日志记录，可按种类筛选（turn、action、memory、system）。`/nep memory archive` 显示归档条目，可按成员或种类筛选。`/nep memory restore` 将归档条目放回热记忆（`id` 从最新条目自动补全）。`/nep memory snapshot` 将 `data/` 复制到带时间戳的目录供测量工具使用。

`/nep memory private show` 显示成员的私有私信记忆。`/nep memory private forget` 仅删除私有文件，公共档案保留。`/nep memory private purge` 删除私有文件，并批量删除机器人发给该成员的私信（最多 `private.purgeMaxMessages` 条）。

## 成员命令

`/nep pings` 是所有服务器成员无需 `bot.access` 授权即可运行的唯一命令。`features.memberCommands: false` 将其限制为仅限所有者。

| 命令 | 说明 |
|---|---|
| `/nep pings [mode]` | 查看或更改角色的消息是否通知你。不带 `mode`：显示当前设置。`on` / `off`：设置偏好。关闭时，对你消息的回复不带回复提醒，角色文本中对你的 @提及仍然显示但不发送通知。角色的措辞不受影响。仅自己可见的回复：`Pings: on` 或 `Pings: off`。按服务器存储，重启后保留，仅 `/nep memory wipe` 时清除 |
