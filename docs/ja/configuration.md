# 設定

`config.json` の全キーとデフォルト値をセクション別に記載します。

## `features`

| キー | デフォルト | 説明 |
|---|---|---|
| `dryRun` | `false` | フルパイプラインを実行するが送信しない。[ドライラン](README.md#ドライラン)を参照 |
| `mentions` | `true` | @メンションに反応 |
| `replies` | `true` | リプライに反応 |
| `nameTriggers` | `true` | メッセージ中の名前トリガーに反応 |
| `spontaneous` | `true` | ランダムタイマーによる自発的メッセージ |
| `eavesdrop` | `true` | どのメッセージにも割り込みうるランダムな確率 |
| `memory` | `true` | プロファイル構築、サーバーパターン追跡、自己言及の記録 |
| `relationships` | `true` | メンバーごとの態度スコア（-100..100） |
| `episodes` | `true` | メンバーごとの長期記憶（出来事、引用、恨み） |
| `lore` | `true` | サーバー全体のロアブック |
| `reactions` | `true` | 絵文字リアクション（ペルソナがリアクションを付ける） |
| `seeReactions` | `true` | トランスクリプト内のメッセージにリアクションを表示。キーが存在しない場合はオンとして扱われる。`reactions`（ペルソナがリアクションを付けるかどうか）とは異なり、こちらはペルソナがリアクションを見るかどうかを制御する |
| `customEmoji` | `true` | サーバーのカスタム絵文字を使用頻度でランク付けし、ペルソナが `:name:` で使用可能にする。キー欠落 = オン |
| `gifs` | `true` | メンバーが共有した GIF からライブラリを構築し、ペルソナがハンドルで投稿可能にする。キー欠落 = オン |
| `gifPicker` | `true` | ペルソナの最初のメッセージが `gifs.pick.maxChars` 文字以下で、自分で GIF を選ばなかった場合、分類器がフルライブラリから適切な GIF を選ぶ。一致した場合 GIF が最初のメッセージを置換し、残りのメッセージはそのまま投稿される。キー欠落 = オン。`features.gifs` がオンで、ライブラリが空でない必要あり |
| `embedUpdates` | `true` | Discord がメッセージ本体の後にリンクの埋め込みを添付した場合（Tenor の GIF はこの方式で届く）、その埋め込みをメモリバッファに取り込み、GIF ライブラリとアナライザーが GIF を認識できるようにする。キー欠落 = オン |
| `multiMessage` | `true` | 2〜3 件の連続メッセージを許可 |
| `vision` | `true` | 添付画像を処理 |
| `mediaDescriptions` | `true` | 画像、GIF、動画フレーム、リンクサムネイルの一行説明文 |
| `attachedDescriptions` | `true` | 添付画像に対しても説明モデルを実行する。ペルソナは引き続き画像を直接見るが、ヘルパーのノートが一目ではわかりにくい点を補足。`vision` と `mediaDescriptions` の両方が必要。キー欠落 = オン |
| `videoDescriptions` | `false` | 動画対応モデルで短い動画クリップを視聴。`mediaDescriptions` も有効にする必要がある。`config.local.json` で有効化。動画対応モデルが必要で、サイトリンクには `yt-dlp`/`ffmpeg` も必要 |
| `videoRewatch` | `true` | 話しかけられた時に動画を再視聴して質問に回答。`videoDescriptions` が必要 |
| `imageRelook` | `true` | 話しかけられた時に画像をもう一度見て質問に回答、または主張された詳細を確認。`vision` が必要。日次 `media.video.rewatch.maxPerDay` カウンターを動画再視聴と共有。未設定 = オン |
| `webLookup` | `false` | チャットに投稿されたリンクを読み取り、事実に関する質問にウェブ検索で回答。他の機能と異なり、キーが存在しない場合はオフとして扱われる。検索には `.env` に `BRAVE_SEARCH_API_KEY` が必要。キーがない場合はリンク読み取りのみ動作する。[メディア: リンクと検索](media.md#リンク)を参照 |
| `imageGeneration` | `false` | ペルソナが描画サブプロセスを通じて画像を描くことを許可。キーが存在しない場合はオンとして扱われる。`config.local.json` で有効化。`image.model` に画像生成対応モデルが必要。[メディア: 描画](media.md#描画)を参照 |
| `privateMessages` | `false` | ギルドメンバーのダイレクトメッセージに応答。保存された公開プロファイルと `affinity.score >= private.minAffinity` が必要。[メッセージとメモリ: プライベートレイヤー](messages-and-memory.md#プライベートレイヤー)を参照 |
| `privateLikeServer` | `true` | プライベートチャットがサーバーチャンネルのように動作する: ルート分類器、チャンネルプル、サーバー検索（recall）、言及メンバーのエピソードが DM で機能する。チャンネルはパートナーが View Channel 権限を持つ場合のみプルされる。キー欠落 = オン。`false` で従来の DM 動作に戻る（プル、ルート、recall、エピソードなし） |
| `channelPull` | `true` | 最近のメッセージやトリガーにチャンネルメンションが含まれている場合、そのチャンネルをリクエストに取り込む。キー欠落 = オン。`context.pull.*` 参照 |
| `elsewhere` | `true` | ボットが読めるが書けないチャンネルからの呼びかけ（@メンション、リプライ、名前）に応答。応答は `memory.mainChannelIds` の最初の利用可能なチャンネルに送信される。キー欠落 = オン |
| `portraitRefresh` | `true` | メッセージカウンターに基づいてメンバーのポートレートを定期的にリフレッシュ。キー欠落 = オン |
| `notesRefresh` | `true` | チャンネルとサーバーのノートを、最近のメッセージの分散サンプルから定期的に再チェック。キー欠落 = オン。`memory.notesRefreshDays*` および [ウォームアップ: ノートの鮮度維持](warmup.md#ノートの鮮度維持) 参照 |
| `versions` | `true` | プロースメモリフィールドのテキストが置換されるたびにバージョン履歴を保持。以前のテキストは `data/guilds/<id>/versions/` に保存。`/nep memory forget` および `/nep memory wipe` でバージョンファイルを削除。キー欠落 = オン |
| `memoryTwoStage` | `false` | メモリアナライザーを 2 段階に分割: ニュートラルな GPT モデルが変更を判定（ステージ A）、次にボイスモデルがペルソナのテキストを執筆（ステージ B）。厳密に `true` で有効。キー欠落 = オフ。`memory.voice.*` 参照 |
| `mentor` | `false` | 独自モデルを使用する手動テストサブプロセス。有効にするには厳密に `true` にする必要がある。キーが存在しない場合はオフ。[Mentor](#mentor) を参照 |
| `promptCache` | `false` | システムメッセージにプロバイダーのプロンプトキャッシュマーカーを付与する。キャッシュ読み取りは通常入力の数分の一のコストで、プロバイダーによってはトークンクォータにカウントされない。厳密に `true` で有効。キーが存在しない場合はオフ。`llm.cache.*` を参照 |
| `recall` | `true` | 質問に応じてウェブ検索と並行してサーバー自身のメッセージ履歴を検索する。キー欠落 = オン。[メディア: 検索](media.md#検索) と `recall.*` 参照 |
| `recent` | `true` | サーバーで直近数日間に何が起きたかを `<recent>` ブロックとして表示する。キー欠落 = オン。`memory.recentHours` と `context.caps.recent` 参照 |
| `channelRoute` | `true` | ターン前に分類器が会話の話題になっているチャンネルを特定し、リクエストに取り込めるようにする。キー欠落 = オン。`route.*` 参照 |
| `channelLinks` | `true` | ペルソナがメッセージ内にサーバーチャンネルの `#チャンネル名` を書いた場合、送信メッセージにはテキストの代わりに本物のチャンネルリンクが入る。名前は最長一致で照合。既存のリンクはそのまま。オフ: テキストがそのまま送信される。キー欠落 = オン |
| `pauseNotice` | `true` | ペルソナが一時停止中に呼ばれた場合、短い通知を投稿する。キー欠落 = オン。`mention.pauseNoticeMinutes` と `labels.limits.paused` 参照 |
| `diary` | `true` | ペルソナがオーナーの選んだチャンネルにランダムなスケジュールで自発的に投稿する。キーが存在しない場合はオン。`diary.channelId` が設定されていなければ何も起きない。[日記](diary.md)を参照 |
| `splitTasks` | `true` | 長く構造化された直接呼びかけを個別のパートに分割し、それぞれ独自のターンで回答。キー欠落 = オン。`prompts/split.md` と `labels.task.part` が必要 |
| `followUp` | `true` | ペルソナの応答後、タグなしメッセージを分類して会話を継続 |
| `typingSimulation` | `true` | タイピング速度をシミュレート |
| `adminCommands` | `true` | オーナースラッシュコマンド。`false` でコマンド登録を解除 |
| `memberCommands` | `true` | `/nep pings` コマンド。全メンバーが使用可能。`false` でオーナーのみに制限 |

## `bot`

| キー | デフォルト | 説明 |
|---|---|---|
| `timezone` | `"UTC"` | モデルのタイムスタンプに使うタイムゾーン |
| `owners` | `[]` | オーナーコマンド用のユーザー ID |
| `commandName` | `"nep"` | スラッシュコマンド名（小文字 `a-z 0-9 _ -`、最大 32 文字。変更時に再登録） |
| `nameTriggers` | `[]` | @メンション以外の追加トリガー文字列 |
| `guildId` | `""` | ロックするサーバー。一つだけに参加している場合は自動検出 |
| `dryRunChannelId` | `""` | ドライランミラー用チャンネル。[ドライラン](README.md#ドライラン)を参照 |
| `channels.allow` | `[]` | 許可チャンネル（空 = 表示可能なすべて） |
| `channels.deny` | `[]` | 無視するチャンネル |
| `access` | `{}` | オーナー以外がどのコマンドを実行できるか（`/nep access` で管理） |

## `llm`

| キー | デフォルト | 説明 |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | チャットコンプリーションのエンドポイント |
| `model` | `"anthropic/claude-opus-4.6"` | モデル ID |
| `temperature` | `1` | サンプリング温度 |
| `maxOutputTokens` | `700` | 最大出力トークン数 |
| `maxRequestTokens` | `50000` | リクエストあたりのハードトークン上限 |
| `safetyMargin` | `0.9` | `maxRequestTokens` のバジェット比率 |
| `timeoutMs` | `300000` | リクエストタイムアウト（ミリ秒） |
| `helperTimeoutMs` | `30000` | ターンと並行して実行されるヘルパー（ルート分類器、検索分類器、リコールサマリー）のタイムアウト。この時間を超えたヘルパーは破棄され、ターンはその結果なしで続行する |
| `pingTimeoutMs` | `30000` | `/nep ping` リクエストのタイムアウト（ミリ秒） |
| `retries` | `2` | 一時的な HTTP エラー（408/429/5xx）およびネットワーク障害時のリトライ回数。プロバイダーアカウントの日次クォータ 429 はリトライされず、1 回の試行後にそのままスローされる |
| `maxRequestsPerDay` | `300` | 1 日あたりのリクエスト上限 |
| `provider` | `null` | OpenRouter の `provider` ルーティングオブジェクト（そのまま渡される）。`null` の場合は送信しない |
| `providerByModel` | `{}` | モデルごとのプロバイダールーティング。詳細は下記 |
| `cache.ttl` | `"1h"` | マーカーに付与するキャッシュ TTL: `"1h"` または `"5m"` |
| `cache.roles` | `["voice"]` | システムメッセージにキャッシュマーカーを付与するリクエストロール。メモリボイスリクエストはオプトアウトするため、リプライのみがキャッシュされる |
| `cache.models` | `["anthropic/"]` | `cache_control` マーカーを受け入れるプロバイダーのモデル id プレフィックス（大文字小文字区別）。リスト外のモデルへのリクエストにはマーカーが付かない |
| `cache.promptIncludesCached` | `true` | プロバイダーが報告する `prompt_tokens` にキャッシュ読み取りとキャッシュ書き込みのトークンが含まれているかどうか。実際のプローブから一度設定する。トークンキャリブレーションとリクエスト上限は常にフルカウントを使用する |
| `hedge.roles` | `["classifier.text"]` | 呼び出しをヘッジするリクエストロール（2 つ同時に試行し、先に完了した方を採用） |
| `hedge.afterMs` | `2500` | 2 回目の試行を開始するまでのミリ秒。`0` 以下ですべてのロールのヘッジをオフ |
| `hedge.timeoutMs` | `8000` | 1 回目の試行開始からこのミリ秒でどちらも返っていない場合、両方を打ち切り |
| `hedge.longTimeoutMs` | `20000` | 呼び出し元がリクエストに `long: true` を付けた場合に `timeoutMs` の代わりに使用するタイムアウト（ルート分類器が大きなチャンネルリストで使用） |

`llm.provider` はチャットリクエストに対するデフォルトの OpenRouter プロバイダールーティングを設定します。例: `{ "ignore": ["some-provider"] }` や `{ "order": ["anthropic"], "allow_fallbacks": true }`。`llm.providerByModel` はモデルごとのオーバーライドを追加します。キーはモデル id のプレフィックス（任意のロールに一致）または `<prefix>@<role>`（1 つのロールのみ一致）で、値はそのまま渡される OpenRouter ルーティングオブジェクトです。

1 つのリクエストに対するプロバイダーの解決順序: 呼び出しごとの固定ルート（動画説明モデルのダイレクト URL パスでは `media.video.provider`）、次にリクエストのロールに一致する `providerByModel` キーのうち最長プレフィックス、次にロールなしキーのうち最長プレフィックス、次に `llm.provider`（画像リクエストでは `image.provider`）、最後にルーティングなし。同じモデルに対してロール指定キーはロールなしキーより常に優先されます。ロール名: `voice`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`、`image`。互換性のため、ルートキーやロールリストで `talk` と記載されたものは `voice` として読み取られ、1 回のログ行が出力されます（`config: role talk is now voice`）。

例: `"google/": { "only": ["google-vertex"], "allow_fallbacks": false }` はすべての Google モデルを Vertex 経由にし、`"google/@classifier.video": { "only": ["google-ai-studio"], "allow_fallbacks": false }` は動画分類器を AI Studio 経由にします。ドットを含むルートキー（例: `google/@classifier.video`）は `/nep set` では編集できません（ドットでパスを分割するため）。`/nep route set` と `/nep route remove` を使用してください。

OpenRouter アカウント自体が許可プロバイダーを制限している場合、唯一残ったプロバイダーを除外するとすべてのリクエストが "No endpoints found" で失敗します。プロバイダー設定を変更した後は `/nep ping` を実行してすべてのモデルロールが到達可能か確認してください。各ロールは `llm.providerByModel` のルートに従うため、表示されるプロバイダーはそのルートが選択したものです。

`features.promptCache` がオンの場合、ロールが `llm.cache.roles` に含まれ、モデルが `llm.cache.models` のプレフィックスで始まるリクエストのシステムメッセージにプロバイダーのプロンプトキャッシュマーカーが付与されます。マーカーはトークン推定の後に付与されるため、リクエストあたり 50k の上限とキャリブレーションに影響しません。`llm.cache.promptIncludesCached` は、プロバイダーがキャッシュトークンをどのように報告するかをエンジンに伝えます。実際のプローブから一度設定してください。`llm: usage` ログ行に `cache` フィールドが追加されます: `write`、`read`、`none`、`off`。

`llm: usage` ログ行には `ms`（リクエストの経過時間）、`purpose`（リクエストの用途を示す短い文字列。例: `route-channel`、`recall-summary`、`address`）、`origin`（例: mentor が発行したリクエストでは `mentor`）、`hedged`（ヘッジされたリクエストの場合 true）、`attempt`（ヘッジされたリクエストで 1 または 2。それ以外は省略）も含まれます。

`llm.hedge` が設定されている場合、リストされたロールのリクエストはヘッジされます: 1 回目の `llm.hedge.afterMs` 後に 2 回目の試行が発火し、先に完了した方が採用されます。どちらも `llm.hedge.timeoutMs`（`long: true` リクエストでは `longTimeoutMs`）で打ち切られます。2 回目が開始される前に完了しなかったヘッジ呼び出しは追加のリクエストを 1 件発生させ、両方が `llm.maxRequestsPerDay` にカウントされます。

## `classifier`

3 つのヘルパーモデルロールを 1 つのキーにまとめています。それぞれ独立して設定できるため、ペルソナの声にはプレミアムモデルを使い、ヘルパーには安価なモデルを使うことができます。

| キー | デフォルト | 説明 |
|---|---|---|
| `text` | `"anthropic/claude-sonnet-4.6"` | テキスト分類器: アドレス分類器（`features.followUp`）、検索分類器・リンク読み取り・検索要約・リコールサマリー（`features.webLookup`、`features.recall`）、再視聴分類器（`features.videoRewatch`）、ルーム分類器（`spontaneous.roomQuestionChance`）、チャンネルルート分類器（`features.channelRoute`） |
| `media` | `"anthropic/claude-haiku-4.5"` | 画像説明モデル（`features.mediaDescriptions`）: 画像、GIF フレーム、動画ポスター、スティッカー、カスタム絵文字、リンクサムネイルの一行説明文 |
| `video` | `"google/gemini-3.8-flash"` | 動画説明モデル（`features.videoDescriptions`）: 短いクリップの視聴、質問に対する再視聴、リクエストに応じたリトライ。動画と音声の両方の入力を受け付ける必要がある |

**旧キーからの移行。** 非推奨のキー `llm.classifierModel`、`mention.followUpModel`、`media.model`、`media.video.model` は読み取られなくなりました。これらのいずれかが `config.local.json` に存在する場合、ボットは起動時に警告をログに記録し（`index: deprecated model key ignored`）、キー名とその置き換え先を示します。値を `classifier.text`、`classifier.media`、`classifier.video` にそれぞれ移行してください。

## `context`

| キー | デフォルト | 説明 |
|---|---|---|
| `channelMessages` | `100` | 現在のチャンネルのメッセージ数 |
| `fetchReplyParents` | `true` | ウィンドウ内のリプライがウィンドウより古いメッセージを指す場合、親メッセージを取得してウィンドウの前に配置し、モデルがリプライ先を読めるようにする。discord.js のキャッシュを先にチェックするため、キャッシュ内ならば API リクエスト不要。キー未設定はオン扱い |
| `replyParentsFor` | `3` | ウィンドウ末尾の返信行のうち、ウィンドウより古いメッセージへの返信であるものについても親を取得する行数。トリガーメッセージは常にチェックされ、親と祖親を取得できる |
| `replyParentsMax` | `4` | ターンあたりウィンドウ前に配置できる親行の上限 |
| `neighborMessages` | `5` | 隣接チャンネルあたりのメッセージ数 |
| `neighborMaxAgeMinutes` | `60` | 隣接メッセージの最大経過時間（分） |
| `neighborMaxChannels` | `8` | 隣接チャンネルの最大数 |
| `neighborMessageChars` | `300` | 隣接チャンネルのメッセージあたりの保持文字数（`<other_channels>`） |
| `maxMessageChars` | `800` | この文字数を超えるメッセージを切り詰め（文字） |
| `gapMarkerMinutes` | `20` | タイムギャップマーカーの閾値（分） |
| `ageAfterMinutes` | `60` | ペルソナがチャットを読む時点で投稿からこの分数以上たったメッセージは、時刻の横に経過時間も表示される（例: `[14:32 · 2 h 58 min ago]`）。それより新しいメッセージは `[14:32]` のみ。現在のチャンネル、プルされたチャンネル、隣接チャンネルに適用。`prompts.local/labels.json` で `transcript.timeAged` を空にすると経過時間は表示されない |
| `reactionsPerMessage` | `6` | トランスクリプト内の 1 メッセージあたりの最大リアクション数（頻度降順） |
| `replyQuoteChars` | `80` | リプライタグに表示される親メッセージのテキスト文字数。引用は単語境界でカットされる。`0` で全文表示 |
| `otherProfiles` | `6` | 表示する他のプロファイルの最大数 |
| `askedAboutProfiles` | `3` | 最近のメッセージで言及されたメンバーを他の参加者より先にフル表示する最大数 |
| `askedAboutEpisodes` | `3` | 言及されたメンバーごとに表示するエピソード数。`0` で非表示。プライベートチャットでは `features.privateLikeServer` がオン（デフォルト）の場合に表示、オフの場合は非表示 |
| `attitudes` | `6` | `<attitudes>` ブロックに表示するメンバー数。態度スコアの強さでランク付け、好意と反感混在。`0` でブロックオフ |
| `tempo.liveMessages10min` | `4` | 10 分間のメッセージ数がこの値で「ライブ」 |
| `tempo.deadSilenceMinutes` | `45` | この分数の沈黙で「デッド」 |
| `caps.interlocutor` | `6000` | トークン上限: 発話者のプロファイル（エピソード含む） |
| `caps.aboutChat` | `2500` | トークン上限: サーバーの傾向 / 自己言及 |
| `caps.lore` | `1500` | トークン上限: ロアブックエントリ |
| `caps.people` | `9000` | トークン上限: 他のプロファイル |
| `caps.attitudes` | `400` | トークン上限: 態度リスト |
| `caps.neighbors` | `3000` | トークン上限: 隣接チャンネル |
| `caps.server` | `4000` | トークン上限: チャンネルマップ |
| `caps.emoji` | `800` | トークン上限: カスタム絵文字 |
| `caps.gifs` | `900` | トークン上限: GIF ライブラリ |
| `caps.pulled` | `4000` | トークン上限: プルされたチャンネルブロック（`<channel_view>`） |
| `channelActivity.liveMessagesPerDay` | `20` | 1 日あたりのメッセージ数がこの値で「アクティブ」チャンネル |
| `channelActivity.deadAfterDays` | `7` | メッセージがないまま経過した日数で「デッド」チャンネル |
| `vision.maxImages` | `4` | リクエストあたりの最大画像数 |
| `vision.tokensPerImage` | `400` | 画像あたりのトークンバジェット |
| `vision.imageSize` | `512` | Discord のメディアプロキシによるダウンスケール目標（px） |
| `vision.recentImages` | `3` | 含める最近のチャンネル画像数 |
| `vision.recentImageMinutes` | `30` | 最近の画像の最大経過時間（分） |
| `vision.maxBytes` | `1500000` | 画像ファイルの最大サイズ（バイト）。超過した画像はスキップ |
| `vision.fetchTimeoutMs` | `10000` | 画像あたりのダウンロードタイムアウト（ミリ秒） |

### `context.customEmoji`

カスタム絵文字ブロック（`features.customEmoji`）の設定。メモリアナライザーがメンバーのカスタム絵文字の使用頻度を追跡します。

| キー | デフォルト | 説明 |
|---|---|---|
| `max` | `30` | `<emoji>` ブロックに表示するカスタム絵文字数（メンバーの使用頻度でランク付け。ランクされた数が `max` 未満の場合、残りはサーバーの絵文字順で補完） |
| `storeMax` | `200` | 使用ランキングに保持するカスタム絵文字数。上位 `max` 件が表示される |
| `halfLifeDays` | `30` | 使用ランキングの新しさ半減期（日）。rank = log2(count + 0.5) + last / halfLife。最近使用されていない絵文字はよく使われるものの下に沈む |
| `backfillMessages` | `500` | 起動時にランキングをシードするためチャンネルごとの履歴から読むメッセージ数。このサーバーで `features.customEmoji` がオンでバックフィルが未実行の場合に 1 回実行。結果は `guild.json` にスタンプ。`0` でバックフィルを無効化 |

### `context.pull`

別のチャンネルをターンのリクエストに取り込む設定（`features.channelPull`）。最近のメッセージやトリガーに Discord チャンネルメンション（`<#id>`）が含まれる場合、そのチャンネルの最新メッセージが `<channel_view>` ブロックとして描画されます。

| キー | デフォルト | 説明 |
|---|---|---|
| `windowMinutes` | `60` | 取り込むメッセージのウィンドウ（チャンネルの最新メッセージから遡る分数） |
| `minMessages` | `5` | ウィンドウ内の最小メッセージ数。不足する場合はさらに遡る |
| `maxMessages` | `60` | チャンネルあたりの最大取り込みメッセージ数 |
| `maxPictures` | `10` | キャプションを含める画像数。キャッシュ済みのキャプションはコストなし |
| `maxNewDescriptions` | `8` | プルされたチャンネルの画像に対するターンあたりの新規説明リクエスト数 |
| `describeTimeoutMs` | `15000` | 新規キャプションリクエストのタイムアウト（ミリ秒） |
| `scanMessages` | `20` | チャンネルメンションをスキャンする現在のチャンネルの直近メッセージ数 |
| `maxChannels` | `1` | ターンあたりに取り込めるチャンネル数 |
| `maxAgeDays` | `0` | チャンネルの最新メッセージがこの日数より古い場合、取り込みを拒否。`0` = 制限なし |
| `sameAudience` | `true` | 送信先チャンネルを閲覧できるすべてのロールがソースも閲覧できるかチェック。`<other_channels>` に表示される隣接チャンネルとリコール検索で保持されるウィンドウにも適用。false にすると制限チャンネルのコンテンツがより広い範囲に届く可能性がある |

## `elsewhere`

ボットが読めるが書けないチャンネルからの呼びかけ（`features.elsewhere`）への応答設定。そうしたチャンネルでの呼びかけ（メンション、リプライ、名前）は会話が落ち着くのを待ち、`memory.mainChannelIds` の最初の利用可能なチャンネルにリンク付きで応答します。

| キー | デフォルト | 説明 |
|---|---|---|
| `settleSeconds` | `90` | ソースチャンネルの最後のメッセージからこの秒数後に応答 |
| `settleMaxSeconds` | `300` | バーストの最初の呼びかけからこの秒数で、待たずに応答 |
| `rememberPings` | `20` | チャンネルあたりのリングに記憶する呼びかけ数 |
| `pingMaxAgeDays` | `7` | 記憶された呼びかけが期限切れになるまでの日数 |

## `pace`

誰かが返答を待っているターンの各段階に許される時間。すべてホットリロード。期限を過ぎたヘルパーは破棄され、ターンはその結果なしで続行します。`dropAfterMs` までに完成した回答が届いていないターンは破棄されます（`turn: dropped` としてログ）。各リクエストは `turn: timings` で各段階の所要時間をログに記録します。

| キー | デフォルト | 説明 |
|---|---|---|
| `prepareMs` | `6000` | ターン開始からボイスリクエストまでのミリ秒。LLM 呼び出し前に実行されるすべて（履歴、キャプション、ルートおよび検索分類器）がこのウィンドウ内に完了する必要がある。`0` または数値以外で制限を解除 |
| `prepareSearchMs` | `12000` | 検索分類器の判定中と、分類器が要求した検索の実行中に、期限をこの値まで延長。「検索不要」の判定でホールドを即座に解除。`prepareMs` より短くならない。`0` または数値以外で制限を解除 |
| `prepareMediaMs` | `20000` | 直接呼びかけのトリガーメッセージ（またはそのリプライ元）に説明モデルや動画ステージが処理する画像、GIF、動画が含まれる場合の延長期限。`prepareMs` より短くならない。検索延長も適用される場合は大きい方が優先。`0` または数値以外で延長を解除 |
| `dropAfterMs` | `60000` | ターン開始からのミリ秒。この時間までに完成した回答が届いていない場合、ターンは投稿されず破棄（`turn: dropped`）。`0` または数値以外で制限を解除 |
| `replyHedgeMs` | `20000` | 直接呼びかけに応答するターンで、リプライリクエストがこのミリ秒以内に回答を返さない場合、同一の 2 回目のリクエストが送信される。先に完了した方が採用され、もう一方は打ち切られる。2 回目の試行は `llm.maxRequestsPerDay` にカウントされる。`dropAfterMs` の制限はそのまま適用される。`0` または数値以外で 1 回のみ。非呼びかけターン（`unpromptedWaits`）は 2 回目を送信しない |
| `typingWhilePreparing` | `false` | 直接呼びかけ（メンション、リプライ、名前、フォローアップ、プライベート）に応答するターンの開始時点から入力中インジケーターを表示する（完成した回答のタイプアウト中だけでなく）。厳密に `true` で有効 |
| `unpromptedWaits` | `true` | 非呼びかけターン（割り込み、話題開始、気付いたコメント、全員への質問、漏れ聞き）は全段階を待ち、準備完了後に投稿する（`prepareMs`、`prepareSearchMs`、`dropAfterMs` を無視）。`false` で全ターンに同じ期限が適用される。キー欠落 = オン |

## `format`

モデル出力を Discord に送信する前の後処理。すべてホットリロード。

| Key | Default | Meaning |
|---|---|---|
| `stripDashes` | `true` | `<msg>` テキストのエムダッシュとエンダッシュを投稿前に除去する。ダッシュとその周囲のスペースは 1 つのスペースになる。ギュメ（`«`、`»`）はプレーンな `"` に置換される。除去後に空になったメッセージは送信されない。ハイフンはそのまま残る。`<draw>`、`<react>`、`<gif>` とリプライ id は影響を受けない。キー未設定はオン。`false` のみオフにする |

## `route`

チャンネルルート分類器（`features.channelRoute`）の設定。会話が別のチャンネルに名前で言及したり参照したりする場合、分類器（`prompts/route-channel.md`、`classifier.text` ロール）がリストからチャンネル番号を選択します。選択されたチャンネルは明示的なチャンネルメンションと並んで `<channel_view>` ブロックとしてリクエストに取り込まれます。ログ: `route: classified`、`route: skipped`、`route: failed`。

| キー | デフォルト | 説明 |
|---|---|---|
| `contextMessages` | `20` | 分類器に渡す直近のチャンネルメッセージ数 |
| `maxChannels` | `40` | 分類器の選択肢として表示するチャンネル数 |
| `purposeChars` | `80` | リストに表示する各チャンネルの保存済み目的の文字数 |
| `maxOutputTokens` | `120` | 分類器の最大出力トークン数 |

## `split`

タスクスプリッター（`features.splitTasks`）の設定。直接呼びかけ（メンション、リプライ、名前、フォローアップ、プライベートメッセージ）が十分に長く構造化されている場合、分類器（`prompts/split.md`、`classifier.text` ロール）がそこに複数の独立したリクエストが含まれるかを判定します。各パートは独自のターンで回答されます。最初のパートはメッセージへのリプライ、残りはプレーンで投稿されます。スプリッターはターンの準備と並行して実行されるため、単一リクエストが遅延することはありません。ログ: `split: verdict`、`split: skipped`、`split: failed`。各パートは `turn: part` をログ。

| キー | デフォルト | 説明 |
|---|---|---|
| `minChars` | `80` | スプリッターに問い合わせる前の最小文字数（リンクと Discord トークンを除く） |
| `minPartChars` | `20` | 返されたパートがこの値より短い場合（文字数、リンクと Discord トークンを除外、`minChars` と同様）次のパートに統合（最後のパートは前のパートに統合）。残りが 2 未満になるとメッセージは 1 つのリクエスト。`0` = 統合なし |
| `maxTasks` | `4` | スプリッターが返せる最大パート数。2 未満でスプリッターオフ |
| `contextMessages` | `6` | 候補と共に分類器に渡す直近のチャンネルメッセージ数 |
| `maxOutputTokens` | `300` | 分類器の最大出力トークン数 |

## `recall`

サーバー履歴検索（`features.recall`）の設定。ルックアップ分類器（`prompts/lookup.md`）が `server:` フォーム、`who:` 名前フォーム、`when:` 日付範囲で応答した場合、エンジンは Discord の検索 API でサーバーのメッセージ履歴を検索し、ヒットをクラスターに分類、各クラスターの周辺のメッセージウィンドウをフェッチし、サマリーヘルパー（`prompts/recall-summary.md`、`classifier.text` ロール）に回答を求めます。サマリーが特定のストレッチを指定した場合、そのストレッチの原文が要約ノートと共に表示されます。ログ: `recall: searched`、`recall: summary`、`recall: skipped`、`recall: failed`。

| キー | デフォルト | 説明 |
|---|---|---|
| `maxForms` | `5` | `server:` 行ごとの検索フォーム（語形変化）の最大数 |
| `maxPeople` | `2` | `who:` 行に含められる人数 |
| `dateSamples` | `4` | コンテンツフォームがない `when:` 範囲でサンプルされる日付のみクエリ数 |
| `clusterGapMinutes` | `30` | ヒットを別のクラスターに分割するギャップ（分） |
| `maxClusters` | `5` | 保持されるクラスター数。トピックスコア（クラスターにヒットがある各 `server:` フォームがレアなら 2、それ以外は 1 を加算）、次に全異なるクエリ数、次に新しい順でランク付け。名前・著者のヒットのみのクラスターはトピックヒットが 1 つでもあるクラスターより下位 |
| `keepOldest` | `0` | 上位 `maxClusters` のうち、トピックスコアが 2 以上の最古のクラスターにこの数のスロットを予約。スコアが 2 未満のクラスターは予約対象外。`0` = ランク順のみ |
| `rareHits` | `5` | サーバー全体で検索結果がこの数以下の `server:` フォームはクラスターのトピックスコアで 2 倍に数える。`0` = レアボーナスなし |
| `windowMessages` | `16` | 各クラスター中心の周辺でフェッチするメッセージ数 |
| `answerChars` | `1200` | サマリーノートの最大文字数。`recall-summary.md` の `{{answerChars}}` に使用 |
| `stretchChars` | `1500` | ペルソナに表示される原文ストレッチの最大文字数 |
| `maxPerDay` | `100` | 1 日あたりのリコール実行数（`state.json` に `recallDay` / `recallCount` として保存） |
| `timeoutMs` | `10000` | リコール実行の合計時間（検索、ウィンドウ、サマリー）。半分の時間が経過すると新たな検索は送信されず、サマリーは少なくとも `minSummaryMs` が残っている場合のみ実行 |
| `minSummaryMs` | `2500` | サマリーヘルパーを呼ぶための最小残り時間。残り時間不足の場合、上位ウィンドウの原文ストレッチがノートなしで返される |
| `memoryItems` | `6` | 分類器のワードフォームとネームフォームに一致する保存済みメモリ項目（エピソード、ロア、レッスン、最近の行）をリコールサマリーの `<memory>` ブロックとして送信。`0` でマッチオフ |
| `maxOutputTokens` | `500` | サマリーヘルパーの最大出力トークン数 |

## `gifs`

GIF ライブラリ（`features.gifs`）の設定です。メッセージ到着時に使用回数をカウントします（メンバーのみ、ボットとペルソナは除外）。起動時にチャンネル履歴から一度だけバックフィルしてランキングをシードします。

| キー | デフォルト | 説明 |
|---|---|---|
| `max` | `40` | `<gifs>` ブロックに表示する GIF 数（使用頻度と新しさでランク付け） |
| `reactionChars` | `40` | `<gifs>` リストおよびライブラリ GIF のトランスクリプト行のリアクションラベルあたりの保持文字数。`0` で全文表示 |
| `actionChars` | `70` | `<gifs>` リストおよびライブラリ GIF のトランスクリプト行のアクション行あたりの保持文字数（単語境界でカット）。`0` で全文表示 |
| `storeMax` | `300` | ライブラリに保持する GIF 数。上位 `max` 件が表示される |
| `halfLifeDays` | `30` | 使用ランキングの新しさ半減期（日）。カスタム絵文字と同じ計算式 |
| `maxPerDay` | `40` | ペルソナが 1 日に投稿できる GIF 数 |
| `backfillMessages` | `500` | 起動時にライブラリをシードするためチャンネルごとの履歴から読むメッセージ数 |
| `backfillDescribe` | `20` | バックフィル後すぐにキャプションを付ける上位 GIF の数 |
| `recachePerRun` | `50` | `/nep gifs recache` の 1 回の実行で再記述するライブラリ GIF の件数。ライブラリ外の単一フレーム説明は即座に削除され、旧形式の視聴済みエントリ（`reaction` フィールドなし）が未完了のものと共にキューされ、古いものから順に処理される。1 回の実行でこの件数まで視聴され、`media.gif.maxPerDay` で制限される |
| `ownMarkHours` | `24` | ペルソナの GIF 投稿後、`<gifs>` リストの該当項目にマークが付く時間。`0` でオフ |

### `gifs.pick`

GIF ピッカー（`features.gifPicker`）の設定です。ペルソナの最初の送信メッセージが短い場合（`gifs.pick.maxChars` 文字以下）で、自分で GIF を選ばなかった場合、分類器（`classifier.text`、プロンプト `prompts/gif-pick.md`）が直近のチャット行（応答先メッセージを明示）、その最初のメッセージ、キャプション付きのフルライブラリ（各エントリにキャプションと、該当する場合は自分マーク付き）を受け取り、ハンドル 1 つまたは `none` を返します。ハンドルが返されると GIF が最初のメッセージを置換し、残りのメッセージは順番に続きます。分類器は最初のメッセージのタイピングシミュレーション中に実行され、日次 GIF 制限 `gifs.maxPerDay` が適用されます。

| キー | デフォルト | 説明 |
|---|---|---|
| `maxChars` | `160` | 最初のメッセージの上限: ペルソナの最初の送信メッセージがこの文字数以下の場合にのみピッカーが実行される |
| `contextMessages` | `4` | 返答とライブラリとともに分類器に送信される直近のチャット行数 |
| `maxOutputTokens` | `60` | ピッカー分類器の最大出力トークン数 |

## `media`

メディア説明モデル（`features.mediaDescriptions`）の設定です。説明モデルは `classifier.media` です。

| キー | デフォルト | 説明 |
|---|---|---|
| `maxOutputTokens` | `120` | 説明文あたりの最大出力トークン数 |
| `descriptionChars` | `500` | 説明文の最大文字数。超過分は文の境界でカット |
| `imageSize` | `512` | ダウンスケール目標（px） |
| `maxPerTurn` | `6` | ターンあたりの最大説明文生成数 |
| `prefillPerMessage` | `4` | メッセージ到着時にプリフィル記述する添付ファイルの最大数（メッセージあたり）。ターンパスはこの制限を受けない |
| `cacheEntries` | `5000` | 添付ファイルをキーとする説明文キャッシュサイズ |
| `filePreviewChars` | `500` | テキストファイル冒頭から表示する文字数 |
| `embedTextChars` | `200` | リンクの埋め込みテキストから表示する文字数 |

### `media.gif`

GIF を短いクリップとして視聴する機能（`media.gif.watch`）の設定です。有効な場合、GIF のアニメーションは短い mp4 に変換されて `classifier.video` モデルに送信され、単一フレームの記述の代わりになります。視聴できない GIF（アニメーションソースなし、日次上限到達、変換失敗）は単一フレームの記述にフォールバックします。

| キー | デフォルト | 説明 |
|---|---|---|
| `watch` | `true` | 単一フレームの記述の代わりに GIF を短い動画クリップとして視聴する。`features.mediaDescriptions` と `features.videoDescriptions` の両方が有効である必要がある。キーが存在しない場合はオンとして扱われる |
| `maxSeconds` | `8` | 動画モデルに送信するアニメーションの秒数。クリップは ffmpeg で変換される |
| `maxPerDay` | `200` | 1 日あたりの GIF 視聴上限。`media.video.maxPerDay` とは別にカウントされる。上限到達後は単一フレームの記述にフォールバック |

### `media.video`

動画説明モデル（`features.videoDescriptions`）の設定です。動画ビジョンは `features.mediaDescriptions` と `features.videoDescriptions` の両方が有効である必要があります。動画モデルは `classifier.video` です。動画対応の別モデルが短いクリップを視聴します。対象は Discord の動画添付ファイルと `media.video.sites` に含まれるサイトへのリンクです。結果は画像の説明文と同じメディアキャッシュに保存されるため、再投稿のコストはかかりません。

| キー | デフォルト | 説明 |
|---|---|---|
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | ダイレクト URL パス（上限内の YouTube）用の OpenRouter プロバイダールーティング。`llm.providerByModel` と `llm.provider` より優先。`null` の場合は通常の解決順序に従う |
| `maxOutputTokens` | `800` | 動画サマリーあたりの最大出力トークン数 |
| `summaryChars` | `1500` | 動画説明の最大文字数。`describe-video.md` の `{{maxChars}}` に使用 |
| `maxRequestTokens` | `60000` | 動画リクエストあたりのトークン上限（入力 + 出力）、`llm.maxRequestTokens` の代わりに使用。agentic モードでは公開 URL 動画の推定に `directUrlTokensPerSecond`（10）を使用: 1 時間の YouTube で 36 000 トークン。ダウンロードしたクリップは `tokensPerSecond`（120）を使用: 3 分で 21 600 トークン |
| `maxSeconds` | `180` | 添付ファイルとダウンロードしたサイト動画のクリップの最大長（秒）。超過する添付ファイルは `ffmpeg` でトリムされ、超過するサイト動画は `yt-dlp` で先頭の `maxSeconds` に切り取られる。ダイレクト URL サイトには `directUrlMaxSeconds` が適用される |
| `directUrlMaxSeconds` | `3600` | 公開 URL 動画（YouTube およびその他の `directUrlSites`）の最大長（秒）。`urlProcessing` が `agentic` の場合に適用。他のモードではこの値と `maxRequestTokens / tokensPerSecond` の小さい方が有効。超過する動画はダウンロードルート（先頭の `maxSeconds` を yt-dlp で取得）へ移行するが、YouTube はサーバーからのダウンロードをボットチェックでブロックすることが多い |
| `maxBytes` | `12000000` | 添付ファイルとダウンロードしたサイトクリップの最大ファイルサイズ（バイト）。ダウンロード自体はこの 4 倍までのサイズになることがある。超過するファイルはまず `ffmpeg` で 360p に再エンコードされ、再エンコード後も超過する場合のみ永続ミスとして拒否 |
| `maxPerTurn` | `1` | ターンあたりの最大新規動画数。成否を問わずすべてのフェッチ試行がカウントされる |
| `maxPerDay` | `40` | 1 日あたりの動画リクエスト上限（`state.json` に `videoDay`/`videoCount` として保存） |
| `tokensPerSecond` | `120` | バジェットチェック用の動画 1 秒あたりのトークン推定値。ダウンロードしたクリップと agentic モード以外の公開 URL 動画に適用。agentic モードでは代わりに `directUrlTokensPerSecond` を使用 |
| `directUrlTokensPerSecond` | `10` | agentic モードにおける公開 URL 動画のプリフライトバジェットチェック用の 1 秒あたりのトークン推定値（モデルは必要な部分だけ読み込み、動画自体はプロンプトトークンとしてカウントされない）。値が未設定または無効な場合は `tokensPerSecond` にフォールバック。`tokensPerSecond`（120）はダウンロードしたクリップと agentic 以外のモードの URL に引き続き適用 |
| `timeoutMs` | `90000` | 動画用の LLM リクエストタイムアウト（ミリ秒） |
| `toolTimeoutMs` | `60000` | `yt-dlp` と `ffmpeg` サブプロセスのタイムアウト（ミリ秒） |
| `sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | 動画として扱うリンクのホスト名 |
| `directUrlSites` | `["youtube.com", "youtu.be"]` | 公開 URL を直接プロバイダーに渡せるサイト（プロバイダーが動画を取得） |
| `directUrlUnknownDuration` | `false` | プローブで再生時間を特定できなかった場合でも directUrlSites のリンクをプロバイダーに送信する。トークン推定は `maxSeconds` を使用。下記の再生時間チェーンを参照 |
| `canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | 起動時と `/nep ping classifier.video` でプローブされる固定の YouTube 動画。YouTube API key と再生時間ソースをテストする |
| `ytdlpPath` | `"yt-dlp"` | `yt-dlp` バイナリのパス。サイト動画リンクと再生時間のプローブに必要 |
| `ffmpegPath` | `"ffmpeg"` | `ffmpeg` のパス。長い、またはサイズの大きい添付ファイルのトリムとダウンスケールに必要 |
| `proxy` | `""` | `yt-dlp` 用のプロキシ URL。`yt-dlp` が受け入れる形式（`socks5h://user:pass@host:port`、`http://host:port`）で指定する。`""` = プロキシなし。サイトがサーバーの IP を拒否する場合に使用（YouTube はデータセンターの IP に「ロボットでないことを確認してください」を返す）。`proxySites` のサイトへのリンクのみがプロキシを使用する。値にパスワードを含む場合があり、ログには出力されない。プロキシ経由では動画全体をダウンロードし、`ffmpeg` がローカルで先頭の `maxSeconds` を切り出す。yt-dlp のセクションダウンロードモードは ffmpeg を起動するが、ffmpeg は SOCKS プロキシを使用できないため、ダウンロード上限（4x `maxBytes`）が長い動画の可否を決める |
| `proxySites` | `["youtube.com", "youtu.be"]` | 再生時間のプローブとダウンロードに `proxy` を使用するサイト。ホストが一覧のサイトと一致するか `.<サイト>` で終わる場合にマッチする。他のサイトへのリンクは直接接続する。`[]` でプロキシをオフにする |
| `proxyRetryMinutes` | `10` | プロキシ経由のダウンロードまたはプローブが失敗した後、ボットはプロキシが接続を受け入れるかを確認する。受け入れる場合は動画自体の問題であり、リンクは読み込み不可として報告される。プロキシがダウンしている場合、そのリンクはプロキシなしで即座に再試行され、この分数の間すべてのリンクがプロキシをスキップする（`fetch-video: proxy failed`、ウィンドウにつき 1 回の `fetch-video: proxy skipped`）。メモリにのみ保持され、再起動でリセットされる |
| `errorRetryMinutes` | `60` | エラーキャッシュされた動画が自動リトライされるまでの分数。再視聴分類器からの強制リトライはこの値を無視する |
| `urlProcessing` | `"agentic"` | 公開 URL 動画パーツに送信される OpenRouter の処理モード。これがないと一部のプロバイダーは 1 フレームしか見ない。`null` でフィールドを省略 |
| `reasoning` | `{ "effort": "low" }` | すべての動画リクエストに使用する OpenRouter `reasoning` 設定。推論が出力バジェットを消費するのを防ぐ。非オブジェクトでフィールドを省略 |
| `prefill` | `true` | 動画が届いた時点で視聴し、次のターンでキャッシュ済みの状態にする |
| `prefillPerMessage` | `2` | メッセージ到着時にプリフィル視聴する動画の最大数（メッセージあたり）。ターンパスはこの制限を受けない |

`yt-dlp` と `ffmpeg` はどちらもオプションのシステムバイナリです。これらがなくても上限内の添付ファイルはそのまま動作します（そのまま送信されます）。長い添付ファイルとすべてのサイトリンクは静止フレームまたはプレビュー画像にフォールバックし、ペルソナには理由が伝えられます。すべての動画リクエストは `llm.maxRequestsPerDay` と動画トークン上限（`maxRequestTokens`）にカウントされます。

YouTube リンクの再生時間は次の順序で取得されます: まず yt-dlp、次に YouTube Data API（`.env` に `YOUTUBE_API_KEY` が設定されている場合）、最後にウォッチページのスクレイプ。すべてのプローブが失敗し `directUrlUnknownDuration` がオフ（デフォルト）の場合、リンクは「読み込めませんでした」と報告されます。スイッチがオンの場合、URL はそのままプロバイダーに送信され、トークン推定では `maxSeconds` として計上されます。Data API キーは無料です: Google Cloud コンソールで YouTube Data API v3 を有効にしてキーを作成します。無料枠は 1 日 10,000 ユニット、再生時間のルックアップ 1 回は 1 ユニットです。`/nep ping classifier.video` は `canaryUrl` をプローブし、API key のステータスを報告します（例: `youtube: API key — ok`）。キャッシュされた長さ制限の結果は動画の再生時間を記録し、上限が引き上げられたときに再試行されます。

### `media.video.rewatch`

再視聴分類器（`features.videoRewatch`）の設定です。ペルソナに話しかけられた時に直近のトランスクリプトに視聴済み動画がある場合、安価な分類器がメッセージがそれらの動画について質問しているかを判定します。ヒットすると動画モデルがクリップを再度視聴し、回答がトランスクリプトに追加されます。分類器は `classifier.text` を使用します。再視聴は常に `classifier.video` を使用します。

| キー | デフォルト | 説明 |
|---|---|---|
| `maxPerDay` | `20` | 1 日あたりの再視聴上限（`media.video.maxPerDay` とは別） |
| `classifierMaxOutputTokens` | `30` | 再視聴分類器の最大出力トークン数。推論する前に考えるモデルはより大きな上限が必要（空の回答を返す場合がある） |
| `maxOutputTokens` | `600` | 再視聴回答の最大出力トークン数 |
| `answerChars` | `1200` | 回答の最大文字数。`rewatch-answer.md` の `{{maxChars}}` に使用 |
| `recentMessages` | `60` | 視聴済みまたはエラー状態の動画をスキャンする直近のメッセージ数 |
| `maxCandidates` | `6` | 直近ウィンドウから分類器に渡す最大動画数（新しい順） |
| `contextMessages` | `50` | 分類器に `<transcript>` ブロックとして渡す直近のチャンネルメッセージ数（トリガーを除く）。`0` でブロック省略 |

ターンあたり最大 1 回の再視聴またはリトライ。回答は質問ごとに 1 時間キャッシュされます。分類器と再視聴はそれぞれ `llm.maxRequestsPerDay` にカウントされます。再視聴は `media.video.maxPerDay` にもカウントされます。

## `mention`

| キー | デフォルト | 説明 |
|---|---|---|
| `ignoreChance` | `0` | 本文でペルソナを @メンションしたメッセージに対するベースの無視確率。上げるとペルソナが一部のピングをスキップ |
| `followUpIgnoreChance` | `0` | ペルソナがフォローアップに応答せず、最後の一言を相手に譲る確率。フォローアップとは、アドレス分類器がペルソナに向けた発言と判定したタグなしメッセージと、ペルソナのメッセージへの Discord リプライのうち、リプライしたメンバーが自分でペルソナの @メンションを入力していないものを指す。Discord がリプライに自動で付けるピングは @メンションとみなさない。これらのメッセージでは `ignoreChance` の代わりにこの確率を使い、リピートペナルティ、スパム判定、態度による補正は通常どおり適用される。スキップされたフォローアップは `followUpNoStreak` にカウントされない |
| `emptyMentionIgnoreChance` | `0` | 素の @メンションの無視確率。上げるとペルソナが一部をスキップ |
| `repeatWindowMinutes` | `10` | リピート追跡ウィンドウ（分） |
| `repeatPenalty` | `0` | リピートごとに加算される無視確率。上げるとリピートにペナルティ |
| `spamThreshold` | `50` | ウィンドウ内でスパムとみなす呼び出し回数 |
| `spamIgnoreChance` | `0.9` | スパム時の無視確率 |
| `nameTriggerChance` | `1` | 名前トリガーへの応答確率 |
| `neverIgnore` | `[]` | 無視しないユーザー ID |
| `affinityIgnoreBonus` | `0` | 態度 -100 時に追加される最大無視率。上げると嫌いなメンバーがより無視される |
| `affinityLikeBonus` | `0.08` | 態度 +100 時に減少する最大無視率 |
| `oneAtATime` | `true` | サーバー全体で一度に一つのリプライ |
| `pendingSameChannel` | `true` | ターン実行中の同一チャンネルでの直接ピングを保持する。ターン終了後に通常の無視確率で応答。キー欠落 = オン |
| `classifyWhileBusy` | `true` | ターン実行中でもフォローアップ候補をアドレス分類器に送信する。候補は同じウィンドウ、no-streak、プレフィルターのチェックを受ける。チャンネルあたり同時に最大 1 件の分類器呼び出し、より新しい候補が待機中のものを置き換える。ビジー状態のアテンションで `yes` は保留キューで待機（チャンネルあたり 1 件）、`overheard` は `mention.pendingOverheard` がオンでない限り `busy` としてドロップ。スイッチオフの場合、候補は呼び出しなしでスキップ。`mention.pendingSameChannel` がオフで候補自身のチャンネルがビジーの場合もスキップ。各呼び出しは `llm.maxRequestsPerDay` の `classifier.text` リクエスト 1 件。キー欠落 = オン |
| `pendingOverheard` | `true` | ペルソナがビジー中に、分類器がペルソナについての話（ペルソナに話しかけているのではない）と判断した行を保留キューに保持する。ペルソナは現在のターン終了後に反応する。待機中のフォローアップは後の overheard 行に押し出されない。待機中の overheard 行は後のフォローアップ、後の overheard 行、または直接メンション、リプライまたは名前呼びかけに押し出される。待機中の overheard 行はスパム上限にカウントされず、チャンネルで待機中の呼びかけとして他のターンに報告されない。オフ: ビジー中の行はドロップされる。キー欠落 = オン |
| `maxPending` | `6` | すべてのチャンネルと著者にわたって保持する保留中の呼びかけの総数。一杯になると最も古い 1 件が淘汰される（`mention: dropped`、reason `full`） |
| `pendingMinutes` | `10` | 保持されたピングが期限切れになるまでの分数 |
| `switchDelayMs` | `[2000, 9000]` | 次のチャンネルで応答する前の待機時間（ミリ秒） |
| `followUpMinutes` | `15` | ペルソナの最後のリプライ後のフォローアップウィンドウ（分） |
| `followUpClassifyReplies` | `true` | 別メンバーのメッセージへのリプライを自動 `no` にせず分類器に送る。キー欠落 = オン。スイッチオフの場合、リプライはモデルに尋ねる前に `no` |
| `followUpContext` | `15` | 分類器に送信するトランスクリプト行数 |
| `followUpMaxOutputTokens` | `8` | 分類器の最大出力トークン数 |
| `followUpOverheard` | `true` | オンの場合、アドレス分類器の `overheard` 回答は `prompts/overheard.md` による独自のターンを開始する。オフ: `overheard` 回答は通常の `yes`（フォローアップターン）として扱われる。キーが存在しない場合はオン |
| `followUpAliases` | `5` | アドレス分類器にペルソナの名前と共に送信する保存済みエイリアス数（呼びかけとして認識させるため）。`0` で送信しない |
| `followUpNoStreak` | `3` | ウィンドウを閉じる連続 `no` 判定回数 |
| `pauseNoticeMinutes` | `10` | 同一チャンネルでのポーズ通知の最小間隔（分）。`0` で呼びかけごとに通知 |

フォローアップウィンドウは `data/state.json` の `followUpWindows` に保存され、起動時に復元されます。期限切れのウィンドウは削除されます。

## `typing`

| キー | デフォルト | 説明 |
|---|---|---|
| `reactionDelayMs` | `[800, 4000]` | リアクション遅延の範囲（ミリ秒） |
| `msPerChar` | `[35, 75]` | 1 文字あたりのタイピング速度（ミリ秒） |
| `minMs` | `900` | タイピングの最短時間（ミリ秒） |
| `maxMs` | `12000` | タイピングの最長時間（ミリ秒） |
| `betweenMessagesMs` | `[700, 3500]` | メッセージ間のポーズ（ミリ秒） |

## `spontaneous`

| キー | デフォルト | 説明 |
|---|---|---|
| `channels` | `[]` | 許可チャンネル |
| `maxChannelSilenceHours` | `72` | 自発的メッセージをブロックするチャンネル沈黙時間（時間）。0 = 制限なし |
| `someoneAroundMinutes` | `120` | すべての読めるチャンネルの最新メッセージがこの時間より古い場合、自発的ターンは発生しない（分）。ペルソナ自身のチャンネルでの最終投稿はカウントしない; 他のボットのメッセージはカウントする。`0` = ゲートなし |
| `initiateCooldownHours` | `[6, 12]` | 話題を切り出した後のクールダウン（時間）。終了まで次の話題は切り出されない。割り込み、全員への質問、盗み聞き、気づいたコメント、`/nep initiate` は影響を受けない。`state.json` に保存され再起動後も維持。`/nep status` で有効中の終了時刻を表示。`[0, 0]` = クールダウンなし |
| `minIntervalMinutes` | `25` | 最小チェック間隔（分） |
| `maxIntervalMinutes` | `420` | 最大チェック間隔（分） |
| `burstChance` | `0.15` | バースト（続けてもう一言）の確率 |
| `burstMinutes` | `[3, 15]` | バーストのタイミング範囲（分） |
| `activeHours` | `{ from: 10, to: 3 }` | アクティブ時間帯（深夜をまたぐ） |
| `liveWindowMinutes` | `15` | ライブウィンドウ（分） |
| `liveMinMessages` | `4` | 「ライブ」判定に必要な最小メッセージ数 |
| `deadAfterMinutes` | `90` | 「デッド」判定までの沈黙時間（分） |
| `initiateChance` | `0.35` | 割り込みではなく話題を切り出す確率 |
| `roomQuestionChance` | `0.04` | 全員に向けた（特定の誰かではない）メッセージがペルソナに拾われる確率。分類器（`prompts/room.md`）が事前フィルター。`0` でオフ |
| `eavesdropChance` | `0.02` | メッセージごとの割り込み確率 |
| `eavesdropDelayMs` | `[5000, 40000]` | 盗み聞き時の遅延範囲（ミリ秒） |
| `minGapMinutes` | `12` | アクション間の最小間隔（分） |

## `memory`

| キー | デフォルト | 説明 |
|---|---|---|
| `model` | `null` | アナライザーモデル（`null` = `llm.model`） |
| `temperature` | `null` | アナライザーのサンプリング温度。`null` は `llm.temperature` を使用 |
| `mainChannelIds` | `[]` | メンバー同士が会話するチャンネル。キャラクターとスタイルのポートレートはここから作成される。空の場合はすべてのチャンネルが対象。読み取り専用チャンネルからの呼びかけへの応答先でもある（`features.elsewhere`）: リストの最初の利用可能なチャンネルが使用される |
| `portraitRefreshHours` | `24` | メンバーごとのポートレートリフレッシュの最小間隔（時間） |
| `portraitRefreshMessages` | `300` | 前回のポートレート以降のメンバー自身のメッセージ数がこの値に達するとコードトリガーのリフレッシュが発動。サンプルサイズも兼ねる |
| `portraitRefreshDays` | `3` | 前回の成功リフレッシュからこの日数が経過するとコードトリガーのリフレッシュが発動 |
| `portraitRefreshPerDay` | `3` | サーバーあたりのポートレートリフレッシュの 1 日最大数（コードトリガー、アナライザーのキュー、`/nep memory refresh` で共有）。日次カウンターは `state.json` に `portraitDay` / `portraitCount` として保存され、`/nep warmup reset` で消去されない |
| `portraitRetryHours` | `24` | リフレッシュ失敗後、同じメンバーを再試行するまでの待機時間（時間） |
| `portraitCheckMinutes` | `60` | ポートレートスケジューラーがリフレッシュ対象をチェックする頻度（分） |
| `analyzerEpisodes` | `8` | アナライザーの `<existing_profiles>` で著者ごとに表示するエピソード数。重みと新しさの上位のみ送信され、保存リストはすべてのエピソードを保持。`0` で送信しない |
| `keepNewestEpisodes` | `5` | 最新のエピソード（追加日時順）は淘汰対象外。`0` = 従来ルール: 重みが軽い順、次に古い順に淘汰 |
| `recentHours` | `72` | `<recent>` ブロックに保持・表示する最近のノートの時間数。下げると即座にビューが狭まり、次の書き込みで古い行が削除される |
| `maxRecentStored` | `150` | ディスクに保持するライン数。書き込み時にこの上限を超えると、重みが軽い順、次に古い順に淘汰 |
| `maxNewRecent` | `3` | アナライザーがバッチごとに追加できるライン数 |
| `recentChars` | `160` | 最近のラインあたりの最大文字数 |
| `recentShown` | `12` | アナライザーに `<existing_recent>` として表示するライブの最近のライン数（重複防止用） |
| `notesStaleDays` | `7` | 最後の有効なレビューまたはテキスト変更からこの日数が経過すると、チャンネルまたはサーバーのノートが次の適格バッチでレビューフラグされる。フラグはその時点から十分なメッセージが蓄積された場合（チャンネルは `notesMinMessages`、サーバーは `notesGuildMinMessages`）かつバッチにそのチャンネルの `notesBatchLines` 以上の行がある場合にのみ送信される。`0` でフラグオフ |
| `notesBatchLines` | `8` | 陳腐化フラグを検討するために現在のバッチに必要なチャンネルのメッセージ数。バッチはローカルな証拠を提供し、累計カウント（`notesMinMessages`）は最後のレビュー以降に十分な活動があったかを追跡する |
| `notesMinMessages` | `30` | チャンネルのノートが陳腐化フラグの対象になるまでに、最後のテキスト変更と最後の有効なレビューのうち遅い方から蓄積される必要があるメッセージ数 |
| `notesGuildMinMessages` | `100` | サーバーノートが陳腐化フラグの対象になるまでに、サーバーノートの最後のテキスト変更と最後の有効なレビューのうち遅い方から全保存チャンネルを合計して蓄積される必要があるメッセージ数 |
| `notesRetryHours` | `24` | フラグ送信後、同じチャンネルまたはサーバーが再びフラグされるまでの時間数。ストリームアナライザーのフラグとサンプルリフレッシュの試行の両方に適用 |
| `notesRefreshDaysMain` | `7` | `mainChannelIds` のチャンネルが最後のテキスト変更またはサンプルレビューからこの日数経過後にサンプルリフレッシュ対象になる（`features.notesRefresh`） |
| `notesRefreshDays` | `21` | `notesRefreshDaysMain` と同じ、`mainChannelIds` にないチャンネル用 |
| `notesServerRefreshDays` | `7` | サーバーノートが最後のテキスト変更またはサンプルレビューからこの日数経過後にサンプルリフレッシュ対象になる。サーバーはサイクル内でチャンネルの後に処理され、日次上限の対象外 |
| `notesRefreshPerDay` | `4` | UTC 日あたりの成功したチャンネルノートリフレッシュ数。失敗したリクエストはスロットを消費しない。日次カウンターは `state.json` に `notesRefreshDay` / `notesRefreshCount` として保存 |
| `notesCheckMinutes` | `60` | ノートリフレッシュスケジューラーが未処理のチャンネルとサーバーをチェックする頻度。最終チェック時刻は `state.json` に `notesRefreshLookAt` として保存 |
| `notesSampleDays` | `30` | サンプルリフレッシュで読み取るチャンネル履歴の日数 |
| `notesSampleMessages` | `160` | 分散サンプルの目標メッセージ数。メッセージは日ごとに分散（最新の日から、ラウンドごとに 1 日 1 メッセージ）し、最新の会話だけを偏ってサンプリングしないようにする |
| `notesSampleMaxAuthorShare` | `0.35` | 1 人の著者がサンプル中に占められる最大シェア。支配的な著者の余剰メッセージは他の著者の行に置き換えられる |
| `versionsKept` | `20` | バージョン履歴でフィールドごとに保持する旧テキストの数。上限を超えると最も古いエントリが削除される。バージョン管理されるのはプロースフィールドのみ: メンバー `character`、`style`、`relationship`、チャンネル `purpose`、`topics`、`tone`、サーバー `patterns`、`starters`、ロアブック `text` |
| `overLimitRetries` | `1` | プロースフィールドのモデル回答が文字数制限を超えた場合のリトライ回数。リトライではモデル自身の回答を正確なフィールド名、文字数、制限値と共に送り返し、短縮を求める。`0` でリトライオフ。正の値はちょうど 1 回のリトライ。ボイスモデル、ポートレートリフレッシュ、ノートリフレッシュに適用。ストリームアナライザーはリトライしない（超過フィールドはそのバッチの書き込みから除外される） |
| `portraitMaxAgeDays` | `21` | ポートレートがこの日数（かつ `portraitMinMessages` 以上の自分のメッセージがある場合）を超えると、`portraitRefreshMessages` に達していなくてもリフレッシュ対象になる |
| `portraitMinMessages` | `60` | 年齢ベースの発動パス（`portraitMaxAgeDays`）のために必要な、最後のポートレート以降の自分のメッセージ数 |
| `privateMaxAgeMinutes` | `360` | 静かなプライベートバッファーが `minBatchMessages` に達していなくても分析されるまでの分数 |
| `channelWritersStored` | `20` | チャンネルごとに保持するトップライター数（減衰するカウントでランク付け） |
| `channelWritersHalfLifeDays` | `30` | チャンネルごとのライターカウントの半減期（日）。書かなくなったライターはアクティブなライターの下に沈む |
| `reasoning` | `null` | アナライザーのステージ A リクエストとウォームアップのニュートラルルートに送信する OpenRouter `reasoning` オブジェクト。`null` でフィールド省略。例: `{ "effort": "low" }` |
| `batchMessages` | `60` | 理想的なバッチサイズ |
| `minBatchMessages` | `15` | 更新前の最小メッセージ数 |
| `maxBatchAgeMinutes` | `180` | この分数経過後に更新を強制（分） |
| `maxOutputTokens` | `20000` | アナライザーの最大出力トークン数 |
| `fieldChars` | `1000` | プロファイルプロースフィールド（`character`、`style`）とチャンネルノートフィールド（`purpose`、`topics`、`tone`）の文字数上限。サーバーレベルの `patterns` と `starters` は `fieldChars * 2` を使用。上限を超える書き換えは拒否され、保存済みテキストがそのまま残る。空のフィールドへの初回書き込みのみ上限まで切り詰められる（`clampTolerance` 参照） |
| `clampTolerance` | `1.25` | 初回書き込みが上限をどこまで超過できるか。フィールドが空の場合のみ適用: テキストは `limit * clampTolerance` まで受け入れられ、文の境界または単語の境界で切り詰められ、メンバー参照の中では切らない。書き換え時（フィールドに既存テキストがある場合）はトレランスは適用されない: テキストは正確な上限以内に収まる必要があり、収まらなければ拒否される |
| `maxDetails` | `15` | プロファイルごとにペルソナとアナライザーに表示される詳細項目数 |
| `maxDetailsStored` | `40` | プロファイルごとに保持される詳細項目数。頻度と新しさの上位が表示される |
| `maxInterests` | `12` | プロファイルごとにペルソナとアナライザーに表示される関心項目数 |
| `maxInterestsStored` | `40` | プロファイルごとに保持される関心項目数。頻度と新しさの上位が表示される |
| `interestTopicChars` | `40` | 関心トピックの最大文字数 |
| `interestNoteChars` | `120` | 関心ノートの最大文字数 |
| `confirmAfter` | `2` | 関心または詳細が確定するまでの目撃回数 |
| `confirmGapHours` | `12` | 新しい機会としてカウントするための目撃間隔（時間） |
| `interestStaleDays` | `90` | 目撃されないまま経過すると関心が古いとマークされる日数 |
| `interestHalfLifeDays` | `180` | 関心の重み半減期（日）。目撃されない項目の重みは半減期ごとに半減するため、新しい趣味が古い趣味を追い越せる |
| `detailHalfLifeDays` | `720` | 詳細の重み半減期（日） |
| `maxLearned` | `20` | アナライザーとチャットモデルに表示されるレッスン数 |
| `maxLearnedStored` | `60` | ディスクに保持されるレッスン数。頻度と新しさの上位が表示される |
| `learnedChars` | `160` | レッスンごとの最大文字数 |
| `learnedHalfLifeDays` | `720` | レッスンの重み半減期（日） |
| `maxAliases` | `5` | プロファイルごとにペルソナとアナライザーに表示されるエイリアス数 |
| `maxAliasesStored` | `15` | プロファイルごとに保持されるエイリアス数。頻度と新しさの上位が表示される |
| `aliasRosterSize` | `40` | サーバーアナライザーバッチの `<known_members>` ブロックに含まれるメンバー: バッチの著者ではない保存済みプロファイル。アナライザーがそのメンバーにエイリアスを記録できるようにする。`0` でロスターをオフにする。プライベートバッチには含まれない |
| `aliasHalfLifeDays` | `365` | エイリアスの重み半減期（日） |
| `maxInjokes` | `15` | サーバー内輪ネタの最大数 |
| `maxSelfFacts` | `20` | 自己言及の最大数 |
| `maxEpisodes` | `20` | メンバーごとに保持されるエピソードの最大数 |
| `maxNewEpisodes` | `3` | メンバーごと・バッチごとの新規エピソードの最大数 |
| `timeoutMs` | `900000` | アナライザーのタイムアウト（ミリ秒）。`llm.timeoutMs` とは別 |

アナライザープロンプトはこれらの上限をプレースホルダーとして読み取るため、値を上げると次のバッチから反映されます。プロファイルを大きくするとコンテキストトークン（`context.caps.people`、`context.caps.interlocutor`）とアナライザー出力（`memory.maxOutputTokens`）のコストが増加します。

**移行。** `memory.voiceModel` は読み取られなくなりました。まだ設定されている場合は警告がログに記録され、値は無視されます。リプライとメモリの記述は共に `llm.model` を使用します。

### `memory.voice`

2 段階アナライザーのステージ B（`features.memoryTwoStage`）の設定です。ステージ B はステージ A がキューしたニュートラルなブリーフを受け取り、ペルソナの声で記述します。キューは `data/guilds/<id>/voice.json` に永続化され、再起動後も保持されます。

| キー | デフォルト | 説明 |
|---|---|---|
| `maxItems` | `24` | ボイスリクエストあたりの項目数。50k トークン制限内に収める |
| `maxPerDay` | `100` | UTC 日あたりのボイスリクエスト数。`0` で送信を防止（ステージ A のみのシミュレーション実行に有用） |
| `maxOutputTokens` | `3000` | ボイスリクエストあたりの最大出力トークン数 |
| `retryMinutes` | `15` | 項目が欠落したボイス回答後のバックオフ。ミスごとに遅延が倍増 |
| `maxAttempts` | `4` | 項目がデグレードパスに入る前に欠落を許容する回答数。失敗したリクエスト（不正 JSON、タイムアウト）はカウントしない |
| `queueMax` | `100` | キューに保持する項目数。最も古い非キャラクター項目がデグレードパスにオーバーフロー |
| `queueHours` | `24` | キューされた項目がデグレードパスに期限切れとなるまでの時間。キャラクター項目は期限切れにならない |
| `timeoutMs` | `120000` | ボイスリクエストのタイムアウト（ミリ秒） |

## `relationships`

| キー | デフォルト | 説明 |
|---|---|---|
| `damping` | `true` | ゼロから離れる方向のスコア変化を減衰。ゼロに向かう変化はそのまま適用 |
| `dampingPower` | `1` | 減衰係数の指数。大きいほどスケールの両端に到達しにくくなる |
| `maxDeltaPerUpdate` | `15` | 更新あたりの最大スコア変化 |
| `historySize` | `10` | メンバーごとに保持される態度変化の履歴数 |
| `shownMoves` | `4` | プロファイルのスコアの後に表示される態度変動数。絶対変動量の大きい順。`0` で非表示 |
| `directTriggerCount` | `6` | 早期更新を強制する直接インタラクション回数 |
| `decayPerDay` | `0.04` | 毎日のゼロへのドリフト。1 日あたり `decayPerDay * |score| * (|score| / 100) ^ decayPower` を失う。`0` または欠落 = オフ |
| `decayPower` | `1` | 減衰曲線の指数。大きいほどゼロ近くのスコアの減衰が遅くなる。正の数でない場合 = 1 |
| `rewriteOnBandChange` | `true` | 態度段階が変化した場合、保存済みの `relationship` テキストを書き直し対象にフラグする。キー欠落 = オン |
| `rewriteOnDrift` | `8` | 記述時からスコアがこのポイント分移動した場合、同じ段階内でも書き直し対象にフラグ。`0` = オフ |
| `rewriteAfterMoves` | `6` | テキスト記述後にこの回数の態度履歴エントリが生じた場合、書き直し対象にフラグ。`0` = オフ |
| `bandHysteresis` | `2` | 旧段階の境界からこのポイント超えてから段階変化を書き直し原因としてカウント。境界付近でのスコア変動による不要な書き直しを防止 |
| `textChars` | `600` | relationship テキストの最大文字数。アナライザープロンプトの `{{relationshipChars}}` に代入。上限を超える書き換えは拒否され、保存済みテキストがそのまま残る。空のフィールドへの初回書き込みのみ切り詰められる |

`damping` が有効な場合、ゼロから離れる方向のスコア変化は `(1 - |score| / 100) ^ dampingPower` でスケールされるため、極端な値には継続的な努力が必要です。ゼロに向かう変化はそのまま適用されます。スコアは小数精度で保存され、整数で表示されます。`/nep memory affinity` は減衰なしで直接設定します。

`decayPerDay` が設定されている場合、すべての保存済み態度スコア（公開およびプライベート）は毎日ゼロに向かってドリフトします。デフォルト設定でスコア 100 の場合、1 日の損失は 4。64 の場合は約 1.6。30 の場合は約 0.36。スイープは起動時と毎時に実行され、プロファイルのスタンプ（`affinity.decayedAt`）から整数日単位で適用されるため、ダウンタイムはキャッチアップされます。一時停止中とウォームアップ中は実行されません。態度履歴エントリは書き込まれません。

## `lore`

| キー | デフォルト | 説明 |
|---|---|---|
| `maxEntries` | `500` | サーバーあたりのロアブックエントリの最大数 |
| `scanMessages` | `30` | キーマッチのためにスキャンするメッセージ数 |
| `maxMatches` | `8` | リクエストあたりに表示されるエントリの最大数 |
| `textChars` | `600` | ロアブックエントリのテキスト上限（文字）。上限を超える書き換えは拒否され、保存済みテキストがそのまま残る。初回書き込みのみ切り詰められる。`/nep lore add` で既存タイトルに書く場合、オーナーのテキストはそのまま保存される |

## `web`

ウェブルックアップ（`features.webLookup`）の設定です。リンク読み取りと検索は日次カウンター（`web.maxPerDay`）を共有します。結果はメディアキャッシュ（`data/guilds/<id>/media.json`）に保存されます。すべてのモデル呼び出しは `classifier.text` ロールを使用します。

| キー | デフォルト | 説明 |
|---|---|---|
| `maxPerDay` | `60` | リンク読み取りと検索リクエストの合計に対する共有日次上限 |
| `acceptLanguage` | `"en,ru;q=0.8"` | ページ読み取り時に送信する Accept-Language ヘッダー。空の場合はヘッダーを送信しない |

### `web.links`

| キー | デフォルト | 説明 |
|---|---|---|
| `enabled` | `true` | チャットに投稿されたリンクを読み取り（http/https のみ、プライベートアドレスは拒否、動画サイトリンクは除外） |
| `prefill` | `true` | リンクが投稿された時点で読み取り、次のターンでキャッシュ済みの状態にする |
| `prefillPerUserPerDay` | `10` | プリフィルがメンバーあたり 1 日に到着時に読み取る最大リンク数。ターンパスはこの制限を受けない |
| `maxPerTurn` | `2` | ターンあたりの最大新規リンク読み取り数（各フェッチ試行がカウントされる） |
| `maxBytes` | `1500000` | ページの最大サイズ（バイト）。超過するとページを拒否 |
| `textChars` | `6000` | 要約モデルに送信するページテキストの最大文字数 |
| `summaryChars` | `700` | 要約抜粋の最大文字数。`read-link.md` の `{{maxChars}}` に使用 |
| `maxOutputTokens` | `300` | 要約モデルの最大出力トークン数 |
| `fetchTimeoutMs` | `10000` | ページあたりのダウンロードタイムアウト（ミリ秒） |
| `skipSites` | `["cdn.discordapp.com", "media.discordapp.net", "tenor.com", "giphy.com", "klipy.com", "imgur.com", "i.redd.it", "v.redd.it", "pbs.twimg.com"]` | リンクを読み取らないホスト名（サブドメインを含む。動画サイトは常に除外されるため、それに追加） |

### `web.search`

| キー | デフォルト | 説明 |
|---|---|---|
| `enabled` | `true` | 分類器が発火した時に検索を実行。`.env` に `BRAVE_SEARCH_API_KEY` が必要 |
| `maxPerTurn` | `1` | ターンあたりの最大検索数 |
| `results` | `5` | Brave Search に要求する結果数 |
| `summaryChars` | `900` | 要約回答の最大文字数。`search-summary.md` の `{{maxChars}}` に使用 |
| `maxOutputTokens` | `400` | 要約モデルの最大出力トークン数 |
| `classifierMaxOutputTokens` | `200` | 検索分類器の最大出力トークン数。複数行回答形式（`web:`、`server:`、`who:`、`when:`）に合わせて増加。推論する前に考えるモデルはより大きな上限が必要 |
| `cacheHours` | `24` | キャッシュされた検索結果が再検索されるまでの時間 |
| `contextMessages` | `50` | 検索分類器に `<transcript>` として渡す直近のチャンネルメッセージ数 |
| `timeoutMs` | `10000` | Brave Search リクエストのタイムアウト（ミリ秒） |

## `image`

描画サブプロセス（`features.imageGeneration`）の設定。ペルソナが `<draw>` タグを出力すると、コードが OpenRouter Images API を通じて 1 枚の画像を生成し、別のメッセージとして投稿します。生成回数と日次カウンターは `data/state.json`（`imageDay`、`imageCount`、`imageUsers`）に保存されます。すべての画像は `image.model` を使用し、チャットモデルや分類器モデルは使用しません。

| キー | デフォルト | 説明 |
|---|---|---|
| `model` | `"openai/gpt-image-2.5-flare"` | 画像モデル ID。`openai/*` と `google/*` ファミリーのみサポート。それ以外はリクエスト前に拒否 |
| `maxPerDay` | `50` | インスタンス全体の日次生成上限 |
| `maxPerUserPerDay` | `50` | メンバーあたりの日次生成上限。自発的ターンと `/nep draw` はメンバーのカウントに含まれない |
| `maxPromptChars` | `800` | `<draw>` タグのシーンテキストはこの長さにクランプされる |
| `reference` | `"avatar"` | ペルソナが画像に含まれるとき（`self="yes"`）に送信するビジュアルリファレンス。`"avatar"` はボットの Discord アバターをダウンロード。他の値や `null` は何も送信しない |
| `referenceMaxBytes` | `4000000` | アバターの最大ファイルサイズ（バイト）。超過するとスキップ |
| `outputFormat` | `"png"` | 要求する出力フォーマット（`png`、`jpeg`、`webp`） |
| `aspectRatio` | `"auto"` | アスペクト比（`auto`、`1:1`、`16:9`、`9:16` など）。Google モデルの場合、`auto` はリクエストから省略される |
| `timeoutMs` | `120000` | リクエストタイムアウト（ミリ秒） |
| `retries` | `1` | 一時的エラー（HTTP 408/429/5xx、ネットワークエラー）時のリトライ回数 |
| `provider` | `null` | 画像リクエスト用の OpenRouter `provider` ルーティング。`llm.providerByModel` に一致するエントリがない場合に使用。`null` は何も送信しない。ファミリー固有のプロバイダーオプション（例: `openai.moderation`）は最終ルーティングの上にマージされる |

### `image.openai`

`openai/*` 画像モデル固有のオプション。

| キー | デフォルト | 説明 |
|---|---|---|
| `quality` | `"medium"` | 画像品質（`auto`、`low`、`medium`、`high`。2.5 モデルは `xhigh`、`max` も受け付ける） |
| `background` | `"auto"` | 背景モード（`auto`、`opaque`。2.5 モデルは `transparent` も受け付ける） |
| `moderation` | `"low"` | `provider.options.openai.moderation` としてプロバイダーパススルーで送信 |

### `image.google`

`google/*` 画像モデル固有のオプション。

| キー | デフォルト | 説明 |
|---|---|---|
| `resolution` | `"1K"` | 出力解像度（`512`、`1K`、`2K`、`4K`。サポートはモデルにより異なる）。`gemini-2.5-flash-image` には解像度の設定なし |

## `diary`

日記チャンネル（`features.diary`）の設定。ペルソナがオーナーの選んだチャンネルに、設定可能なウィンドウからランダムな時間に自発的に投稿します。各投稿は分類器によって計画され、メインモデルがキャラクターカードと全メモリブロックで作成します。すべてホットリロード。[日記](diary.md)を参照。

| キー | デフォルト | 説明 |
|---|---|---|
| `channelId` | `""` | 日記チャンネル。`/nep diary set` で書き込まれ、毎ティック読み取られる。空は日記なし |
| `world` | `false` | 日記の計画・作成リクエストに `prompts/world.md` を `<world>` ブロックとして含める。`true` でのみ有効。キー欠落 = オフ。`/nep set diary.world true` でオンにする。ファイルはペルソナの仮想世界を記述し、日記のみで使用、通常のターンでは使用されない |
| `windows` | 下記参照 | `bot.timezone` での投稿ウィンドウ。各ウィンドウは `from` と `to`（0–24 時、午前 0 時をまたぐ）と `posts: [min, max]`（ウィンドウが引く投稿数）。デフォルトの 4 ウィンドウは[日記: ウィンドウ](diary.md#ウィンドウ)を参照 |
| `quietDayChance` | `0.3` | 一日中投稿なしになる確率。日のプラン作成時に 1 回判定 |
| `hungerBoost` | `0.5` | How strongly an empty window pushes later posts. A window that drew no posts gets one extra roll per hunger point, and each roll redraws its count with chance 1 minus this value. `1` turns hunger off |
| `quietCarry` | `0.25` | After quiet days in a row the quiet chance is `quietDayChance` times this value per quiet day, so a long silence gets less likely. `1` keeps the chance flat |
| `minGapMinutes` | `90` | 計画スロット間の最小間隔（分）。これより近いスロットは削除 |
| `maxPerDay` | `3` | 一日の最大投稿数。プランナーがこれを超えるスロットを引いた場合、ランダムに削除。日次カウントは `/nep diary post` にも適用 |
| `maxPicturesPerDay` | `2` | 一日の日記画像最大数。`image.maxPerDay` と共有: 先に尽きた方が制限。使い切ると計画の `picture` は強制 false になり、センスは描画不可と伝える |
| `slotGraceMinutes` | `30` | 計画スロットが発火可能な猶予時間（分）。ボット停止中にこれを超えて逃したスロットは削除され、遅延発火しない |
| `forceWaitMs` | `120000` | `/nep diary post` が実行中のターンの完了を待つミリ秒数。待機がタイムアウトするとコマンドは `busy` と応答する。定期投稿には影響しない |
| `maxMessages` | `3` | 日記投稿あたりの最大 `<msg>` メッセージ数。超過分はカット |
| `historyPosts` | `150` | `diary.json` に保持され、プランナーと作成者に `<diary>` ブロックで表示される過去の投稿数。超過時は最も古いものが削除 |
| `gistChars` | `200` | 日記履歴の投稿要約と画像シーンあたりの文字数 |
| `seedSets` | `2` | `prompts/diary-seeds.md` から引かれ、プランナーに `<seeds>` ブロックで表示されるランダムシード組み合わせ数。`0` でブロック省略 |
| `kinds` | `{ "selfPicture": 3, "picture": 2, "meme": 1, "thought": 2, "people": 2, "news": 2, "facts": 1, "status": 3, "photoset": 1, "randomSet": 1 }` | 投稿種類と重み。重み 0 の種類は選ばれない。プランナーは重みと最近の投稿で各種類が何回使われたかを見る。ホットリロードなのでオーナーはいつでもバランスを変えられる |
| `searchKinds` | `["news", "facts"]` | ウェブ検索をトリガーできる種類。プランナーはこれらの種類のみクエリを書く |
| `pictureKinds` | `["selfPicture", "picture", "meme", "photoset", "randomSet"]` | 日次の画像上限が許す限り、プランナーの回答に関わらず常に画像付きになる種類。その他の種類はプランナーが求めた場合のみ描画 |
| `setKinds` | `["photoset", "randomSet"]` | Kinds whose post is a set of pictures instead of one. Keep them in `pictureKinds` too, so they are dropped with the other picture kinds when the post cannot carry a picture |
| `set.pictures` | `[4, 6]` | How many pictures a set has: the prompt asks for between the two numbers, the bot generates at most the second (the first `<draw>` tags of the answer, the rest ignored) |
| `set.minPosted` | `2` | A set with fewer pictures generated than this is not posted at all, its messages included. Generation stops early once the pictures left cannot reach it. The pictures already generated still count against the day's picture caps |
| `set.seedSets` | `6` | Random seed combinations shown in a `<seeds>` block of the compose request of a set post (the plan request keeps `seedSets`). `0` omits the block |
| `set.maxMessageBytes` | `8000000` | The most picture bytes one Discord message carries. A set larger than this, or of more than 10 pictures, is split over several messages |
| `planMaxOutputTokens` | `300` | 計画リクエストの最大出力トークン数 |
| `planTimeoutMs` | `20000` | 計画リクエストのタイムアウト（ms） |

デフォルトの `windows`:

```json
[
  { "from": 7,  "to": 11, "posts": [0, 0] },
  { "from": 12, "to": 16, "posts": [0, 1] },
  { "from": 18, "to": 1,  "posts": [0, 2] },
  { "from": 1,  "to": 5,  "posts": [0, 1] }
]
```

朝（7–11）はオフ。昼（12–16）は 0 または 1 投稿。夕方（18–翌 01）は 0、1 または 2。夜（01–05）は 0 または 1。すべて `bot.timezone`。`to` が `from` より後でないウィンドウは午前 0 時をまたぐ: `{ "from": 18, "to": 1 }` は今日の 18:00 から明日の 01:00 まで。

## `private`

プライベートチャット（`features.privateMessages`）の設定。すべてホットリロード。ゲートは LLM リクエストなしでローカルチェック。

| キー | デフォルト | 説明 |
|---|---|---|
| `minAffinity` | `5` | DM に応答するための最低公開アティチュードスコア。オーナーはこのチェックをバイパス |
| `maxPerUserPerDay` | `100` | メンバーごとの 1 日あたりのモデルに到達した DM ターン数（応答または沈黙）。到達時は 1 日 1 回のリミット通知を投稿 |
| `maxPerOwnerPerDay` | `200` | ボットオーナーの 1 日あたりのモデルに到達した DM ターン数（応答または沈黙） |
| `purgeMaxMessages` | `5000` | `/nep private purge` が 1 回の実行でスキャンする DM メッセージの最大数（新しいものから） |

`features.relationships` がオフの場合、公開スコアは 0 のままになるため、デフォルトの `minAffinity` ではオーナーのみが DM できます。

## `mentor`

手動テストサブプロセス（`features.mentor`）の設定。Mentor はチャット状況を作成し、サンドボックスでペルソナに回答させ、スコアリングします。独自のモデルと日次トークン予算を使用し、`llm.maxRequestsPerDay` にはカウントされません。すべてホットリロード。

| キー | デフォルト | 説明 |
|---|---|---|
| `model` | `null` | Mentor モデル ID。`null` または未設定の場合、モデルが必要なすべてのコマンドはその旨を報告 |
| `maxTokensPerDay` | `400000` | 日次トークン予算。実使用量から計算: プロンプトトークン x1、キャッシュプロンプトトークン x`cachedTokenWeight`、出力トークン x`outputTokenWeight`。サンドボックスでのペルソナのボイスモデルの回答も同様に計算 |
| `outputTokenWeight` | `5` | 予算における出力トークンの重み。生成トークンの高コストを反映 |
| `cachedTokenWeight` | `0.1` | 予算におけるキャッシュプロンプトトークンの重み |
| `maxOutputTokens` | `6000` | Mentor リクエストあたりの最大出力トークン |
| `timeoutMs` | `300000` | Mentor リクエストのタイムアウト（ミリ秒） |
| `situations` | `5` | 1 回の実行で作成するチャット状況の数 |
| `situationLines` | `[6, 15]` | 状況あたりの最小・最大行数 |
| `samples` | `3` | 状況あたりのペルソナの回答数。実際の moment は `anchor.samples` を使用 |
| `check.samples` | `1` | `/nep mentor check` 時の状況あたりのペルソナの回答数。実際の moment は `anchor.samples` を使用 |
| `pass.score` | `7` | `overall` と `goal` の中央値がこの閾値に達した場合にケースが合格 |
| `pass.anchorScore` | `null` | 実際の moment の閾値。数値に設定すると、実際の moment の `overall` または `goal` 中央値がその値を下回る場合にケースが不合格。`null` は `pass.score` を使用 |
| `pass.floor` | `5` | いずれかの軸の中央値がこの下限を下回る場合にケースが不合格。各作成された状況もこの下限でチェックされ、いずれか 1 つの作成された状況の `overall` 中央値または `goal` 中央値がこの値を下回る場合、全回答の中央値に関わらずケースは不合格。実際の moment はパススコア（`pass.anchorScore` が設定されている場合はその値、それ以外は `pass.score`）で判定 |
| `diagnose` | `true` | 不合格または弱い状況のあるラン後に、mentor がコンテキスト内の弱い回答の原因を説明。ランの `diagnosis` として保存。check では要求しない |
| `reference.days` | `7` | スタイルリファレンス構築に使用するチャット履歴の日数 |
| `reference.samples` | `60` | リファレンスウィンドウからランダムに選択するスタイル例の行数（2〜200 文字） |
| `reference.maxMessages` | `3000` | リファレンスチャンネルから読み取る最大メッセージ数 |
| `reference.rarePer1000` | `0.5` | 1000 文字あたりの使用回数がこの値未満のマークはレアとみなす |
| `reference.rareMinAuthors` | `2` | 使用する著者数がこの値未満のマークはレアとみなす |
| `anchor.max` | `5` | ケースあたりの実際の moment 数。各 moment はオーナーが拒否したペルソナのメッセージで、その前のチャットと共に保存 |
| `anchor.contextMessages` | `30` | moment 解決時にチャンネルから取得するコンテキストメッセージ数（トリガーまで） |
| `anchor.samples` | `5` | ランおよび `/nep mentor check` での実際の moment あたりのペルソナ回答数 |
| `anchor.hideLaterMemory` | `true` | 実際の moment を再生する際、トリガーの時点以降に書き込まれた記憶を非表示にする（エピソード、態度変化、詳細、興味、エイリアス、学習項目、ロアエントリ）。`false` にすると現在の全記憶で再生 |
| `anchor.ledgerSize` | `300` | ポストレジャー（`state.json` `postLedger`）に保持するエントリ数。各投稿メッセージとそのターンを対応付け、mentor が実際の moment のトリガーを見つけるために使用。`features.mentor` が有効の間のみ書き込み。`0` で保持しない |
| `feedbackExamples` | `10` | すべてのスコアリングリクエストに含める最新のオーナー修正（`/nep mentor wrong`）の数 |

`llm.maxRequestTokens`（リクエストあたり 50k）は、mentor が発行または引き起こすすべてのリクエスト（サンドボックス回答を含む）に適用されます。各 mentor リクエスト前の予算チェックでは、プロンプトに加えて回答が最大でかかるコスト（`mentor.maxOutputTokens` を `mentor.outputTokenWeight` で乗算）を計上するため、可能な出力が残り予算に収まらない場合リクエストは拒否されます。予算が尽きると実行が停止し、得られた結果を報告します。ラン中に `features.mentor` や `mentor.model` がオフにされた場合、またはリファレンスウィンドウ内のリファレンスチャンネルに人々のメッセージがない場合も実行が停止します。

## `warmup`

| キー | デフォルト | 説明 |
|---|---|---|
| `enabled` | `true` | 初回起動時にウォームアップを自動実行 |
| `lookbackDays` | `60` | サンプルする過去の日数 |
| `minMessages` | `30` | メンバーが対象となるための自身のメッセージの最低数 |
| `maxPeople` | `40` | 処理するメンバー数（アクティブ順） |
| `messagesPerPerson` | `2000` | メンバーあたりにサンプルする自身のメッセージ数 |
| `contextBefore` | `1` | サンプルメッセージごとの直前のコンテキスト行数 |
| `maxChannelShare` | `0.5` | 一つのチャンネルからのサンプルの最大割合 |
| `messagesPerChannel` | `200` | チャンネル記述に使う最新メッセージ数 |
| `serverSampleMessages` | `600` | サーバーリクエスト用のメインチャンネルの最新メッセージ数 |
| `fetchLimitPerChannel` | `15000` | サンプルプール用にチャンネルごとにフェッチするメッセージ数 |
| `maxOutputTokens` | `6000` | ウォームアップリクエストあたりの最大出力トークン数 |
| `maxRequestTokens` | `120000` | ウォームアップリクエストあたりの最大トークン数（入力 + 出力） |
| `maxTokens` | `6000000` | ラン全体のトークンバジェット |
| `rateLimitWaitMinutes` | `10` | レートリミット時の待機時間（分） |
| `rateLimitMaxWaits` | `36` | ランを中断する前の連続待機回数 |

## モデル

エンジンは 7 つのモデルロールを使用します。それぞれ独立して設定できるため、ペルソナの声にはプレミアムモデルを使い、ヘルパーには安価なモデルを使うことができます。

### 声（`llm.model`）

ロール `voice`。バジェットが許す最も高性能なモデルを選びます。ロールプレイの品質、キャラクターの一貫性、自然な会話のすべてがこのモデルに依存します。小さなモデルはキャラクターが崩れ、コンテキストの手がかりを忘れ、平坦に聞こえます。2 段階モードでは、同じモデルがペルソナのメモリテキスト（ステージ B: リレーションシップノート、態度の理由、エピソードの感想、レッスン、自己言及、サーバーパターン、スターター、キャラクターポートレート）も記述します。両方のリクエストは使用ログでロール `voice` を持ちます。目的（`reply`、`memory-voice`）で区別されます。

デフォルト: `anthropic/claude-opus-4.6`。より安価な選択肢: `anthropic/claude-sonnet-4.6`。

### アナライザー（`memory.model`）

ロール `analyzer`。長いトランスクリプトを推論し、厳密な JSON を返します。ペルソナの声と同じティアの知性が必要です。`null`（デフォルト）はペルソナのモデルを使用します。同じ例が適用されます。2 段階モード（`features.memoryTwoStage`）では、このモデルがステージ A（ニュートラルな判定）を実行します。

### テキスト分類器（`classifier.text`）

「yes」または「no」を確実に回答できる最も安価なテキストモデルです。アドレス分類器（`features.followUp`）、検索分類器・リンク読み取り・検索要約・リコールサマリー（`features.webLookup`、`features.recall`）、再視聴分類器（`features.videoRewatch`）、ルーム分類器（`spontaneous.roomQuestionChance`）、チャンネルルート分類器（`features.channelRoute`）を実行します。デフォルト: `anthropic/claude-sonnet-4.6`。

### 画像（`classifier.media`）

安価なビジョンモデルであれば何でも使えます。一行の説明文を書くだけなので、推論能力はほとんど問題になりません。

デフォルト: `anthropic/claude-haiku-4.5`。最も安価な代替: `google/gemini-2.5-flash-lite`。

### 動画（`classifier.video`）

OpenRouter を通じて動画と音声の両方の入力を受け付けるモデルのみがここで動作します。フレームは受け付けるが音声は受け付けないモデル（Qwen VL、GLM、Seed、Gemma）は音声を聞き取れず、重要な情報の大部分を逃します。

`google/gemini-flash-latest` は価格が予告なく変わる可能性のあるフローティングエイリアスです。バッチ（`:batch`）バリアントは非同期であり、ライブリプライには使用できません。ダイレクト URL パス（上限内の YouTube を `media.video.provider` で公開 URL として送信）には Google AI Studio をプロバイダーとして指定する必要があります。

1 分間のクリップあたりのコスト（USD）、2026-09-23 時点の OpenRouter 価格:

| モデル | 1 分クリップあたり約 USD |
|---|---|
| `google/gemini-2.5-flash-lite` | 0.002 |
| `google/gemini-3.1-flash-lite` | 0.005 |
| `google/gemini-3.5-flash-lite` | 0.006 |
| `google/gemini-3.7-flash` | 0.014 |
| `google/gemini-3.8-flash` (default) | 0.014 |

`qwen/qwen3.8-omni-flash` も動画と音声を受け付けます。価格は変動します。上の表は記載日時点のスナップショットです。

### Mentor（`mentor.model`）

ロール `mentor`。ペルソナの回答をスコアリングし、テスト状況を作成します。ボイスモデルとは異なるファミリーのモデルを推奨: モデルは自身のファミリーの癖に気づけません。`null`（デフォルト）は mentor を無効のまま保持。モデルが必要な `/nep mentor` コマンドはその旨を報告します。

### 画像出力（`image.model`）

`classifier.media`（画像の説明を書くモデル）とは別です。このモデルは OpenRouter Images API（`POST /api/v1/images`）を通じて画像を生成します。サポートされるファミリーは `openai/*` と `google/*` の 2 つのみ。サポートされないファミリーはリクエストやカウントの前に拒否されます。

**OpenAI モデル。** `image.openai.quality`、`image.openai.background`、`image.openai.moderation`、`image.aspectRatio`、`image.outputFormat`、`input_references` を使用。

| モデル | 備考 |
|---|---|
| `openai/gpt-image-2.5-flare` (default) | 高速ティア |
| `openai/gpt-image-2.5-sunburst` | 高精度ティア |
| `openai/gpt-image-2` | |
| `openai/gpt-image-1` | |
| `openai/gpt-image-1-mini` | |

**Google モデル。** `image.google.resolution`、`image.aspectRatio`、`image.outputFormat`、`input_references` を使用。`image.aspectRatio` が `auto` の場合、Google リクエストから省略されます。

| モデル | 備考 |
|---|---|
| `google/gemini-3.1-flash-image` | Nano Banana 2 |
| `google/gemini-3-pro-image-preview` | |
| `google/gemini-2.5-flash-image` | 解像度設定なし |

課金は画像単位ではなく出力トークン単位です。プロバイダーの `usage.cost` は `/nep draw` で報告されログに記録されます。エンジンが送信前に拒否したリクエスト（日次または個人上限、非対応モデルファミリー）はコストがかかりません。プロバイダーが拒否した生成は通常課金されません。タイムアウト、または画像生成後にアップロードが失敗した場合は課金される可能性があります。
