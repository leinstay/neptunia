# プロンプトコントラクト

プロンプトファイルとコード（`src/behavior/prompt.js`、`src/llm/parse.js`、`src/discord/format.js`、
`src/memory/update.js`、`src/memory/channels.js`、`src/memory/warmup.js`）が接するポイントです。一方を変更する場合、
もう一方も合わせてください。変更のワークフローについては `CONTRIBUTING.md` を参照してください。

## レイヤー

| ディレクトリ | 追跡対象 | 内容 |
|---|---|---|
| `prompts/` | はい | 英語のエンジンデフォルト + ニュートラルなサンプルキャラクター。そのまま動作します |
| `prompts.local/` | いいえ | デプロイ先のオーバーライド: 同名ファイルがデフォルトを置き換え、`labels.json` はディープマージ |

どちらもホットリロードされます。`/nep rule add` は `prompts.local/rules.md`（デフォルトからシードされる）に書き込み、`prompts/` には書き込みません。
すべてのインストラクションは両レイヤーとも英語です。キャラクターの発話サンプルはそのキャラクターが話す言語で記述できます。

## ファイル

| ファイル | 必須 | 役割 | プレースホルダー |
|---|---|---|---|
| `system-prompt.md` | はい | キャラクター非依存の、チャットメンバーとして振る舞うためのルール: 長さ、アンチ AI ルール、コンテキストの使い方、人に対する態度、境界線。カードが話し方において優先すると明示する | `{{name}}` |
| `character-card.md` | はい | パーソナリティ: 人物像、性格、話し方と言語、メタレイヤー、**ペルソナの好感を得るものと失うもの**（アナライザーが読み取る）、リファレンスライン。デプロイ時に書き換える唯一のファイル | `{{name}}` |
| `rules.md` | いいえ | オーナーのライブ修正、上の二つを上書きする。**最後の `## ` 見出しの下にある箇条書きリストで終わる必要がある。** コードが `- …` 行を追記する | `{{name}}` |
| `format.md` | はい | 出力プロトコル | なし |
| `reply.md` | はい | タスク: 誰かがペルソナに話しかけた | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `follow-up.md` | いいえ | タスク: ペルソナとのやり取りを続ける行。ペルソナはまず、もう一度発言するかどうかを決める。ペルソナに何も求めていない行では `<skip/>` がデフォルト。トリガー種別が `followUp`（アドレス分類器の `yes`）、またはペルソナへの明示的な @メンションのない `reply`（Discord がリプライに付ける暗黙のピングは数えない）のとき、`reply.md` の代わりにタスクテキストとして使用。メンション、@メンション付きのリプライ、名前呼びかけは `reply.md` のまま。ファイルが存在しないか空の場合は `reply.md` にフォールバック | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `interject.md` / `initiate.md` | はい | タスク: 進行中の会話に割り込む / 静かなチャットで話題を切り出す。コードが `deadAfterMinutes` の沈黙後に `spontaneous.initiateChance` を判定するため、initiate プロンプトはデフォルトで発言し、`<skip/>` は新しい話題が明らかに場違いなチャンネル用。initiate ターンはチャンネルが静まった後、ペルソナ自身の最後のメッセージの後にも発生しうる | `{{name}}` |
| `forced.md` | いいえ | 強制ターン（`/nep interject`、`/nep initiate`）時にモードプロンプトの後に追加される。デフォルトの `<skip/>` を無効化する | `{{name}}` |
| `memory.md` | はい | ストリームアナライザーのアウトオブキャラクタープロンプト（シングルステージモードおよびプライベートバッチ）: ライブバッチからのメモリへの差分更新 | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` `{{relationshipChars}}` |
| `memory-decide.md` | いいえ | 2 段階アナライザーのステージ A（`features.memoryTwoStage`）: 変更のニュートラルな判定。`memory.md` と同じ入力ブロック。JSON を返す。ファイルがない場合はシングルステージにフォールバック | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` `{{relationshipChars}}` |
| `memory-voice.md` | いいえ | 2 段階アナライザーのステージ B: ペルソナがキューされたアイテムを自分自身の声で記述。JSON を返す。リトライ時、オプションの `<over_limit>` ブロックに前回の回答が制限を超えたアイテムが列挙される | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{relationshipChars}}` `{{learnedChars}}` |
| `portrait.md` | いいえ | 2 段階ポートレートリフレッシュのステージ A。リトライ時、オプションの `<over_limit>` ブロックに前回の回答が制限を超えたフィールドが列挙される | `{{name}}` `{{fieldChars}}` |
| `profile.md` | はい | ウォームアップ / ポートレートリフレッシュ: メッセージサンプルからメンバーのプロファイルを作成。リトライ時、オプションの `<over_limit>` ブロックに前回の回答が制限を超えたフィールドが列挙される | `{{name}}` `{{fieldChars}}` `{{maxInterests}}` `{{maxDetails}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{maxNewEpisodes}}` |
| `channel.md` | はい | ウォームアップおよびノートリフレッシュ: メッセージサンプルからチャンネルノートを作成。リフレッシュ時、オプションの `<existing_notes>` ブロックに保存済みノートが評価対象の主張として（証拠としてではなく）含まれる。リトライ時、オプションの `<over_limit>` ブロックに前回の回答が制限を超えたフィールドが列挙される | `{{fieldChars}}` |
| `server.md` | はい | ウォームアップおよびノートリフレッシュ: チャンネルノートとメンバーの要約からサーバーレベルのノートを作成。リフレッシュ時、オプションの `<existing_notes>` ブロックに保存済みノートが評価対象の主張として含まれる。リトライ時、オプションの `<over_limit>` ブロックに前回の回答が制限を超えたフィールドが列挙される | `{{fieldChars}}` `{{maxInjokes}}` `{{loreTextChars}}` |
| `describe.md` | はい | メディア説明モデルのアウトオブキャラクタープロンプト（`features.mediaDescriptions`）: 画像 1 枚を入力、プレーンテキスト 1 行を出力: 写っているもの、要点、判読可能なテキストは元のスクリプトで引用。常に英語。意見なし、道徳的判断なし、マークダウンなし | `{{today}}` `{{maxChars}}`（オプション） |
| `describe-video.md` | はい | 動画説明モデルのアウトオブキャラクタープロンプト（`features.videoDescriptions`）: 動画クリップ 1 本（音声付き）を入力、設定可能な長さの完全な説明を出力: 誰が登場するか、何が言われるか（重要なフレーズを引用）、画面上のテキスト、視覚的に何が起きるか、音楽/効果音。常に英語。発話、字幕、画面上のテキストは元の言語で引用。キャラクターカードなし | `{{today}}` `{{maxChars}}` |
| `describe-gif.md` | いいえ | GIF 説明モデルのアウトオブキャラクタープロンプト（`media.gif.watch`）: 短い無音クリップを入力、ラベル付き 3 行を出力: `reaction`（返信機能、数語または `none`）、`action`（視覚的な出来事、`{{maxChars}}` で制限）、`text`（画面上のテキストをそのまま、または `none`）。常に英語。キャラクターカードなし。ファイルがない場合は `describe-video.md` にフォールバック | `{{today}}` `{{maxChars}}` `{{seconds}}` |
| `rewatch.md` | はい | 分類器: ペルソナが動画を再視聴するか、読み込めなかった動画をリトライするか、画像をもう一度見る必要があるか（`features.videoRewatch`、`features.imageRelook`）。番号付きの最近のメディアリスト（動画と画像）を種類・ステータスと共に受け取る。出力は 1 行: `<number> \| <question>`、`<number> \| retry` または `none` | `{{name}}` |
| `rewatch-answer.md` | はい | セカンドルックのアウトオブキャラクタープロンプト: ビジョンまたは動画モデルがアイテムをもう一度見て、質問の言語で 1 つの質問に回答。種類を問わず（動画と画像の両方に対応）。キャラクターカードなし | `{{today}}` `{{question}}` `{{maxChars}}` |
| `address.md` | はい | 分類器: タグなしメッセージがペルソナ宛か、ペルソナについてか、どちらでもないか。出力は 1 語: `yes`、`overheard` または `no` | `{{name}}` |
| `overheard.md` | いいえ | タスク: メッセージがペルソナについて話しているが、ペルソナに話しかけてはいない。トリガー種別が `overheard` でファイルが存在し空でない場合、モードプロンプトの代わりに使用。ファイルが存在しないか空の場合はモードプロンプトにフォールバック（劣化） | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `lookup.md` | いいえ | 分類器: ペルソナが何かを調べる必要があるか（`features.webLookup`、`features.recall`）。短いトランスクリプトと `<candidate>` ブロックを受け取る。出力は `none`、または最大 4 行のラベル付き行: `web:` ウェブクエリ、`server:` サーバーのメッセージを検索するワードフォーム、`who:` 人物を見つけるネームフォーム、`when:` 日付範囲。ラベルなしの 1 行（旧フォーマット）はウェブクエリとして読み取られる | `{{name}}` `{{today}}` |
| `recall-summary.md` | いいえ | リコールサマリーのアウトオブキャラクタープロンプト（`features.recall`）: サーバー検索で見つかった古いチャットのストレッチを読み、質問に回答。ペルソナに原文で届けるストレッチを任意に指定。キャラクターカードなし | `{{name}}` `{{answerChars}}` |
| `room.md` | いいえ | 分類器: メッセージが全員に向けたものか、特定の一人に向けたものか（`spontaneous.roomQuestionChance`）。短いトランスクリプト、発話者のエイリアス、`<candidate>` ブロックを受け取る。出力は 1 語: `yes` または `no` | `{{name}}` |
| `route-channel.md` | いいえ | 分類器: このメッセージに応答するにはペルソナが別のチャンネルを見る必要があるか（`features.channelRoute`）。短いトランスクリプト、`<channels>` リスト、`<candidate>` ブロックを受け取る。出力は 1 行: リストの番号または `none` | `{{name}}` |
| `elsewhere.md` | いいえ | タスク: ペルソナが書き込めないチャンネルを読み、メインチャンネルでコメントする可能性がある（`features.elsewhere`）。注目ターンのタスクテキストとして使用。`<skip/>` が通常の結果 | `{{name}}` `{{channel}}` `{{destination}}` |
| `read-link.md` | いいえ | リンク読み取りのアウトオブキャラクタープロンプト（`features.webLookup`、`web.links.enabled`）: フェッチしたページを 1 段落に要約する。ページのタイトルと本文を受け取る。キャラクターカードなし | `{{today}}` `{{maxChars}}` |
| `search-summary.md` | いいえ | 検索要約のアウトオブキャラクタープロンプト（`features.webLookup`、`web.search.enabled`）: 番号付き検索結果をインラインソース付きの 1 つのノートに要約する。キャラクターカードなし | `{{today}}` `{{query}}` `{{maxChars}}` |
| `private.md` | いいえ | モードプロンプト（`reply.md`）の後、`forced.md` の前に追加。DM（`features.privateMessages`）のみ。プライベートな会話: ここで話されたことはここに留まる。ペルソナは公開知識を保持する。ファイルがなければ何も追加されない | `{{name}}` `{{author}}` |
| `diary.md` | はい | タスク: 日記投稿を書く。ペルソナ自身のチャンネル、誰にも頼まれていない。計画の種類と概要、過去の投稿、オプションのワールドと検索結果がユーザーメッセージブロックに含まれる。出力: `<msg>`（1〜`diary.maxMessages`）、`<draw>`、または `<skip/>`。`<react>` と `<gif>` は削除。返信属性なし、リンクなし | `{{name}}` |
| `diary-plan.md` | はい | プランナー: 種類、概要、検索と描画の有無を選択。`classifier.text` で動作、キャラクターカードなし。`<now>`、`<server>`、`<about_chat>`、`<recent>`、`<lore>`、`<world>`、`<diary>`、`<kinds>`、`<seeds>`、`<topic>` を受け取る。JSON オブジェクト 1 つで回答 | `{{name}}` |
| `world.md` | いいえ | ペルソナの仮想世界: チャット外の場所と日常。日記の計画・生成リクエストでのみ `<world>` ブロックとしてレンダリング、`diary.world === true` の場合のみ。通常のターンでは使用されない。ファイルなしまたはスイッチオフはブロックなし | `{{name}}` |
| `diary-seeds.md` | いいえ | 日記プランナー用ランダムシードファミリー。`# name` ヘッダーがファミリーを開始。コードが各ファミリーから 1 行選び `diary.seedSets` 組み合わせを作成。ファイルなしまたは `seedSets` = 0 で省略 | なし |
| `draw.md` | はい | 描画サブプロセスのアウトオブキャラクタープロンプト（`features.imageGeneration`）: シーン説明から画像 1 枚を生成する。外見とリクエストのみを受け取り、キャラクターカードは受け取らない | `{{name}}` `{{appearance}}` `{{request}}` `{{when}}` |
| `appearance.md` | いいえ | ペルソナのビジュアル外見。`self="yes"` 時に `draw.md` に挿入される。パーソナリティやバックストーリーなし、1 段落 | `{{name}}` |
| `mentor-situations.md` | いいえ | Mentor: ケースのテスト状況を作成（`features.mentor`）。JSON のみを返す | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-score.md` | いいえ | Mentor: ペルソナの回答をスコアリング（`features.mentor`）。キャラクターカードを受け取る。JSON のみを返す | `{{name}}` |
| `mentor-signs.md` | いいえ | Mentor: モデル文の既知の癖。すべての mentor リクエストで `<signs>` ブロックとして送信（`features.mentor`）。ファイルがないか空の場合は省略 | `{{name}}` |
| `mentor-diagnose.md` | いいえ | Mentor: スコアリング後に弱い回答の原因をペルソナのコンテキスト内の具体的なテキストで説明（`features.mentor`）。結果は未検証の仮説としてランの `diagnosis` に保存。`mentor.diagnose` が false またはファイルがない場合は省略 | `{{name}}` |
| `gif-pick.md` | いいえ | 分類器: 短いテキスト返答の代わりにライブラリから GIF を選ぶ（`features.gifPicker`）。直近の `gifs.pick.contextMessages` チャット行（応答先メッセージを明示）、ペルソナの返答、キャプション付きのフルライブラリを受け取る。長さゲートは `gifs.pick.maxChars`（デフォルト 160）; 複数の送信メッセージがある場合は最初のメッセージのみ置換。出力はライブラリのハンドル 1 つまたは `none`。キャラクターカードなし | `{{name}}` |
| `split.md` | いいえ | 分類器: 直接呼びかけに複数の独立したリクエストが含まれるか（`features.splitTasks`）。短い `<transcript>` と新しいメッセージを `<candidate>` として受け取る。出力は `one` という語、または 2 行から `{{maxTasks}}` 行で各行 `- ` で始まり著者自身の言葉でパートを示す。キャラクターカードなし。このファイルがない場合スプリッターはオフ | `{{name}}` `{{maxTasks}}` |
| `merge.md` | いいえ | 分類器: 待機中の項目を持つ著者からの新しいメッセージがそのいずれかに属するか。番号付き `<waiting>` リストと新しいメッセージを `<candidate>` として受け取る。出力は 1 行: リストの番号または `new` という語。キャラクターカードなし。このファイルがない場合、新しい呼びかけは常に独自の項目としてキューされる | `{{name}}` |
| `labels.json` | はい | コードがプロンプトに挿入するすべての文字列。キーは以下で固定、値はライターが記述する | 以下参照 |

`{{name}}` ボットの表示名 · `{{author}}` 発話者の表示名 · `{{trigger}}` `labels.triggers.*` のいずれか ·
`{{target}}` 呼び出しメッセージのインデックス（`#87`）。
`{{today}}` は `lookup.md` では `bot.timezone` の日付、説明モデル（`describe.md`、`describe-video.md`、`describe-gif.md`）と `search-summary.md` では UTC 日付。
システムメッセージ = `system-prompt` + `character-card` + `rules` + `format`。アナライザーの場合: `memory.md` のみ。
強制ターン（`/nep interject`、`/nep initiate`）では、`forced.md` が存在する場合、モードプロンプトの後に追加されます。
`overheard` ターンでは、`overheard.md` がモードプロンプトを置き換えます（追加ではなくタスクテキストそのもの）。`overheard.md` が存在しないか空の場合、モードプロンプトが代わりに使用されます（劣化: モードプロンプトはメッセージをペルソナ宛として扱い、実際と異なる）。
プライベートチャットでは、`private.md` がモードプロンプトの後（`forced.md` の前）に同じ `{{name}}` と `{{author}}` プレースホルダーで追加されます。
アナライザーとウォームアップの `profile.md` および `server.md` はキャラクターカードと `rules.md` をユーザーメッセージ内の
`<character>` ブロックとして受け取ります。`channel.md`、`describe.md`、`describe-video.md`、`describe-gif.md`、`draw.md`、`rewatch.md`、`rewatch-answer.md`、`address.md`、`lookup.md`、`read-link.md`、`search-summary.md`、`recall-summary.md`、`room.md`、`route-channel.md`、`elsewhere.md` はカードを受け取りません。

`{{guildFieldChars}}` は `fieldChars * 2` で、コードがギルドレベルのパターンとスターターをクランプする上限です。
`{{maxEpisodes}}` はメンバーごとに保持されるエピソードの総数です。どちらも config から設定されますが、デフォルトプロンプトでは
使用されません。カスタムの `memory.md` が参照する場合があります。

## ブロック

ユーザーメッセージのブロックです。空のものは省略され、順序は以下の通りです。

| ブロック | 内容 |
|---|---|
| `<now>` | 日付、曜日、`config.bot.timezone` の時刻。`labels.locale` でフォーマット |
| `<senses>` | ペルソナが今この瞬間に何を知覚でき何を知覚できないか。ライブ設定から生成: どの画像をペルソナ自身が見て、どれがヘルパーの説明文として届き、何が見えず聞こえないか。ペルソナが動画を見たと偽ることなく、自分の声でネタにできるようにする |
| `<about_chat>` | 人々がここでどう話すか、会話の始め方と割り込み方、内輪ネタ、人々がペルソナに教えたこと |
| `<emoji>` | ペルソナが使えるカスタム絵文字（`features.customEmoji`）: 最大 `context.customEmoji.max` エントリ、メンバーの使用頻度でランク付け。各エントリは `:name:` とキャッシュ済みのヘルパーキャプション（ある場合）。`labels.emoji.seenInChat` がある場合、トランスクリプト・プルされたチャンネル・隣接チャンネルに出現したがトップリストに含まれない説明付きカスタム絵文字がそのサブ見出しの下に表示される。トランスクリプト行ではすべてのカスタム絵文字が素の `:name:` のまま残る。ラベルがない場合（またはブロックがない場合）はインラインの `transcript.emojiDescribed` タグがそのまま使用される |
| `<gifs>` | ペルソナが投稿できる GIF（`features.gifs`）: 最大 `gifs.max`（デフォルト 40）エントリ、使用頻度と新しさでランク付け。各エントリはハンドル（`g1`、`g2`、...）とキャッシュ済みの説明 3 フィールド（ある場合）: リアクションラベル（`gifs.reactionChars` で制限、デフォルト 40）、可視アクション（`gifs.actionChars` で制限、デフォルト 70）、画面上のテキスト。フィールド付きエントリは `labels.gifs.entryFields`（`{id}`、`{reaction}`、`{action}`、`{text}`; コードが空フィールドとそのセパレータを除去）で表示; フィールドなしのエントリは `labels.gifs.entry`（`{id}`、`{text}`）でキャプションを単語境界でカット。各エントリはペルソナ自身の投稿時刻と回数も記録し（`ownLast`、`ownUses`）、`gifs.ownMarkHours`（デフォルト 24、`0` = オフ）以内に投稿されたものには `gifs.ownMark` が短い相対時間とともに付く |
| `<server>` | 現在のチャンネルの詳細（Discord カテゴリとトピック、目的、投稿内容、トーン、アクティビティ、最新メッセージ、トップライター。`labels.server.currentMark` でマーク）に加え、このターンで `<other_channels>` に供給した隣接チャンネルのみ。他のチャンネルは含まない |
| `<lore>` | 直近のメッセージにキーが出現するサーバーのロアブックエントリ（常時表示マーク付きのエントリも含む）: イベント、繰り返し登場するキャラクター、長期にわたるストーリー。ロアブックのように数百エントリが存在できるが、該当する少数だけが表示される |
| `<self_facts>` | ペルソナが自身について主張した内容 |
| `<recent>` | サーバーで直近 `memory.recentHours`（デフォルト 72）時間に何が起きたか: アナライザーが書く最近のノート（短いイベント）と、ウィンドウ内のメンバーのエピソード（参照で表示）。ノートはターン自身のチャンネル、またはここにいる全員が読めるチャンネルからのみ表示。プライベートチャットでは全サーバーメンバーが読めるチャンネルからのみ表示され、エピソードなし。このターンが話しかけている人についての項目が優先。`<people>` で既に表示されたエピソードは除外、メンバーあたり最大 2 件。古い順。ヘッダーのみで項目がない場合は何も表示しない。スイッチ `features.recent`（キー欠落 = オン）。上限 `context.caps.recent`（デフォルト 1200） |
| `<people>` | メンバープロファイル。発話者が先頭で `labels.profile.interlocutorMark` でマーク（`overheard` ターンでは省略: 発話者はペルソナについて話しているのであり、ペルソナに話しかけているのではない）。各メンバーにペルソナの態度を付し、その後に態度を形成した最大 `relationships.shownMoves` 件の変動が続く（絶対変動量の大きい順、ブロック内では古い順、正負両方があれば両方を保持、現在の理由は繰り返さない）。発話者には**エピソード**も含む: ペルソナが二人の間で記憶している出来事（日付と短い引用付き） |
| `<attitudes>` | ペルソナが最も強く感じているメンバーの上位 `context.attitudes`（デフォルト 6、`0` = オフ）名。態度スコアの大きさで順位付け、好意と反感混在。発話者と `<people>` に既に表示されているメンバーはスキップ。メンバーごとに 1 行（`labels.attitudes.line`）: 名前と態度バンド。ヘッダー: `labels.attitudes.header`。上限 `context.caps.attitudes`（デフォルト 400）。サーバーターンとプライベートチャットの両方に表示 |
| `<other_channels>` | 隣接チャンネルごとに最大 `context.neighborMessages` 件のメッセージ。`context.neighborMaxAgeMinutes` より古いものは含まない。`features.mediaDescriptions` がオンの場合、隣接チャンネルの行内の画像はキャッシュ済みキャプションを持つ場合にそれを付加。隣接チャンネルに対して新規の説明リクエストは行われない。`<channel_view>` にブロックが表示されているチャンネルは `<other_channels>` から除外。バジェットがプルされたブロックを落とした場合、そのチャンネルは通常の隣接チャンネルとしてここに再表示 |
| `<channel_view>` | このターンにプルされた別のチャンネル（`features.channelPull`）。プルされたチャンネルごとにヘッダー行（`labels.pull.header`）、該当時の読み取り専用マーク（`labels.server.readOnly`）、ウィンドウがカットされた場合の「古いものは非表示」行、「画像は未確認」カウント、ペルソナへの過去の呼びかけ（応答済み/未応答/スキップマーク付き）、ウィンドウの行。行は `<chat>` と同じトランスクリプト形式だが、チャットの後に番号が続く（チャットは `#1`..`#N`、プルブロックは `#N+1` から）ため、すべての `#n` がブロック間で一意。画像はキャプションまたはブラインドタグのみ、添付画像としては含まない。`labels.pull.header` がない場合ブロックは空 |
| `<lookup>` | ペルソナがこのターンで調べた内容。ウェブ検索（`features.webLookup`）は `labels.lookup.webHeader`、要約された回答、`labels.lookup.sources`。何も見つからなかった場合は `labels.lookup.none`。サーバー検索（`features.recall`）は `labels.lookup.serverHeader`、サマリーノート。サマリーがストレッチを指定した場合はそのストレッチの原文行。両方実行された場合は `labels.lookup.bothNote` がその間に配置。`labels.lookup.stretch` 行が原文ストレッチを導入（`{date}` `{channel}`）。検索分類器が発火し少なくとも 1 つの検索が完了した場合にのみ表示 |
| `<chat>` | 現在のチャンネルの最新 `context.channelMessages` 件のメッセージ。投稿から `context.ageAfterMinutes`（デフォルト 60）分以上たった行には、どれだけ前の投稿かも表示される（`transcript.timeAged`）。`context.fetchReplyParents` がオンの場合、トリガーメッセージとウィンドウ末尾の `context.replyParentsFor` 件の返信行（ウィンドウより古いメッセージへの返信）の親が取得され、通常のトランスクリプト行としてウィンドウの前に配置される。トリガーの親はさらにその親も取得可能。ターンあたり最大 `context.replyParentsMax` 件。ギャップマーカーと日付ヘッダーが時間の飛びをカバーし、リプライ行は `transcript.replyTo` で親を引用する。親のメディアは他の行と同様に扱われ、キャッシュ済みの説明はコストなしで提供される。削除済みまたはアクセス不能な親はスキップされ `collect: parent missing` としてログ出力 |
| `<tempo>` | 10 分 / 1 時間 / 1 日のカウント、参加人数、沈黙時間、判定（live / slow / dead） |
| `<world>` | ペルソナの仮想世界（`prompts/world.md`、`{{name}}` 補完済み）。日記投稿（`mode === 'diary'`）かつ `diary.world === true` の場合のみ。予算圧迫で丸ごと削除。ファイルなしまたはスイッチオフは何も追加しない |
| `<diary>` | 過去の日記投稿、古い順: `labels.diary.intro`、次に投稿ごとに `labels.diary.line`。計画・生成両方のリクエストに表示。予算圧迫では古い行から先にカット |
| `<plan>` | この日記投稿の計画: `labels.diary.plan`、次に JSON 1 行 `{"kind","brief","picture"}`、オーナーが `/nep diary post` で指定した場合は `"topic"` も含む。カットされない |
| `<found>` | 日記の検索結果: `labels.diary.found`、次に検索結果テキスト。計画が検索を要求し結果があった場合のみ。予算では `<lookup>` の直後 |
| `<kinds>` | 投稿種類と重み・使用回数: `labels.diary.kinds`、次に正の重みを持つ種類ごとに `labels.diary.kindLine`; 投稿が画像を含められない場合、`diary.pictureKinds` の種類は除外される。カットされない |
| `<seeds>` | ランダムシード組み合わせ: `labels.diary.seeds`、次にセットごとに `- a; b; c`。計画リクエストのみ。ファイルなしまたは `diary.seedSets` = 0 で省略。カットされない |
| `<topic>` | オーナーの強制投稿の題材（`/nep diary post [kind] [topic]`）: `labels.diary.topic`、次にトピック 1 行、最大 300 文字。計画リクエストのみ、`<seeds>` の直後、トピック指定時のみ。カットされない |
| `<task>` | `reply` / `follow-up`（`follow-up.md` が存在する場合、`followUp` と @メンションのない `reply` 用）/ `interject` / `initiate` / `overheard`（`overheard.md` が存在する場合）/ `elsewhere`（`elsewhere.md` が存在する場合、注目コメント用）/ `diary`（`diary.md` が存在する場合、日記投稿用）、プレースホルダー補完済み。モードプロンプトの後、条件が成立する場合に最大 3 つの `task.*` ラベルが追加（それぞれ空行で区切り）: 分割メッセージの 1 パートに応答するターンでは `task.part`、またはトリガー著者が他の呼びかけを待機中なら `task.queued`。次に他のメンバーがチャンネルで呼びかけを待機中なら `task.queuedOthers`。次に後のメッセージがこの呼びかけに統合されていれば `task.added`。`labels.task.*` を参照 |

バジェットの優先順位（このリストの下からセクションがトリムされる）: system + task + clock + tempo + senses
（カットされない）-> 発話者のプロファイル（エピソード付き）-> lookup（全体として保持または削除。ウェブパート、サーバーパート、またはその両方を含む場合がある）-> about_chat -> self_facts -> lore -> server -> chat（新しい順）->
pulled（`<channel_view>`、`context.caps.pulled` で制限。読み取り専用チャンネルからの呼びかけに応答するターンでは、プルされたブロックは chat の後ではなく前に配置）->
recent（`context.caps.recent` で制限）->
他のプロファイル -> attitudes（`context.caps.attitudes` で制限）->
日記モードのみ: `<found>`（`<lookup>` の直後）、`<world>`（丸ごと、attitudes の後）、`<diary>`（古い行から先にカット）、`<plan>` + `<kinds>` + `<seeds>` + `<topic>`（カットされない）->
other channels -> 絵文字（下からエントリを削除、次にブロック全体; `context.caps.emoji`）-> GIF（同じトリム; `context.caps.gifs`）。

GIF ピッカー（`features.gifPicker`、デフォルトオン）。ペルソナが短い返答（最大 `gifs.pick.maxChars` 文字、デフォルト 160）を書き、自分で GIF を選ばなかった場合、分類器（`classifier.text`、purpose `gif-pick`、`gifs.pick.maxOutputTokens` 60、プロンプト `prompts/gif-pick.md`）が直近の `gifs.pick.contextMessages`（デフォルト 4）チャット行（応答先メッセージを明示）、ペルソナの最初のメッセージ、キャプション付きのフルライブラリ（各エントリにキャプション、ペルソナが最近投稿した場合は自分マーク付き）を受け取ります。分類器はハンドル 1 つまたは `none` を返します。ハンドルが返されると GIF が最初の送信メッセージを置換し、元のメッセージと同じ送信先にリプライします。残りのメッセージは順番に続きます。GIF の送信に失敗した場合、すべてのメッセージがそのまま投稿されます。分類器は最初のメッセージのタイピングシミュレーション中に実行され、日次 GIF 制限 `gifs.maxPerDay` が適用されます。ログ: `gifs: picked`（handle true/false、ライブラリサイズ）または `gifs: pick failed`。

トランスクリプト行のメディア（利用可能な最も情報量の多い形式）: このリクエストに添付された画像 →
`transcript.imageAttached`（画像がテキストの後に並ぶ順にナンバリング）、説明済み →
`imageDescribed` / `gifDescribed` / `videoDescribed`、それ以外はブラインド形式 `image` / `gif` / `video`。
動画ビジョンが有効な場合（`features.mediaDescriptions` かつ `features.videoDescriptions`）、動画または動画サイトのリンクは
状態を持ちます: `videoWatched`（一次情報、映像と音声を視聴済み）、`videoNotWatchedFrame`（未視聴だが静止フレームの説明あり）、
`videoNotWatched`（未視聴、フレームなし）。理由コード（`length` / `size` / `daily` / `error` / `pending`）はトランスクリプトに届く前に
`transcript.videoReason.*` の人間向けフレーズに置換されます。リンクはベースタグ（`link` / `linkText`）を維持し、動画のエクストラ
（`linkWatched`、`linkNotWatchedFrame`、`linkNotWatched`）を追加します。静止フレームが画像として添付されている場合、
`frameAttached` も追加されます。リンクは Discord の埋め込みから構築された `link` / `linkText`（サイト、タイトル、スニペット）を
使用。`features.webLookup` が有効でリンクが読み取られた場合、リンクの他のエクストラ（動画、サムネイル）の後に `linkRead` が追加されます。テキストファイルは冒頭を `filePreview` で表示。転送されたメッセージは `forwarded` でラップ。`features.seeReactions` が有効（デフォルト）の場合、リアクションタグがメディアタグおよび転送ラッパーの後、行の末尾に追加されます。1 メッセージあたり最大 `context.reactionsPerMessage` 件のリアクションが頻度降順で表示されます。各項目は `transcript.reactionItem` または `transcript.reactionMine`（ペルソナがリアクションした場合）を使用し、", " で結合され `transcript.reactions` でラップされます。`transcript.reactions` キーのないラベルファイルでは何も表示されません。

動画の結果は添付ファイルごとまたはリンクごとに `data/guilds/<id>/media.json` にキー
`video:<itemId>`（添付ファイル ID、またはリンク URL の安定ハッシュ）で保存されます。キャッシュエントリ:

- 視聴済み: `{ text, ts, watched: true }`: 永続、サマリーテキスト。
- リミットミス（length または size）: `{ miss: true, ts, reason: "length"|"size" }`: 永続、ファイルは変化しない。
- エラーミス: `{ miss: true, ts, reason: "error" }`: `media.video.errorRetryMinutes`（デフォルト 60）分後にリトライ、または再視聴分類器からの強制リトライで即時リトライ。
- デイリーリミット: キャッシュされない。そのターンのみ `{ state: "limit", reason: "daily" }` として返される。

再視聴の回答はキー `video:<itemId>:q:<hash>`（小文字化・空白正規化した質問の SHA-1 の先頭 16 桁の十六進数）で保存されます: `{ text, ts, answer: true }`。1 時間で期限切れ。コードは読み取り時に期限切れのエントリを削除します。

画像の静止フレームエントリは従来通り独自の `<itemId>` キーを保持します。同一アイテムに対して両方が共存できます。

視聴された GIF は GIF 自身の `<itemId>` キー（`video:` プレフィックスなし）でキャッシュされます: `{ text, reaction, action, screen, ts, watched: true, gif: true }`。`text` は一行のアクション（アクション行がない場合はリアクションまたは画面上のテキスト）です。4 つのフィールドはすべて完全な状態で保存され、`media.descriptionChars` のみで制限されます。切り詰めはフィールドが表示される場所、`<gifs>` リストとライブラリ GIF のトランスクリプト行（`transcript.gifKnownFields`）で適用されます: `gifs.reactionChars` が `reaction` と `screen` を、`gifs.actionChars` が `action` と旧形式の一行キャプションを切り詰めます。`0` = 切り詰めなし。単一フレームのキャプションは `{ text, ts, gif: true }`（視聴を試みて失敗した場合は `watchFailed` 付き）で保存されます。どちらも画像の記述と同じキャッシュ内に配置されます。

ウェブルックアップの結果も同じ `data/guilds/<id>/media.json` に動画や画像のエントリと並んでキャッシュされます:

- リンク読み取り: `read:<link.id>` は `{ text, ts }`（要約抜粋、永続）または `{ miss, ts, reason }`（6 時間スキップされるミス。理由: `scheme`、`private`、`redirects`、`type`、`size`、`timeout`、`http`、`network`、`empty`、`unreadable`、`llm`）を保持します。`TokenLimitError` や `DailyCapError` はキャッシュされません。
- 検索: `search:<正規化クエリの SHA-1 プレフィックス、16 桁の十六進数>` は `{ query, text, sources, ts }` を保持し、`web.search.cacheHours`（デフォルト 24）時間以内であれば提供されます。空の `text` は結果なし（`labels.lookup.none` を描画）を意味します。失敗はキャッシュされません。

トランスクリプト行: `#87 [14:32] nick: text <replyTo> <media…> <sticker> <reactions>`。自分の行には `labels.self` を使用。
行間に `labels.transcript.gap` / `gapWithDate` / `date`。ブロック冒頭に `labels.transcript.header`。隣接チャンネル:
`#n` なしの同じ行形式、`# channel-name` の下に配置。リクエスト時点（`<now>` と同じ時刻）で投稿から
`context.ageAfterMinutes`（デフォルト 60）分以上たった行は、時刻部分が `labels.transcript.timeAged` で描画される:
`#87 [14:32 · 2 h 58 min ago] nick: text …`。経過時間が付くのは `<chat>`、`<channel_view>`、`<other_channels>` の行だけで、
リクエストごとに計算され、保存されない。それ以外のトランスクリプト（分類器、サーバー検索の原文ストレッチ、アナライザー、
ウォームアップ）は時刻のみ。

## ラベル

`labels.json` のキー。`{x}` はコードが挿入します。

```
locale                                   BCP-47 tag for dates
ping.prompt                              the whole user message of `/nep ping`; must make any model answer one short word
self                                     {name}
units.lessThanMinute | minute | hour | day
transcript.gap                           {duration}: `context.gapMarkerMinutes` 分以上離れた隣り合う 2 行の間の時間。メッセージの経過時間と読まれない書き方にする
transcript.gapWithDate                   {duration} {date}: 同上、2 行の間で日付が変わった場合。date は下の行の日付
transcript.date | header                 {date}
transcript.timeAged                      {clock} {age}: 投稿から `context.ageAfterMinutes` 分以上たった行の、角括弧を含む時刻部分全体を置き換える。age は `labels.units` 単位の時間。それより新しい行は `[{clock}]` のまま。キーがないか空の場合、経過時間は表示されない
transcript.empty | replyToOld | image
transcript.replyTo                       {index} {author} {quote}: 親メッセージの番号、その著者（親がペルソナ自身の場合は self ラベル）、親テキストの引用（`context.replyQuoteChars`（デフォルト 80、`0` = 全文）で単語境界にカット。メディアのみの親はそのメディアラベルを引用する）
transcript.file | sticker                {name}
transcript.stickerDescribed              {name} {text}
transcript.emojiDescribed                {name} {text}: 説明付きカスタム絵文字のインラインタグ。チャット行に付加される。`<emoji>` ブロックがない場合、または `labels.emoji.seenInChat` が未設定の場合のみ使用。`seenInChat` がある場合は行に素の `:name:` が残り、説明はブロックに移動する
transcript.imageAttached                 {n}: this picture is attached to the request, the persona sees it
transcript.imageAttachedDescribed        {n} {text}: attached to the request and captioned by the helper (features.attachedDescriptions)
transcript.imageDescribed                {text}
transcript.gif                           {name}
transcript.gifDescribed                  {text}
transcript.gifKnown                      {id} {text}: a GIF that is in the library; id is its handle, text is the caption
transcript.gifKnownFields                {id} {reaction} {action} {screen}: キャッシュにリアクションまたは画面上のテキストがあるライブラリ GIF。gifKnown に代わって使用。gifs.reactionChars / gifs.actionChars で gifs.entryFields と同様に切り詰め。コードが空フィールドとセパレータを除去。キーが空: gifKnown にフォールバック
transcript.gifKnownNoText                {id} {name}: a library GIF without a caption; id is the handle, name is the file or link name
transcript.video                         {name} {duration}
transcript.videoDescribed                {name} {duration} {text}: text describes ONE frame
transcript.videoWatched                  {name} {duration} {text}: first-hand, the persona saw and heard the clip
transcript.videoNotWatched               {name} {duration} {reason}: reason is the human phrase from videoReason.*
transcript.videoNotWatchedFrame          {name} {duration} {reason} {text}: not watched but a still frame was described
transcript.videoAnswered                {question} {text}: extra tag after a watched video tag; the persona re-watched the clip for this question
transcript.imageAnswered                {question} {text}: extra tag under the picture's line; the persona looked at the picture again for this question
transcript.videoReason.length | size | daily | error | pending    human phrases for the five reason codes; pending = the clip was still loading when the request went out
transcript.linkWatched                   {text}: extra tag after a link tag, first-hand video summary
transcript.linkNotWatched                {reason}: extra tag after a link tag, not watched with reason
transcript.linkNotWatchedFrame           {reason} {text}: extra tag after a link tag, not watched but preview described
transcript.voice                         {duration}
transcript.audio                         {name} {duration}
transcript.link                          {site} {title}
transcript.linkText                      {site} {title} {text}
transcript.linkRead                      {text}: extra tag after a link tag; the page was fetched and condensed, first-hand
transcript.thumbnailDescribed            {text}: follows a link tag; describes the link's preview picture
transcript.filePreview                   {name} {text}
transcript.forwarded                     {text}
transcript.forwardedFrom                 {channel} {text}: used when the source channel is known; falls back to `forwarded`
transcript.frameAttached                 {n}: follows a video/gif item whose still frame is attached picture n
transcript.reactions                     OPTIONAL {list}: appended at the end of a line after all media and forwarded tags; list is items joined with ", ". A labels file without this key renders nothing
transcript.reactionItem                  {emoji} {count}: one reaction; emoji is unicode or :name: for custom
transcript.reactionMine                  {emoji} {count}: used instead of reactionItem when the persona is among the reactors; reads correctly whether count is 1 or more
transcript.unknownDuration               shown in place of {duration} when Discord gave none
senses.imageSee | imageDescribed | imageBlind        one line each; code picks the ones true under the live config. imageSee also covers the helper's note when features.attachedDescriptions is on
senses.gifWatched | gifDescribed | gifBlind   gifWatched replaces gifDescribed when media.gif.watch is on (needs video vision on and a describe-gif or describe-video prompt); a labels file without gifWatched falls back to gifDescribed. Both say GIF descriptions come from a helper (second-hand); without a description the persona does not infer the content
senses.videoDescribed | videoBlind
senses.videoWatch                        replaces videoDescribed when features.videoDescriptions is on (needs mediaDescriptions too); covers watched, still frame and not-watched states
senses.videoRewatch                      shown alongside videoWatch when features.videoRewatch is on; tells the persona that a second look at a watched video may appear, marked as first-hand
senses.stickerSee | stickerDescribed | stickerBlind
senses.lottie
senses.customEmoji                       shown when features.customEmoji is on and the server has at least one custom emoji; tells the persona they can use server custom emoji by writing :name:
senses.gifs                              shown when features.gifs is on and the library is not empty; tells the persona they can post one GIF per turn by handle from the list or transcript; entries give the reaction, visible action and on-screen text; recent-use marks show own posts; only listed or transcript handles; unknown handle posts nothing
senses.voice | links | files
senses.linksWatch                        replaces links when features.videoDescriptions is on; adds that a linked video may come watched or not watched with the reason
senses.linksRead                         shown after the links line when features.webLookup is on and web.links.enabled is not false; tells the persona that a link may come with a read excerpt, first-hand
senses.search                            shown when features.webLookup is on, web.search.enabled is not false AND a Brave Search key is configured; tells the persona that a `<lookup>` block may appear with web results and that no search can happen during the reply itself
senses.recall                            shown right after the search line when the server-history search is available: on every server turn, and in a private chat when `features.privateLikeServer` is on (the default). Tells the persona that a search of the server's old messages either ran before the reply or did not, that its part of `<lookup>` is what the history holds (a helper's summary or a verbatim stretch), and that without it nothing was looked up there. An older labels file without the key renders nothing
senses.diary                             {channel}: `diary.channelId` が設定済みかつ `features.diary` が false でない場合に表示。ペルソナがそのチャンネルで日記をつけていることを伝える
senses.draw                              shown when features.imageGeneration is on and an image client is wired; tells the persona they can draw
senses.drawSpent                         replaces draw when the daily picture quota is spent
senses.drawSpentUser                     replaces draw when this member's daily quota is spent
senses.privateChat                       shown in a DM turn: this is a one-on-one conversation, what is said here stays between the two of them
senses.privateAware                      shown on a server turn when features.privateMessages is on: the persona knows they have private chats and never repeats or hints at anything from them
lookup.header                            {query}: heading of the `<lookup>` block (web search)
lookup.sources                           {list}: site names, comma-separated by code
lookup.none                              shown in `<lookup>` when the search found nothing useful
lookup.webHeader                         heading of the web part inside `<lookup>` when both web and server searches ran
lookup.serverHeader                      heading of the server part inside `<lookup>` when both web and server searches ran
lookup.bothNote                          shown between the web and server parts when both ran
lookup.stretch                           {date} {channel}: introduces a verbatim stretch of old chat inside the server part
tempo.counts                             {last10min} {lastHour} {lastDay}
tempo.authors                            {authors}: a head count
tempo.silenceBeforeTrigger | lastMessageAgo | sinceOwn          {duration}
tempo.emptyChannel | ownUnanswered
tempo.verdict                            {verdict} = tempo.verdictLive | verdictSlow | verdictDead
profile.interlocutorMark                 appended to the caller's heading (starts with a space)
profile.formerNames                      {names}
profile.character | interests | style | details | relationship  {text}
profile.aliases                          {text}: what people in chat call this member (comma-separated by code)
profile.interestItem                     {topic} {note}: one interest with a note
profile.interestItemNoNote               {topic}
profile.unsureMark                       appended to an unconfirmed interest or detail (starts with a space, self-explanatory)
profile.staleMark                        appended to an interest not seen for memory.interestStaleDays (starts with a space)
profile.unknown
profile.messageCount                     {count}
profile.affinity                         {score} {band} {reason}
profile.affinityMove                     {delta} {date} {reason}: 態度履歴からの 1 つの変動。態度行の後に最大 `relationships.shownMoves` 件が続く。絶対変動量の大きい順、ブロック内では古い順、正負両方があれば両方を保持、現在の理由は繰り返さない
profile.episodes                         heading line above the caller's episodes
profile.episode                          {date} {what} {quote} {feeling}: one remembered moment
profile.episodeNoQuote                   {date} {what} {feeling}: the same without a quote
lore.entry                               {title} {text}
emoji.header                             カスタム絵文字リストの導入
emoji.entry                              {name} {text}: キャプション付きの絵文字 1 つ
emoji.entryNoText                        {name}: キャプションなしの絵文字 1 つ
emoji.seenInChat                         トランスクリプトに出現したがトップリストに含まれない説明付きカスタム絵文字の前のサブ見出し。なければインラインの `transcript.emojiDescribed` タグがそのまま使用される
gifs.header                              GIF ライブラリリストの導入: エントリごとに、表現する返答、可視アクション、画面上のテキスト
gifs.entry                               {id} {text}: 1 行キャプション付きの GIF 1 つ（3 フィールド説明なしのエントリ）
gifs.entryFields                         {id} {reaction} {action} {text}: 3 フィールドキャプション付きの GIF 1 つ; コードが空フィールドとセパレータを除去
gifs.entryNoText                         {id}: キャプションなしの GIF 1 つ
gifs.ownMark                             {ago}: appended to an entry the persona posted within gifs.ownMarkHours
affinity.bands.hostile | dislike | cool | neutral | warm | fond | devoted
                                         thresholds in code: ≤-60 · ≤-25 · ≤-8 · <8 · <25 · <60 · ≥60
affinity.ownerSet                        reason shown when the owner set a score by hand without giving one
aboutChat.patterns | starters | injokes  {text}
aboutChat.learned                        {text}: things people taught the persona, joined by `; ` by code
aboutChat.learnedItem                    {text} {who}: one lesson with a teacher
aboutChat.learnedItemNoFrom              {text}: one lesson with no known teacher
aboutChat.unsureMark                     appended to an unconfirmed learned item (starts with a space)
server.currentMark                       appended to the current channel's heading (starts with a space)
server.category | topic | purpose | topics | tone               {text}
server.activity                          {activity} = server.activityLive | activitySlow | activityDead
server.lastMessage                       {when}: humanised age of the channel's newest message
server.topWriters                        {names}: current names of the members who write there most
server.diary                             `<server>` マップの日記チャンネルに表示。ペルソナの日記
server.readOnly                          shown on a channel the bot can read and react in but not write in; never shown on the current channel. Appears in the `<server>` map entry and as a line after a pulled channel's header
senses.time                              すべての `<senses>` ブロックで files 行の直後に表示（プライベートチャットを含む）: メッセージの時刻は `<now>` と同じタイムゾーン、古い行には経過時間が付く、ギャップマーカーは隣り合う 2 行の間の沈黙を示すだけ、出来事がどれだけ前かはその出来事自身の行から読み、ギャップマーカーや `<tempo>` からは読まない。プレースホルダーなし。キーがないか空の場合は何も表示しない
senses.channels                          shown on every server turn: which channels this request shows (the chat, `<other_channels>`, `<channel_view>`); never claim to have looked at a channel not shown
senses.elsewhere                         {destination}: shown when `features.elsewhere` is on and `memory.mainChannelIds` has a usable channel; says a call from a read-only channel is answered in {destination} with a link
pull.header                              REQUIRED {channel} {from} {to} {ago}: first line of a pulled channel. Without it no `<channel_view>` renders. {from}/{{to}} are formatted dates, {ago} is a duration phrase from labels.units
pull.olderNotShown                       shown when older messages exist in the pulled channel that are not included
pull.picturesNotSeen                     {count}: shown when pictures in the pulled channel were not looked at
pull.earlierPings                        {date}: heading before earlier calls to the persona in that channel, older than the window
pull.pingAnswered                        appended to a pulled line that called the persona and was answered
pull.pingUnanswered                      appended to a pulled line that called the persona and has not been answered yet
pull.pingSkipped                         OPTIONAL appended to a pulled line the persona saw and chose to let pass; without it no mark is shown for skipped calls
elsewhere.called                         {channel} {destination}: appended to the reply task text on a turn answering a call from a read-only channel
elsewhere.link                           {text} {link}: joins the jump link to the persona's posted message; members read it, the model never sees it
triggers.mention | reply | name | followUp | overheard   followUp = an untagged message the address classifier judged to be for the persona; overheard = talk about the persona, not to them. Both post plain, never as a Discord reply. overheard falls back to followUp, then reply
triggers.private                         the trigger for a private (DM) message
triggers.drawFailed                      {reason}: the drawing sub-process failed; reason is the human phrase from draw.reasons.*
draw.when                                {when}: 画像モデルに光と季節を合わせるためのローカル日時。すべての描画リクエスト（日記含む）で時間が既知の場合に補完。不明時は空
draw.reasons.moderation | daily | userDaily | timeout | error    human phrases for the five failure reasons; daily and userDaily are reserved but no longer reached by triggers.drawFailed — an image cap now posts limits.notice instead of a follow-up turn
diary.intro                              `<diary>` ブロックの最初の行
diary.line                               {date} {kind} {gist}: 過去の投稿 1 件
diary.picture                            {scene}: 投稿に画像があった場合に日記行に付加
diary.pictureUnknown                     バックフィルされた投稿で画像があったがシーンが記録されていない場合のプレースホルダー
diary.kindUnknown                        バックフィルされた投稿で種類が記録されていない場合のプレースホルダー
diary.kinds                              `<kinds>` ブロックの最初の行
diary.kindLine                           {key} {weight} {count} {window}: 種類 1 件と重み・使用回数
diary.plan                               `<plan>` ブロックの最初の行
diary.found                              `<found>` ブロックの最初の行
diary.seeds                              `<seeds>` ブロックの最初の行
diary.topic                              `<topic>` ブロックの最初の行（オーナーの強制投稿の題材）
memory.privateNote                       the <private> block content in a private analyzer batch: marks the batch as a private conversation, constrains output to users for the partner's id only
memory.privateChannel                    heading used in place of a channel name for the <new_messages> section in a private batch
limits.notice                            {limit} {used} {cap}: posted as a plain reply when a rail refuses a triggered action; limit is the config key, used/cap are the numbers
limits.paused                            posted as a plain reply when the persona is called while paused (`features.pauseNotice`). No placeholders. At most once per channel per `mention.pauseNoticeMinutes`
warmup.ownMark                           prefixed to a member's own lines in the profile.md transcript
warmup.contextMark                       prefixed to context lines in the profile.md transcript
mentor.intended                          array of short strings: engine behaviours that must not cost points in the mentor's scoring
mentor.examples                          first line inside the `<examples>` block in a situations request: introduces the real moments
mentor.original                          first line inside the `<original>` block in a score request: introduces the persona's rejected answer
room.focus                               {target} {author}: appended to the reply task when a room question triggers the turn
address.author                           {name} {aliases}: the candidate author's display name and known aliases, shown to the address classifier when the member has aliases
recent.header                            REQUIRED {hours}: the block's first line. A missing header or a missing `recent.line` means no `<recent>` block
recent.line                              REQUIRED {date} {time} {text}: one note from the turn's own channel or an unnamed channel
recent.lineIn                            OPTIONAL {date} {time} {channel} {text}: a note from another named channel; {channel} arrives without '#'. Without it `recent.line` is used
recent.episode                           OPTIONAL {date} {name} {what}: a moment the persona remembers with {name} on {date}; no quote, no feeling. Without it the block shows notes only
attitudes.header                         the block's first line: who these members are and how to use the list
attitudes.line                           {name} {band}: one member and their attitude band
task.part                                {index} {total} {part} {others}: this turn answers one part of a split message. {index} is 1-based, {part} is the text of this part, {others} lists the remaining parts and any queued calls as numbered items joined by `; `. Without this key the splitter is off even when the prompt file exists
task.queued                              {others}: the trigger author has other calls waiting, listed as numbered items joined by `; `. Shown only when there is no `task.part` for this turn. Without this key the waiting calls are not named and the seen-in-history drop rule applies to them
task.queuedOthers                        {others}: other members have calls waiting in this channel, listed as `<n>. <author>: <text>` items joined by `; `. Without this key those calls are not named
task.added                               {added}: later messages from the author were folded into this call while it waited, joined by `; `. Without this key the folded messages are not named
```

## 出力

モデルの出力で処理されるのは以下のタグのみです:

- `<think>…</think>` 任意、先頭に配置、1–4 行の隠れた計画。閉じていない場合は沈黙を意味する。
- `<msg>text</msg>` チャットメッセージ 1 件、最大 3 件連続可能。`reply="#87"` で Discord リプライになる。
- `<react to="#87">💀</react>` Unicode 絵文字 1 つ。`<msg>` と単独でも併用でも可。
- `<draw self="yes" reply="#87">scene</draw>` 描画サブプロセスへの画像。ターンにつき 1 つ、最初の非空が優先、800 文字でクランプ。`self="yes"` でペルソナの外見が追加。`reply="#87"` は `<msg>` と同じ。`<msg>` や `<react>` と併用可。
- `<skip/>` 沈黙。
- `@nick` トランスクリプトと同一の表記が実際のメンションになる。
- `#チャンネル名` がサーバーチャンネルの場合、`<msg>` テキスト内で本物のチャンネルリンク（`<#id>`）に変換される（`features.channelLinks` オン時、デフォルト true、未設定 = オン）。名前は最長一致。既存のリンクはそのまま。

`features.reactions: false` は `<react>` を無効化、`features.multiMessage: false` は最初の `<msg>` のみを保持。
`features.imageGeneration: false` またはイメージクライアントなしの場合は `<draw>` を無効化。`drawFailed` ターンでも `<draw>` は無効化されます。プロンプトが知る必要はありません。

`format.stripDashes` がオン（デフォルト true、未設定 = オン、`false` のみオフにする）の場合、`<msg>` テキストのすべてのエムダッシュとエンダッシュが投稿前に除去される。ダッシュとその周囲のスペースは 1 つのスペースになり、ギュメ（`«`、`»`）はプレーンな `"` に置換される。除去後に空になったメッセージは送信されない。ハイフンはそのまま残る。`<draw>`、`<react>`、`<gif>` とリプライ id は影響を受けない。`turn: dashes stripped` として `channel` と `count` でログされ、テキスト自体はログされない。

## アナライザー

1 回の呼び出し（`memory.md`）でペルソナが記憶するすべてを更新します。ペルソナの**目を通して**人々を判断するため、キャラクターカードを受け取ります。チャンネルが活発かどうかの判断はアナライザーの役割ではなく、コードがカウントします。ウォームアップは古い履歴をウォームアップ用プロンプト（`profile.md`、`channel.md`、`server.md`）を通じて供給し、アナライザーは通しません。

プロンプト内の数値制限はプレースホルダーで、ランタイムに `config.memory.*` と `relationships.maxDeltaPerUpdate` から設定されます。

入力: `<character>` · `<existing_profiles>`（ユーザー ID 別の JSON。各プロファイルは全体またはコンパクト。全体プロファイルは散文フィールド、態度、関心・詳細・エイリアス・エピソードのランク付き上位を含む: 関心は `memory.maxInterests`、詳細は `memory.maxDetails`、エイリアスは `memory.maxAliases`、エピソードは `memory.analyzerEpisodes`（デフォルト 8）で制限。コンパクトプロファイルは `names`、`affinity`、`"compact": true` のみ。バッチが大きすぎて全プロファイルを全体で収められない場合、表示行数の多い著者が全体を保持し、残りはコンパクトになる。ログフィールド `profilesWhole`、`profilesCompact`、`profilesTokens` は `memory: update applied` に記録）· `<existing_lore>` ·
`<existing_guild>`（JSON: パターン、スターター、内輪ネタ、学んだ項目。サーバーノートがレビュー待ちの場合 `"stale": { "days": n }` を含むことがある）· `<existing_channels>`（チャンネル ID 別の JSON: `name`、Discord の `category`、`topic`、保存済みの
`purpose`、`topics`、`tone`。エントリはノートがレビュー待ちの場合 `"stale": { "days": n }` を含むことがある）· `<known_members>`（サーバーバッチのみ、プライベートバッチには含まれない。部分的または完全に欠落する場合あり: このバッチで書き込みをしていない保存済みメンバー。各メンバーの表示名とエイリアス付き。アナライザーがそのメンバーにエイリアスを記録できるようにする。最大 `memory.aliasRosterSize` 件、最近確認された順、`0` = オフ。バジェットではトランスクリプトより前にランクされ、必須ではないためリクエストを失敗させることはない）· `<new_messages>` は `## #channel-name (id:123)` の下にグループ化、行形式は
`[14:32] nick (id:123): text`、ペルソナ宛の行は `→ ` で始まり、自分の行には `labels.self` を使用。

ユーザーメッセージ内のセクション順（バジェットは下から先にトリム）: 全著者のコンパクトプロファイル、ロスター（`<known_members>`）、トランスクリプト（`<new_messages>`）、全体プロファイル（表示行のある著者のみ、行数の多い順）、最近のノート（`<recent_notes>`）。ギルド、チャンネル、ロアブロックはコンパクトプロファイルの前に配置。プロファイルが全体で収まらない場合はコンパクトで送信。プロファイルが原因でリクエストが失敗することはない。

出力: 素の JSON オブジェクト。プロファイルは**差分更新**されます。アナライザーは変更だけを返し、保存済みの再要約は行わないため、バッチごとの書き換えで事実が劣化しません:

```
{
  "users": { "<userId>": {
      "portrait": "",                                                // OPTIONAL: one-line cue that the stored character/style misses something
      "relationship": "",                                            // OPTIONAL: present when first written or when it must change, then the whole new text
      "aliases": { "add": [""], "remove": [""] },
      "interests": { "add": [ { "topic": "", "note": "", "sure": false } ], "update": [ { "topic": "", "note": "" } ],
                     "seen": [ "topic" ], "remove": [ "topic" ] },
      "details":   { "add": [ { "text": "", "sure": false } ], "seen": [ 3 ], "remove": [ 3 ] },   // numbers = stored detail ids
                                                                                 // "sure" is OPTIONAL everywhere, default true
      "affinity":  { "delta": 0, "reason": "" },
      "episodes":  [ { "date": "YYYY-MM-DD", "what": "", "quote": "", "feeling": "", "weight": 3 } ] } },
  "guild": { "patterns": "", "starters": "", "injokes": [""],
             "learned": { "add": [{ "text": "", "from": "<@id>" }], "seen": [3], "remove": [3] } },
  "channels": { "<channelId>": { "purpose": "", "topics": "", "tone": "" } },
  "lore": [ { "title": "", "keys": [""], "text": "" } ],
  "self": [""],
  "note_reviews": [{ "target": "", "status": "" }]
}
```

- **関心はアトミックな項目であり**、散文ではありません。`topic`（≤ `{{interestTopicChars}}`、アイデンティティ、大文字小文字を無視して比較）と `note`（≤ `{{interestNoteChars}}`、具体的に何が。空でも可）。両方のプレースホルダーは他の制限と同様に `memory.interestTopicChars` / `memory.interestNoteChars` から設定されます。メンバーごとに最大 `memory.maxInterestsStored` 件保存され、アナライザーが再び追加または更新すると重みが増加します。ランク最下位から削除されます。入力には保存済みの項目が表示されるため、アナライザーは新しいものだけを追加し、ノートは新情報があるときだけ更新し、本人が明確にやめたものだけを削除します。
- **詳細もアトミックな項目です**: `{ id, text, weight, firstSeen, lastSeen }`。入力には保存済みの各詳細が数値 `id` 付きで表示されます。`seen` と `remove` はその id で詳細を参照します（コードは保存された正確なテキストも受け付けます）。`add` は `{ text, sure? }` を受け取ります（単純な文字列も受け付けます）。`memory.maxDetailsStored` を超えると、ランク最下位から削除されます。
- **学んだ項目はギルドレベルのアトミックな項目です**: `{ id, text, from, weight, firstSeen, lastSeen }`。`from` は教えたメンバー（`<@id>`、または空）を保持します。詳細と同じ `add` / `seen` / `remove` 操作、同じ確定メカニズム、同じランクと削除ルールを適用します。`memory.maxLearned` 件が表示され、`memory.maxLearnedStored` 件が保持され、`memory.learnedChars` が項目ごとの文字数上限です。チャットモデルには `<about_chat>` 内の内輪ネタの行の後にランク順で表示され、未確定のものは `labels.aboutChat.unsureMark` 付きで表示されます。
- **確定（「(?)」メカニズム）、関心、詳細、学んだ項目に共通。** `weight` はその事柄が観測された個別の機会をカウントします。新しい項目は重み 1 で始まりますが、アナライザーが `"sure": false` をマークした場合は 0 です（誰のものか不明確、本気かどうか不明確、またはアナライザーが認識しない名前）。`seen`（新情報はないが再び話題になった）、既存項目への `add`、`update` はそれぞれ 1 回の目撃としてカウントされます。目撃が重みを 1 上げるのは、そのバッチ内のその人のメッセージが項目の `lastSeen` から少なくとも `memory.confirmGapHours` 時間離れている場合のみです（長い会話がバッチ分割されても 1 回とカウント）。既存項目への `"sure": false` 付きの操作は何も変更しません。項目は重みが `memory.confirmAfter` 以上で**確定**されます。それまではチャットモデルに `labels.profile.unsureMark` 付きで表示されます。
- **表示されるよりも多くが保存され、ランクは時間とともに減衰します。** コードはメンバーごとに最大 `memory.maxInterestsStored` / `memory.maxDetailsStored` 件の項目を保持します。ペルソナとアナライザーはランク上位の `memory.maxInterests` / `memory.maxDetails` 件だけを見ます。ランク = `log2(weight + 0.5) + lastSeen / halfLife`（半減期は `memory.interestHalfLifeDays`、`memory.detailHalfLifeDays`）。つまり重みは沈黙の半減期ごとに半分になり、頻繁かつ最近のものが上位に来ます。新規項目は削除されずに表示されない末尾で重みを蓄積できます。削除はランク最下位から行います。アナライザーが保存済みだが表示されていない項目を `add` した場合、コードは目撃としてカウントします。そのため、プロンプトはアナライザーに対してリストが一杯に見えるからといって控えず、新しいと思うものは何でも追加するよう指示します。
- **日付はメッセージから取得し**、時計からではありません。`firstSeen` / `lastSeen` は、目撃を発生させたバッチ内のその人の最新メッセージの時刻です（min / max。履歴が順序通りでなくても正しく動作します）。`lastSeen` が `memory.interestStaleDays` より古い関心は、チャットモデルに `labels.profile.staleMark` 付きで表示され、新しいものの後にソートされます。詳細は古くなりません。
- 保存済み項目の入力ビュー: 関心 `{ topic, note, seen, last }`、詳細 `{ id, text, seen, last }`（`seen` = weight、`last` = `YYYY-MM-DD`、不明の場合は省略）。
- **帰属、すべてのプロファイルフィールドに適用。** ある人物について記録されるのは、その人物自身のメッセージからのみです。本人が話題にする、繰り返す、実質のある発言をする場合です。他人のトピックにその場にいた、または一度返信しただけでは、その人のものにはなりません。ノートにはそのトピックについて言われたことだけを含めます。どのトピックまたはどの人物に属するか不明確な場合は、記録しないか `"sure": false` でマークします。サーバーの全員がやっていることは `guild.patterns` や `lore` に属し、個々のプロファイルには書きません。
- **各散文フィールドの定義。** `character`: その人が他者とどう振る舞うか、具体的な繰り返される習慣を数個（4–7 個）、ペルソナの声で記述する（「ラベルより習慣」: 形容詞の羅列や評価は決してしない）。スキル、知識、仕事、趣味、一度限りの行動はキャラクターではありません。保存済みの形容詞/評価テキストはバッチから書き直し、パッチしません。`character`、`relationship`、態度の `reason`、エピソードの `feeling` はカードに基づくペルソナの声で書きます（一人称可、臨床的な語彙は不可）。`style`: その人がどう書くか（長さ、リズム、語彙、絵文字の使い方）であり、何をするか、何について話すかではありません。`relationship`: 3 つだけ: ペルソナにとってこの人は誰か、ペルソナがこの人に対して何を感じているか、この人がペルソナについて何を言いそれをペルソナが気に入ったかどうか。3 つに関して明示的に裏付けられた意味のみ保持します。エピソード的な状況や無関係な事実は、範囲内の意味を保ちつつ除去します。行動だけから新しい役割や感情を推測しません。範囲内の意味を含む混合文は、その意味を保つよう書き直し、丸ごと削除しません。イベント、共同の活動、約束事、この人に関する事実は `episodes`、`details` または `interests` に属します。制限に迫られた場合、重要度の低い項目から丸ごと削除します。文を断片に短縮しません。保存済みテキストが空で、バッチでペルソナとこの人が実際にやり取りしている（または affinity/episodes がすでにある）場合に初回を書き、以降は 3 つのうちいずれかが変わったとき、または `relationshipStale` が設定されたときだけ返します。プロファイルに `relationshipStale` がある場合、テキストの書き直しが必要です。`writtenAt` はテキストが書かれたときの段階（テキスト未作成の場合は `none`）、`now` は現在の段階（`affinity.band`）、`cause` は `first`（テキスト未作成で非ゼロのスコア、理由またはエピソードがある）、`band`（段階が `relationships.bandHysteresis` を超えて変化）、`drift`（同じ段階内でスコアが `relationships.rewriteOnDrift` ポイント移動）、`moves`（テキスト記入後に少なくとも `relationships.rewriteAfterMoves` 件の態度履歴エントリ）、または `rewrite`（オーナーが設定する一度きりのフラグ。保存済みテキストをフィールドの範囲と完全文スタイルに書き直す。立場の変化は含意しない。ステージ A は空のブリーフを返してよく、ボイスモデルはそれでも書き直す）のいずれかです。コードは `relationship` が書かれるたびに `relationshipScore` と `relationshipWrittenAt` をプロファイルにスタンプし、段階とドリフトを比較して陳腐化を検出します。スイッチ: `relationships.rewriteOnBandChange`（デフォルト true、キー欠落 = オン）、`rewriteOnDrift`（デフォルト 8、`0` = オフ）、`rewriteAfterMoves`（デフォルト 6、`0` = オフ）。relationship テキスト ≤ `relationships.textChars`（デフォルト 600、プレースホルダー `{{relationshipChars}}`）；他の散文フィールド ≤ `memory.fieldChars`；フィールドが省略された場合、保存済みのテキストは変更されません。`character` と `style` は `profile.md`（ウォームアップとポートレートリフレッシュ）のみが書き込み、ストリームアナライザーは直接編集しません。アナライザーはバッチがそれを必要とする場合に `portrait`（保存済みテキストが見落としている点を示す一行のヒント）を返し、コードがリフレッシュをキューに入れます。
- **メンバーはニックネームではなく ID で参照します。** ニックネームは頻繁に変わるため、アナライザーが書くすべての自由テキストフィールド（プロファイル散文、関心のノート、詳細のテキスト、エピソードの `what`/`feeling`、態度の reason、`guild` フィールド、チャンネルノート、ロアブックの `text`、`self`）でメンバーは `<@id>` トークンとして記述します（id はトランスクリプトの `nick (id:123)`、`<existing_profiles>` または `<known_members>` から取得）。アナライザーが誰のことか確信している場合のみ使用します。そうでない場合は名前をそのまま記述します。id を創作しません。逐語的な `quote` とロアブックの `keys`/`title` はそのまま残します。コードは使用時にトークンを解決します。チャットモデルには `<@id>` がメンバーの現在の名前（トランスクリプトに表示されるのと同じ文字列、`@name` も機能します）になり、アナライザーには `name (id:123)` になります。入力時にはモデルが書いた `name (id:123)` をコードがトークンに戻し、不明な id はそのまま残します。
- **エイリアス**は、チャットの中で人々が実際にメンバーを呼ぶ名前（短縮形や翻訳名などの安定したニックネーム）であり、Discord の表示名ではありません。`users.<id>.aliases: { "add": ["…"], "remove": ["…"] }`。関心と同様にランク付き項目として保存されます（`memory.maxAliases` 件表示、`memory.maxAliasesStored` 件保持、`memory.aliasHalfLifeDays`）。既知のエイリアスの `add` は目撃としてカウントされます。入力ビューではプレーンなリストとして表示され、チャットモデルには `labels.profile.aliases` `{text}` を通じて表示されます。現在の名前またはエイリアスが直近のトランスクリプトに出現するメンバーは、発言していなくても `<people>` に含まれます。トリガーまたは直近 5 件のメッセージで（メンション、現在の名前、エイリアス、4 文字以上の名前のプレフィックスマッチで）参照されたメンバーは、発話者の次にフル表示されます（最大 `context.askedAboutProfiles` 件）。その他の最近の参加者はコンパクト形式（名前、エイリアス、キャラクター、態度、トップ 5 トピック）で続きます。バジェットはコンパクトな方から先にトリムします。
  `<known_members>` に含まれるメンバー（ロスターメンバー）には `aliases` のみ適用されます。回答内のその他のキーは破棄されカウントされます。ロスターメンバーにプロファイルが新規作成されることはありません（既に存在している必要があります）。提案されたエイリアスに対する保護（全メンバー、著者とロスター共通）: `<@` トークンまたは `(id:` マーカーを含む場合は破棄、メンバーの保存済み表示名と一致する場合は破棄（大文字小文字不問、句読点無視）。`aliases` の下の単純な配列（`{ add, remove }` ではなく）は、まだ保存されていない名前のみの追加として読み取られます（保存済みのエイリアスをバンプすることはありません）。ロスターメンバーのエイリアスの `firstSeen`/`lastSeen` 日付は、そのメンバー自身がメッセージを書いていないため、バッチ内の最新メッセージから取得されます。
- **メインチャンネルがポートレートの情報源です。** `memory.mainChannelIds`（デフォルト `[]`）は人々が互いに話すチャンネルをリストします。`<existing_channels>` でそのようなチャンネルは `"main": true` を持ちます（そうでない場合はキー省略）。`character` と `style` はメインチャンネルでその人が他者とどう話すかから判断します。日記やトピック特化チャンネルは関心と詳細を供給し、話し方は供給しません。その人のメインチャンネルメッセージがまだない間は、ポートレートは暫定的で短いものになります。その人のメインチャンネルメッセージを含むバッチでのポートレートリフレッシュは両フィールドを**洗練**します: 全体の新しいテキスト（≤ `memory.fieldChars`）を返し、まだ当てはまるものを引き継ぎ、バッチが示したものを追加し、新しい証拠が古いものより優先され、もう見られないものを削除します。こうしてポートレートは時間と共にその人を追いかけます。メインとマークされたチャンネルがない場合、すべてのチャンネルがメインとして扱われます。
- **サーバーレベルのノートはサーバーについてです。** ある人が自分のチャンネルでやっていることは `guild` のパターン、スターター、内輪ネタではなく、`lore` でもありません。内輪ネタは複数の人が使っているものです。
- **制限はカットなしで適用されます。** 記述された文字数制限を超えたプロースフィールドは保存されません。以前のテキストがそのまま残ります。コードはモデルの書き換えを短縮しません。プロンプトがモデルに制限を伝え、コードが正確な数値（コードポイント）で検証します。空のフィールドへの最初の書き込みのみ `memory.clampTolerance`（デフォルト 1.25）で制限まで切り詰められます。失うものがないからです。その場合、文または単語の境界で切り、`<@id>` トークンの途中では切りません。ストリームアナライザーはリトライしません。超過フィールドはそのバッチの書き込みから除外されカウントされます。ボイスモデル、ポートレートリフレッシュ、ノートリフレッシュは 1 回リトライします（`memory.overLimitRetries` が 0 を超える場合）。モデル自身の回答がアシスタントターンとして返され、続くユーザーターンに `<over_limit>` ブロックが含まれ、各超過フィールドの文字数と制限が記載されます。2 回目の超過では以前のテキストがそのまま残ります。途中で途切れた保存済みノートやテキスト（古いバージョンによるカット）は、その主題が次に話題になった際に全体を書き直します。
- **出力の簡潔さ。** `"sure"` は false のときだけ記述します。`affinity` は変更がないときは省略します。
- **ファクトの一元管理。** イベントは `episodes` か `lore` に、事実は `details` に、趣味は `interests` に、ペルソナへの教えは `learned` に入れます。同じことを複数のフィールドに書きません。
- **モデルの知識によるサニティチェック。** ある名前付きのものを別のものに紐付ける（地域、モード、キャラクター、アイテムをゲームに。人物をフランチャイズに）前に、アナライザーはそれらが実際に関連するか確認します。チャットの記述がモデルの知識と矛盾する場合、またはそのものを認識しない場合は紐付けず、そのものを単独で `"sure": false` として記録します。チャットの内容を「修正」することはしません。
- **ノートはその人がトピックについて何をしているかを記述します**（プレイしている、動画を見ている、言及しただけ）。その人がずっと前にやっていてやめたものは関心ではありません（せいぜい詳細）。周囲の会話なしには理解できないものは記録しません。
- 意図的に欠如: アイロニーやサーカズムに関するルール。あらゆる種類の不確実性は `"sure": false` で処理します。
- アナライザープロンプトは短く保ちます。ルールを追加するたびに、既存のテキストを引き締めて対価を支払います。
- 新しい内容があるユーザーとチャンネルのみ返します。返されたチャンネル / `guild` / `self` はマージ後の全体の値で、保存済みの値を置き換えます。空の `guild` / `self` = 新しい内容なし。チャンネルフィールド（purpose、topics、tone）の空文字列は無視され、保存済みテキストはそのまま残ります。
- **陳腐化ノートレビュー。** `"stale": { "days": n }` を含むチャンネルまたはギルドエントリには、トップレベルの `note_reviews` 配列にちょうど 1 つの項目が必要です: `{ "target": "<channelId>" | "guild", "status": "updated" | "confirmed" | "insufficient_evidence" }`。`updated` はバッチがコンテンツ変更を正当化し、通常の `channels` または `guild` 出力を通じて返されたことを意味します。`confirmed` はアナライザーがこのバッチの関連証拠に基づいて保存済みノートを調査し、変更の根拠がないと判断したことを意味します（バッチレベルのレビューであり、全期間の証明書ではありません）。`insufficient_evidence` はバッチに判断するための関連素材が少なすぎることを意味します。コードは `confirmed` と、保存済みテキストが実際に変更された `updated` に対してのみ `notesCheckedAt` をスタンプします（2 段階モードでは、`patterns`/`starters` のキューされたボイスブリーフが変更としてカウントされます）。`insufficient_evidence`、欠落した項目、テキストが同一の `updated` はスタンプしません。対象は `memory.notesRetryHours` 後に再びフラグされます。フラグごとに `notesFlaggedAt` がスタンプされます。
- `affinity` は変化量です: 整数の `delta`（通常 ±1…5、際立った出来事で最大 ±`relationships.maxDeltaPerUpdate`）と一行の `reason`（観測されたイベントを記述）。コードは ±`relationships.maxDeltaPerUpdate` にクランプし、−100…100 に累積し、短い履歴を保持します。モデルは絶対スコアを設定しません。`relationships.decayPerDay` が設定されている場合、スコアは毎日ゼロに向かってドリフトします。1 日あたり `decayPerDay * |score| * (|score| / 100) ^ decayPower` を失い、ゼロから遠いほど速くなります。負のスコアも同様にゼロへ向かいます。起動時と毎時、プロファイルのスタンプ `affinity.decayedAt` から整数日単位で適用され、ダウンタイムはキャッチアップされます。一時停止中とウォームアップ中は実行されません。履歴エントリは書き込まれません。
- `episodes` は追記のみで、書き直しません: 数か月間記憶に値する新しい瞬間だけを返します。侮辱、親切、約束、賭け、喧嘩、共有されたジョーク、ペルソナに何かを頼んだこと、または決してしないよう頼んだこと。`what` は 1 行。`quote` はその人自身の言葉を逐語的に、短く（≤ 120 文字）、または空。`feeling` はペルソナがどう受け取ったかをキャラクターカードを通じて判断。`weight` は 1–5（5 = 決して忘れない）。バッチごとにユーザーあたり最大 `memory.maxNewEpisodes` 件。ほとんどのバッチでは追加なし。入力には保存済みのエピソードが表示されるため、同じ出来事を二度記録しません。コードはメンバーごとに `memory.maxEpisodes` 件保持し、最も軽いものから、次に最も古いものから削除します。
- `lore` はサーバーのロアブックです: 会話を超えて残るもの、すなわちイベント（「X が去った日」）、繰り返し登場するキャラクターやペット、長期にわたるストーリー、対立、伝統。`title` はアイデンティティ（同じタイトルのエントリは更新であり、マージ後の全体テキストを持つ）、`keys` は 2–6 個の単語または短いフレーズで、そのことが話題になるとき人々が実際に入力するもの（名前、ニックネーム、ミームの文言、チャットの言語で、小文字）、`text` ≤ `lore.textChars`（`{{loreTextChars}}`）。入力の `<existing_lore>` には保存済みのタイトルとキーのリスト、およびバッチが触れるエントリの全テキストが表示されます。オーナーが追加したエントリ（`/nep lore add`）はアナライザーが変更しません。
- 文字列フィールド ≤ `memory.fieldChars`。詳細 ≤ `memory.maxDetails`、内輪ネタ ≤ `memory.maxInjokes`、self ≤ `memory.maxSelfFacts`。ノートはチャットの言語で記述します。観測された事実のみ。センシティブな情報（住所、電話番号、書類、健康、財務、本名）は記録しません。
- **`memory: update applied` のカウンター**（各バッチ後にログ出力）: `roster`（`<known_members>` に含まれたメンバー数）、`rosterCandidates`（バジェットに提供されたロスターエントリ数）、`rosterTokens`（送信されたロスターが使用した推定トークン数）、`aliasesChanged`（著者とロスターの中で保存済みエイリアスリストが実際に変更されたメンバー数）、`aliasOnly`（その中のロスターメンバー数）、`droppedUsers`（著者でもプロファイルを持つロスターメンバーでもない id のエントリ数）、`droppedFields`（ロスターメンバーのエントリから破棄された非 `aliases` キー数）、`portraitDropped`（著者の非空の `character`/`style` が破棄された数）、`notesFlagged`（このバッチで陳腐化フラグを持つチャンネルまたはギルドエントリ数）、`overLimit`（制限超過で拒否されたプロースフィールド数）、`overLimitFields`（`kind.field` 名の配列、例: `['channels.topics', 'guild.patterns', 'lore.text', 'users.relationship']`、メンバー id なし）。フラグが送信された場合、さらに: `notesUpdated`、`notesConfirmed`、`notesInsufficient`（3 つのレビューステータス）、`notesMissing`（モデルが返さなかったフラグ対象）、`notesIdentical`（テキストがストレージと一致した `updated`）、`notesUnflagged`（フラグされていない対象に返されたレビュー）。

`memory: voice applied` のカウンター: `overLimit`（リトライ後に拒否されたアイテム数、保存済みテキストが維持された）、`overLimitRetried`（`<over_limit>` ブロック付きで再送されたアイテム数）。リトライリクエスト自体が失敗した場合（不正な JSON、タイムアウト、プロバイダーエラー）、`retryFailed` に理由の文字列が入る。

### ポートレートおよびノートリフレッシュのオーバーフロー

ポートレートリフレッシュが制限を超える `style` または `character` テキストを生成した場合、同じリトライが実行される。2 回目の超過では `warmup: portrait refresh failed` に結果 `over-limit` と `fields`（超過フィールド名）が記録される。試行スタンプが設定され、その日のスロットは使用済み（リクエストは送信された）となるが、何も書き込まれない。

ノートリフレッシュ（リフレッシュモードの `channel.md` または `server.md`）がフィールド超過を生成した場合、同じリトライが実行される。2 回目の超過では `warmup: notes refresh failed`、理由 `over-limit`、`fields` にフィールド名が記録される。そのチャンネルまたはサーバーには何も書き込まれない。次の試行は `memory.notesRetryHours` 後。スケジューラーは次のターゲットに移行する。

### バージョン履歴

`features.versions` がオン（デフォルト）の場合、プロースフィールドのテキストが置換されるたびに、新しいテキストの保存前に以前のテキストが記録される。以前のテキストは `data/guilds/<guildId>/versions/<kind>/<id>.json` に格納される。`kind` は `users`、`channels`、`guild`（id `guild`）、または `lore`（id はエントリタイトルのスラッグと短いハッシュ）。各ファイルはフィールド名をキーとする JSON オブジェクトで、各値はレコードの配列（最新が最後）:

```
{ "<field>": [ { "at": "ISO", "by": "analyzer"|"voice"|"portrait"|"refresh"|"warmup"|"unknown", "chars": n, "before": n, "after": n, "kept": n, "removed": n, "added": n, "text": "<previous text>" } ] }
```

`before` と `after` は旧テキストと新テキストの文数。`kept` は両方に存在する文数。`removed` = `before - kept`、`added` = `after - kept`。8 文中 `kept` が 0 の書き換えは、モデルがテキスト全体を置換したことを意味する。フィールドあたり最大 `memory.versionsKept`（デフォルト 20）レコード。上限を超えると最も古いエントリが削除される。初回書き込み（フィールドが空）では何も記録されない。同一内容の書き換えでも何も記録されない。プライベートチャットの relationship テキストはバージョン管理されない。

`/nep memory forget` でメンバーのバージョンファイルを削除。`/nep memory wipe` でサーバーの `versions/` フォルダ全体を削除。

各レコードは `store: version recorded` として `kind`、`field`、`by`、`chars`、`kept`、`removed`、`added` と共にログ出力される（チャンネルバージョンにはチャンネル id、メンバー id は含まれない）。

## チャンネルマップ

`<server>` ブロックは保存されたチャンネルノートとコードが管理するファクトから構成され、このターンに関連するチャンネルだけにフィルタリングされます。現在のチャンネルが最初に表示され、`labels.server.currentMark` でマークされます。続いて、このターンで `<other_channels>` にメッセージを提供した隣接チャンネルのみがフル表示されます。その他の保存済みチャンネルはすべて除外されます。大規模サーバーではほとんどが無関係でバジェットの無駄です。

チャンネルエントリ（`src/memory/channels.js` の `renderChannel`）が持つ情報:

- **Discord ファクト:** 名前（`# ` 見出し）、カテゴリ、トピック。チャンネルが初めて確認された時点から存在します。
- **アナライザーノート:** 目的、トピック、トーン。ウォームアップ中に `channel.md` が書き込み、ストリームアナライザー（`memory.md`）がライブバッチから更新します。3 つともフリーテキストで、描画時にトークン解決（`<@id>` → 現在の名前）されます。
- **コードが管理するカウンター:** メッセージ数、最初と最後のメッセージのタイムスタンプ、30 日間のアクティビティヒストグラム（UTC 日ごとのメッセージ数、直近 30 日にトリム）、トップ 5 ライター（メッセージ数順、ボットとペルソナを除く）。ウォームアップがチャンネルのフェッチ済み履歴から `store.setChannelFacts` 経由で充填し、ライブトラフィックが `store.touchChannel` 経由で最新に保ちます。
- **アクティビティ判定:** `live`、`slow`、`dead`。カウンターから `channelActivity` が計算し、モデルの判断ではありません。今日と昨日（UTC）のメッセージ合計が `context.channelActivity.liveMessagesPerDay`（デフォルト 20）に達すると `live`。チャンネルにメッセージがないか、最新メッセージが `context.channelActivity.deadAfterDays`（デフォルト 7）日より古い場合は `dead`。その中間はすべて `slow`。`labels.server.activity` / `activityLive` / `activitySlow` / `activityDead` で描画されます。
- **最新メッセージの経過時間:** `labels.server.lastMessage` が存在しデータが利用可能な場合、人間に読みやすい形式で描画されます。
- **トップライター:** `labels.server.topWriters` で描画し、保存された作者 ID を現在の名前に解決します。プロファイルのない ID はスキップされます。

現在のチャンネルに保存済みノートがまだない場合（アナライザーが触れていない）、トランスクリプト内のメッセージの Discord ファクトからフォールバックエントリが合成されるため、ペルソナは自分がどこにいるか把握できます。

## ウォームアップ

各ウォームアップリクエストは一つの作業単位（一つのチャンネル、一人のメンバー、またはサーバー）を処理し、帰属を正確に保ちます。`channel.md` はチャンネルノート（目的、トピック、トーン）を生成します。`profile.md` はメンバーのキャラクター、スタイル、関心、詳細、エピソード、エイリアスを生成します。`server.md` はサーバー全体のパターン、会話の始め方、内輪ネタ、ロアブックを生成します。実行順序、サンプリング、進捗、制限、サブコマンドについては[ウォームアップ](warmup.md)を参照してください。

### データモデル

`character` と `style` は**自由記述のまま**で、`profile.md` のみが書き込みます: ウォームアップ時とポートレートリフレッシュ時です。ストリームアナライザーは編集しません。保存されたポートレートが見落としている、または矛盾している繰り返し見られる習慣や書き方の変化をバッチが示したメンバーについて、アナライザーは `users.<id>.portrait: "一行: ポートレートが見落としていること"` を返します。コードはそのメンバーのリフレッシュをキューに入れます。`profile.md` が `<draft>` = 保存済みの character + style、`<hint>` = アナライザーの一行で呼び出され、回答の `character` と `style` が保存済みのものを置き換えます（その回答の関心、詳細、エピソード、エイリアスは無視されます。これらはストリームの差分更新を通じて引き続き反映されます）。

メンバーは 2 つのパスのいずれかでポートレートリフレッシュの対象になります。カウンターパス: 前回のポートレート以降少なくとも `memory.portraitRefreshMessages`（デフォルト 300）件の自分のメッセージ、かつ `memory.portraitRefreshDays`（デフォルト 3）日以上経過。エイジパス: ポートレートが `memory.portraitMaxAgeDays`（デフォルト 21）日以上古く、かつ少なくとも `memory.portraitMinMessages`（デフォルト 60）件の自分のメッセージが蓄積。キュー順: 最も長く待っているメンバーが先（`portraitDueAt`: メンバーが初めて対象になった時にスタンプされ、ポートレート完了でクリア）、次にポートレートが最も古い、次に自分のメッセージ数が最多。プロバイダーエラー（リクエスト送信後の HTTP 408/429/5xx またはタイムアウト）はその日のスロットを返却し、前回の試行スタンプを復元するため、メンバーは対象のまま残ります。スケジューラーはそのティックのサイクルを終了します。

態度と `relationship` はウォームアップされません。ライブ会話からのみ蓄積されます。

`profile.md` の出力: `{ "character": "", "style": "", "interests": [{ topic, note, times }], "details": [{ text, times }],
"episodes": [...], "aliases": [""] }`。ブロック `<character>` `<member>` `<draft>`（任意）`<hint>`（任意、ポートレートリフレッシュ時のみ）`<snippets>`。スニペット内の本人の行は `labels.warmup.ownMark` で始まり、コンテキスト行は `labels.warmup.contextMark` で始まります。エイリアスは他の人の行（その人をどう呼んでいるか）から得られるため、本人の行の帰属ルールは適用されません。エイリアスの証拠として、明示的に名前を示す発言が一つあれば十分です。からかいで一度だけ言われた名前はエイリアスにはなりません。

## アドレス分類器

ペルソナが誰かに応答した後、そのチャンネルで会話ウィンドウが開きます（`mention.followUpMinutes`、応答ごとに延長）。ウィンドウ内でトリガー（メンション、ペルソナへのリプライ、名前）を持たないメッセージは無条件には応答されません。コードはチャンネルの直近 `mention.followUpContext`（デフォルト 15）行を送信します。ペルソナ自身の行は `labels.self` でマーク、新しいメッセージは `<candidate>` としてマークされ、`address.md` に `classifier.text` モデルロール（デフォルト `anthropic/claude-sonnet-4.6`）で送信されます。出力は 1 語: 候補がペルソナに話しかけているか、ペルソナとのやり取りを続けている場合は `yes`、人々がペルソナについて他の相手や部屋に向かって話している場合は `overheard`、会話がペルソナに無関係な場合は `no`。別のメンバーへの明示的な @メンションは、モデルに尋ねる前に常に `no`。返信先の著者に Discord が付加する暗黙のピングはそのようなメンションとして扱いません。`mention.followUpClassifyReplies` がオン（デフォルト `true`、キー欠落 = オン）のとき、別のメンバーのメッセージへのリプライは通常のテキストと同様に分類器に送られます。スイッチオフの場合、別のメンバーへのリプライは自動的に `no` です。`mention.classifyWhileBusy` がオン（デフォルト `true`、キー欠落 = オン）のとき、ターン実行中に届いたフォローアップ候補は同じウィンドウ、no-streak、プレフィルターのチェックを経て分類器に送られます。チャンネルあたり同時に最大 1 件の分類器呼び出しで、より新しい保留行が古いものを置き換えます。スイッチオフの場合、または `mention.pendingSameChannel` がオフで候補自身のチャンネルがビジーの場合、候補は分類されません（`yes` はどのみちドロップされます）。各呼び出しは `llm.maxRequestsPerDay` の `classifier.text` リクエスト 1 件です。ビジー状態のターンに出くわした `yes` は保留キューで待機します（ログ `follow-up: deferred`）。キューにはチャンネルごとに 1 件の保留フォローアップが保持され、より新しいものが古いものを置き換えます（ログ `follow-up: dropped`、reason `newer`）。アテンションが空くとメンションと同じチェック（期限切れ、スイッチ、一時停止、送信権限、メッセージの存在）に加え 2 つの独自チェックを経てピックアップされます（`follow-up: picked up`）: そのチャンネルと著者のフォローアップウィンドウがまだ開いていること（`mention.followUpMinutes` と no-streak）、さもなくばドロップ `closed`、およびその行がそのチャンネルで応答済みのターンの履歴に含まれていないこと、さもなくばドロップ `answered`。これらのチェックを通過した保留フォローアップも、即時のフォローアップと同じく呼びかけとしてカウントされ、`mention.followUpIgnoreChance` で無視確率のロールを受けます。`mention.pendingOverheard` がオン（デフォルト `true`、キー欠落 = オン）の場合、ビジー状態のターンに出くわした `overheard` はドロップされず保留キューで待機し、現在のターン終了後にペルソナが反応します。待機中のフォローアップは後の overheard 行に押し出されません。待機中の overheard 行は後のフォローアップ、後の overheard 行、または直接メンション、リプライまたは名前呼びかけに押し出されます。待機中の overheard 行はスパム上限にカウントされず、チャンネルで待機中の呼びかけとして他のターンに報告されません。スイッチオフの場合、`overheard` はドロップされます（`busy`）。

`yes` は、無視確率のロールで無視されなければ、トリガー種別 `followUp` のリプライモードターンを実行します。タスクテキストは `prompts/follow-up.md`（存在しない場合は `reply.md` にフォールバック）で、`yes` が出ても応答するとは限りません。フォローアップはメンションと同じく著者の呼びかけとしてカウントされ、ロールは `mention.ignoreChance` の代わりに `mention.followUpIgnoreChance`（デフォルト `0`）から始まります。リピートペナルティ、スパム判定、態度による補正は他の呼びかけと同様に適用されます。無視されたフォローアップはログ `mention: decided`、reason `ignored:follow-up` で記録され（著者の直近の呼びかけがリピートやスパムに当たる場合は `ignored:repeat` または `ignored:spam`）、ウィンドウとその no-streak は変わりません。`overheard` はトリガー種別 `overheard` のリプライモードターンを実行します。タスクテキストは `prompts/overheard.md`（存在しない場合はモードプロンプトにフォールバック）、発話者のプロファイル見出しに `interlocutorMark` なし、プレーン投稿、リピートペナルティ非対象、無視確率のロールなし、レール拒否時のリミット通知なし、検索・再視聴分類器なし、描画は非リクエスト扱い（画像上限通知なし、ユーザー別画像カウントなし、`drawFailed` フォローアップなし）。`mention.followUpOverheard` がオフの場合、`overheard` 回答は通常のフォローアップターンとして開始されます（ログには `answer: 'overheard'` が記録されます）。`overheard` 判定時にクラシファイアコール中に新しいメッセージが保留されていた場合、保留メッセージが先に分類されます: `yes` ならそのためのフォローアップターン、`overheard` なら保留メッセージの `overheard` ターン、`no` なら元の候補の `overheard` ターンが開始されます。

3 回連続の `no`（`mention.followUpNoStreak`、デフォルト 3）でウィンドウが閉じます。`overheard` は連続判定では `yes` としてカウントされます。スイッチ `features.followUp`（デフォルトオン）。カウント、判定、`follow-up: verdict` の `answer` がログに記録されます。
ウィンドウの状態は再起動後も維持されます。アクティブなウィンドウは `data/state.json` の `followUpWindows` に保存され、起動時に復元されます。期限切れのウィンドウは削除されます。

## 再視聴分類器

ペルソナに直接話しかけられた（リプライターン、`overheard` や自発的ターンではない）とき、チャンネルの直近 `media.video.rewatch.recentMessages`（デフォルト
60）件のメッセージに動画や画像がある場合、分類器がそのメッセージがそれらのアイテムについて質問しているか、画像の具体的な詳細を主張しているか、または読み込めなかった
動画のリトライを求めているかを判定します。候補: 視聴済み動画、エラー状態の動画、説明済み画像（添付画像、ペルソナ自身のアップロードを含む。貼り付けられた画像リンクは除外）。画像は `features.vision` がオンの場合のみ提供されます。分類器には最大
`media.video.rewatch.maxCandidates`（デフォルト 6）件のアイテムが渡されます。動画が先、画像が後、各種類内で新しい順です。コードは `rewatch.md` を
システムプロンプトとして `classifier.text` モデルロール（デフォルト `anthropic/claude-sonnet-4.6`）に送信し、
ユーザーメッセージに 3 つのブロックを含めます: チャンネルの直近数件のメッセージを含む短い `<transcript>`（ペルソナ自身の行は `labels.self` でマーク、分類器が候補の返信先を把握できるようにする）、続いてメディアリストと候補:

```
<transcript>
...
</transcript>
<media>
<number> | <kind> | <name> | <status> | <キャプションまたは説明の冒頭>
...
</media>
<candidate>
<著者名>: <トリガーテキスト>
</candidate>
```

各 `<media>` 行には `|` 区切りの 5 列: 連番（1 = 種類グループ内で最新のアイテム）、種類（`video` または `picture`）、アイテム名、
ステータス（動画の場合 `watched` または `not loaded`、画像の場合 `described`）、サマリーまたはキャプションの先頭 200 文字（読み込めなかった動画は空）。名前とサマリーは空白が正規化されて 1 行に。トリガーテキストは
`context.maxMessageChars` で切り詰め。出力は 1 行:

- `<number> | <question>`: メッセージが視聴済み動画または説明済み画像について質問しており（確認が必要な主張された詳細を含む）、説明でカバーされていない詳細を必要とする。番号はリストからそのままコピーする。
- `<number> | retry`: メッセージが読み込めなかった動画について、再試行を求めるかその内容を質問している。番号はリストからそのままコピーする。リトライは動画のみに適用。
- `none`: 再視聴もリトライも不要。

動画の質問でヒットした場合、動画モデルが `rewatch-answer.md`（`{{question}}` と `{{maxChars}}` =
`rewatch.answerChars`、デフォルト 1200）でクリップを再度視聴し、回答は `transcript.videoAnswered`（`{question}`、
`{text}`）として視聴済みタグの後にトランスクリプトに追加されます。

画像の質問でヒットした場合、ビジョンモデル（`classifier.media`、`purpose: relook`、プロンプト `rewatch-answer.md`、種類を問わず共用）がその質問で画像をもう一度見ます。回答はキャプションとして保存されず（1 時間キャッシュ）、トランスクリプトは画像の行の下に `transcript.imageAnswered`（`{question}`、`{text}`）を運びます。

`<senses>` ブロックには機能が有効な場合に `senses.videoRewatch` が含まれます。

リトライでヒットした場合、動画モデルが `force`（エラーキャッシュを無視）でクリップを視聴します。初回視聴と同じ
`describeVideo` パスを使用します。リトライが成功すると、動画のステータスがエラーから視聴済みに変わり、トランスクリプト
にはサマリーがファーストハンドとして表示されます。リトライは `media.video.maxPerTurn` と `media.video.maxPerDay` に
対する新しい動画試行としてカウントされます。

制限: ターンあたり最大 1 回の再視聴またはリトライ。分類器と再視聴はそれぞれ `llm.maxRequestsPerDay` にカウントされ
ます。再視聴は `media.video.maxPerDay` にもカウントされます。`media.video.rewatch.maxPerDay`（デフォルト 20）は
動画再視聴と画像リルックの両方を制限します（共有カウンター）。回答は質問ごとに 1 時間キャッシュされます（上記の動画キャッシュセクションを参照）。スイッチ
`features.videoRewatch`（未設定 = オン、`videoDescriptions` が必要）。スイッチ `features.imageRelook`（未設定 = オン、`vision` が必要）。

## 検索およびリコール分類器

ペルソナに直接話しかけられた（リプライターン、`overheard` や自発的ターンではない）とき、`lookup.md` プロンプトが存在する場合、分類器がトリガーにウェブ検索、サーバー履歴検索、またはその両方が必要かを判定します。コードは `lookup.md` をシステムプロンプトとして `classifier.text` モデルに送信し、ユーザーメッセージに短い `<transcript>`（再視聴分類器と同じもの、ペルソナ自身の行は `labels.self` でマーク）と `<candidate>` ブロックを含めます:

```
<transcript>
...
</transcript>
<candidate>
<著者名>: <トリガーテキスト>
</candidate>
```

トランスクリプトには利用可能な場合、説明文、動画サマリー、リンク読み取りが含まれます。トリガーテキストは `context.maxMessageChars` で切り詰め。出力は `none`、または最大 4 行のラベル付き行（順不同）:

- `web: <検索クエリ>`（プレーンワード、引用符なし、演算子なし、最大 12 語）: メッセージがチャット外の事実を必要とする場合、またはウェブ検索を明示的に依頼された場合。`features.webLookup` がオン、`web.search.enabled` が false でない、`web.search.maxPerTurn` が 1 以上、`BRAVE_SEARCH_API_KEY` が設定されている場合のみ発火。
- `server: <フォーム>, <フォーム>, ...`: メッセージがこのサーバーで言われたことや行われたことについてで、トランスクリプトにない場合。各フォームは人々が実際に入力するような 1 語または短いフレーズで、活用形を列挙。`features.recall` がオンの場合のみ発火。
- `who: <名前フォーム>, <名前フォーム>, ...`: 質問がトランスクリプトに明示的にいない人物についての場合。ニックネーム、ユーザー名、タグで見つけるためのフォーム。
- `when: <from> .. <to>`: 質問が時間を指していう場合（`..` の各側に `YYYY-MM-DD` または `YYYY-MM-DD HH:MM`。日付単体はその日全体）。

ラベルなしの 1 行（旧フォーマット）はウェブクエリとして読み取られます。空白の回答は失敗した呼び出し（`reason: empty`）であり、`none` ではありません。

`web:` ヒット時、Brave Search がクエリを実行し（`web.search.results` 件の結果、デフォルト 5）、番号付きの結果が `classifier.text` を通じて `search-summary.md`（`{{today}}`、`{{query}}`、`{{maxChars}}` = `web.search.summaryChars`、デフォルト 900）で要約され、ウェブパートが `<lookup>` ブロックに描画されます: `labels.lookup.header` にクエリ、要約テキスト、`labels.lookup.sources` にサイト名（重複排除済み）。検索が何も返さなかった場合、または要約が有用な内容を見つけなかった場合は `labels.lookup.none` が代わりに表示されます。

`server:` ヒット時（オプションの `who:` と `when:` 行付き）、エンジンは Discord の検索 API でサーバーのメッセージ履歴を検索します。フォームは順序付きの検索クエリリストになり（コンテンツフォームのラウンドロビン、次に著者名）、`when:` のみの場合は日付範囲のサンプルになります。ヒットはフィルター（他のボットとオーディエンスルールが拒否するチャンネルは除外）され、チャンネルと時間（`recall.clusterGapMinutes`）でクラスター化され、トピックスコア（クラスターにヒットがある各 `server:` フォーム、サーバー全体で `recall.rareHits` 以下のヒット数なら 2、それ以外は 1 を加算）、次に全異なるクエリ数、次に新しい順でランク付けされ、上位 `recall.maxClusters` が保持されます。名前・著者のヒットのみのクラスターはトピックヒットが 1 つでもあるクラスターより下位です。`recall.keepOldest` はトピックスコアが 2 以上の最古のクラスターにスロットを予約。保持された各クラスターの周辺で `recall.windowMessages` 件のメッセージがフェッチされます。分類器のワードフォームとネームフォームは保存済みメモリ（プライベートレイヤーは対象外）とも照合: メンバーのエピソード、ロアエントリ、学んだレッスン、最近の行。一致する各項目は `<memory>` ブロックの 1 行になります: `kind | date | name | text`、種類は `episode`、`lore`、`learned`、`recent`。`when:` の日付範囲は日付のない種類（lore、learned）を除外。最大 `recall.memoryItems`（デフォルト 6）項目、一致するフォーム数と重みでランク付け。`<memory>` ブロックは `<people>` の後 `<found>` の前に配置。メモリのマッチがあってチャットヒットがない場合でもサマリーに問い合わせます。`recall: searched` 行の `stats.memory` としてログ。

サマリーヘルパー（`recall-summary.md`、`classifier.text`、ブロック `<people>`、`<memory>`、`<found>`、`<question>`）がウィンドウ、保存済みメモリ、質問を読み、ノートを書きます。サマリーが 1 つのストレッチを指定した場合（`stretch: <n>`）、そのストレッチの原文行（`recall.stretchChars` で制限）がノートと共に表示されます。サマリーが `nothing` の場合、`<lookup>` ブロックにサーバーパートは含まれません。サマリーの失敗またはタイムアウトの場合、上位ウィンドウの原文ストレッチがノートなしでフォールバックとして返されます。

両方のウェブとサーバー検索が実行された場合、`<lookup>` ブロックには `labels.lookup.webHeader`（ウェブパートの上）、`labels.lookup.serverHeader`（サーバーパートの上）、`labels.lookup.bothNote`（その間）が含まれます。

`<lookup>` ブロックは `<other_channels>` と同じオーディエンスルール（`context.pull.sameAudience`）に従います: ソースのチャンネルが送信先の全閲覧者に読めない場合、そのサーバー検索ウィンドウは拒否されます。

制限: ターンあたり最大 1 回のウェブ検索と 1 回のサーバー検索。分類器、ウェブ要約、リコールサマリーはそれぞれ `llm.maxRequestsPerDay` にカウント。ウェブ検索は `web.maxPerDay`（リンク読み取りと共有）にカウント。リコール実行は `recall.maxPerDay`（`state.json` に `recallDay` / `recallCount` として保存）にカウント。ウェブ結果は正規化されたクエリごとに `web.search.cacheHours`（デフォルト 24）時間キャッシュ。分類器は `features.webLookup` または `features.recall` のいずれかがオンの場合に発火。スイッチ: `features.webLookup`（未設定 = オフ）、`features.recall`（未設定 = オン）。

## タスクスプリッター

直接呼びかけ（メンション、リプライ、名前、フォローアップ、プライベートメッセージ）が十分に長く構造化されている場合（`split.minChars` 文字、リンクと Discord トークンを除外、少なくとも 2 つのセパレーター区間）、ターンの準備と並行して分類器（`prompts/split.md`、`classifier.text`、目的 `split`）に渡されます。分類器は直近 `split.contextMessages` 件のメッセージの短い `<transcript>`（ペルソナ自身の行は `labels.self` でマーク）を読み、新しいメッセージを `<candidate>`（`<著者名>: <テキスト>`）として受け取ります。回答は `one` という語、または 2 行から `split.maxTasks`（デフォルト 4）行で各行 `- ` で始まり著者自身の言葉でパートを示します。パース後、`split.minPartChars`（デフォルト 20）文字より短いパート（リンクと Discord トークンを除外、`minChars` と同様）は次のパートに統合されます（最後のパートは前のパートに統合）。残りが 2 未満になると 1 つのリクエストとして扱われます（`folded`）。空、パースできない、または遅延した回答（ターンの準備が先に完了）は 1 つのリクエストとして扱われ `split: failed` としてログされます。スイッチ `features.splitTasks`（未設定 = オン）。

パートは同じメッセージに対する通常のターンのチェーン（`turn: part`）となります。各パートのヘルパー（検索分類器、リコール、ルートフック、再視聴）はそのパートのテキストを判定し、リクエストにはパートと残りが示されます（`labels.task.part`、`{index}`、`{total}`、`{part}`、`{others}`）。最初のパートはメッセージ全体のターンが取得した履歴を再利用しメッセージにリプライ。後のパートは履歴を新たにフェッチしプレーンで投稿。各パートには独自の期限とドロップバーがあります。失敗または拒否されたパートは次のパートを止めません。無視ロール、プライベートの日次上限、リングのスタンプはメッセージごとに 1 回カウント。一時停止またはウォームアップはチェーンの次のパートの前に終了します（`turn: chain stopped`）。チェーン実行中、未開始のパートはその著者の待機中の項目（ターンランナーの `waitingParts`）です。後のメッセージがそのいずれかに統合（`addToPart`）された場合、そのパートのリクエストに `tasks.added` で届きます。アテンションは最初のターンから最後まで保持され、アイドル通知は最後に 1 回発火します。

`prompts/split.md` がない場合、スプリッターはオフ（`split: skipped`、`no-prompt`）。`labels.task.part` がない場合もオフ: パースされた回答は破棄されます。設定: `split.minChars`（デフォルト 80）、`split.minPartChars`（デフォルト 20）、`split.maxTasks`（デフォルト 4）、`split.contextMessages`（デフォルト 6）、`split.maxOutputTokens`（デフォルト 300）。

## マージ分類器

呼びかけが届いた著者がそのチャンネルに待機中の項目をすでに持っている場合（分割メッセージのチェーンがまだ到達していないパート、または保留リストのキューされた呼びかけ）、分類器（`prompts/merge.md`、`classifier.text`、目的 `merge`）が新しいメッセージがそのいずれかに属するかを判定します。分類器は番号付きの `<waiting>` ブロック（`1. <テキスト>`、待機中の項目ごとに 1 行）と新しいメッセージを `<candidate>`（`<著者名>: <テキスト>`）として読み取ります。回答は 1 行: 待機リストの番号または `new` という語。統合されたメッセージは独自のターンを持ちません。その項目のターンで `labels.task.added`（`{added}`）を通じて表示されます。ルーティングされた呼びかけには統合されません。プロンプトファイルがない場合、すべての呼びかけは独自の項目としてキューされます（`merge: failed`、`no-prompt`）。ログ: `merge: verdict`、`merge: failed`。独自の設定はなく、出力上限は `mention.followUpMaxOutputTokens`。

## 描画

ペルソナは描画サブプロセス（`features.imageGeneration`、デフォルトオン）を通じて画像を生成できます。モデルが `<draw>` タグを出力すると、`src/behavior/turn.js` が `draw.md` からイメージプロンプトを組み立て、OpenRouter Images API（`src/llm/images.js`）を通じて 1 枚の画像を生成します。画像はペルソナのテキストメッセージの後に独立したメッセージとして投稿され、インラインにはなりません。

### プロンプトの組み立て

`buildDrawPrompt`（`src/behavior/prompt.js`）が `draw.md` を 3 つのプレースホルダーで埋めます:

- `{{name}}` — ボットの表示名。
- `{{appearance}}` — `{{name}}` を埋めた `appearance.md`。`self="yes"` の場合のみ含まれ、それ以外は空。
- `{{request}}` — `<draw>` タグのシーンテキスト。`image.maxPromptChars`（デフォルト 800）でクランプ。

描画サブプロセスはキャラクターカード、`rules.md`、システムプロンプトを一切受け取りません。`draw.md` 内の独自のスタイルセクションに従います。

### リファレンス

ペルソナが画像に含まれ（`self="yes"`）、`image.reference` が `'avatar'`（デフォルト）の場合、ボットの Discord アバターがダウンロードされ `input_references` エントリとして送信されます。アバターの取得に失敗した場合はリファレンスなしで生成が続行されます。

### 感覚

`<senses>` ブロックには、イメージクライアントが接続され `features.imageGeneration` が false でない場合に描画行が 1 行含まれます:

- `senses.draw` — ペルソナは描画できる。
- `senses.drawSpent` — 日次クォータ（`image.maxPerDay`）が使い切られた。
- `senses.drawSpentUser` — このメンバーの日次クォータ（`image.maxPerUserPerDay`）が使い切られた。

`senses.draw` のない古い `labels.json` では何も表示されません。

### 失敗ターン

誰かが依頼したターン（メンション、リプライ、名前トリガー、フォローアップ。`overheard` や自発的ターンではない）で生成が失敗した場合、2 回目のターンが自動的に発火します:

- `triggerKind: 'drawFailed'`、失敗理由が `labels.draw.reasons.*` を通じて `labels.triggers.drawFailed` の `{reason}` プレースホルダーにレンダリングされます。
- モードは `reply`、同じトリガーメッセージ、リプライ可。
- 2 回目のターン自体の `<draw>` は無効化されるため、モデルは生成をリトライできません。
- チャンネルのアイドル通知は 2 回目のターンが終了するまで保留されるため、保留中のピングはフォローアップの後にのみ処理されます。

自発的または `overheard` ターン（誰も依頼していない）では、失敗はログに記録されるだけでフォローアップは実行されません。

画像上限（`ImageCapError`、理由 `daily` または `userDaily`）は失敗ターンを発火しません。代わりにリミット通知（`labels.limits.notice`）をプレーンリプライとして投稿します。`draw.reasons.daily` と `draw.reasons.userDaily` は `labels.json` に予約されていますが、`triggers.drawFailed` 経由では到達しなくなりました。

### 制限

- ターンあたり `<draw>` は 1 つ。最初の非空が優先、`image.maxPromptChars`（デフォルト 800）でクランプ。
- `image.maxPerDay`（デフォルト 50）と `image.maxPerUserPerDay`（デフォルト 50）はリクエスト前にチェックしカウント。上限エラーは `ImageCapError`（理由 `daily` または `userDaily`）。
- サポートされないモデルファミリー（`openai/*` でも `google/*` でもない）は `UnsupportedImageModelError` で拒否。
- 生成失敗は `ImageGenError`（理由 `moderation`、`timeout`、`error`、`empty`）。
- 一時的な HTTP エラー（408、429、5xx）とネットワーク障害は `image.retries`（デフォルト 1）回までリトライ。
- モデレーション拒否（HTTP 400/403 + モデレーションマーカー）はリトライされない。
- ログにはモデル、カウント、コスト、失敗理由が記録され、プロンプトは含まれません（メンバーを引用する可能性があるため）。
- ドライランでは完全なイメージプロンプト（プロンプトファイル + ペルソナのリクエスト）がログとミラーに記録されますが、何も生成されません。

## 日記

`features.diary`（デフォルトオン、ただし `diary.channelId` なしでは何も動かない）。ペルソナがオーナーの選んだチャンネルに、`bot.timezone` のウィンドウからランダムな時間に自発的に投稿する。各投稿は 2 つのモデルリクエスト: 計画ステップと生成ステップ。計画がウェブ検索を要求すると 3 番目が追加される。

2 つのリクエスト、計画 JSON の形式、バリデーションとフォールバック、出力ルール、`{{when}}` プレースホルダー、記録、データファイル、バックフィル、サーバーマップでの表示、ログの詳細は英語版 `docs/en/prompt-contract.md` の「Diary」セクションを参照。

ログ: `diary: plan`、`diary: planned`、`diary: due`、`diary: post`、`diary: skip`（理由: `no-channel`、`off`、`paused`、`warmup`、`not-writable`、`cap`、`grace`、`busy`）、`diary: backfill`、`diary: plan failed`、`diary: search failed`、`diary: backfill failed`。

## プライベートチャット

`features.privateMessages`（デフォルトオフ）で、サーブしているギルドのメンバーが Discord ダイレクトメッセージでペルソナと会話できます。ペルソナは同じキャラクター、同じ公開メモリ。DM で話された内容はメンバーごとのプライベートレイヤーに保存され、他の会話には一切見えません。

### ゲート

DM は以下のすべてが満たされた場合にのみ応答されます（トークンゼロでローカルチェック）:

1. `features.privateMessages` が `true`。
2. 送信者がサーブしているギルドのメンバー。
3. ペルソナが送信者の公開プロファイルを保持している。
4. 公開 `affinity.score >= private.minAffinity`（デフォルト 5）。ボットオーナーはこのチェックをバイパス。
5. 本日のリプライ数がキャップ未満（オーナーは `private.maxPerOwnerPerDay`、それ以外は `private.maxPerUserPerDay`）。

5 で日次キャップに達した場合のみ、1 日 1 人 1 回のリミット通知（`labels.limits.notice`）が投稿されます。

### DM ターンの内容と省略

- `<server>`（チャンネルマップ）と `<other_channels>` は省略。
- `features.privateLikeServer` がオン（デフォルト `true`、キー欠落 = オン）の場合、チャンネルルート分類器、チャンネルプル、サーバー検索（recall）が DM で動作する。チャンネルは DM パートナーがそのチャンネルの View Channel 権限を持つ場合のみプルされる（`context.pull.sameAudience` はこれを緩和しない）。recall 検索もチャンネルごとに同じパートナールールを適用する。DM で言及されたメンバーのエピソードが表示される（`context.askedAboutEpisodes`）。DM にプルされたものはサーバー上で既読や回答済みにならない。スイッチがオフの場合、ルート、プル、recall、言及メンバーのエピソードなし。
- `prompts.private`（存在する場合）がモードプロンプト（`reply.md`）の後、`forced.md` の前に追加。`{{name}}` と `{{author}}` が設定される。
- `{{trigger}}` は `labels.triggers.private` から取得。
- `<senses>` に `senses.privateChat` が含まれる。
- サーバーターンでは、`features.privateMessages` がオンの場合、`<senses>` に `senses.privateAware` が代わりに含まれる。
- 対話相手のプロファイルは `mergeProfiles(publicProfile, privateProfile)`。他のプロファイルは公開のみ。

### プライベートレイヤー

`data/guilds/<guildId>/private/<userId>.json` に DM で学んだ内容を保存。独自の `relationship`、`interests`、`details`、`episodes`、`affinity`（初期スコア 0）を持つ。DM でペルソナは公開とプライベートデータの結合を見る: インタレストはトピックで結合（プライベートノートが優先）、ディテールは連結、エピソードは日付順、`relationship` は段落結合。

### DM でのアフィニティ

公開スコアはサーバーバッチからのみ変化。プライベートレイヤーは独自のスコア（初期 0）を持ち、DM バッチからのみ変化。DM でペルソナが感じるのは `clamp(公開 + プライベート, -100, 100)`。サーバーでは公開スコアのみ。ゲートは公開スコアのみを使用。

### プライベートモードのアナライザー

`analyzePrivate` は同じ `memory.md` フォーマットに `<private>` ブロック（`labels.memory.privateNote`）を加えたリクエストを構築。`<existing_profiles>` にはパートナーのみ。回答からは `users[<partnerId>]` のみがプライベートストアメソッドで適用。`portrait`、`aliases`、`guild`、`channels`、`lore`、`self` は破棄。

## Mentor

手動サブプロセス（`features.mentor`）で、独自モデル（`mentor.model`）を使用します。オーナーがケース（ペルソナに期待する行動）を追加し、mentor がチャット状況を作成、サンドボックスでペルソナに回答させ、スコアリングします。不合格またはスコアが低い場合、ペルソナのコンテキスト内の原因を特定し、オーナーが検討する助言として変更を提案します。同時実行は 1 つのみ。すべての作業は `data/` に保存されます。`bot.dryRunChannelId` が設定されている場合、完了したランはそこにも投稿されます。管理チャンネルがない場合、オーナーは `/nep mentor status` でランを追跡し、`/nep mentor show <id>` でレポートを読みます。

### プライバシー

Mentor モデルはレンダリングされたサンドボックスリクエストを読み取るため、ペルソナが実際の人物について記憶している内容を読み取ります。ダイレクトメッセージとプライベートメモリレイヤーはサンドボックスリクエストに含まれません。

サンドボックスにはライブターンと同じカスタム絵文字と GIF のブロックが含まれるため、ペルソナはサンドボックスの回答で絵文字リアクション、GIF の投稿、画像の描画が可能です。GIF や描画は `<msg>` と同様にアクションとしてカウントされます。サンドボックスには elsewhere の送信先と検索感覚の `<senses>` 行も含まれるため、これらの機能に対するペルソナの認識もテストされます。

### ポストレジャー

`state.json` の `postLedger` はペルソナがサーバーチャンネルに投稿した各メッセージを記録します: メッセージ ID、チャンネル、モード、トリガー種別、トリガー ID、最新の履歴行 ID、ソースチャンネル ID。`features.mentor` がオン（または mentor のアンカー関連パスが使用されている）間のみ書き込まれます。レジャーは `mentor.anchor.ledgerSize`（デフォルト 300）エントリで制限されます。mentor はこれを使って、実際の moment を解決する際に投稿されたメッセージがどのターンに属していたかを特定します。mentor 自身のリクエストは使用ログに `origin: mentor` を付けます。

### ランの終了方法

ランは通常、判定とレポートで正常終了します。早期終了もあります:

- **停止** (`budget`): 日次トークン予算が枯渇。スイッチと予算は各状況の前と各 mentor リクエストの前にチェックされます。
- **停止** (`owner`): オーナーが `/nep mentor stop` または `/nep pause` を実行。
- **停止** (`disabled`): ラン中に `features.mentor` または `mentor.model` がオフにされた。
- **エラー** (`the reference is empty`): リファレンスウィンドウ内のリファレンスチャンネルから人々のメッセージを読み取れなかった。モデルリクエスト前にランを終了。

停止されたランは既に得られたスコアを保持し、レポートに含めます。

### 実際の moment（anchors）

ケースはチャットからの実際の moment を含むことができます。各 moment はオーナーが拒否したペルソナの 1 つのメッセージです。解決プロセス: ボットはメッセージを取得し、トリガー（リプライ先のメッセージ、またはその前のペルソナ以外の最後のメッセージ）を見つけ、そのチャンネルのトリガーまでの最大 `mentor.anchor.contextMessages`（デフォルト 30）件のメッセージを収集し、ペルソナのバースト全体（指定メッセージから始まる連続メッセージ）をオリジナルの回答として保存します。保存された履歴は通常のトランスクリプトと同じ方法で正規化され（メディアラベル、リアクション）、ダウンロードも記述も行いません。解決時にペルソナが見たメディアも保存されます。各メッセージについて、記述器が `media.json` にキャッシュしたキャプション（画像、GIF、動画フレーム、リンクサムネイル、スタンプ、カスタム絵文字）と視聴済み動画要約のうち、ペルソナのメッセージ以前に書き込まれたエントリが `mediaSeen: { captions?: { <itemId>: text }, watched?: { <itemId>: text } }` になります。保存されないもの: 未視聴状態（制限またはエラー）、再視聴回答（`videoAnswered`）、ウェブ検索読み取り（`linkRead`）、添付画像マーカー。名前とリアクションは取得時のまま保持されます。保存後、チャンネルが進んだりメッセージが削除されても、moment は保存されたメッセージから再生されます。

ケースは moment を `anchors` として保存します:

```json
[{ "id": 1, "channelId": "...", "messageId": "...", "triggerId": "...",
   "addedAt": "...",
   "history": [
     { "...正規化されたメッセージフィールド...",
       "mediaSeen": { "captions": { "<itemId>": "text" }, "watched": { "<itemId>": "text" } } }
   ],
   "original": ["text", "..."] }]
```

ラン中、各使用可能な anchor は独立した状況になり、作成された状況の前に番号が付けられます。状況レコードは `anchor: <id>` を持ちます（作成された状況にはありません）。再生は保存された履歴を使用し、ペルソナのオリジナルメッセージの時点で、anchor 自身のチャンネルで行われます。

再生時、保存された `mediaSeen` はライブのトランスクリプトラベル（`imageDescribed`、`gifDescribed`、`videoDescribed`、`videoWatched`、`thumbnailDescribed`、`linkWatched`、`stickerDescribed`、`emojiDescribed`）でペルソナのリクエスト、`<examples>`、スコアリングの `<situation>`、`<worst>` にレンダリングされます。保存された記述のない項目は、再生時に同じ時間制限（ペルソナの回答）でキャッシュを読み取り専用で参照します。キャッシュにもない場合、項目はプレーンラベルでレンダリングされます。

`mentor.anchor.hideLaterMemory` が `false` でない場合（デフォルト `true`）、再生される moment はトリガー時点より前の記憶状態で回答されます。トリガーのタイムスタンプ以降に記録された項目は非表示になります: エピソード（`addedAt` を使用、なければ `date` の UTC 日付にフォールバック）、態度履歴エントリと態度の理由（スコアは現在の値のまま）、詳細（`firstSeen`）、興味（`firstSeen`）、エイリアス（`firstSeen`）、学習項目（`firstSeen`）、ロアエントリ（`createdAt`）。解析可能な日付のない項目はフィルタリングされません。日付のないフィールド（プロファイルのテキストフィールド、サーバーパターン、スターター、インジョーク、自己事実、チャンネルエントリ）は現在の値で表示されたままです。実際の moment の `<learned>` ブロックも同じ方法でフィルタリングされます。`false` に設定すると、現在の全記憶で moment を再生します。

状況リクエストでは、ケースの anchor が `<examples>`（最後のブロック）として mentor モデルに提示されます。各 `<example>` には保存されたトランスクリプトの `<situation>` とペルソナのメッセージの `<original>` が含まれます。各例の最も古いメッセージはリクエスト予算に収まるようにトリミングされる場合があります。トリガーは削除されません。Mentor は同種の状況を作成します: メッセージの長さ、ターン数、圧力の程度を合わせます。

実際の moment のスコアリングリクエストでは、`<original>` が `<situation>` と `<answers>` の間に配置され、ペルソナの拒否された回答を既知の悪い参照として含みます。

バリデーターの作成された状況の 1 行あたりの上限は 2000 文字（旧 500）になり、mentor が例のメッセージの長さに合わせられます。

### プロンプト

Mentor は 4 つのプロンプトファイルを使用します。状況/スコアのペア、特徴ファイルと診断ファイル:

- `mentor-situations.md`（状況を作成）と `mentor-score.md`（回答をスコアリング）。
- `mentor-diagnose.md`（スコアリング後に弱い回答を説明）。

各プロンプトファイルは 1 つの mentor リクエストのシステムメッセージです。ブロックはユーザーメッセージで送信されます。

コードが埋めるプレースホルダー: 4 つすべてに `{{name}}`。状況プロンプトに `{{count}}`、`{{minLines}}`、`{{maxLines}}`。

### ブロック

| ブロック | 内容 | どのリクエストで |
|---|---|---|
| `<case>` | オーナーのケーステキスト、逐語 | すべて |
| `<members>` | 保存されたプロファイル 1 行ずつ: `name (id:123)` | 状況 |
| `<reference>` | スタイルプロファイル JSON: 句読点の頻度、長さ、返信頻度、未使用文字 | 状況、スコアリング |
| `<samples>` | チャットからのランダムな行、1 行ずつ | 状況、スコアリング |
| `<signs>` | `{{name}}` を埋めた `mentor-signs.md`: モデル文の既知の癖。ファイルがないか空の場合は省略 | すべて |
| `<intended>` | `labels.mentor.intended`、1 項目ずつ | スコアリング |
| `<feedback>` | オーナーの修正の JSON 配列: `[{ "case": "...", "reason": "..." }]`、新しい順。空の場合省略 | すべて |
| `<examples>` | チャットからの実際の moment: `labels.mentor.examples` を先頭行とし、moment ごとに 1 つの `<example>`。各 `<example>` には `<situation>`（保存されたトランスクリプト、最も古いメッセージはリクエスト予算に合わせてトリミングされる場合あり）と `<original>`（ペルソナのメッセージ）が含まれる。ケースに moment がない場合は省略 | 状況 |
| `<original>` | その時のペルソナの回答（実際の moment のスコアリングリクエスト内）。`labels.mentor.original` を先頭行とし、ペルソナのメッセージが続く。既知の悪い参照であり、スコアリング対象の回答ではない。作成された状況では省略 | スコアリング（実際の moment のみ） |
| `<character>` | `{{name}}` を埋めたキャラクターカード | スコアリング |
| `<rules>` | ルールプロンプト | スコアリング |
| `<learned>` | ペルソナが見ている指示的な学習項目。`mentor.anchor.hideLaterMemory` が有効な実際の moment では、トリガー以降に書き込まれた項目は非表示 | スコアリング |
| `<situation>` | チャットトランスクリプトとしてレンダリングされた状況（ペルソナの視点）。実際の moment では、最も古いメッセージがリクエスト予算に合わせてトリミングされる場合があり、トリガーは削除されない | スコアリング |
| `<answers>` | JSON 配列: `[{ "id": "s1a1", "messages": ["..."], "reactions": ["..."], "silent": false }]` | スコアリング |
| `<facts>` | 回答 id をキーとした JSON オブジェクト。確定的測定結果（未使用マーク、レアマーク、コンマ数、コンマ密度、長さ）と、2 つ以上の異なる状況で見つかったフレーズ `"repeated"` を含む。回答ごと: `commas` はカウント、`commaPer1000` は測定テキストが 150 文字以上の場合のみ数値で、短い場合は `null`（短すぎて測定不能、mentor はカウントで判断し密度を推定しない）。`repeated` は異なる状況で繰り返されたフレーズを列挙し、`count` は状況の数 | スコアリング |
| `<verdict>` | JSON: `{ passed, medians, situations, reasons }`。合否結果、各軸の中央値、状況ごとの中央値、診断の理由。理由には作成された状況の `situation <n>: <axis> <v> is under the floor <f>` と実際の moment の `real moment <n>: <axis> <v> is under the pass score <s>` または `real moment <n>: <axis> <v> is under the anchor score <s>` が含まれる | 診断 |
| `<worst>` | JSON: 種類を問わず `overall` 中央値が最低の状況（同率の場合はより低い `goal` 中央値、次に実際の moment が作成された状況より優先、次により小さい `n`）: `{ n, title, transcript, answers }`。各回答は id、messages/reactions/silent、`facts`、`score` を含む。トランスクリプトはリクエスト予算に合わせてトリミングされる場合がある | 診断 |
| `<seen>` | その状況でペルソナに渡された完全なリクエスト。2 つのサブブロック: `<system>`（キャラクターカード、ルール、フォーマットを含むシステムプロンプト）と `<user>`（トランスクリプト、メモリブロック、タスク） | 診断 |

### 回答 ID

`s<状況>a<サンプル>`、どちらも 1 から。例: `s2a3` は 2 番目の状況の 3 番目のサンプル。

### 状況スキーマ

```json
{
  "situations": [
    {
      "title": "短いラベル",
      "lines": [
        {
          "authorId": "123456789 or self",
          "authorName": "表示名",
          "text": "メッセージ",
          "replyTo": null,
          "minutesBefore": 5
        }
      ]
    }
  ]
}
```

`authorId` は `<members>` のメンバー id または `self`（ペルソナ自身の行）。`replyTo` はこの状況の `lines` 配列内の 0 ベースインデックス、または `null`。最後の行は `self` であってはならず、ペルソナに話しかけます。

実際の moment からの状況レコードは `lines` の代わりに `anchor: <id>` を持ちます。そのトランスクリプトは保存された履歴から構築されます。レコードには `original`（ペルソナのメッセージ）と `at`（ペルソナが回答した時間）も含まれます。

### スコアスキーマ

```json
{
  "answers": [
    {
      "id": "s1a1",
      "human": 7,
      "character": 8,
      "rules": 9,
      "goal": 6,
      "overall": 7,
      "comment": "1～2 文。"
    }
  ]
}
```

各スコアは 0–10 の整数または `null`。`overall` と `goal` は常に数値。

### 軸

すべて 0–10 の整数、10 が理想、`null` は判定不能時（5 を「不明」の代用にしない）。

| 軸 | 測定内容 | 0 | 5 | 10 |
|---|---|---|---|---|
| `human` | AI らしさの低さ | このチャットの人々の書き方から遠い | どちらとも言えない | リファレンスの実際の人の書き方と一致 |
| `character` | キャラクターカードへの適合度 | 完全にキャラクター外 | 認識できるが滑りあり | カードの声そのもの |
| `rules` | ルールと学習項目の遵守 | すべての適用ルールに違反 | 一部遵守、一部違反 | すべての適用ルールを遵守 |
| `goal` | `<case>` の要求を満たしているか | 逆のことをしている | 部分的に達成、部分的に未達 | 記述通りに行動を処理 |
| `overall` | Mentor の総合判定 | 全面的に不合格 | 明確な弱点はあるが許容範囲 | 全面的に優秀 |

### 合格ルール

ケースが合格する条件: `overall` の中央値 >= `mentor.pass.score`（デフォルト 7）かつ `goal` の中央値 >= `mentor.pass.score` かつ、いずれの軸の中央値も `mentor.pass.floor`（デフォルト 5）を下回らないこと。作成された状況は下限でチェックされます: いずれか 1 つの作成された状況の `overall` 中央値または `goal` 中央値が `mentor.pass.floor` を下回る場合、全回答の中央値に関わらずケースは不合格です。実際の moment はパススコアで判定されます: `mentor.pass.anchorScore`（数値に設定時）または `mentor.pass.score`（`anchorScore` が `null` の場合）を下回ると不合格です。理由文字列: `anchorScore` 未設定時は `real moment <n>: <axis> <v> is under the pass score <s>`、設定時は `real moment <n>: <axis> <v> is under the anchor score <s>`。レポートには各状況の `overall` と `goal` の中央値が表示されます。すべてのスコアが `null` の軸は中央値が `null` となり、チェックされません。

### スコアリングのエビデンス順序

1. `<feedback>` 内のオーナーの修正。Mentor の好みに優先する。
2. 測定されたリファレンス（`<reference>`、`<samples>`）と確定的事実（`<facts>`）。
3. モデル文の既知の特徴（`<signs>`）。測定結果やリファレンスに優先しない。
4. Mentor 自身の好み。提案のみ行い、上記 3 つに優先しない。

### 出典

`mentor-signs.md` の既知の特徴リストは、Wikipedia の "Signs of AI writing" と humanizer skill (MIT) を参考に作成されました。

### 診断

スコアリング後、ランが早期終了せずケースが不合格または任意の状況の `overall` 中央値が `mentor.pass.score` を下回る場合、mentor はもう 1 つのリクエストを行い、ペルソナのコンテキストのどこが弱い回答を引き起こしたかを説明します。スイッチ `mentor.diagnose`（デフォルト `true`）。`/nep mentor check` で開始されたランは診断を要求しません。このステップの失敗はランを失敗させません。ランは `diagnosis: null` で保存され、エラーが記録されます。

結果はランの `diagnosis` として保存され、レポートに出力されます。これらはオーナーが検討するための仮説であり、mentor 自体は何も編集しません。

原因が指すレイヤー: `rules`（ルールブロック内のルール）、`prompt`（エンジンのシステムプロンプト、フォーマット、タスク）、`card`（キャラクターカード）、`self`（ペルソナが自身について保持するメモ）、`learned`（ペルソナに教えたこと）、`guild`（サーバーの習慣や内輪ネタ）、`profile`（ペルソナがある人について記憶していること）、`labels`（`labels.json` の文字列）、`lore`（ロアブックエントリ）、`channel`（チャンネルノート）、`recent`（`<recent>` ブロック内の行）、`missing`（あるべき指示が存在しない）。

#### 診断スキーマ

```json
{
  "summary": "1 段落",
  "causes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile|missing",
      "excerpt": "<seen> からの逐語引用、最大 300 文字。missing の場合は空",
      "why": "1～2 文"
    }
  ],
  "changes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile",
      "target": "どのファイル、ルール、または項目",
      "from": "置換する逐語テキスト。追加の場合は空",
      "to": "新しいテキスト",
      "why": "1 文"
    }
  ]
}
```

最大 5 個の原因と 5 個の変更。`summary` は 1500 文字に切り詰め、`excerpt` は 300、`from`/`to` は 1000、`target` は 200、`why` は 500。不明な `layer` または `why` のない項目は破棄。`summary` と `why` はチャットの言語で、`to` は対象レイヤーの言語で記述。

## リミット通知

レールがトリガーされたアクション（メンション、リプライ、名前トリガー、フォローアップ、プライベートメッセージ。`overheard` や自発的ターンではない）を拒否した場合、ボットは `labels.limits.notice` から 1 行を投稿。`{limit}`（config キー）、`{used}`、`{cap}` が設定される。自発的ターンと `overheard` ターンはサイレント。ドライランではログとミラーに記録。

`{limit}` に表示される config キー: `llm.maxRequestsPerDay`、`llm.maxRequestTokens`、`image.maxPerDay`、`image.maxPerUserPerDay`、`private.maxPerUserPerDay`、`private.maxPerOwnerPerDay`。
