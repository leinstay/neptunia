# 接口：核心与适配器之间的协议

引擎有两个方面：核心（角色、它的记忆、它关于何时以及如何发言的决策）和接口（它所在的聊天平台）。接口适配器将平台上发生的事件转换为核心的入站事件，并执行核心返回的动作。每个动作都有一个结果。两方之间的契约位于 `packages/protocol/`（`@neptunia/protocol`）中：纯对象，无构建步骤，无依赖，两侧都没有平台类型。

| 文件 | 内容 |
|---|---|
| `packages/protocol/events.js` | 入站事件的种类及其形状 |
| `packages/protocol/actions.js` | 动作名称、结果形状和端口辅助函数（`ok`、`notOk`、`mentionsOf`、拒绝、`declaredHooks`） |
| `packages/protocol/validate.js` | `validateEvent(event)` 和 `validateAction(action)` |

引擎通过 `src/protocol.js` 导入该包（当包成为 npm workspace 时切换到裸 `@neptunia/protocol` 指定符的唯一位置）；`src/interface/port.js` 重新导出出站部分。Discord 适配器是 `interfaces/discord/`（`@neptunia/interface-discord`，通过 `src/interface/discord.js` 访问）包：`port.js`（动作）与 `collect.js` 中的事件构建器（`toEvent`、`reactionEvent`）；测试用的内存适配器是 `src/interface/fake.js`。

核心仅通过组合根提供的内容访问 Discord。除端口外，`createDiscordInterface({ client })` 返回一个冻结的 capabilities 对象：核心按名称向 Discord 询问的函数（角色能否在频道中读取、发送、附加或反应，频道历史，要显示的另一个频道，服务器消息和成员的搜索，消息与协议事件之间的转换）。`src/index.js` 一次性构建它并作为 `discord` 传递给每个需要它的模块：通过选项传给工厂，通过环境（`env.discord`）传给操作，作为参数传给纯辅助函数。`src/` 下没有其他文件导入 Discord 接口，因此测试或工具可以传入相同的函数或其伪造版本。

## 规则

- ID 是不透明的字符串。对话、消息、成员、表情或事件 ID 是只有创建它的适配器才知道如何读取的字符串。核心比较 ID 但不解析它们。动作中的引用按适配器的 `iface`（`discord`、`fake`）划分命名空间。
- 平台对象不跨越边界。事件或动作是纯可序列化对象。Discord 适配器在仍位于引擎内部时，其事件上还携带 `raw`（编辑时为 `rawPrevious`）：discord.js 对象的句柄，仅在 Discord 侧读取，`src/behavior/` 不读取，验证忽略，适配器移到独立包后移除。
- 提及即是寻址。提及角色或回复角色的消息是一个 `message.received`，其 `addressing` 表明这一点，而非单独的事件。
- 私聊是一种对话类型。私信是 `dm` 类型对话中的 `message.received`，不是单独的事件类型。
- 验证不抛出异常。`validateEvent` 和 `validateAction` 都返回 `{ ok: true }` 或 `{ ok: false, reason }`，其中 `reason` 指明字段和问题（`message.at:type`、`kind:unknown`、`conversation.id:required`）。核心以一行警告（`interface: invalid event`，包含种类和原因但不含内容）丢弃无效的入站事件。伪造适配器以 `failed`（代码 `invalid-action`）拒绝无效动作。
- 验证只检查形状。它检查种类、必需键、字符串 ID、有限数字和标志。引用是否属于此接口、内容是否符合限制、谁可以执行命令由适配器和核心负责。

## 入站事件

每个事件都有 `kind`、`iface`（适配器的命名空间）、`at`（自纪元以来的毫秒）、`id`（用于去重的不透明事件 ID），对于发生在对话中的事件还有一个 `conversation` 对象：

| 字段 | 内容 |
|---|---|
| `id` | 对话的 ID |
| `kind` | `channel`、`dm` 或 `thread` |
| `guildId` | 所属社区；私聊时为 null 或缺失 |
| `name`、`topic`、`category` | 参与者看到的内容；未知时为 null 或缺失 |

五种事件：

| 种类 | 发送者 | 载荷 |
|---|---|---|
| `message.received` | 适配器 | `message`、`addressing`；编辑时 `edit: true`（同一消息 ID），删除时 `deleted: true`（仅 `message.id`），适配器无法完整读取的编辑时 `edit: true, partial: true`（仅 `message.id`；核心向适配器请求其余部分） |
| `reaction.changed` | 适配器 | `messageId`、`emoji`（`{ name, id? }`：`name` 是 unicode 表情本身或自定义表情的名称，`id` 是自定义表情的 ID；二者必有其一）、`userId`、`added`（添加时 true，移除时 false） |
| `command.requested` | 适配器 | `name`（`group.sub` 或 `sub`）、`args`（对象）、`requester`（`{ id, name, roles, owner }`：`name` 可为 null，`roles` 为角色 ID，`owner` 为是否在配置的所有者中，仅供参考：核心自行检查权限）、`replyRef`（不透明令牌；答复作为携带它的 `command.result` 动作返回） |
| `scheduler.tick` | 核心 | 仅 `at`：核心自己的时钟。适配器不发送此种类；`iface`、`id` 和 `conversation` 非必需 |
| `task.completed` | 核心 | `taskId`、`status`、`result`（如 `src/errands` 所定义）；`iface`、`id` 和 `conversation` 非必需 |

`message`：

| 字段 | 内容 |
|---|---|
| `id` | 消息的 ID |
| `author` | `{ id, name, self, bot }`：`name` 是作者的显示名或 null；`self` 为角色自身消息时 true；`bot` 为另一个自动化账户 |
| `content` | 人们读到的文本（提及写为名称） |
| `at` | 写入时间 |
| `replyToId` | 回复的消息，或 null（转发不回复任何东西） |
| `replyPingUserId` | 仅通过回复通知的被回复作者，或 null |
| `forwardedFrom` | 转发来源的对话名称，或 null |
| `attachments`、`links`、`forwarded`、`stickers`、`emojis`、`reactions` | 数组，形状由 `interfaces/discord/collect.js#normalizeMessage` 给出 |

`addressing`：

| 字段 | 内容 |
|---|---|
| `mentioned` | 角色在被提及的成员中 |
| `replyToSelf` | 就适配器不重新查询平台所知，消息是对角色消息的回复（核心可能还会检查） |
| `mentionedUserIds` | 消息提及的所有成员 |
| `mentionedConversationIds` | 消息提及的所有对话 |

## 动作

每个动作是带有 `action` 名称的纯对象。前六个是端口的 capabilities，是适配器在 `capabilities().operations` 中列出的名称：

| 动作 | 字段 |
|---|---|
| `message.send` | `conversation`（`{ iface, conversationId }`）、`content` |
| `message.edit` | `message`（`{ iface, conversationId, messageId }`）、`content` |
| `message.delete` | `message` |
| `message.react.add` | `message`、`emoji`（字符串） |
| `message.react.remove` | `message`、`emoji` |
| `conversation.typing` | `conversation` |
| `command.result` | `replyRef`（来自 `command.requested`）、`text`、可选 `files`、可选 `ephemeral`（仅请求者可见） |

`content` 是 `{ text?, attachments?, replyTo?, mentions? }`：`attachments` 是 `{ name, data?, url?, contentType? }`，`replyTo` 是同一接口的消息引用，`mentions` 是 `{ users, repliedUser }`（消息可以通知的成员）。mentions 缺失时不通知任何人。null 的部分视为缺失。

## 结果

每个动作都有结果；适配器不抛出异常。

| 字段 | 内容 |
|---|---|
| `status` | `ok`；`failed`（动作确定未生效）；`unknown`（动作可能已生效，不可盲目重试）；`unsupported`（此接口无法执行该动作）；`forbidden`（此接口无权执行，例如删除他人消息） |
| `ref` | 消息的当前状态（发送时为新消息），如果有的话 |
| `at` | 接口标记结果的时间，如果报告 |
| `error` | `{ code, retryable }`（状态非 `ok` 时）：`code` 是 kebab-case 字符串（`empty-content`、`text-too-long`、`invalid-attachment`、`attachment-too-large`、`foreign-reference`、`invalid-reference`、`not-own-message`、`unknown-message`、`invalid-action`、`timeout`）或 `http-<status>`，`retryable` 表示稍后重试是否可能成功。适配器可以为自己的日志添加 `cause`；它不会传递给模型 |

适配器仅编辑和删除角色自己的消息（否则返回 `forbidden`），并拒绝其他接口的引用为 `foreign-reference`。

## 尚未实现

Discord 适配器是独立的包（`interfaces/discord/`），但仍在引擎进程内运行，将在后续阶段分离。在此之前，消息管道读取从事件重建的规范化消息，所有者命令通过直接回复而非 `command.result` 动作应答，核心的 `scheduler.tick` 和 `task.completed` 是直接调用而非通过统一调度器的事件。
