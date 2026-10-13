# ウォームアップ

ウォームアップは最近のメッセージのサンプルからサーバーに関するペルソナのメモリを構築します。運用ツール `tools/warmup.mjs` として、ボットを停止した状態でサーバー上のチェックアウトから実行します。初回起動の前に使います（[実行方法](#実行方法)参照）。スラッシュコマンドはありません。

ボットがウォームアップを実行することはありません。ツールが未完了のランを自ら再開します。

## ステージ

フルランはチャンネル、メンバー、サーバーの順に進行します。

### チャンネル

読み取り可能なすべてのチャンネルに対して 1 リクエストずつ実行し、経過時間に関係なく最新の `warmup.messagesPerChannel`（デフォルト 200）件のメッセージから記述します。チャンネルの履歴がその件数に満たない場合、より深いフェッチを試みます。履歴がまったくないチャンネルは、名前、カテゴリ、トピックのみから記述されます。結果はチャンネルノート（目的、トピック、トーン）とコードが管理するファクト（メッセージ数、トップライター、30 日間のアクティビティヒストグラム）になります。

### メンバー

最もアクティブなメンバーが対象になります。過去 `warmup.lookbackDays` 日間に少なくとも `warmup.minMessages` 件の自身のメッセージがあり、`warmup.maxPeople` 人まで、アクティブ順に選択されます。`node tools/warmup.mjs people` で現在の設定での対象メンバー一覧を確認できます。

対象メンバーごとに、`warmup.messagesPerPerson` 件までの自身のメッセージと `warmup.contextBefore` 行の直前のコンテキストをサンプルします。一つのチャンネルからのサンプルは `warmup.maxChannelShare` を超えません。大きなサンプルは `warmup.maxRequestTokens` に収まるよう時系列で分割されます。2 番目以降のチャンクは前回の回答を `<draft>` ブロックとして受け取り、有効な内容を保持しつつ変化を修正し、新しい証拠で拡張します。最終的な回答にはキャラクター、スタイル、関心、詳細、エピソード、エイリアスが保存されます。メッセージ数や初回/最終確認のタイムスタンプはコードが計算します。

### サーバー

1 リクエストで、すべてのチャンネルノート、プロファイル済みメンバーごとの一行要約（名前、主な習慣、主な関心）、およびメインチャンネル（`memory.mainChannelIds`、空の場合はすべてのチャンネル）の最新 `warmup.serverSampleMessages`（デフォルト 600）行を受け取ります。出力はサーバー全体のパターン、会話の始め方、内輪ネタ、ロアブックエントリとして保存されます。

## 対象範囲

ウォームアップが書き込むもの: チャンネルノート（目的、トピック、トーン）、メンバープロファイル（キャラクター、スタイル、関心、詳細、エピソード、エイリアス）、サーバーの傾向（パターン、会話の始め方、内輪ネタ）、ロアブック。

態度と `relationship` はウォームアップされません。ストリームアナライザーによるライブ会話からのみ蓄積されます。

`character` と `style` は `profile.md`（プロファイルプロンプト）のみが書き込む自由記述フィールドで、ウォームアップ時とポートレートリフレッシュ時に使われます。ストリームアナライザーが直接編集することはありません。データモデルと出力スキーマの詳細は[プロンプトコントラクト](prompt-contract.md)を参照してください。

## 進捗

進捗はリクエストごとに `data/state.json` の `state.warmup` に永続化され、再起動後も保持されます。Ctrl+C、トークンバジェット、レートリミット、3 回連続の失敗でランが中断された場合、`node tools/warmup.mjs run` を再度実行すると中断した地点から再開できます。`node tools/warmup.mjs reset` は進捗のみをクリアし、保存されたメモリは消去しません。

## 制限

ラン全体のトークンバジェットは `warmup.maxTokens`（デフォルト 6,000,000）です。各リクエストは `warmup.maxRequestTokens`（デフォルト 120,000、入力 + 出力）と `warmup.maxOutputTokens`（デフォルト 6,000、出力）で制限されます。サンプルプールを構築するチャンネルフェッチはチャンネルあたり `warmup.fetchLimitPerChannel`（デフォルト 15,000）件までのメッセージを読み取ります。

プロバイダーが HTTP 429 を返した場合、ウォームアップは `warmup.rateLimitWaitMinutes`（デフォルト 10）分間待機してリトライします。`warmup.rateLimitMaxWaits`（デフォルト 36）回連続で待機するとランは中断されます。進捗は保持され、ランは再開可能です。

## ポートレートリフレッシュ

ウォームアップ完了後、ストリームアナライザーがライブバッチからメモリを最新に保ちます。ポートレートは 2 つの方法でリフレッシュされます。

**カウンターによる**（`features.portraitRefresh`）。定期スケジューラーが `memory.portraitCheckMinutes`（デフォルト 60）分ごとにチェックし、前回のポートレート以降 `memory.portraitRefreshMessages`（デフォルト 300）件以上の自身のメッセージを書き、前回の成功から `memory.portraitRefreshDays`（デフォルト 3）日以上経過したメンバーをリフレッシュします。1 日 `memory.portraitRefreshPerDay`（デフォルト 3）名まで。失敗した試行は `memory.portraitRetryHours`（デフォルト 24）時間待機します。

**アナライザーのキューによる。** ストリームアナライザーがポートレートの欠落や矛盾を検出すると、ワンラインのヒントを返し、コードがリフレッシュをキューに入れます。既存のクールダウン `memory.portraitRefreshHours`（デフォルト 24 時間）を使います。ストリームアナライザーは `character` や `style` を直接上書きできなくなりました。

2 段階モードでは、メンバーのキャラクターテキストがボイスモデルの待ち状態（`voice-pending`）の間、ポートレートリフレッシュは実行されません。強制リフレッシュ（`/nep memory refresh`）はこのチェックを無視します。`/nep memory refresh` はメンバーにキューされたキャラクターアイテムがある場合、その旨をオーナーに伝えます。

両パスは日次上限を共有します。`/nep memory refresh <user>` はタイマーに関係なく強制実行しますが、上限にはカウントされます。

リフレッシュ時のドラフトはマージベースです。サンプルと一致する点は保持、矛盾する点は修正、新しい習慣は追加、サンプルが示していない点は削除しません。関心、詳細、エピソード、エイリアスは無視されます。

## 実行方法

ボットのチェックアウトから、サービスユーザーとして、ボットを停止した状態で実行します:

```bash
sudo systemctl stop neptunia-bot
cd /opt/neptunia-bot
sudo -u neptunia-bot node tools/warmup.mjs run --guild <server id> --dry-run
sudo -u neptunia-bot node tools/warmup.mjs run --guild <server id> --spend <usd>
sudo systemctl start neptunia-bot
```

`--guild` は `data/guilds/` にサーバーが 1 つだけある場合、または `bot.guildId` が設定されている場合は省略できます。ツールはチェックアウトから `config.json`、`config.local.json`、`prompts/`、`prompts.local/`、`.env` を読み、ボットトークンで REST 経由の Discord 履歴取得（ゲートウェイセッションなし、投稿なし）と OpenRouter キーによるモデルリクエストを行います。

| サブコマンド | 動作 | 課金 |
|---|---|---|
| `run` | 進捗がまだ完了していない、すべての読み取り可能なチャンネル、対象メンバー、サーバーノートを順に処理 | あり |
| `users [--user <id>]` | 指定メンバー、または対象となるすべてのメンバーをプロファイル（進捗に関係なく） | あり |
| `channels [--channel <id>]` | 指定チャンネル、またはすべての読み取り可能なチャンネルを記述 | あり |
| `server` | サーバーノートとロアブックを再構築 | あり |
| `people` | 対象メンバー一覧を表示 | なし |
| `status` | フェーズ、進捗、`warmup.maxTokens` に対するトークン使用量 | なし |
| `reset` | 進捗のみをクリア（保存されたメモリは消去しない） | なし |

**課金について。** `run`、`users`、`channels`、`server` はまずプラン（チャンネル、メンバー、サーバーノート）と見積もりを表示し、`--spend <usd>` が見積もりを賄わない場合は終了コード 2 で拒否します。見積もりは各リクエストを `warmup.maxRequestTokens` で計算し、`warmup.maxTokens` の残りと `--max-usd <n>` の範囲内で、`--usd-per-ktok`（デフォルト 0.005 USD / 千トークン）の単価で算出します。ランはその見積もりをバジェットとして使い、そこで停止（再開可能）し、超過することはありません。サンプルが 1 リクエストに収まらないメンバーはバジェットを早く消費する可能性があります。再度実行すれば続きから再開します。`--dry-run` はプランと見積もりを表示するだけで何も送信しません。リクエストは `llm.maxRequestsPerDay` にカウントされません。

**安全性。** `run`、`users`、`channels`、`server`、`reset` はボットが同じ `data/` で実行中（ジャーナルの `.running` マーカー）の場合は拒否し、`sudo systemctl stop neptunia-bot` を案内します。課金サブコマンドは、削除処理中やメモリが一時停止中も拒否し、`data/` に削除台帳の対象が残っている場合はまず台帳を適用します。`people`、`status`、ドライランは何も書き込みません。Ctrl+C は実行中のリクエストをキャンセルしてランを停止します。進捗は保持されます。終了前にツールはメモリをディスクにフラッシュします（アーカイブコピーを含む）。

**書き込み先。** チャンネルノートとファクトは `data/guilds/<id>/channels/`、メンバープロファイルは `data/guilds/<id>/users/`、サーバーノートは `data/guilds/<id>/guild.json`、ロアブックは `data/guilds/<id>/lore.json`、進捗は `data/state.json`。`features.archive` が有効な場合、書き換えで消えるものはまずアーカイブに保存されます。

**その後。** ボットを起動します。以降メモリはボットが維持します: ライブバッチのストリームアナライザー、ポートレートリフレッシュ、以下のノートリフレッシュ。`/nep memory refresh kind:user <user>` はメンバーのポートレートを即座に書き換えます。`kind:channel <channel>` と `kind:server` はチャンネルノートやサーバーノートを新しいサンプルから書き換えます（以下のノートリフレッシュと同じリクエスト、ライブの制限下、ペルソナは会話を続けます）。ノートがまだないチャンネルとロアブックはこのツールの担当です: `channels --channel <id>` と `server`。

完全にやり直すには、まず `/nep memory wipe` を使用します。メンバープロファイル（態度とエピソードを含む）、サーバーの傾向、チャンネルマップ、ロアブックエントリ、ウォームアップの進捗がすべてクリアされます。

## ノートの鮮度維持

チャンネルとサーバーのノートはウォームアップ時に書かれ、その後ストリームアナライザーがバッチに十分な証拠があるときに更新します。しかし時間が経つと、短いバッチでは、人々の話し方やチャンネルの話題の緩やかな変化を捉えられなくなります。ノートリフレッシュ（`features.notesRefresh`）は、最近のメッセージの完全なサンプルからノートを定期的に再チェックすることでこれを補います。ウォームアップ時にチャンネルを記述したのと同じ方法です。

### 何が起きるか

スケジューラーが `memory.notesCheckMinutes`（デフォルト 60）分ごとに、どのチャンネルとサーバーノートが期限を過ぎているかチェックします。チャンネルが対象になる条件: ノートのテキストが既にある（ウォームアップが記述していないチャンネルはウォームアップに委ねられる）。最後のテキスト変更またはサンプルレビューから十分な日数が経過（`memory.notesRefreshDaysMain`、`memory.mainChannelIds` 内のチャンネルはデフォルト 7、それ以外は `memory.notesRefreshDays`、デフォルト 21）。その時点以降 `memory.notesMinMessages`（デフォルト 30）以上のメッセージが蓄積。`warmup.lookbackDays`（デフォルト 60）日以内にメッセージがあること。`memory.notesRetryHours`（デフォルト 24）以内に失敗した試行がないこと。

対象チャンネルに対し、エンジンは `memory.notesSampleDays`（デフォルト 30）日分の履歴を読み、ペルソナや他のボットの行を除き、`memory.notesSampleMessages`（デフォルト 160）件のメッセージを日ごとに分散してピックします。分散により最新の会話だけを偏ってサンプリングすることを避けます。1 人の著者はサンプルの `memory.notesSampleMaxAuthorShare`（デフォルト 0.35）を超えることはできません。有効なメッセージが `notesMinMessages` 未満の場合、チャンネルはスキップされます（`too-few`）。

リクエストはウォームアップと同じ `channel.md`（サーバーの場合は `server.md`）を使い、1 つ追加があります: `<existing_notes>` ブロックに保存済みノートの JSON と `writtenDaysAgo`（最後の変更からの日数、不明時は null）が含まれます。プロンプトはモデルにこれらをサンプルに対して評価すべき主張として扱い、証拠としては扱わないよう指示します。回答は保存済みの purpose、topics、tone を置き換えます（サーバーの場合は patterns、starters、injokes）。履歴の読み取りと回答の間にチャンネルのテキストが変更された場合（別のバッチが更新した場合）、回答は破棄されます（`conflict`）。いずれの場合も、有効な回答は `notesSampleReviewedAt` をスタンプします。テキストの `updatedAt` は実際に変更があった場合のみ移動します。

サーバーは同じルールに従います: `memory.notesServerRefreshDays`（デフォルト 7）、全チャンネル合計で `memory.notesGuildMinMessages`（デフォルト 100）メッセージ。サーバーはサイクル内でチャンネルの後に処理され、日次上限の対象外です。

### 頻度とコスト

UTC 日あたり `memory.notesRefreshPerDay`（デフォルト 4）件までの成功したチャンネルリフレッシュ。失敗したリクエストはスロットを消費しません。日次カウンターは `state.json` に `notesRefreshDay` / `notesRefreshCount` として保存されます。サーバーリフレッシュはチャンネル上限にカウントされません。

各リフレッシュリクエストは `llm.maxRequestsPerDay` と 50k トークン上限にカウントされますが、ウォームアップの `warmup.maxTokens` にはカウントされません。リフレッシュ中もペルソナはミュートされません。ウォームアップパスの実行中はリフレッシュが拒否されます。

### ログ行

`warmup: notes refreshed`（`{ target: "channel" | "server", channelId, changed, sample, authors, days }`）。

`warmup: notes refresh failed`（`{ target, channelId, reason }`）。理由: `running`（ウォームアップパス実行中）、`paused`、`gone`（チャンネルが存在しない）、`too-few`（有効なメッセージが少なすぎる）、`conflict`（履歴読み取りと回答の間にテキストが変更）、`bad-json`、`llm-error`、`token-limit`、`daily-cap`、`no-prompt`。

`notes refresh: look`（`{ due, started, refreshed, changed, skipped }`、および `buckets { neverReviewed, fresh, due, few, quiet, retryWait }` を全チャンネルでカウント）。

見た目を新しくするためだけに書き直されることはありません。主張がまだ有効かどうかサンプルで判断できない場合、保存済みテキストはそのまま残ります。

ウォームアップの設定キーの全一覧は[設定: `warmup`](configuration.md#warmup)を参照してください。
