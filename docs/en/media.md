# Media

What the persona can see, hear and read, and the helpers that make it happen.

Transcript lines carry media markers in brackets: pictures, GIFs, videos, stickers, custom emoji, voice messages, audio files, links, text file previews and forwarded messages. What the persona actually perceives depends on the features below. A `<senses>` block in the user message tells the persona what is on and what is off under the current config; they trust this block and never claim to have seen, heard or opened anything beyond it.

## Pictures

`features.vision` attaches pictures from the calling message, from the message it replies to, and the newest few in the channel to the LLM request as images, downscaled through Discord's media proxy. The bot downloads every picture itself and sends it inline as data, because Discord refuses downloads coming from the model provider. Pictures larger than `context.vision.maxBytes` or slower than `context.vision.fetchTimeoutMs` are skipped. The persona sees these directly, with no helper needed.

When `features.attachedDescriptions` is on (the default), the describer also runs for attached pictures. The persona still sees the picture directly; the helper's note catches what is easy to miss at a glance (who the characters are, what happened, what the joke is). The helper can be wrong, so the persona's own eyes come first. Needs both `vision` and `mediaDescriptions` on. Each attached picture costs one extra describer request within `media.maxPerTurn`.

When `features.imageRelook` is on (the default) and someone addresses the persona with a question or a concrete claim about a picture, the re-watch classifier offers recent pictures alongside videos and the vision model looks at the picture again with that question. The answer appears in the transcript under the picture's line. Picture relooks share the daily `media.video.rewatch.maxPerDay` counter with video re-watches. Retry applies to videos only.

`features.mediaDescriptions` (on by default) runs the `classifier.media` model to write a one-line description for pictures, GIF frames, video posters, stickers, custom emoji and link thumbnails. Each attachment is described once and cached in `data/guilds/<id>/media.json`. Descriptions feed the chat transcript, the memory analyzer and the warmup. The describer's prompt is `prompts/describe.md`.

Stickers and custom emoji recur constantly, so they are cached by id and cost nearly nothing after the first description. With `features.vision`, the sticker of the calling message is attached as a picture. Discord's built-in animated stickers are Lottie animations, not images, so they are never more than a name.

When `features.customEmoji` is on (the default), an `<emoji>` block lists the server's most-used custom emoji ranked by how often members use them (at most `context.customEmoji.max`, default 30). The persona can write `:name:` in a message or a reaction, and the engine turns known names into real emoji. Unknown names stay as plain text. At first startup the engine seeds the ranking by reading the last `context.customEmoji.backfillMessages` (default 500) messages of every readable channel (no model calls); `/nep media kind:emoji action:rescan` clears the ranking and recounts from scratch.

When `features.gifs` is on (the default), a `<gifs>` block lists the GIFs members share most, ranked by recency-weighted use (at most `gifs.max`, default 40). Each GIF gets a short handle (`g1`, `g2`, …) and three caption fields from the describer when cached: a reaction label (capped at `gifs.reactionChars`, default 40), a visible action (capped at `gifs.actionChars`, default 70) and on-screen text. The caps apply wherever the fields are shown, in the list and in a library GIF's transcript line; the cache stores them whole under `media.descriptionChars`. Entries without fields use a single-line caption cut at a word boundary. The persona can post a GIF by writing its handle in a `<gif>` tag; one per turn; an unknown handle does nothing. A GIF is any embed of type `gifv` whatever its provider, or a page on a known GIF host (Tenor, Giphy, Klipy); GIF pages are never read as links. Uses are counted as each message arrives (members only, bots and the persona excluded). When Discord attaches the embed after the message (Tenor GIFs arrive this way), the bot folds it into the buffer so the library and the analyzer still see it (`features.embedUpdates`, on by default). At first startup the engine reads the last `gifs.backfillMessages` (default 500) messages of every readable channel to seed the library, and the top `gifs.backfillDescribe` (default 20) get captions right away. In the transcript, a GIF that is in the library carries its handle so the persona can reuse what they just saw. `/nep media kind:gifs action:status` shows the library size and top entries; `/nep media kind:gifs action:rescan` resets use counts to zero and recounts from channel history, keeping handles stable.

When `media.gif.watch` is on (the default, needs video vision on as well), a GIF is watched as a short silent clip: the animation is converted to an mp4 of at most `media.gif.maxSeconds` (default 8) seconds and sent to the `classifier.video` model through `prompts/describe-gif.md` (falling back to `describe-video.md` when absent). The watched caption replaces the old single-frame description. A GIF that cannot be watched (no animation, a spent daily cap `media.gif.maxPerDay`, a failed conversion or request) keeps the one-frame description instead. `/nep media kind:gifs action:recache` drops stale one-frame captions outside the library and re-watches up to `gifs.recachePerRun` (default 50) library entries in the background, oldest first.

When `features.gifPicker` is on (the default, needs `features.gifs` on and a non-empty library), a classifier picks a GIF from the full library to replace a short first message. The picker runs when the persona's first outgoing message is at most `gifs.pick.maxChars` (default 160) characters and she chose no GIF herself; it sees the last few chat lines, that first message and every library entry with its caption. On a match the GIF replaces the first message and replies where it would have; the remaining messages follow in order. When the GIF fails to send, every message goes as written.

Settings: `context.vision.*` for direct vision, `media.*` for the describer, `gifs.*` for the GIF library. See [Configuration](configuration.md#media) for every key.

## Video

`features.videoDescriptions` is off by default; turn it on in `config.local.json`, with `mediaDescriptions` on as well. It adds the `classifier.video` model, which watches short clips: Discord video attachments, video links pasted from the Discord CDN, and links to known video sites (YouTube, TikTok, VK, X, Reddit, Twitch). The model must accept both video and audio input through OpenRouter.

### Caps

Attachments and downloaded site videos are capped at `media.video.maxSeconds` (default 180 s) and `media.video.maxBytes` (over-size files are re-encoded to 360p at a capped bitrate first; only a clip still too large after re-encoding is refused). In agentic mode (`urlProcessing`, the default), public-URL videos (YouTube and other `directUrlSites`) up to `directUrlMaxSeconds` (default 3600 s, one hour) are sent by URL to the pinned provider; in other modes the effective cap is the smaller of this value and `maxRequestTokens / tokensPerSecond` (500 s with the defaults). Longer videos take the download route (first `maxSeconds` via yt-dlp), which YouTube often blocks with a bot check on servers. At most `maxPerTurn` new videos per turn (every attempt counts, failed or not) and `maxPerDay` per day. Results are cached alongside picture descriptions; a repost costs nothing.

### Tools

Everything beyond attachments within the caps is downloaded with `yt-dlp` and trimmed with `ffmpeg`, both optional system binaries. Without them, attachments within the caps still work (sent as-is). Longer attachments and all site links fall back to a still frame. A video link from the Discord CDN has no duration metadata, so it always goes through ffmpeg; without ffmpeg it falls back to a still frame. For YouTube, when `yt-dlp` cannot probe the duration, an optional `YOUTUBE_API_KEY` in `.env` (free, from the Google Cloud console's YouTube Data API v3) or a watch-page scrape provides it. `/nep status` reports the API key status.

### Re-watch

When someone directly addresses the persona (not an overheard or spontaneous turn) with a question about a video they have already watched, a classifier (`prompts/rewatch.md`, on the `classifier.text` role) decides whether a second look is needed. If so, the video model watches the clip again with `prompts/rewatch-answer.md` and the answer appears in the transcript alongside the original summary. The same classifier can retry a video that failed to load when the person asks about it again. At most one re-watch or retry per turn; answers are cached for one hour. Switch `features.videoRewatch` (default on).

The video prompt is `prompts/describe-video.md`. Settings live under `media.video`. See [Configuration](configuration.md#mediavideo) for every key and a model comparison table.

## Links

`features.webLookup` (off by default; unlike other features, a missing key counts as off) lets the persona open links posted in the chat and read them.

When the feature is on and `web.links.enabled` is not false, a link in the transcript (http/https only, private addresses refused, video-site links excluded, `web.links.skipSites` excluded) is fetched through an SSRF-guarded page fetcher (size capped at `web.links.maxBytes`, timeout `web.links.fetchTimeoutMs`, at most 3 redirects, html and plain text only). The page text is condensed by the `classifier.text` model through `prompts/read-link.md` into an excerpt of at most `web.links.summaryChars` characters. The excerpt is appended to the link's transcript tag as `transcript.linkRead` and appears as first-hand: the persona opened and read the page themselves, within that excerpt. Unreadable pages (paywalls, consent screens, login gates, empty content) are detected and cached as a miss. Links whose URL path ends with an image, video, audio or archive extension (png, jpg, jpeg, gif, webp, avif, svg, mp4, webm, mov, mkv, mp3, ogg, wav, zip, rar, 7z, pdf) are never read regardless of the host, and `web.links.skipSites` (subdomains included) skips Discord CDN, Tenor, Giphy, Klipy, Imgur, Reddit media and Twitter images by default.

With `web.links.prefill` on (the default), links are read as soon as they arrive so the next turn finds them cached. The prefill is capped at `web.links.prefillPerUserPerDay` (default 10) per member per day; the turn path is not limited by it. Each fetch attempt during a turn counts against `web.links.maxPerTurn` (default 2). Link reads and searches share a daily counter capped at `web.maxPerDay` (default 60). Once `llm.maxRequestsPerDay` is spent, nothing new is downloaded or cached as a miss.

Read results are cached in the media cache: `read:<link.id>` holds the excerpt or a miss (skipped for 6 hours). The `<senses>` block includes `senses.linksRead` when the feature is on, telling the persona that a link may come with a read excerpt.

## Search

When the persona is directly addressed (not an overheard or spontaneous turn) and the trigger message needs facts the chat does not have, a classifier (`prompts/lookup.md`, on the `classifier.text` role) decides what to look up. The classifier can ask for a web search, a server-history search, or both.

The classifier fires when the `lookup.md` prompt exists and either `features.webLookup` or `features.recall` is on. Its answer is up to four labelled lines: `web:` phrases a web query, `server:` lists word forms to search the server's own messages, `who:` lists name forms to find a person, `when:` gives a date range. A single unlabelled line (the old format) is still read as a web query.

A web search needs `features.webLookup` on, `web.search.enabled` not false, `web.search.maxPerTurn` at least 1 and a `BRAVE_SEARCH_API_KEY` in `.env` (free tier: 2,000 queries/month, then $5 per 1,000). The results are condensed through `prompts/search-summary.md` and appear in the `<lookup>` block. Without a Brave key, link reading still works but web search does not.

A server search needs `features.recall` on (the default). The engine searches the server's message history through Discord's search API, groups the hits into time clusters, fetches a window of messages around each cluster, and asks a summary helper (`prompts/recall-summary.md`) what the history answers. The classifier's word forms and name forms are also matched against stored memory (episodes, lore, lessons, recent lines, never the private layer; at most `recall.memoryItems`, default 6), and matching items go to the summary as a `<memory>` block so the helper has context even when no old chat was found. The summary may single out one stretch that the persona then gets verbatim in the `<lookup>` block. When the summary finds nothing, no server part appears. The recall run is capped at `recall.maxPerDay` (default 100) per day and `recall.timeoutMs` (default 10 s) per run. Windows from channels the audience rule refuses are excluded. See [Configuration](configuration.md#recall) for every key.

When both searches ran, the `<lookup>` block carries separate headings and a note between them. At most one web search and one server search per turn. The classifier, the web condenser and the recall summary each count against `llm.maxRequestsPerDay`. Web results are cached for `web.search.cacheHours` (default 24) hours per normalised query. The `<senses>` block includes `senses.search` only when a Brave key is configured. `senses.recall` is included on server turns when the server-history search is available.

Settings for the web side live under `web`, for the server side under `recall`. See [Configuration](configuration.md#web) and [Configuration](configuration.md#recall) for every key. The contract between the prompt files and the code is in [Prompt contract](prompt-contract.md).

## Drawing

`features.imageGeneration` (off by default; a missing key counts as on) lets the persona draw pictures. Turn it on in `config.local.json`. When the model emits a `<draw>` tag, the engine generates one picture through OpenRouter's Images API (`image.model`, default `openai/gpt-image-2.5-flare`) and posts it as a separate message after the persona's words. Whether to draw is the model's own decision; the persona can refuse. In a channel where the bot lacks Attach Files permission, the drawing sense is not shown and a `<draw>` tag is dropped, so nothing is generated or billed.

### Caps

At most `image.maxPerDay` (default 50) pictures per day for the instance and `image.maxPerUserPerDay` (default 50) per member. Both are checked before the request and counted only when it is sent. One picture per turn. The scene text from the `<draw>` tag is clamped to `image.maxPromptChars` (default 1600), cut at the last sentence or word boundary. When the persona is in the picture (`self="yes"`) and `image.reference` is `'avatar'`, the bot's Discord avatar is sent as a visual reference.

### Cost

Pricing is per output token, not per picture. The provider's `usage.cost` is reported by `/nep draw` and logged. A request refused by the engine before it is sent (daily or per-member cap, unsupported model family) costs nothing; a generation the provider rejects is usually not billed; a timeout, or an upload that fails after the picture was generated, may still be billed. Image requests do not count against `llm.maxRequestsPerDay`.

### Privacy

The drawing prompt may quote members (it includes the scene text the model wrote, which can reference the conversation). Only counts are logged — never the prompt itself. In dry-run, the full image prompt is logged and mirrored to the dry-run channel, but nothing is generated.

### Failure

When the drawing fails on a turn someone asked for (a mention, reply, name trigger or follow-up), a second turn fires with the failure reason in the trigger label, so the persona can tell the requester what happened. The second turn's own `<draw>` is dropped. On a spontaneous or overheard turn, a failure is only logged. An image cap (daily or per-member) does not fire the failure turn; it posts a limit notice (`labels.limits.notice`) instead on asked-for turns, naming the limit and the numbers. On a turn answering a call from a read-only channel, the limit notice is posted plain in the destination channel (no Discord reply to a message in another channel).

Settings live under `image`. See [Configuration](configuration.md#image) for every key and [Configuration: Pictures out](configuration.md#pictures-out-imagemodel) for the supported models.

## Blind spots

Voice messages show only duration. Audio files show a name and duration. The persona cannot hear either. How they handle a blind spot is the character card's call.

## Cost

Each turn is one LLM request; a memory update adds a second. Video descriptions add one request per watched clip to the `classifier.video` model (`media.video.maxPerDay` caps the daily count); `yt-dlp` and `ffmpeg` run locally and cost nothing beyond bandwidth. Link reads, web searches and server searches add requests to the `classifier.text` model, capped by `web.maxPerDay` (shared, web side), `recall.maxPerDay` (server side) and `llm.maxRequestsPerDay` (global). Web search additionally needs a Brave Search key; the free tier handles a low-traffic server. Server search uses Discord's built-in search API and costs no money, only LLM requests for the classifier and the summary. Image generation bills per output token through the `image.model`; `image.maxPerDay` caps the daily count separately from chat requests.

## Privacy

With `features.webLookup` on, the bot makes outbound HTTP requests to read pages and to the Brave Search API. Pages are fetched directly from the host; private addresses (loopback, link-local, private ranges) are refused. Page content is sent to the `classifier.text` model through the LLM endpoint for condensation; neither the page text nor the search query is logged. `data/` holds the cached excerpts and search results on your machine, gitignored, sent to the LLM as context only.
