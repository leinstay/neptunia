# 媒体

角色能看到、听到和阅读什么，以及实现这些功能的辅助工具。

对话记录行在括号中携带媒体标记：图片、GIF、视频、贴纸、自定义表情、语音消息、音频文件、链接、文本文件预览和转发消息。角色实际感知到什么取决于以下功能开关。用户消息中的 `<senses>` 块告知角色在当前配置下什么是开启的、什么是关闭的；角色信任此块的内容，不会声称看到、听到或打开了超出其描述的任何东西。

## 图片

`features.vision` 将呼叫消息、被回复消息以及频道中最新的几张图片作为图像附加到 LLM 请求中，通过 Discord 的媒体代理缩小。机器人自行下载每张图片并以内联数据发送，因为 Discord 拒绝来自模型提供商的下载请求。超过 `context.vision.maxBytes` 或下载时间超过 `context.vision.fetchTimeoutMs` 的图片会被跳过。角色直接看到这些图片，无需辅助工具。

当 `features.imageRelook` 开启（默认）且有人向角色提出关于图片的问题或声称了某张图片的具体细节时，重看分类器会在视频旁边提供近期图片，视觉模型会带着该问题再看一次图片。回答出现在对话记录中图片行的下方。图片二次查看与视频重看共享每日 `media.video.rewatch.maxPerDay` 计数器。重试仅适用于视频。

`features.mediaDescriptions`（默认开启）运行 `vision` 角色的模型为图片、GIF 帧、视频封面、贴纸、自定义表情和链接缩略图生成单行描述。每个附件只描述一次并缓存在 `data/guilds/<id>/media.json` 中。描述提供给对话记录、记忆分析器和预热。描述器的提示是 `prompts/describe.md`。

贴纸和自定义表情经常重复出现，因此按 id 缓存，首次描述后几乎没有开销。启用 `features.vision` 时，呼叫消息的贴纸会作为图片附加。Discord 内置的动态贴纸是 Lottie 动画而非图片，因此只能显示名称。

当 Discord 在消息本体之后才附加嵌入内容时（Tenor 的 GIF 就是这样到达的），机器人会将其纳入缓冲区，使 GIF 库和分析器也能看到（`features.embedUpdates`，默认开启）。

当 `media.gif.watch` 开启时（默认如此，需同时开启视频视觉），GIF 作为短无声片段被观看：动画被转换为不超过 `media.gif.maxSeconds`（默认 8）秒的 mp4，通过 `prompts/describe-gif.md` 发送给 `video` 角色的模型（文件不存在时回退到 `describe-video.md`）。观看后的说明替代旧的单帧描述。无法观看的 GIF（无动画、每日 `media.gif.maxPerDay` 限额耗尽、转换或请求失败）保留单帧描述。`/nep media kind:gifs action:recache` 删除库外过时的单帧说明，并在后台从最旧的开始重新观看最多 `gifs.recachePerRun`（默认 50）个库条目。

当 `features.gifPicker` 开启时（默认如此，需要 `features.gifs` 开启且库非空），分类器从完整库中挑选 GIF 替代短的第一条消息。挑选器在角色的第一条发出消息不超过 `gifs.pick.maxChars`（默认 160）个字符且自己没选 GIF 时运行；它接收最近几行聊天、该第一条消息及每条库记录的说明。匹配时 GIF 替换第一条消息并以其原本的回复方式发送；其余消息按原顺序跟随。GIF 发送失败时，所有消息照常发布。

设置：直接视觉位于 `context.vision.*`，描述器位于 `media.*`，GIF 库位于 `gifs.*`。每个键请参阅[配置](configuration.md#media)。

## 视频

`features.videoDescriptions` 默认关闭；在 `config.local.json` 中开启，并同时开启 `mediaDescriptions`。开启后会添加 `video` 角色的模型，可观看短视频片段：Discord 视频附件、从 Discord CDN 粘贴的视频链接以及已知视频站点的链接（YouTube、TikTok、VK、X、Reddit、Twitch）。模型必须通过 OpenRouter 同时接受视频和音频输入。

### 限制

附件和下载的站点视频受 `media.video.maxSeconds`（默认 180 秒）和 `media.video.maxBytes` 限制（超限的文件先以限定码率重编码为 360p；仅重编码后仍超限的片段才被拒绝）。agentic 模式（`urlProcessing`，默认）下，公开 URL 视频（YouTube 及其他 `directUrlSites`）在 `directUrlMaxSeconds`（默认 3600 秒，一小时）以内时通过 URL 发送给固定的提供商；其他模式下有效上限为此值与 `maxRequestTokens / tokensPerSecond`（默认值下为 500 秒）中较小者。超长视频走下载路径（通过 yt-dlp 取前 `maxSeconds`），但 YouTube 在服务器上经常以 bot 验证阻止下载。每回合最多 `maxPerTurn` 个新视频（每次尝试都计数，无论成功与否），每天最多 `maxPerDay` 个。结果与图片描述一起缓存；重复发布不产生额外开销。

### 工具

超出限制的所有内容通过 `yt-dlp` 下载并使用 `ffmpeg` 裁剪，两者均为可选的系统二进制文件。没有它们时，在限制内的附件仍然可用（直接发送）。更长的附件和所有站点链接会回退到静帧。来自 Discord CDN 的视频链接没有时长元数据，因此始终经过 ffmpeg 处理；没有 ffmpeg 时会回退到静帧。对于 YouTube，当 `yt-dlp` 无法探测时长时，`.env` 中的可选 `YOUTUBE_API_KEY`（免费，Google Cloud 控制台，YouTube Data API v3）或观看页面抓取可以提供时长信息。`/nep status` 报告 API key 状态。

### 重看

当有人直接呼叫角色（非 `overheard` 或自发回合）并对角色已观看的视频提出问题时，分类器（`prompts/rewatch.md`，使用 `analyzer` 角色）判断是否需要再看一遍。如果需要，视频模型使用 `prompts/rewatch-answer.md` 再次观看片段，回答与原始摘要一起出现在对话记录中。当有人再次询问未能加载的视频时，同一分类器也可以重试加载。每回合最多一次重看或重试；回答缓存一小时。开关 `features.videoRewatch`（默认开启）。

视频提示是 `prompts/describe-video.md`。设置位于 `media.video` 下。每个键和模型对比表请参阅[配置](configuration.md#mediavideo)。

## 链接

`features.webLookup`（默认关闭；与其他功能不同，缺失的键视为关闭）允许角色打开聊天中发布的链接并阅读它们。

当功能开启且 `web.links.enabled` 不为 false 时，对话记录中的链接（仅 http/https，拒绝私有地址，排除视频站点链接，排除 `web.links.skipSites`）会通过 SSRF 防护的页面抓取器获取（大小限制 `web.links.maxBytes`，超时 `web.links.fetchTimeoutMs`，最多 3 次重定向，仅 html 和纯文本）。页面文本通过 `reasoner` 角色的模型经由 `prompts/read-link.md` 浓缩为不超过 `web.links.summaryChars` 字符的摘要。摘要以 `transcript.linkRead` 追加到链接的对话记录标签之后，显示为第一手信息：角色自己打开并阅读了页面，在该摘要的范围内。无法阅读的页面（付费墙、同意屏幕、登录门控、空内容）会被检测并缓存为未命中。URL 路径以图片、视频、音频或压缩文件扩展名（png、jpg、jpeg、gif、webp、avif、svg、mp4、webm、mov、mkv、mp3、ogg、wav、zip、rar、7z、pdf）结尾的链接不论主机一律不读取，`web.links.skipSites`（含子域名）默认排除 Discord CDN、Tenor、Giphy、Klipy、Imgur、Reddit 媒体和 Twitter 图片。

当 `web.links.prefill` 开启时（默认如此），链接在到达时立即被阅读，以便下次回合时已有缓存。预读按每个成员每天 `web.links.prefillPerUserPerDay`（默认 10）个限制；回合路径不受此限制。回合期间每次抓取尝试计入 `web.links.maxPerTurn`（默认 2）。链接阅读和搜索共享一个每日计数器，上限为 `web.maxPerDay`（默认 60）。`llm.maxRequestsPerDay` 耗尽后，不再下载新页面或缓存未命中。

阅读结果缓存在媒体缓存中：`read:<link.id>` 保存摘要或未命中记录（跳过 6 小时）。当功能开启时，`<senses>` 块包含 `senses.linksRead`，告知角色链接可能附带阅读摘要。

## 搜索

当角色被直接呼叫（非 `overheard` 或自发回合）且触发消息需要聊天之外的事实时，分类器（`prompts/lookup.md`，使用 `reasoner` 角色）决定需要搜索什么。分类器可以要求网络搜索、服务器消息历史搜索，或两者兼有。

分类器在 `lookup.md` 提示文件存在且 `features.webLookup` 或 `features.recall` 任一开启时触发。其回答至多四行标注行：`web:` 生成网络查询，`server:` 列出在服务器消息中搜索的词形，`who:` 列出找人的名称词形，`when:` 给出日期范围。单行无标注（旧格式）仍被读取为网络查询。

网络搜索需要 `features.webLookup` 开启、`web.search.enabled` 不为 false、`web.search.maxPerTurn` 至少为 1、且 `.env` 中配置了 `BRAVE_SEARCH_API_KEY`（免费层：每月 2,000 次查询，之后每 1,000 次 $5）。结果通过 `prompts/search-summary.md` 浓缩并出现在 `<lookup>` 块中。没有 Brave 密钥时，链接阅读仍然可用但网络搜索不可用。

服务器搜索需要 `features.recall` 开启（默认如此）。引擎通过 Discord 搜索 API 搜索服务器消息历史，将命中项分组为时间聚类，获取每个聚类周围的消息窗口，并让摘要辅助（`prompts/recall-summary.md`）给出历史中的答案。分类器的词形和名称词形还会与已存储记忆匹配（不含私有层；最多 `recall.memoryItems`，默认 6），匹配的条目作为 `<memory>` 块发送给摘要，使辅助即使在没有找到旧聊天时也有上下文。摘要可能指出一段最佳回答问题的原文，角色会在 `<lookup>` 块中看到该段原文。摘要未找到结果时，不显示服务器部分。recall 运行受 `recall.maxPerDay`（默认 100）每日上限和 `recall.timeoutMs`（默认 10 秒）每次运行限制。受众规则拒绝的频道中的窗口会被排除。每个键请参阅[配置](configuration.md#recall)。

两者都运行时，`<lookup>` 块分别使用标题和中间注释。每回合最多一次网络搜索和一次服务器搜索。分类器、网络浓缩器和 recall 摘要各自计入 `llm.maxRequestsPerDay`。网络结果按规范化查询缓存 `web.search.cacheHours`（默认 24）小时。`<senses>` 块仅在配置了 Brave 密钥时包含 `senses.search`。`senses.recall` 在服务器历史搜索可用的服务器回合中包含。

网络侧设置位于 `web`，服务器侧设置位于 `recall`。每个键请参阅[配置](configuration.md#web)和[配置](configuration.md#recall)。提示文件与代码之间的契约在[提示契约](prompt-contract.md)中。

## 绘画

`features.imageGeneration`（默认关闭，缺失的键视为开启）允许角色绘制图片。在 `config.local.json` 中启用。当模型输出 `<draw>` 标签时，引擎通过 OpenRouter Images API（`roles.drawing`，默认 `openai/gpt-image-2.5-flare`）生成一张图片，并在角色的文本消息之后作为独立消息发布。是否绘画由模型自行决定，可以拒绝。在机器人没有附加文件权限的频道中，绘画感知行不会显示，`<draw>` 标签会被丢弃，因此不会生成任何图片，也不会产生费用。

### 限制

每日整个实例最多 `image.maxPerDay`（默认 50）张，每个成员最多 `image.maxPerUserPerDay`（默认 50）张。在请求前检查，仅在发送时计数。每回合一张。`<draw>` 标签的场景文本截断至 `image.maxPromptChars`（默认 800）。角色出现在图片中（`self="yes"`）且 `image.reference` 为 `'avatar'` 时，机器人的 Discord 头像作为视觉参考发送。

### 成本

按输出 token 计费，而非按图片。provider 的 `usage.cost` 由 `/nep draw` 报告并记入日志。引擎在发送前拒绝的请求（每日或每人上限、不支持的模型系列）不产生费用；provider 拒绝的生成通常不计费；超时或图片生成后上传失败的情况仍可能产生费用。图像请求不计入 `llm.maxRequestsPerDay`。

### 隐私

绘画提示可能引用成员（它包含模型编写的场景文本，可能涉及对话内容）。日志只记录计数，不记录提示本身。试运行中，完整的图像提示被记录并镜像到试运行频道，但不生成任何图片。

### 失败

当有人请求的回合（提及、回复、名字触发或跟进）中绘画失败时，触发第二个回合，触发标签中包含失败原因，以便角色告知请求者发生了什么。第二个回合自身的 `<draw>` 被移除。自发或 `overheard` 回合中失败仅记录日志。图片配额超限（每日或每成员）不触发失败回合；在被请求的回合中发布限制通知（`labels.limits.notice`），显示哪个限制和数值。

设置位于 `image` 下。每个键请参阅[配置](configuration.md#image)，支持的模型请参阅[配置：图片输出](configuration.md#图片输出imagemodel)。

## 盲区

语音消息只显示时长。音频文件显示名称和时长。角色无法听到任何一种。如何处理盲区由角色卡决定。

## 成本

每个回合是一次 LLM 请求；记忆更新再增加一次。视频描述为每个观看的片段向 `video` 角色发送一次请求（`media.video.maxPerDay` 限制每日数量）；`yt-dlp` 和 `ffmpeg` 在本地运行，除带宽外不产生费用。链接阅读、网络搜索和服务器搜索向 `analyzer` 和 `reasoner` 角色发送请求，受 `web.maxPerDay`（共享，网络侧）、`recall.maxPerDay`（服务器侧）和 `llm.maxRequestsPerDay`（全局）限制。网络搜索还需要 Brave Search 密钥；免费层可以处理低流量的服务器。服务器搜索使用 Discord 内置的搜索 API，不花钱，只消耗分类器和摘要的 LLM 请求。图像生成通过 `roles.drawing` 按输出 token 计费；`image.maxPerDay` 独立于聊天请求限制每日数量。

## 隐私

启用 `features.webLookup` 后，机器人会发出出站 HTTP 请求以读取页面和访问 Brave Search API。页面直接从主机获取；私有地址（回环、链路本地、私有网段）会被拒绝。页面内容通过 LLM 端点发送给 `reasoner` 角色的模型进行浓缩；页面文本和搜索查询均不会被记录到日志中。`data/` 在你的机器上保存缓存的摘要和搜索结果，已加入 gitignore，仅作为上下文发送给 LLM。
