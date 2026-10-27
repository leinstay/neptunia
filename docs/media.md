# Media

What the persona perceives from the chat and what she can produce.

Transcript lines carry media in brackets: pictures, GIFs, videos, stickers, custom emoji, voice messages, audio files, links. A `<senses>` block in each request tells the persona what is on and what is off under the current config; she trusts this block and never claims to have seen or heard anything beyond it.

## What she perceives

### Pictures

The persona does not receive images directly in her own request. A picture reaches her as a one-line caption in the transcript, written by a vision-capable model on the `vision` role (`models.base.vision`, default `google/gemini-3.8-flash`). The prompt is `prompts/describe.md`.

Each attachment or embed is described once and cached in `data/guilds/<id>/media.json`, trimmed by LRU to `media.cacheEntries` (default 5000) entries. A repost costs nothing. A failed description is cached as a miss for one hour, except when the daily request cap (`llm.maxRequestsPerDay`) is spent: then nothing is downloaded or cached as a miss, so pictures from the last hours are still described after midnight UTC.

The picture is downloaded first (`src/media/fetch-image.js`) and sent to the model as a `data:` URL, because some providers get a 403 from Discord's CDN. Downloads are cached in a small in-memory LRU (about 50 entries, 10 minutes), keyed by the URL without its query string (Discord's CDN query params rotate between fetches of the same file).

When someone asks about a picture the persona has already seen, a re-look happens. With `features.imageRelook` on (default `true`), the rewatch classifier offers recent pictures alongside videos and the vision model looks at the picture again with the person's question. The answer appears in the transcript alongside the original caption. Picture re-looks share the daily counter `media.video.rewatch.maxPerDay` (default 20) with video rewatches.

With `features.coreTools` on, the persona can look at a picture herself by calling the `media.look` tool with a message reference and her own question (at most `media.look.maxPerTurn` per turn, default 2).

Switch: `features.mediaDescriptions` (default `true`).

### Avatars

When `features.avatars` is on (default `false`), each member's Discord avatar is described by the `vision` role's model and stored in their profile as `avatar: { hash, text, describedAt }`. The avatar used is the server avatar when the member set one, otherwise the account avatar. Discord's default avatar (no upload) is recorded as `{ hash: null, default: true }`. A new version replaces the old one; no history is kept.

Avatars are queued (`src/memory/avatar-queue.js`) and described at `avatars.intervalMs` (default 20000 ms) with at most `avatars.maxPerDay` (default 60) per day. The caption is at most `avatars.descriptionChars` (default 200) characters. It appears in the `<people>` prompt block.

Switch: `features.avatars` (default `false`).
Model role: `vision`.

### Reactions

When `features.seeReactions` is on (default `true`), reactions on the persona's messages are visible to her. The reactor store (`src/behavior/reactor-store.ts`) tracks who reacted (in-process, never persisted, gone at restart). Reactions appear in the transcript; `features.reactionNames` (default `true`) shows the reactor's name alongside the emoji.

### Video

A video attached to a message, or a link to a known video site, is watched by a model on the `video` role (`models.base.video`, default `google/gemini-3.8-flash`). The model must accept both video and audio input through OpenRouter. The prompt is `prompts/describe-video.md`.

The known video sites (from `media.video.sites`): YouTube, TikTok, VK, X/Twitter, Reddit, Twitch.

Attachments and downloaded site videos are capped at `media.video.maxSeconds` (default 300 s) and `media.video.maxBytes` (default about 14.5 MB). Over-size files are re-encoded to 360p at a capped bitrate; a clip still too large after re-encoding is refused. In agentic mode (`media.video.urlProcessing`, the default value `agentic`), public-URL videos (YouTube and other `media.video.directUrlSites`) up to `media.video.directUrlMaxSeconds` (default 3600 s) are sent by URL to the pinned provider. Longer videos take the download route (the first `maxSeconds` via yt-dlp).

At most `media.video.maxPerTurn` (default 5) new videos per turn and `media.video.maxPerDay` (default 40) per day. Results are cached alongside picture descriptions.

Everything beyond attachments within the caps is downloaded with `yt-dlp` and trimmed with `ffmpeg`, both optional system binaries. Without them, attachments within the caps still work (sent as-is); longer attachments and all site links fall back to a still frame. For YouTube, when yt-dlp cannot probe the duration, an optional `YOUTUBE_API_KEY` in `.env` or a watch-page scrape provides it.

An optional proxy (`media.video.proxy`) routes yt-dlp downloads for sites listed in `media.video.proxySites`. When a proxied run fails, a plain TCP connect test tells whether the proxy is dead or the video itself is the problem. A dead proxy is skipped for `media.video.proxyRetryMinutes` (default 10) and the run retried directly.

#### The audio map

A video model told nothing about the sound tends to invent it for a silent clip. To prevent this, the fetcher measures each clip with a read-only ffmpeg `silencedetect` pass (`src/media/audio-map.js`) and the describer adds a measured note to the video model's system prompt:

- `none`: no audio stream, or the entire track is silence.
- `map`: a list of audible stretches in `m:ss-m:ss` format.
- `full`: sound throughout.

The note uses the label from `labels.videoAudio.none` or `labels.videoAudio.map`. A failed measurement is logged and the note omitted, never treated as a failed fetch. GIF clips are silent by design and skip the audio measurement.

Settings: `media.video.audioMap.noiseDb` (default -50), `media.video.audioMap.minSilenceSeconds` (default 0.5), `media.video.audioMap.mapBelowShare` (default 0.8, a clip with less than 80% audible time gets a map instead of `full`).

#### Re-watch

When someone directly addresses the persona with a question about a video she already watched, a classifier (`analyzer` role) decides whether a second look is needed. If so, the video model watches the clip again with her question and the answer appears in the transcript alongside the original summary. The classifier can also retry a video that failed to load. At most one re-watch or retry per turn; answers are cached. Switch: `features.videoRewatch` (default `true`).

Switch: `features.videoDescriptions` (default `false`). `features.mediaDescriptions` must also be on.
Model role: `video`.

### Links

When `features.webLookup` is on (default `false`; unlike other features, a missing key counts as off) and `web.links.enabled` is not false, links in the transcript are fetched and condensed.

A link (http/https, private addresses refused, video-site and `web.links.skipSites` excluded) is fetched through an SSRF-guarded page fetcher (at most `web.links.maxBytes`, timeout `web.links.fetchTimeoutMs`). The page text is condensed by the `analyzer` role through `prompts/read-link.md` into an excerpt of at most `web.links.summaryChars` (default 700) characters, appended to the link's transcript tag. Unreadable pages (paywalls, consent screens, login gates) are cached as a miss.

With `web.links.prefill` on (default `true`), links are read as messages arrive so the next turn finds them cached. The prefill is capped at `web.links.prefillPerUserPerDay` (default 10) per member per day. During a turn, at most `web.links.maxPerTurn` (default 2) fetches. Link reads and web searches share a daily counter capped at `web.maxPerDay` (default 60).

With `features.coreTools` on, posted links show an opening of the page's extracted text (cut at `web.links.previewChars`, default 700), no model request. The persona reads further by calling her own `web.read` tool.

Model role: `analyzer`.

## What she produces

### GIFs

The persona builds a library of GIFs from the chat. Every GIF a member posts (a `gifv` embed from any site, a page from Tenor, Giphy or Klipy, or an attached .gif file) is counted deterministically (no model call) into `data/guilds/<id>/gifs.json`. Each entry gets a stable handle (`g1`, `g2`, etc.) that never changes and is never reused.

A `<gifs>` block in the prompt lists the most-used GIFs ranked by recency-weighted use (at most `gifs.max`, default 25). Each GIF has three caption fields from the describer: a reaction label (capped at `gifs.reactionChars`, default 40 characters), a visible action (capped at `gifs.actionChars`, default 70 characters) and on-screen text. The persona posts a GIF by writing its handle in a `<gif>` tag. One GIF per turn; an unknown handle does nothing. At most `gifs.maxPerDay` (default 40) GIF posts per day.

When `media.gif.watch` is on (default `true`, needs video descriptions on), a GIF is watched as a short silent clip: the animation is converted to an mp4 of at most `media.gif.maxSeconds` (default 15 s) and sent to the `video` role through `prompts/describe-gif.md`. The watched caption replaces the old single-frame description. GIFs that cannot be watched keep the one-frame description. At most `media.gif.maxPerDay` (default 200) watches per day.

When `features.gifPicker` is on (default `true`, needs `features.gifs` on), a classifier on the `analyzer` role picks a GIF from the library to replace a short first message. The picker runs when the persona's first outgoing message is at most `gifs.pick.maxChars` (default 160) characters and she chose no GIF herself.

At first startup the engine reads the last `gifs.backfillMessages` (default 500) messages of every readable channel to seed the library; the top `gifs.backfillDescribe` (default 20) get captions right away.

Switch: `features.gifs` (default `true`).
Model roles: `video` (GIF watch), `analyzer` (GIF picker).

### Custom emoji

When `features.customEmoji` is on (default `true`), an `<emoji>` block lists the server's most-used custom emoji ranked by how often members use them. Uses are counted deterministically from each message. The persona writes `:name:` in a message or a reaction, and the engine turns known names into real Discord emoji markup (`<:name:id>`). Unknown names stay as plain text.

At first startup the engine reads the last `context.customEmoji.backfillMessages` (default 500) messages to seed the ranking.

### Stickers

Stickers appear in the transcript as their name. Frequently used stickers are described once by the `vision` role and cached by id. Discord's built-in animated stickers are Lottie animations, which cannot be described; they appear as a name only.

### Edits and deletes

The persona can edit and delete her own messages through her tools (`message.edit`, `message.delete`). She can only touch her own messages; the adapter returns `forbidden` for anyone else's. On Discord, an edited message shows Discord's "edited" marker.

### Drawings

When `features.imageGeneration` is on (default `false`; a missing key counts as on), the persona can draw pictures. She calls the `draw.create` tool with a scene description, and the engine generates one picture through OpenRouter's Images API on the `drawing` role (`models.base.drawing`, default `openai/gpt-image-2.5-flare`). The picture is posted as a file attachment in a separate message before her speech goes out. If the picture fails, her speech for that step is held so she does not claim a picture that does not exist.

The drawing prompt is `prompts/draw.md`. The scene text is clamped to `image.maxPromptChars` (default 1600) characters. When the persona is in the picture (`self: true` in the call) and `image.reference` is `'avatar'`, the bot's Discord avatar is sent as a visual reference so the model knows what she looks like.

At most `image.maxPerDay` (default 50) pictures per day and `image.maxPerUserPerDay` (default 50) per requesting member. Both are checked before the request and counted only when it is sent. Image requests do not count against `llm.maxRequestsPerDay`. They are paid with the key `llm.keyByRole.drawing` names and show in the `costs.base` row of `/nep status`. A single request is cut off after `image.timeoutMs`.

Pricing depends on the provider. The provider's `usage.cost` is reported by `/nep draw` and logged (model and counts only, never the prompt). A generation the provider rejects for content policy costs nothing. In dry-run, the full prompt is logged but nothing is generated.

Switch: `features.imageGeneration` (default `false`).
Model role: `drawing`.

### Voice messages

When `features.speech` is on (default `true`; needs the system `ffmpeg`), the persona can send a voice message. She calls the `voice.say` tool with text, and the engine runs a three-step pipeline:

1. A preparation pass on the `analyzer` role (`prompts/speech-prepare.md`): dropped letters restored, stress marked on ambiguous words, bracketed directions rewritten as short audio tags. The pass may add marks and rewrite brackets, never touch a word. When its answer changes even one word (checked by `sameWords`), or the pass times out, errors or answers nothing, the call fails with `speech-prepare-failed` (the reason is in the result): nothing is synthesized, sent or counted against the daily limit, and she learns of it in her turn.

2. Synthesis through OpenRouter's speech endpoint on the `speech` role (`models.base.speech`, default `elevenlabs/eleven-v4`) with the voice named in `speech.voice` (default `jessica`). The key is the one `llm.keyByRole.speech` names (the main key without one).

3. Conversion to OGG/Opus at 48 kHz mono with ffmpeg, producing the audio file, its duration in seconds and the 256-byte waveform Discord draws.

The result is posted as a Discord voice message (no text, with the voice flag). At most `speech.maxPerDay` (default 100) messages per day, counted only when the synthesis request is sent. At most `speech.maxChars` (default 1500) characters per message.

The result tells her the duration, the characters, the estimated cost and the text as spoken. A diary turn may make one: it is not posted from the turn but kept in the entry, whose post keeps a `voice` field with the text as voiced and the length, and the diary's mirrors send it before her messages (`src/behavior/mirror.ts`).

Switch: `features.speech` (default `true`).
Model roles: `analyzer` (pronunciation pass), `speech` (synthesis).

## Blind spots

Voice messages from other people show only their duration. Audio files show a name and duration. The persona cannot hear either. How she handles a blind spot is the character card's call.
