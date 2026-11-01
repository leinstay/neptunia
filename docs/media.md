# Media

What the persona perceives from the chat and what she can produce.

Transcript lines carry media in brackets: pictures, GIFs, videos, stickers, custom emoji, voice messages, audio files, links. A `<senses>` block in each request tells the persona what is on and what is off under the current config; she trusts this block and never claims to have seen or heard anything beyond it.

## What she perceives

### Pictures

The persona does not receive images directly in her own request. A picture reaches her as a one-line caption in the transcript, written by a vision-capable model on the `vision` role (`models.base.vision`, default `google/gemini-3.8-flash`). The prompt is `prompts/describe.md`.

Each attachment or embed is described once and cached in `data/guilds/<id>/media.json`, trimmed by LRU to 5,000 entries (`MEDIA_CACHE_ENTRIES` in `src/web/cache.ts`). A repost costs nothing. A failed description is cached as a miss for one hour, except when the daily request cap (`llm.maxRequestsPerDay`) is spent: then nothing is downloaded or cached as a miss, so pictures from the last hours are still described after midnight UTC.

The picture is downloaded first (`src/media/fetch-image.ts`) and sent to the model as a `data:` URL, because some providers get a 403 from Discord's CDN. Downloads are cached in a small in-memory LRU (about 50 entries, 10 minutes), keyed by the URL without its query string (Discord's CDN query params rotate between fetches of the same file).

The persona looks at a picture again herself by calling the `media.look` tool with a message reference and her own question, at most twice per turn (`lookPerTurn` in `src/tools/tools.ts`). The vision model answers, and the answer appears in the transcript alongside the original caption. With the `vision` role down the look goes to the core model or answers `ability-unavailable` (see [When a model role is down](#when-a-model-role-is-down)).

### Avatars

Each member's Discord avatar is described by the `vision` role's model and stored in their profile as `avatar: { hash, text, describedAt }`. The avatar used is the server avatar when the member set one, otherwise the account avatar. Discord's default avatar (no upload) is recorded as `{ hash: null, default: true }`. A new version replaces the old one; no history is kept.

Avatars are queued (`src/memory/avatar-queue.ts`) and described one every 20 seconds (`INTERVAL_MS`). The caption is at most 200 characters (`DESCRIPTION_CHARS`). It appears in the `<people>` prompt block.

Model role: `vision`.

### Reactions

Reactions on the persona's messages are visible to her. The reactor store (`src/behavior/reactor-store.ts`) tracks who reacted (in-process, never persisted, gone at restart). Reactions appear in the transcript with the reactor's name alongside the emoji.

### Video

A video attached to a message, or a link to a known video site, is watched by a model on the `video` role (`models.base.video`, default `google/gemini-3.8-flash`). The model must accept both video and audio input through OpenRouter. The prompt is `prompts/describe-video.md`.

The known video sites (from `media.video.sites`): YouTube, TikTok, VK, X/Twitter, Reddit, Twitch.

Attachments and downloaded site videos are capped at 300 seconds and 14,500,000 bytes (`VIDEO_FIXED` in `src/memory/describe.ts`). Over-size files are re-encoded to 360p at a capped bitrate; a clip still too large after re-encoding is refused. Public-URL videos from `youtube.com` and `youtu.be` up to 3,600 seconds are sent by URL to the pinned provider (the `agentic` URL processing of `VIDEO_FIXED`). Longer videos take the download route (the first 300 seconds via yt-dlp).

At most five new videos per turn (`VIDEOS_PER_TURN` in `src/turn/phases/request/stages.ts`). Results are cached alongside picture descriptions.

Everything beyond attachments within the caps is downloaded with `yt-dlp` and trimmed with `ffmpeg`, both optional system binaries. Without them, attachments within the caps still work (sent as-is); longer attachments and all site links fall back to a still frame. For YouTube, when yt-dlp cannot probe the duration, an optional `YOUTUBE_API_KEY` in `.env` or a watch-page scrape provides it.

An optional proxy (`media.video.proxy`) routes yt-dlp downloads for sites listed in `media.video.proxySites`. When a proxied run fails, a plain TCP connect test tells whether the proxy is dead or the video itself is the problem. A dead proxy is skipped for `media.video.proxyRetryMinutes` (default 10) and the run retried directly.

#### The audio map

A video model told nothing about the sound tends to invent it for a silent clip. To prevent this, the fetcher measures each clip with a read-only ffmpeg `silencedetect` pass (`src/media/audio-map.ts`) and the describer adds a measured note to the video model's system prompt:

- `none`: no audio stream, or the entire track is silence.
- `map`: a list of audible stretches in `m:ss-m:ss` format.
- `full`: sound throughout.

The note uses the label from `labels.videoAudio.none` or `labels.videoAudio.map`. A failed measurement is logged and the note omitted, never treated as a failed fetch. GIF clips are silent by design and skip the audio measurement.

The measures are `AUDIO_MAP_DEFAULTS` in `src/media/audio-map.ts`: a noise floor of -50 dB, silences of at least 0.5 seconds, at most 20 stretches, and a map instead of `full` for a clip with less than 80% audible time.

#### Re-watch

The persona watches a video again herself through `media.look`, with her own question. The video model watches the clip again and the answer appears in the transcript alongside the original summary. The per-turn bound of `media.look` applies, and answers are cached for an hour per question.

Model role: `video`.

### Links

Links in the transcript are fetched and shown. The reader is `src/web/lookup.ts`, and its measures are constants there.

A link (http/https, private addresses refused, video-site links and the media hosts of `SKIP_SITES` excluded) is fetched through an SSRF-guarded page fetcher (at most 1,500,000 bytes, `LINK_MAX_BYTES`, with the timeout `web.links.fetchTimeoutMs`). The link's transcript tag carries the opening of the page's extracted text, cut at 700 characters (`LINK_PREVIEW_CHARS`), with no model request. A page that fails to load or has no text is cached as a miss.

The first link of each arriving message is read as the message arrives, so the next turn finds it cached (`src/pipeline/media-prefill.ts`). During a turn, at most two new links are fetched (`LINKS_PER_TURN` in `src/turn/phases/request/lookup.ts`). The persona reads further by calling her own `web.read` tool.

## What she produces

### GIFs

The persona builds a library of GIFs from the chat. Every GIF a member posts (a `gifv` embed from any site, a page from Tenor, Giphy or Klipy, or an attached .gif file) is counted deterministically (no model call) into `data/guilds/<id>/gifs.json`. Each entry gets a stable handle (`g1`, `g2`, etc.) that never changes and is never reused.

A `<gifs>` block in the prompt lists the most-used GIFs ranked by recency-weighted use (at most 25, `GIFS_MAX` in `src/turn/request/emoji-gifs.ts`). Each GIF has three caption fields from the describer: a reaction label (cut at 40 characters), a visible action (cut at 70 characters, both by `gifFieldChars`) and on-screen text. The persona posts a GIF by writing its handle in a `<gif>` tag. One GIF per turn; an unknown handle does nothing.

A GIF is watched as a short silent clip: the animation is converted to an mp4 of at most 15 seconds (`GIF_MAX_SECONDS` in `src/memory/describe.ts`) and sent to the `video` role through `prompts/describe-gif.md`. The watched caption replaces the old single-frame description. GIFs that cannot be watched keep the one-frame description.

A classifier on the `analyzer` role picks a GIF from the library to replace a short first message. The picker runs when the persona's first outgoing message is at most 160 characters (`GIF_PICK_DEFAULTS.maxChars` in `src/behavior/gif-pick.ts`) and she chose no GIF herself.

At first startup the engine reads the last 500 messages of every readable channel to seed the library, and the top 20 get captions right away (`BACKFILL_MESSAGES` and `BACKFILL_DESCRIBE` in `src/memory/gif-backfill.ts`).

Model roles: `video` (GIF watch), `analyzer` (GIF picker).

### Custom emoji

An `<emoji>` block lists the server's most-used custom emoji ranked by how often members use them. Uses are counted deterministically from each message. The persona writes `:name:` in a message or a reaction, and the engine turns known names into real Discord emoji markup (`<:name:id>`). Unknown names stay as plain text.

At first startup the engine reads the last 500 messages of each channel to seed the ranking (`BACKFILL_MESSAGES` in `src/memory/emoji-backfill.ts`).

### Stickers

Stickers appear in the transcript as their name. Frequently used stickers are described once by the `vision` role and cached by id. Discord's built-in animated stickers are Lottie animations, which cannot be described; they appear as a name only.

### Edits and deletes

The persona can edit and delete her own messages through her tools (`message.edit`, `message.delete`). She can only touch her own messages; the adapter returns `forbidden` for anyone else's. On Discord, an edited message shows Discord's "edited" marker.

### Drawings

The persona can draw pictures. She calls the `draw.create` tool with a scene description, and the engine generates one picture through OpenRouter's Images API on the `drawing` role (`models.base.drawing`, default `openai/gpt-image-2.5-flare`). The picture is posted as a file attachment in a separate message before her speech goes out. If the picture fails, her speech for that step is held so she does not claim a picture that does not exist.

The drawing prompt is `prompts/draw.md`. The scene text is clamped to `image.maxPromptChars` (default 1600) characters. When the persona is in the picture (`self: true` in the call) and `image.reference` is `'avatar'`, the bot's Discord avatar is sent as a visual reference so the model knows what she looks like.

Image requests do not count against `llm.maxRequestsPerDay`. They are paid with the key `llm.keyByRole.drawing` names and show in the `costs.base` field of the status card. A single request is cut off after `image.timeoutMs`.

Pricing depends on the provider. The provider's `usage.cost` is reported by `draw.create` and logged (model and counts only, never the prompt). A generation the provider rejects for content policy costs nothing.

With the `drawing` role down, her `draw.create` goes to the core model or answers `ability-unavailable` (see [When a model role is down](#when-a-model-role-is-down)).

Model role: `drawing`.

### Voice messages

The persona can send a voice message (it needs the system `ffmpeg`). She calls the `voice.say` tool with text, and the engine runs a three-step pipeline:

1. A preparation pass on the `analyzer` role (`prompts/speech-prepare.md`): dropped letters restored, stress marked on ambiguous words, bracketed directions rewritten as short audio tags. The pass may add marks and rewrite brackets, never touch a word. When its answer changes even one word (checked by `sameWords`), or the pass times out, errors or answers nothing, the call fails with `speech-prepare-failed` (the reason is in the result): nothing is synthesized or sent, and she learns of it in her turn.

2. Synthesis through OpenRouter's speech endpoint on the `speech` role (`models.base.speech`, default `elevenlabs/eleven-v4`) with the voice named in `speech.voice` (default `jessica`). The key is the one `llm.keyByRole.speech` names (the main key without one).

3. Conversion to OGG/Opus at 48 kHz mono with ffmpeg, producing the audio file, its duration in seconds and the 256-byte waveform Discord draws.

The result is posted as a Discord voice message (no text, with the voice flag). At most `speech.maxChars` (default 1500) characters per message.

The result tells her the duration, the characters, the estimated cost and the text as spoken. A diary turn may make one: it is not posted from the turn but kept in the entry, whose post keeps a `voice` field with the text as voiced and the length, and the diary's mirrors send it before her messages (`src/behavior/mirror.ts`).

With the `speech` role down, the synthesis goes to the core model or the call answers `ability-unavailable` (see [When a model role is down](#when-a-model-role-is-down)). The pronunciation pass stays on the `analyzer`.

Model roles: `analyzer` (pronunciation pass), `speech` (synthesis).

## When a model role is down

The roles behind her tools are `vision` and `video` (`media.look`), `drawing` (`draw.create`) and `speech` (`voice.say`). `src/llm/role-health.ts` keeps in memory which of them is down. A role is down when its model is `false` in `models.base`, when its key is missing, after a 401, 402 or 404, after a 429 that says the provider's daily limit is spent, and after three answers in a row with no text from the vision or video model. Any other failure of one request leaves the role up. A failing role gets one try after 1, 5, 15 and then every 60 minutes, and its first success clears it. The describer's vision and video requests, the drawing requests of her turn and the synthesis of `voice.say` report to it. A 429 from the speech endpoint carries no body the engine reads, so a daily limit there counts as a failure of one request.

While a role is down, its call goes to the core model with the same input and the role's own prompt when `models.abilities` declares the role's ability for the core model (`imagesIn`, `videoIn`, `imagesOut` or `audioOut`). Otherwise the call does not happen and its result is `ability-unavailable`, worded with the ability and the reason. A global failure met during a call routes that same call at once. The first result of a turn that took either path carries one more line naming every tool role that is down, so she hears it once per turn (`labels.tools.route`, [Prompt contract](prompt-contract.md)). `/status` lists each failing role with its reason, and `neptunia doctor` warns about a role with no model or no key.

The analyzer and the embedding role never move to the core: the analyzer's gates fail as they do without it, and recall searches by words when embeddings fail. `draw.create` runs on the drawing role alone.

## Blind spots

Voice messages from other people show only their duration. Audio files show a name and duration. The persona cannot hear either. How she handles a blind spot is the character card's call.
