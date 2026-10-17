# エラントエージェント

エンジンはタスクを独立したエラントエージェントに委託できます。エラントエージェントは一つの仕事（ウェブ検索、ローカルファイルシステムの読み取り）をこなして結果を報告するスタンドアロンのプロセスです。各エージェントは `src/agent-runner/` のランナーコードが駆動する [OpenCode](https://opencode.ai) ワーカーです。ボットをインポートせず、ペルソナのものではない独自の OpenRouter キーで動作します。エンジンには 2 つのワーカープロファイルが同梱されています:

| プロファイル | 機能 | アクセス範囲 | ツール |
|---|---|---|---|
| `web` | インターネット関連のエラント（検索、ページ読み取り、画像閲覧、ファイルダウンロード） | プロキシ経由の公開インターネット、独自の出力フォルダ | OpenCode `websearch`, `webfetch`, `read`、およびダウンロード用に `curl`/`wget`/`ffmpeg`/`ffprobe`/`file`/`ls`/`mkdir` に制限された `bash` |
| `server` | このマシンへの読み取り専用の質問 | ローカルファイルシステム（読み取り専用）、モデル API へのネットワークのみ | OpenCode `read`, `grep`, `glob`, `list`、および読み取り専用コマンド（`ls`, `cat`, `head`, `tail`, `grep`, `find`, `ps`, `systemctl status`, `journalctl`, `df`, `du`, `stat`, `git log`, ...）に制限された `bash` |

どちらも一度に 1 タスクを実行し、追加のリクエストはキューに入ります。各タスクにはタスクごとの上限（`agents.<profile>.limits`: モデルステップ数、推定 USD、ウォールクロック秒数）があり、エンジンは 1 日あたりの上限（`agents.<profile>.daily`）を強制します。USD 上限は OpenCode のコスト見積もりに対するソフト上限です。ハードな支出制限はランナーの OpenRouter キーのクレジット上限です。

## agents フォルダ

各エージェントはエンジンルートの `agents/` 配下にフォルダを持ちます: `agents/web/` と `agents/server/` が 2 つのワーカー、`agents/advice/` がコンサルテーションです。フォルダにはエージェントの追跡プロンプト（`prompt.md`）と説明（`profile.json`）が含まれます。ランナーは起動時にこのフォルダからプロファイルを構築します（`src/agent-runner/profiles.js#loadProfiles`）。ボットも同じフォルダからデフォルト値（ソケット、出力ディレクトリ、制限、1 日あたりの上限）を読み取ります。`listAgents` はワーカーとコンサルテーションの両方を含むすべてのエージェントを返します。

2 種類あります。ワーカーは独自のプロセス（`bin/agent-runner.mjs --profile <id>`）として実行され、Unix ソケットでタスクを受け付けます。コンサルテーションにはプロセスがありません: ツールがそのモデルロールを直接呼び出します。ランナーはコンサルテーションをスキップします。

## プロファイルキー

`profile.json` はエージェントが要求するものを記述します。何かを認可することはありません。すべてのキーは必須です:

| キー | 内容 |
|---|---|
| `id` | フォルダ名（`web`） |
| `kind` | `worker`（エージェントランナー配下でソケット上で実行）または `consultation`（ツールが直接呼び出すモデルロール。プロセスなし、ランナーはスキップ） |
| `role` | `src/llm/roles.js` のモデルロール（`agent.web`, `agent.server`, `agent.advice`） |
| `prompt` | フォルダ内のプロンプトファイル（`prompt.md`）。プロンプトなしのコンサルテーションは `null` |
| `override` | デプロイがプロンプトの代わりに `prompts.local/` に配置できるファイル名（`agent-web.md`）。プロンプトがなければ `null` |
| `description` | エージェントの機能を説明する 1 文 |
| `tools` | ワーカーのみ: 要求する OpenCode ツール。シェルクラスが許可するものまで |
| `shell` | ワーカーのみ: ランナーがコードで定義するシェルクラス名（`server-read-only`, `web-download`） |
| `limits` | ワーカーのみ: タスクごとのデフォルト上限 `{ steps, usd, seconds }`。設定の `agents.<id>.limits` でオーバーライド |
| `daily` | ワーカーのみ: 1 日あたりのデフォルト上限 `{ tasks, usd }`。`agents.<id>.daily` でオーバーライド |
| `searchProvider` | ワーカーのみ: デフォルトのウェブ検索プロバイダー（`exa`）または `null` |
| `socket`, `out` | ワーカーのみ: デフォルトのソケットパスと出力フォルダ。`agents.<id>.socket` / `.out` でオーバーライド |
| `env` | ワーカーのみ: タスクがキーを持参しない場合にランナーがフォールバックする環境変数名 |

キーの欠落、不明なキー、シェルクラスが許可しないツール、ランナーが認識しないシェルクラスを持つプロファイルは、エージェント名とキーを示す 1 行のエラーでランナー（および同じフォルダを読むボット）の起動を停止させます。

## プロファイルに含まれないもの

パーミッションとセキュリティはコード（`src/agent-runner/profiles.js`, `src/agent-runner/policy.js`）に残り、プロファイルキーでは変更できません:

- パーミッションの上限: シェルクラスが付与できるツールと許可するシェルコマンド;
- シェルの拒否パターンと、すべてのエージェントに拒否されるツール（`edit`, `write`, `patch`, `task`, `question`）。`external_directory`（エージェント自身のフォルダ外のパス）も拒否されますが、server エージェントは例外で、パスツールと同じ秘匿パスルールの下でこのツールを使用できます;
- スコープフィルター、秘匿パス、結果のリダクション;
- 実行するコマンドとフォルダ外のパス（`socket` と `out` は設定がオーバーライドするデフォルト値にすぎない）。

プロファイルはコードが許可するものを狭めることしかできません: プロファイルが省略したツールは拒否されます。シェルクラスが許可しないツール、またはコードが定義しないシェルクラスは起動時に拒否されます。

## 2 つのサービス

各ワーカーは独自の systemd サービスと Unix ユーザーとして動作します（`deploy/neptunia-agent-web.service`, `deploy/neptunia-agent-server.service`。インストール手順はユニットヘッダーに記載）:

- `neptunia-agent-web`: ネットワークあり。localhost およびプライベート範囲への送信はユニット（`IPAddressDeny=`）とコードで拒否されます。ファイルシステムはステートディレクトリを除き読み取り専用です（`ProtectSystem=strict`, `ProtectHome=yes`, `InaccessiblePaths=`（`/srv`、ボットのデータと `.env`、`/var/www`、nginx、Let's Encrypt 用））。
- `neptunia-agent-server`: ネットワークはローカルリゾルバとモデル API のみ（`IPAddressDeny=any` + Cloudflare のレンジの `IPAddressAllow=`（OpenRouter の所在地）。シェルは許可リストに加えて `find -exec`、`awk` のネットワークパス、`gawk` も拒否します）。システム全体が読み取り専用です（`ProtectSystem=strict`、ステートディレクトリとプライベート `/tmp` 以外に書き込みパスなし）。唯一の書き込みコマンド `cp` はファイルをタスクフォルダにコピーすることしかできず、そこから結果ファイルとして返されます。フィルタされたスコープでは、秘匿パスは `cat` と同様に `cp` でも拒否されます。`CAP_DAC_READ_SEARCH` を持ち、root なしで任意のファイルを読めます。読み取り専用の保証はコマンドフィルターではなくユニットが提供します。

どちらも `bin/agent-runner.mjs --profile <name>` で起動します。上限、モデル価格、ソケットは設定の `agents.<profile>` から、モデルは `agent.web` と `agent.server` のモデルロールから読み取ります（`/nep model set` で設定、タスクごとに再読み込み。`run` が独自の `model` を持参することもあります）。設定の詳細は[設定: `agents`](configuration.md#agents)を参照。

## キー

すべてのキーはコア側、ボットの `.env` に格納されます。ランナー（非特権、ファイルへのアクセスは不可）はこれを読めません。コアは各タスクの `run` メッセージの `secrets` にキーを送ります。

OpenRouter キーはタスクのモデルロールのキーで、ボットが任意のロールのキーを解決するのと同じ方法で解決されます（`llm.keyByRole`）: `agent.web` と `agent.server` は `OPENROUTER_AGENT_KEY` を使います。この変数がなければシークレットは送信されません。ボットがエージェントキーで自分自身のリクエストを送ることはありません。`web` エージェントはプロキシ（`MEDIA_VIDEO_PROXY`、プロキシ自体もサーブする `http://` URL として送信）と `OPENCODE_WEBSEARCH_KEY`（設定時）も受け取ります。ランナーは OpenCode の子プロセスにキーを `OPENROUTER_API_KEY` として、プロキシを `HTTPS_PROXY` / `HTTP_PROXY`（およびその小文字形式、curl が読む形式）として、検索キーを検索プロバイダーに渡します。

ユニットの `EnvironmentFile`（`/etc/neptunia/agent-<profile>.env`、root 所有、0600）は任意です。その `OPENROUTER_AGENT_KEY`、`OPENCODE_WEBSEARCH_KEY`、`PROXY_URL` はタスクが持参しなかったものにのみ使用されます。どちらのソースからもキーがないタスクは `no-key` で失敗し、ランナーごとに 1 回の警告が出ます。シークレットがログ、ジャーナル、イベントに記録されることはありません。

オーナーの `/nep status` カードはエージェントのキーを `agents` キーとして、コーディングワーカーの `OPENROUTER_DEV_KEY`（ロール `agent.dev`）を `development` キーとして表示します。4 番目のエージェントロール `agent.advice` はボット外のコンサルテーションツールのモデル（素の OpenRouter id、シミュレーターの `OPENROUTER_SIM_KEY` 上）を指定します。エラントエージェントやボットのリクエストでは使用されません。

## プロトコル

コアはランナーの Unix ソケット（`agents.<profile>.socket`、グループ `neptunia-discord-interface`、モード 0660）に接続し、1 行に 1 オブジェクトの JSON を交換します（`src/agent-runner/protocol.js`）。

コアからランナー:

- `{ "op": "run", "id", "goal", "context": { "scope", "channel", "asker", ... }, "limits": { "steps", "usd", "seconds" }, "tools": [...], "model"?, "cost"?, "searchProvider"?, "secrets"?: { "openrouterKey", "proxy"?, "searchKey"? }, "preamble"? }`（`secrets`: 空でない文字列、他のキーなし。拒否された `run` にはエラーコードのみで値は返さない。`preamble`: 後述の共有プリアンブル、トリム後最大 8000 文字の文字列。それ以外の場合は `bad-preamble` または `preamble-too-long` で run が拒否される）
- `{ "op": "cancel", "id" }`
- `{ "op": "ping", "ids": [...] }`

ランナーからコア:

- `{ "id", "event": "progress", "step", "tool", "note" }`: タスク進行中に送信;
- 1 回の `{ "id", "event": "end", "status": "done" | "failed" | "cancelled", "result": { "text", "sources": [url...], "files": [{ "path", "name", "contentType", "bytes" }], "withheld"?: [path...], "filesDropped"?: [{ "name", "reason" }] }, "usage": { "input", "output", "usd", "steps", "seconds", "costUnknown"? }, "error"? }`（`withheld`: フィルタされたスコープ内でエージェントが拒否されたパス、最大 50。`filesDropped`: ランナーが配信しなかった結果ファイル。理由 `withheld` はフィルタされたスコープの実行が秘匿パスに到達した場合（この場合ファイルは一切配信されない）、`secret` は 2 MB 以下のテキストファイルにシークレットが含まれる場合で、すべてのスコープに適用）;
- `{ "event": "pong", "profile", "busy", "queued" }`: `ping` に対する応答。

再起動したランナーは、もう知らない `ping` の id に対して `status: "failed", error: "restarted"` の `end` を返し、コアが待機を停止できるようにします。`SIGTERM` でランナーは開いているすべてのタスクを同様に終了させて終了します。出力ファイルは `<out>/<id>/` に置かれ、コアは `agents.keepFilesHours` 後に削除します。

## スコープとリダクション

`run` は `context.scope` を持ち、`core`、`dm`、`group` のいずれかです（`src/agent-runner/policy.js`）。`core` では何も秘匿されません。`dm` と `group` では:

- `server` エージェントのファイルツールはセンシティブなパス（`/var/www`、すべての `.git`/`.local.git`、`.secrets`、`.env`、`.ssh`、`/etc/shadow`、nginx htpasswd、Let's Encrypt、`/etc/neptunia`、`/srv/neptunia-backups`、`config.local.json`、ペルソナ自身の `data/`、すべての `.agents/scratch`）の内容を拒否し、`bash` はこれらのパスを引数に持つ内容コマンド（`cat`、`head`、`tail`、`grep`、`egrep`、`fgrep`、`sed`、`awk`、`cut`、`sort`、`uniq`、`wc`、`file`、`git`）を拒否します。名前のリスト表示（`ls`、`find`、`stat`、`du`、`readlink`、`realpath`）は許可されます。拒否はステップ単位で発生します: OpenCode がその 1 つのツール呼び出しを拒否し、エージェントは拒否を見て続行し、結果の `withheld` に拒否されたパスがリストされます;
- ランナーが返すすべての結果はリダクションパスを通過し、キー・トークン・パスワードに見える文字列、秘密鍵ブロック、SSH キーマテリアル、URL のクレデンシャルを `[redacted]` に置換します。

これらのルールにもかかわらず秘匿パスに到達するコマンド（`bash -c`、リーダーへのパイプ）は事後にキャッチされます: ランナーはその出力を保持せず（進捗イベントが `withheld` とパスを報告）、パスは結果の `withheld` に追加され、タスクは続行します。エージェントは出力を見ているため、最終リダクションパスがシークレットを回答から除外する最後の砦です。

## タスクの実行方法

1 つのタスクはプロファイルの出力ディレクトリ内の新しい作業ディレクトリで実行される 1 つの `opencode run` 子プロセスです。プロジェクト/`.claude` 設定、自動更新、価格カタログの取得は無効化されており、このサーバーの情報がワーカーに漏れることはありません。エンジンは OpenCode 設定（`agents/<profile>/prompt.md` またはデプロイの `prompts.local/agent-<profile>.md` からのエージェントプロンプト、ステップ上限、スコープのパーミッションルールセット、モデルとそのコスト）を構築し、`OPENCODE_CONFIG_CONTENT` を通じて渡します。子プロセスは JSON イベントストリームを出力します。ランナーはステップごとのコストとトークンを合計し、進捗を転送し、最終のアシスタントテキストを結果として取得し、エージェントが保存したファイルをリストし、上限に達したら子プロセスを停止します。OpenCode v1.19.3 で構築。

デプロイは各エラントエージェントに 1 つの共有プリアンブルを渡せます。オプションファイル `prompts.local/agents.md` です（追跡されたデフォルトはありません。ファイルがないか空の場合、何も変わりません）。コアはライブプロンプトローダーを通じてこのファイルを読み、編集は再起動なしで次のタスクに届きます。テキストは各タスクの `run` メッセージの `preamble` として送信されます。ランナーはそれをエージェントのシステムプロンプトの先頭に配置し、空行の後にエージェント自身のプロンプトが続きます。ランナーはプリアンブルのために `prompts.local/` を読むことはありません。ファイルを読むのはコアだけなので、ユニットがプライベートディレクトリへのアクセスを遮断しているランナーでもプリアンブルを受け取れます。プリアンブルはログに記録されません。コアの `errands: sent` 行にはその長さのみが含まれます。

## ペルソナ側

コア（`src/errands/`）はペルソナのタスクをサーバーごとに `data/guilds/<id>/tasks.json`（オープンなものと最新の完了分）と `tasks.jsonl`（遷移ごとに 1 行）に保持し、各遷移を 1 つの `task` オペレーションとしてジャーナルに記録します（カウントのみ、ゴールや結果は含まない）。タスクは `queued`、`running`、そして `done`、`failed` または `cancelled` の状態を遷移します。

- オペレーション（ペルソナのスキルでもあり、グラントされるまで閉じている。[コマンド](owner-commands.md#member-commands)参照）: `task.run`（`agent`, `goal`、有料）、`task.status`（`id` は任意）、`task.cancel`（`id`）、`task.list`。誰でも `web` を依頼可能。`server` はオーナーのみ、ペルソナ経由でもそうでなくても。`task.run` は id と `queued` で即座に応答し、タスクは `agents.<profile>.limits` の制限でバックグラウンドで実行されます。プライベートチャットで依頼されたタスクは `dm` スコープ、その他は `group` で実行されます。上限は `agents.maxOpen` のオープンタスクと `agents.<profile>.daily`（UTC 日あたり）です。
- `<tasks>`: ペルソナにオープンなタスクまたはまだ見ていない完了タスクがある間、すべてのリクエストのテールに 1 行ずつ（id、エージェント、状態、経過分数、120 文字に切り詰めたゴール）。プライベートチャットのタスクはそのチャットでのみ表示。完了タスクはペルソナのターンで表示された後に閲覧済みとなります。
- `<task_result>`: タスク終了時、タスクが依頼された会話で、開始メッセージへの返信としてペルソナのターンが発生します（開始メッセージがない場合は割り込み）。ターンは通常のアテンションと同じく処理され、1 つの会話で 2 つの結果ターン間に `agents.resultCooldownSeconds` を遵守します。ブロックには id、エージェント、ゴール、状態、`agents.resultMaxChars` に切り詰めた結果テキスト、番号付きリストのソース、各ファイルのハンドルが含まれます。ペルソナは返答するか沈黙するか選べます。その後タスクは閲覧済みとなります。キャンセルされたタスクはターンを開きません。コアの再起動でオープンのまま残ったタスクは `restarted` で失敗します。
- ファイルハンドル: `file:<task id>/<name>` はタスクが保存したファイルを指します。`message.create` はこれを `file` 属性として受け取り、`<agents.<profile>.out>/<task id>/<name>` からファイルを添付します。ペルソナのタスクのファイルを指さないハンドル（またはプライベートチャット外のそのチャットのファイル）は `unknown-file` で拒否され、インターフェースの制限を超えるファイルは `attachment-too-large` で拒否されます。

## エージェントの追加

1. `agents/<id>/` を `profile.json`（既存のものをコピー）と、ワーカーの場合は `prompt.md` で作成します。
2. まだ存在しないモデルロールが必要な場合、`src/llm/roles.js` に追加します。
3. ワーカーの場合: `config.json` に `agents.<id>` ブロック、`deploy/neptunia-agent-web.service` のような systemd ユニット、ペルソナがアクセスできるように `TASK_AGENTS`（`src/ops/catalog.js`）にその名前、`src/ops/task.js` に誰が依頼できるかを追加します。
4. 既存のシェルクラスが適合しない場合、それは `src/agent-runner/profiles.js` のコード変更であり、プロファイルキーではありません。
5. `tests/agent-runner-profiles.test.js` を実行します。
