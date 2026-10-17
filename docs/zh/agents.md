# 差遣代理

引擎可以将任务交给独立的差遣代理：一个完成单一工作（搜索网络、读取本地文件系统）并返回结果的独立进程。每个代理是由 `src/agent-runner/` 中的运行器代码驱动的 [OpenCode](https://opencode.ai) 工作器。它不导入机器人，使用自己的 OpenRouter 密钥而非角色的密钥运行。引擎附带两个工作器配置文件：

| 配置文件 | 功能 | 可访问范围 | 工具 |
|---|---|---|---|
| `web` | 互联网差遣（搜索、读取页面、查看图片、下载文件） | 通过代理访问公共互联网；自有输出文件夹 | OpenCode `websearch`、`webfetch`、`read`，以及限制为 `curl`/`wget`/`ffmpeg`/`ffprobe`/`file`/`ls`/`mkdir` 的 `bash`（用于下载） |
| `server` | 对本机的只读查询 | 本地文件系统（只读）；仅模型 API 的网络 | OpenCode `read`、`grep`、`glob`、`list`，以及限制为只读命令（`ls`、`cat`、`head`、`tail`、`grep`、`find`、`ps`、`systemctl status`、`journalctl`、`df`、`du`、`stat`、`git log` 等）的 `bash` |

两者每次执行一个任务；后续请求排队。每个任务有单任务上限（`agents.<profile>.limits`：模型步骤数、估计 USD、挂钟秒数），引擎强制执行每日上限（`agents.<profile>.daily`）。USD 上限是 OpenCode 成本估算的软上限；硬性支出限制是运行器 OpenRouter 密钥的信用额度。

## agents 文件夹

每个代理在引擎根目录的 `agents/` 下拥有自己的文件夹：`agents/web/` 和 `agents/server/` 是两个工作器，`agents/advice/` 是咨询。文件夹包含代理的受追踪提示词（`prompt.md`）和描述（`profile.json`）。运行器在启动时从此文件夹构建配置文件（`src/agent-runner/profiles.js#loadProfiles`）；机器人读取同一文件夹获取默认值（socket、输出目录、限制、每日上限）。`listAgents` 返回所有代理，包括工作器和咨询。

有两种类型。工作器作为独立进程运行（`bin/agent-runner.mjs --profile <id>`），通过 Unix socket 接收任务。咨询没有进程：工具直接调用其模型角色。运行器跳过咨询。

## 配置文件键

`profile.json` 描述代理请求什么；它不授权任何东西。所有键都是必需的：

| 键 | 内容 |
|---|---|
| `id` | 文件夹名（`web`） |
| `kind` | `worker`（在代理运行器下通过 socket 运行）或 `consultation`（工具直接调用的模型角色；无进程，运行器跳过） |
| `role` | `src/llm/roles.js` 中的模型角色（`agent.web`、`agent.server`、`agent.advice`） |
| `prompt` | 文件夹内的提示词文件（`prompt.md`）；无提示词的咨询为 `null` |
| `override` | 部署可以放在 `prompts.local/` 下以替换提示词的文件名（`agent-web.md`）；没有提示词时为 `null` |
| `description` | 描述代理功能的一句话 |
| `tools` | 仅工作器：请求的 OpenCode 工具，不超过其 shell 类允许的范围 |
| `shell` | 仅工作器：运行器在代码中定义的 shell 类名（`server-read-only`、`web-download`） |
| `limits` | 仅工作器：默认单任务上限 `{ steps, usd, seconds }`，由配置中的 `agents.<id>.limits` 覆盖 |
| `daily` | 仅工作器：默认每日上限 `{ tasks, usd }`，由 `agents.<id>.daily` 覆盖 |
| `searchProvider` | 仅工作器：默认网页搜索提供商（`exa`）或 `null` |
| `socket`、`out` | 仅工作器：默认 socket 路径和输出文件夹，由 `agents.<id>.socket` / `.out` 覆盖 |
| `env` | 仅工作器：任务未携带密钥时运行器回退使用的环境变量名 |

缺少键、未知键、shell 类不允许的工具或运行器不认识的 shell 类的配置文件会在启动时停止运行器（以及读取同一文件夹的机器人），并输出一行错误，指明代理和键。

## 配置文件中不包含的内容

权限和安全留在代码中（`src/agent-runner/profiles.js`、`src/agent-runner/policy.js`），任何配置文件键都无法更改它们：

- 权限上限：shell 类可以授予哪些工具以及允许哪些 shell 命令；
- shell 拒绝模式，以及对所有代理拒绝的工具（`edit`、`write`、`patch`、`task`、`question`）；`external_directory`（代理自身文件夹外的路径）同样被拒绝，但 server 代理除外，它在与其路径工具相同的隐藏路径规则下获得该工具；
- 范围过滤器、隐藏路径和结果编辑；
- 任何要执行的命令，以及文件夹外的任何路径（`socket` 和 `out` 只是配置覆盖的默认值）。

配置文件只能收窄代码允许的范围：配置文件省略的工具会被拒绝。shell 类不允许的工具或代码未定义的 shell 类在启动时被拒绝。

## 两个服务

每个工作器作为独立的 systemd 服务和 Unix 用户运行（`deploy/neptunia-agent-web.service`、`deploy/neptunia-agent-server.service`；安装说明在 unit 头部）：

- `neptunia-agent-web`：有网络；到 localhost 和私有范围的出站流量被 unit（`IPAddressDeny=`）和代码拒绝。文件系统除状态目录外只读（`ProtectSystem=strict`、`ProtectHome=yes`、`InaccessiblePaths=` 用于 `/srv`、机器人的数据和 `.env`、`/var/www`、nginx 和 Let's Encrypt）。
- `neptunia-agent-server`：网络仅限本地解析器和模型 API（`IPAddressDeny=any` 加 Cloudflare 范围的 `IPAddressAllow=`（OpenRouter 所在地）；shell 在允许列表之上还拒绝 `find -exec`、`awk` 网络路径和 `gawk`）。整个系统只读（`ProtectSystem=strict`，除状态目录和私有 `/tmp` 外无写入路径）；其唯一的写入命令 `cp` 只能将文件复制到任务文件夹中，文件从那里作为结果文件返回，而在过滤范围中，隐藏路径对 `cp` 的拒绝与对 `cat` 相同。它拥有 `CAP_DAC_READ_SEARCH`，无需 root 即可读取任何文件。只读保证由 unit 提供，而非命令过滤器。

两者均由 `bin/agent-runner.mjs --profile <name>` 启动。它们从配置的 `agents.<profile>` 读取上限、模型价格和 socket，从 `agent.web` 和 `agent.server` 模型角色读取模型（通过 `/nep model set` 设置，每个任务重新读取；`run` 可以携带自己的 `model`）。设置详见[配置: `agents`](configuration.md#agents)。

## 密钥

所有密钥存在核心中，即机器人的 `.env` 文件，运行器（非特权，文件对其不可访问）无法读取。核心在每个任务的 `run` 消息的 `secrets` 中发送密钥。

OpenRouter 密钥是任务模型角色的密钥，解析方式与机器人解析任何角色的密钥相同（`llm.keyByRole`）：`agent.web` 和 `agent.server` 使用 `OPENROUTER_AGENT_KEY`；没有该变量则不发送 secrets。机器人从不在代理密钥上发送自己的请求。`web` 代理还获得代理（`MEDIA_VIDEO_PROXY`，作为代理也提供服务的 `http://` URL 发送）和 `OPENCODE_WEBSEARCH_KEY`（如已设置）。运行器将密钥作为 `OPENROUTER_API_KEY` 传递给 OpenCode 子进程，将代理作为 `HTTPS_PROXY` / `HTTP_PROXY`（及其小写形式，curl 读取的形式）传递，将搜索密钥传递给搜索提供商。

unit 的 `EnvironmentFile`（`/etc/neptunia/agent-<profile>.env`，root 所有，0600）是可选的：其 `OPENROUTER_AGENT_KEY`、`OPENCODE_WEBSEARCH_KEY` 和 `PROXY_URL` 仅用于任务未携带的部分。两个来源都没有密钥的任务以 `no-key` 失败，每个运行器一次警告。密钥永远不会被记录到日志、journal 或事件中。

所有者的 `/nep status` 卡片将代理的密钥显示为 `agents` 密钥，将编码工作器的 `OPENROUTER_DEV_KEY`（角色 `agent.dev`）显示为 `development` 密钥。第四个代理角色 `agent.advice` 指定机器人外部咨询工具的模型（裸 OpenRouter id，在模拟器的 `OPENROUTER_SIM_KEY` 上）；差遣代理和机器人的请求都不使用它。

## 协议

核心连接到运行器的 Unix socket（`agents.<profile>.socket`，组 `neptunia-discord-interface`，模式 0660）并交换 JSON，每行一个对象（`src/agent-runner/protocol.js`）。

核心到运行器：

- `{ "op": "run", "id", "goal", "context": { "scope", "channel", "asker", ... }, "limits": { "steps", "usd", "seconds" }, "tools": [...], "model"?, "cost"?, "searchProvider"?, "secrets"?: { "openrouterKey", "proxy"?, "searchKey"? }, "preamble"? }`（`secrets`：非空字符串，无其他键；被拒绝的 `run` 只返回错误码，不返回值；`preamble`：下述共享前导语，裁剪后不超过 8000 字符的字符串，否则 run 以 `bad-preamble` 或 `preamble-too-long` 拒绝）
- `{ "op": "cancel", "id" }`
- `{ "op": "ping", "ids": [...] }`

运行器到核心：

- `{ "id", "event": "progress", "step", "tool", "note" }`：任务执行中发送；
- 一次 `{ "id", "event": "end", "status": "done" | "failed" | "cancelled", "result": { "text", "sources": [url...], "files": [{ "path", "name", "contentType", "bytes" }], "withheld"?: [path...], "filesDropped"?: [{ "name", "reason" }] }, "usage": { "input", "output", "usd", "steps", "seconds", "costUnknown"? }, "error"? }`（`withheld`：在过滤范围内代理被拒绝的路径，最多 50 个；`filesDropped`：运行器未交付的结果文件，原因 `withheld` 表示过滤范围运行访问了隐藏路径（此时不交付任何文件），`secret` 表示不超过 2 MB 的文本文件包含秘密，适用于所有范围）；
- `{ "event": "pong", "profile", "busy", "queued" }`：对 `ping` 的响应。

重启过的运行器对它不再认识的 `ping` 中的 id 返回 `status: "failed", error: "restarted"` 的 `end`，使核心停止等待。收到 `SIGTERM` 时，运行器以同样方式结束所有开放任务并退出。输出文件放在 `<out>/<id>/` 中，核心在 `agents.keepFilesHours` 后删除它们。

## 范围与编辑

`run` 携带 `context.scope`，为 `core`、`dm`、`group` 之一（`src/agent-runner/policy.js`）。在 `core` 中不隐藏任何内容。在 `dm` 和 `group` 中：

- `server` 代理的文件工具拒绝敏感路径（`/var/www`、所有 `.git`/`.local.git`、`.secrets`、`.env`、`.ssh`、`/etc/shadow`、nginx htpasswd、Let's Encrypt、`/etc/neptunia`、`/srv/neptunia-backups`、`config.local.json`、角色自身的 `data/` 和所有 `.agents/scratch`）的内容，其 `bash` 拒绝以这些路径为参数的内容命令（`cat`、`head`、`tail`、`grep`、`egrep`、`fgrep`、`sed`、`awk`、`cut`、`sort`、`uniq`、`wc`、`file`、`git`）。列出名称的命令（`ls`、`find`、`stat`、`du`、`readlink`、`realpath`）仍然允许。拒绝按步骤发生：OpenCode 拒绝该次工具调用，代理看到拒绝后继续，结果的 `withheld` 列出被拒绝的路径；
- 运行器返回的每个结果都经过编辑处理，将看起来像密钥、令牌和密码的字符串、私钥块、SSH 密钥材料和 URL 凭据替换为 `[redacted]`。

尽管有这些规则仍到达隐藏路径的命令（通过 `bash -c`、管道到阅读器）会在事后被捕获：运行器不保留该输出（其进度事件报告 `withheld` 和路径），路径加入结果的 `withheld`，任务继续。代理已经看到了输出，因此最终编辑处理是阻止秘密进入回答的最后保障。

## 任务如何运行

每个任务是配置文件输出目录下新工作目录中的一个 `opencode run` 子进程，禁用了项目/`.claude` 配置、自动更新和价格目录获取，确保服务器上的信息不会泄露到工作器中。引擎构建 OpenCode 配置（来自 `agents/<profile>/prompt.md` 或部署的 `prompts.local/agent-<profile>.md` 的代理提示词、步骤上限、范围的权限规则集、模型及其成本）并通过 `OPENCODE_CONFIG_CONTENT` 传递。子进程输出 JSON 事件流；运行器汇总每步的成本和 token，转发进度，将最终助手文本作为结果，列出代理保存的文件，并在达到上限时停止子进程。基于 OpenCode v1.19.3 构建。

部署可以为每个差遣代理提供一份共享前导语：可选文件 `prompts.local/agents.md`（没有受追踪的默认值；没有该文件或文件为空时不产生任何变化）。核心通过实时提示词加载器读取该文件，因此编辑无需重启即可到达下一个任务，并将其文本作为 `run` 消息的 `preamble` 随每个任务发送。运行器将其置于代理系统提示词的最前面，后接空行和代理自身的提示词。运行器从不为此读取 `prompts.local/`：只有核心读取该文件，因此 unit 将私有目录排除在运行器访问范围之外的运行器仍能获得前导语。前导语不会被记录到日志中；核心的 `errands: sent` 行仅包含其长度。

## 角色一侧

核心（`src/errands/`）按服务器在 `data/guilds/<id>/tasks.json`（开放的和最新完成的）和 `tasks.jsonl`（每次转换一行）中保存角色的任务，并将每次转换记录为一个 `task` 操作（仅计数，不含目标或结果）。任务经历 `queued`、`running`，然后 `done`、`failed` 或 `cancelled` 状态。

- 操作（也是角色的技能，授权前关闭；见[命令](owner-commands.md#member-commands)）：`task.run`（`agent`、`goal`；付费）、`task.status`（`id` 可选）、`task.cancel`（`id`）、`task.list`。任何成员都可以请求 `web`；只有所有者可以请求 `server`，无论是否通过角色。`task.run` 立即返回 id 和 `queued`，任务在后台以 `agents.<profile>.limits` 的限制运行。在私聊中请求的任务以 `dm` 范围运行，其他以 `group` 运行。上限为 `agents.maxOpen` 个开放任务和 `agents.<profile>.daily`（每 UTC 日）。
- `<tasks>`：当角色有开放任务或尚未查看的已完成任务时，在每个请求的尾部显示，每行一个（id、代理、状态、经过分钟数、截断到 120 字符的目标）。私聊的任务仅在该聊天中显示。已完成的任务在角色的回合显示后标记为已查看。
- `<task_result>`：当任务结束时，角色在请求任务的对话中获得自己的回合，回复启动任务的消息（没有该消息时为插话）。回合遵循与普通回合相同的注意力机制，并遵守同一对话中两个结果回合之间的 `agents.resultCooldownSeconds`。区块包含 id、代理、目标和状态、截断到 `agents.resultMaxChars` 的结果文本、编号列表的来源和每个文件的 handle。角色可以回复或保持沉默；之后任务标记为已查看。被取消的任务不打开回合；核心重启时留下的开放任务以 `restarted` 失败。
- 文件 handle：`file:<task id>/<name>` 指向任务保存的文件。`message.create` 将其作为 `file` 属性接受，从 `<agents.<profile>.out>/<task id>/<name>` 附加文件。不指向角色任务文件的 handle（或私聊外该聊天的文件）以 `unknown-file` 拒绝；超过接口限制的文件以 `attachment-too-large` 拒绝。

## 添加代理

1. 创建 `agents/<id>/`，包含 `profile.json`（复制现有的一个）和工作器的 `prompt.md`。
2. 如果需要尚不存在的模型角色，添加到 `src/llm/roles.js`。
3. 对于工作器：在 `config.json` 中添加 `agents.<id>` 块，参照 `deploy/neptunia-agent-web.service` 创建 systemd unit，并在 `TASK_AGENTS`（`src/ops/catalog.js`）中添加其名称以及在 `src/ops/task.js` 中指定谁可以请求它，以便角色能够使用。
4. 如果现有 shell 类不适用，这是 `src/agent-runner/profiles.js` 中的代码更改，而非配置文件键。
5. 运行 `tests/agent-runner-profiles.test.js`。
