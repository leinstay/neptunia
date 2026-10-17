# インターフェース: コアとアダプター間のプロトコル

エンジンには 2 つの側面があります: コア（ペルソナ、その記憶、いつどのように発言するかの判断）とインターフェース（ペルソナが存在するチャットプラットフォーム）です。インターフェースアダプターはプラットフォーム上のイベントをコアへのインバウンドイベントに変換し、コアが返すアクションを実行します。各アクションは結果を返します。両者間のコントラクトは `packages/protocol/`（`@neptunia/protocol`）にあります: プレーンオブジェクト、ビルドステップなし、依存なし、どちら側にもプラットフォーム型なし。

| ファイル | 内容 |
|---|---|
| `packages/protocol/events.js` | インバウンドイベントの種類とその形状 |
| `packages/protocol/actions.js` | アクション名、結果の形状、ポートヘルパー（`ok`, `notOk`, `mentionsOf`、拒否、`declaredHooks`） |
| `packages/protocol/validate.js` | `validateEvent(event)` と `validateAction(action)` |

エンジンは `src/protocol.js` を通じてパッケージをインポートします（パッケージが npm workspace になったときに素の `@neptunia/protocol` 指定子に切り替える唯一の場所）。`src/interface/port.js` がアウトバウンド側を再エクスポートします。Discord アダプターは `interfaces/discord/`（`@neptunia/interface-discord`、`src/interface/discord.js` 経由でアクセス）パッケージです: `port.js`（アクション）と `collect.js` のイベントビルダー（`toEvent`, `reactionEvent`）。テスト用のインメモリアダプターは `src/interface/fake.js` です。

コアは Discord にコンポジションルートが渡すものを通じてのみアクセスします。ポートに加え、`createDiscordInterface({ client })` はフリーズされた capabilities オブジェクトを返します: コアが Discord に名前で問い合わせる関数（ペルソナがチャンネルで読み取り、送信、添付、リアクションできるか、チャンネルの履歴、表示する別のチャンネル、サーバーのメッセージとメンバーの検索、メッセージのプロトコルイベントへの変換とその逆）。`src/index.js` がこれを一度構築し、必要なすべてのモジュールに `discord` として渡します: ファクトリーにはオプション経由で、オペレーションには環境（`env.discord`）経由で、純粋なヘルパーにはパラメーターとして。`src/` 配下で Discord インターフェースをインポートする他のファイルはないため、テストやツールは同じ関数またはそのフェイクを渡せます。

## ルール

- ID は不透明な文字列です。会話、メッセージ、メンバー、絵文字、イベント ID は、それを作成したアダプターだけが読み方を知る文字列です。コアは ID を比較しますが、パースはしません。アクション内の参照はアダプターの `iface`（`discord`, `fake`）で名前空間化されます。
- プラットフォームオブジェクトは境界を越えません。イベントやアクションはプレーンなシリアライズ可能オブジェクトです。Discord アダプターは、まだエンジン内部に存在する間、イベントに `raw`（編集の場合は `rawPrevious`）を付加します: discord.js オブジェクトのハンドルで、Discord 側でのみ読み取り、`src/behavior/` では読み取られず、バリデーションからは無視され、アダプターが別パッケージに移動した後に除去されます。
- メンションはアドレッシングです。ペルソナをメンションする、またはペルソナに返信するメッセージは、`addressing` がそれを示す 1 つの `message.received` であり、別のイベントではありません。
- ダイレクトチャットは会話の種類です。プライベートメッセージは `dm` 種別の会話における `message.received` であり、別のイベント種別ではありません。
- バリデーションは例外をスローしません。`validateEvent` と `validateAction` はどちらも `{ ok: true }` または `{ ok: false, reason }` を返します。`reason` はフィールドと問題を示します（`message.at:type`、`kind:unknown`、`conversation.id:required`）。コアは無効なインバウンドイベントを 1 行の警告（`interface: invalid event`、種類と理由を含むが内容は含まない）で破棄します。フェイクアダプターは無効なアクションを `failed`（コード `invalid-action`）として拒否します。
- バリデーションは形状のみをチェックします。種類、必須キー、文字列 ID、有限数値、フラグをチェックします。参照がこのインターフェースに属するか、内容が制限に収まるか、コマンドを実行できるのは誰かはアダプターとコアの責任です。

## インバウンドイベント

すべてのイベントは `kind`、`iface`（アダプターの名前空間）、`at`（エポックからのミリ秒）、`id`（重複排除用の不透明なイベント ID）を持ち、会話内で起きるものには `conversation` オブジェクトがあります:

| フィールド | 内容 |
|---|---|
| `id` | 会話の ID |
| `kind` | `channel`、`dm` または `thread` |
| `guildId` | 所属するコミュニティ。ダイレクトチャットでは null または不在 |
| `name`, `topic`, `category` | 参加者に見えるもの。不明な場合は null または不在 |

5 種類のイベント:

| 種類 | 送信元 | ペイロード |
|---|---|---|
| `message.received` | アダプター | `message`, `addressing`。編集の場合 `edit: true`（同じメッセージ ID）、削除の場合 `deleted: true`（`message.id` のみ）、アダプターが全体を読めなかった編集の場合 `edit: true, partial: true`（`message.id` のみ。コアがアダプターに残りを問い合わせる） |
| `reaction.changed` | アダプター | `messageId`, `emoji`（`{ name, id? }`: `name` は Unicode 絵文字自体またはカスタム絵文字の名前、`id` はカスタム絵文字の ID。いずれか一方が必須）、`userId`、`added`（付加時 true、除去時 false） |
| `command.requested` | アダプター | `name`（`group.sub` または `sub`）、`args`（オブジェクト）、`requester`（`{ id, name, roles, owner }`: `name` は null の場合あり、`roles` はロール ID、`owner` は設定されたオーナーに含まれるか。情報提供用: コアが権限を自分でチェック）、`replyRef`（不透明トークン。応答はこれを持つ `command.result` アクションとして返る） |
| `scheduler.tick` | コア | `at` のみ: コア自身のクロック。アダプターはこの種類を送信しない。`iface`、`id`、`conversation` は不要 |
| `task.completed` | コア | `taskId`, `status`, `result`（`src/errands` の定義通り）。`iface`、`id`、`conversation` は不要 |

`message`:

| フィールド | 内容 |
|---|---|
| `id` | メッセージの ID |
| `author` | `{ id, name, self, bot }`: `name` は表示名または null、`self` はペルソナ自身のメッセージで true、`bot` は別の自動化アカウント |
| `content` | 人が読むテキスト（メンションは名前で表記） |
| `at` | 書かれた時刻 |
| `replyToId` | 返信先のメッセージ、または null（転送は何にも返信しない） |
| `replyPingUserId` | 返信のみで通知された返信先の著者、または null |
| `forwardedFrom` | 転送元の会話名、または null |
| `attachments`, `links`, `forwarded`, `stickers`, `emojis`, `reactions` | `interfaces/discord/collect.js#normalizeMessage` が与える形状の配列 |

`addressing`:

| フィールド | 内容 |
|---|---|
| `mentioned` | ペルソナがメンションされたメンバーに含まれている |
| `replyToSelf` | アダプターがプラットフォームに再問い合わせせずに把握できる限り、メッセージがペルソナのメッセージへの返信である（コアがさらにチェックする場合あり） |
| `mentionedUserIds` | メッセージがメンションしたすべてのメンバー |
| `mentionedConversationIds` | メッセージがメンションしたすべての会話 |

## アクション

すべてのアクションは `action` 名を持つプレーンオブジェクトです。最初の 6 つはポートの capabilities であり、アダプターが `capabilities().operations` でリストする名前です:

| アクション | フィールド |
|---|---|
| `message.send` | `conversation`（`{ iface, conversationId }`）、`content` |
| `message.edit` | `message`（`{ iface, conversationId, messageId }`）、`content` |
| `message.delete` | `message` |
| `message.react.add` | `message`、`emoji`（文字列） |
| `message.react.remove` | `message`、`emoji` |
| `conversation.typing` | `conversation` |
| `command.result` | `replyRef`（`command.requested` から）、`text`、任意の `files`、任意の `ephemeral`（リクエスター本人にのみ表示） |

`content` は `{ text?, attachments?, replyTo?, mentions? }` です: `attachments` は `{ name, data?, url?, contentType? }`、`replyTo` は同じインターフェースのメッセージ参照、`mentions` は `{ users, repliedUser }`（メッセージが通知できるメンバー）。mentions が不在の場合、誰にも通知されません。null のパーツは不在として扱われます。

## 結果

すべてのアクションは結果を受け取ります。アダプターは例外をスローしません。

| フィールド | 内容 |
|---|---|
| `status` | `ok`、`failed`（アクションが実行されなかったことが確定）、`unknown`（アクションが実行された可能性があるため盲目的な再試行は不可）、`unsupported`（このインターフェースはアクションを実行できない）、`forbidden`（このインターフェースにはその権限がない、例えば他人のメッセージの削除） |
| `ref` | 現在のメッセージ（送信の場合は新しいメッセージ）。存在する場合 |
| `at` | インターフェースが結果にタイムスタンプを付けた時刻。報告される場合 |
| `error` | `{ code, retryable }`（ステータスが `ok` でない場合）: `code` は kebab-case 文字列（`empty-content`、`text-too-long`、`invalid-attachment`、`attachment-too-large`、`foreign-reference`、`invalid-reference`、`not-own-message`、`unknown-message`、`invalid-action`、`timeout`）または `http-<status>`、`retryable` は後で再試行が成功する可能性があるか。アダプターは自身のログ用に `cause` を追加できるが、モデルには届かない |

アダプターはペルソナ自身のメッセージのみ編集・削除し（それ以外は `forbidden` を返す）、別のインターフェースの参照を `foreign-reference` として拒否します。

## 未実装

Discord アダプターは独自のパッケージ（`interfaces/discord/`）ですが、まだエンジンのプロセス内で動作しており、後のステージで分離されます。それまでの間、メッセージパイプラインはイベントから再構築された正規化メッセージを読み、オーナーコマンドは `command.result` アクションではなく直接返信で応答され、コアの `scheduler.tick` と `task.completed` は 1 つのディスパッチャーを通じたイベントではなく直接呼び出しです。
