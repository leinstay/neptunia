# コマンド

スラッシュコマンド `/nep` 1 つに 18 のトップレベルエントリ。すべての応答はエフェメラル（実行者のみに表示）。チャンネル、ロール、ユーザーは Discord 標準のピッカーから選択します。一部のオプションはオートコンプリート対応: `set`/`unset` は `path`、`access grant`/`access revoke` は `command`、`model set` は `id`（使用中のモデル ID）、`route set`/`route remove` は `model`、`memory restore` は `id`（最新のアーカイブエントリ）をオートコンプリートします。

## アクセス

`/nep` は最初からすべてのメンバーに表示されます。アクセスはコマンド実行時にオペレーション単位でゲートされ、Discord のコマンド表示設定は使いません。各コマンドは 1 つの名前付きオペレーションを実行します。読み取りと変更は分離されています: `/nep memory show` は `memory.profile.read`、`/nep memory affinity <user>` は `memory.affinity.read`、`/nep memory affinity <user> <score>` は `memory.affinity.set` を実行します。

オーナー（`bot.owners`）はすべてを常に実行できます。それ以外のユーザーには正確なオペレーションへのグラントが必要です。`/nep access grant <operation> [role] [user]` で 1 つのオペレーション（例: `memory.profile.read`）を全員（ロール/ユーザー指定なし）、ロール、またはユーザーに開放します。グループ名（例: `memory`）や `*` も指定できますが、グラントはその時点で存在する読み取りオペレーションとして個別に記録されます。書き込みは開放されず、後で追加されたオペレーションは名前で明示的にグラントするまで閉じたままです。`/nep access revoke` は対象を 1 つのオペレーションから、またはグループや `*` 配下のすべてのオペレーションから削除します。`/nep access list` は各オペレーション、その保持者、およびグループや `*` 展開の一部だったグラントの出所を表示します。グラントがなければ、オーナー以外のメンバーはエフェメラルな "Not allowed" の応答を受け取ります。

オーナー専用オペレーション（`access.*`、`diary.*`、`memory.private.*`、`memory.journal.read`、`memory.snapshot`、`memory.forget`、`memory.wipe`、`memory.archive.read`、`memory.restore`）は `*` を含むいかなるグラントでも開放されません。

**旧コマンドキーからの移行。** オペレーションベースのアクセスを導入したデプロイ後の初回起動時に、すべての保存済みグラントが一度変換されます: 旧コマンドキーはそれが実行していたオペレーションに、旧グループや `*` はカバーしていた読み取りオペレーションに展開され、オーナー専用オペレーションは除外されます。ジャーナルの `system` レコード `access-migrated` に、各旧グラントが現在カバーする内容が記録されます。移行後: `/nep access revoke * everyone`、次に `/nep access grant memory.profile.read everyone` を実行し、他の必要なオペレーションを名前で再グラントしてください（`/nep access list` で確認）。

## ステータス

`/nep status` はクイックチェックに必要なフィールドを 1 枚のカードに表示します: ボットの状態（稼働中またはいつから一時停止中か、ストレージ行付き）、ゲートウェイ接続、長時間タスク（バックフィル、アーカイブドレイン）、グループ別モデル（voice, analyzer, reasoner, extractor, media = vision + video, embedding, drawing。ロールごとに 1 行: ロール、モデル、プロバイダー、レイテンシ。`roles.byPurpose` の上書きはそのロールの下に表示）、デイリーリミット、メモリタイプ別カバレッジ（record, index, archive, プロフィール, サーバーメモ, チャンネル, 最近の行, participation: 件数, 期間, パーセント）、過去 24 時間の速度（リプライ、recall、プランナー、アナライザーバッチ、エンベディングフラッシュの中央値、平均、件数。サンプルは `data/metrics.json`）、アップタイム。各ロールは自身のモデルを表示（他のロールのモデルは使いません）。エンベディングロールは 1 入力のエンベディングリクエスト（`status.probe` のテキスト）でプローブされます。エンベディングクライアントがない場合はチェックされなかったと表示されます。`/nep status detail` はカードの下に長いテキスト形式を追加します: モデルキャリブレーション、ウォームアップの進捗、読み込まれたプロンプトとそのソース、ボイスキュー。`status.show` をグラントされたメンバーはメモリと速度のフィールドなしのカードを表示でき、長いテキスト形式は表示されません。

## コマンド一覧

| コマンド | オペレーション | 応答 | 内容 |
|---|---|---|---|
| `/nep status [detail]` | `status.show` | エフェメラル | ボットの現在の状態: 1 枚のカード |
| `/nep set <path> <value>` | `config.set` | エフェメラル | config.local.json の設定値をオーバーライド; `path` はオートコンプリート |
| `/nep unset <path>` | `config.unset` | エフェメラル | 設定のオーバーライドを削除; `path` はオートコンプリート |
| `/nep pause` | `bot.pause` | エフェメラル、遅延 | ペルソナを一時停止しメモリをフラッシュ。data/ の手動編集が可能に |
| `/nep resume` | `bot.resume` | エフェメラル、遅延 | 一時停止から再開; data/ のファイルが無効なら拒否 |
| `/nep draw <text> [self]` | `draw.create` | エフェメラル、遅延 | このチャンネルに 1 枚描画。残高を消費 |
| `/nep talk <action:interject\|initiate> [channel]` | `talk.interject`, `talk.initiate` | エフェメラル、遅延 | ペルソナに今すぐ発言させる |
| `/nep media <kind:emoji\|gifs> <action:status\|rescan\|recache>` | `media.status`, `media.rescan`, `media.recache` | エフェメラル、`media.rescan` は遅延 | カスタム絵文字ランキングと GIF ライブラリ |
| `/nep model show` | `model.show` | エフェメラル | 各ロールのモデルを表示 |
| `/nep model set <role:voice\|analyzer\|reasoner\|extractor\|vision\|video\|embedding\|drawing> <id>` | `model.set` | エフェメラル | ロールのモデルを設定; `id` はオートコンプリート |
| `/nep route list` | `route.list` | エフェメラル | すべてのルート、各ロールの現在のモデルとルート |
| `/nep route set <model> <providers> [role:voice\|analyzer\|reasoner\|extractor\|vision\|video\|embedding\|drawing] [fallbacks]` | `route.set` | エフェメラル | モデルプレフィックスを指定プロバイダーのみにルーティング; `model` はオートコンプリート |
| `/nep route remove <model> [role:voice\|analyzer\|reasoner\|extractor\|vision\|video\|embedding\|drawing]` | `route.remove` | エフェメラル | ルートを削除; `model` はオートコンプリート |
| `/nep rule add <text>` | `rule.add` | エフェメラル | ルールを追加 |
| `/nep rule list` | `rule.list` | エフェメラル | ルール一覧を番号付きで表示 |
| `/nep rule remove <number>` | `rule.remove` | エフェメラル | 番号指定でルールを削除 |
| `/nep access grant <command> [role] [user]` | `access.grant` | エフェメラル | オペレーション、グループ、または * を全員、ロール、またはユーザーに開放; `command` はオートコンプリート |
| `/nep access revoke <command> [role] [user]` | `access.revoke` | エフェメラル | オペレーション、グループ、または * を全員、ロール、またはユーザーから取り消し; `command` はオートコンプリート |
| `/nep access list` | `access.list` | エフェメラル | すべてのアクセスグラントを表示 |
| `/nep diary set <channel>` | `diary.set` | エフェメラル、遅延 | 日記チャンネルを設定 |
| `/nep diary show` | `diary.show` | エフェメラル | 今日の日記の状態 |
| `/nep diary off` | `diary.off` | エフェメラル | 日記を停止 |
| `/nep diary post [kind] [topic]` | `diary.post` | エフェメラル、遅延 | 今すぐ 1 エントリを投稿 |
| `/nep alias add <user> <name>` | `alias.add` | エフェメラル | エイリアスを追加または強化 |
| `/nep alias remove <user> <name>` | `alias.remove` | エフェメラル | エイリアスを削除 |
| `/nep learning add <text>` | `learning.add` | エフェメラル | レッスンを追加または強化 |
| `/nep learning remove <number>` | `learning.remove` | エフェメラル | レッスンを削除 |
| `/nep lore add <title> <keys> <text> [always]` | `lore.add` | エフェメラル | ロアエントリを追加または上書き（オーナーエントリになる） |
| `/nep lore list [query]` | `lore.list` | エフェメラル | エントリ一覧（フィルター可能） |
| `/nep lore show <id>` | `lore.show` | エフェメラル | エントリ全文を表示 |
| `/nep lore remove <id>` | `lore.remove` | エフェメラル | エントリを削除 |
| `/nep memory show <user> [section:summary\|character\|style\|relationship\|affinity\|aliases\|interests\|details\|episodes\|raw] [limit] [order:rank\|recent]` | `memory.profile.read` | エフェメラル | メンバーの保存されたプロファイルを表示 |
| `/nep memory channel [channel]` | `memory.channel.read` | エフェメラル | チャンネルのノート、またはすべてのチャンネルの一覧 |
| `/nep memory server` | `memory.server.read` | エフェメラル | サーバーノート: パターン、スターター、内輪ネタ、自己言及 |
| `/nep memory recent` | `memory.recent.read` | エフェメラル | ライブの最近のラインを新しい順に表示 |
| `/nep memory refresh <kind:user\|channel\|server> [user] [channel]` | `memory.refresh.user`, `memory.refresh.channel`, `memory.refresh.server` | エフェメラル、遅延 | メンバーのポートレート、チャンネルやサーバーのノートを新しいサンプルから書き換える |
| `/nep memory forget <user>` | `memory.forget` | エフェメラル、遅延 | メンバーのプロファイルとプライベートメモリを削除 |
| `/nep memory affinity <user> [score] [reason]` | `memory.affinity.read`, `memory.affinity.set` | エフェメラル | 態度スコアの表示または設定 |
| `/nep memory wipe <confirm>` | `memory.wipe` | エフェメラル、遅延 | サーバーのすべてのメモリを削除（プロファイル、プライベートメモリ、傾向、チャンネル、ロア） |
| `/nep memory journal [day] [kind:turn\|action\|memory\|system\|all] [n]` | `memory.journal.read` | エフェメラル | ジャーナルレコード |
| `/nep memory archive [user] [kind] [n]` | `memory.archive.read` | エフェメラル、遅延 | アーカイブされたアイテム |
| `/nep memory restore <id>` | `memory.restore` | エフェメラル、遅延 | アーカイブされたアイテムを復元; `id` はオートコンプリート |
| `/nep memory snapshot` | `memory.snapshot` | エフェメラル、遅延 | data/ をツール用にスナップショット |
| `/nep memory private <action:show\|forget\|purge> <user>` | `memory.private.read`, `memory.private.forget`, `memory.private.purge` | エフェメラル、`memory.private.forget`・`memory.private.purge` は遅延 | メンバーのプライベートメモリ: DM で話した内容 |

## メモリコマンド

`/nep memory show` はメンバーの保存済みプロファイルを表示します: コンパクトな要約、または特定のセクション（character、style、relationship、affinity、aliases、interests、details、episodes、raw JSON）。`/nep memory channel` はチャンネルのノート、またはすべてのチャンネルの一覧を表示します。`/nep memory server` はサーバー全体のパターン、スターター、内輪ネタ、自己言及を表示します。

`/nep memory forget` はメンバーの公開プロファイル、プライベート DM ファイル、ボイスキューアイテム、バージョン履歴、レコードおよびアーカイブのエントリを削除します。削除前に、すべてを保管庫ディレクトリ（`memory.vaultDir`、デフォルト `data/vault/`）にコピーし、メンバーの ID を `data/guilds/<id>/forgotten.json` に書き込みます。エンジンは保管庫を読み戻すことはありません。メンバーを復元するには、ファイルを手動でコピーし `forgotten.json` からエントリを削除してください。`/nep memory wipe` はサーバー全体に同じことを行います: ギルドディレクトリ配下のすべてを保管庫にコピーし、プロファイル、プライベートファイル、チャンネル、傾向、ロア、ジャーナル、レコード、アーカイブ、ボイスキュー、バージョン、日記履歴、recall トレースを削除します。

`/nep memory journal` はペルソナのジャーナルレコードを UTC 日で表示し、種類（turn、action、memory、system）でフィルターできます。`/nep memory archive` はアーカイブされたアイテムを表示し、メンバーや種類でフィルターできます。`/nep memory restore` はアーカイブされたアイテムをホットメモリに戻します（`id` は最新エントリからオートコンプリート）。`/nep memory snapshot` は `data/` をタイムスタンプ付きディレクトリにコピーします。

`/nep memory private show` はメンバーのプライベート DM メモリを表示します。`/nep memory private forget` はプライベートファイルのみを削除し、公開プロファイルは保持します。`/nep memory private purge` はプライベートファイルを削除し、そのメンバーへのボットの DM メッセージも一括削除します（最大 `private.purgeMaxMessages`）。

## メンバーコマンド

`/nep pings` は、`bot.access` のグラントなしにすべてのサーバーメンバーが使用できる唯一のコマンドです。`features.memberCommands: false` でオーナーのみに制限されます。

| コマンド | 説明 |
|---|---|
| `/nep pings [mode]` | ペルソナのメッセージからの通知を受け取るかどうかを表示・変更します。`mode` なし: 現在の設定を表示。`on` / `off`: 設定を切り替え。オフの場合、あなたのメッセージへのリプライにリプライピングが付かず、ペルソナのテキスト内のあなたへの @メンションは表示されますが通知は送信されません。ペルソナの文面は変わりません。エフェメラルな応答: `Pings: on` または `Pings: off`。サーバーごとに保存され、再起動後も維持され、`/nep memory wipe` でのみ削除されます |
