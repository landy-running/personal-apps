# Cloudflare Pages 公開設定と確認手順

最終確認日: 2026-07-10  
対象: RunOS PWA / RunOS Legacy PWA / Wanoku PWA

この文書は、Cloudflare Pagesで公開済みのRunOS PWA、RunOS Legacy PWA、Wanoku PWAの設定、確認手順、次フェーズ候補を記録する。RunOS Legacy PWAは完成済みの `runos/RunOS v100 apex.html` をPWA配信するための構成であり、元HTML、実データキー、IndexedDB、外部API、Cloudflare Workerにはまだ接続しない。

## 1. 前提

- PWAソース:
  - `apps/runos-pwa`
  - `apps/runos-legacy-pwa`
  - `apps/wanoku-pwa`
- 共通・core:
  - `packages/runos-core`
  - `packages/wanoku-core`
  - `packages/storage`
- build output:
  - RunOS: `dist/runos-pwa`
  - RunOS Legacy: `dist/runos-legacy-pwa`
  - Wanoku: `dist/wanoku-pwa`
- build scripts:
  - `npm run build:runos`
  - `npm run build:runos-legacy`
  - `npm run build:wanoku`
  - `npm run build`

APIキーやsecretはクライアント配布物へ埋め込まない。WanokuのAI/外部情報連携が必要になった場合も、Cloudflare Worker等の管理されたバックエンド側へ分離してから扱う。Worker本体はこの段階では実装しない。

## 2. 公開方針

RunOS PWAとWanoku PWAは、2つのCloudflare Pagesプロジェクトとして分けて公開する。短期のRunOS本線はRunOS Legacy PWAとし、完成済みの `runos/RunOS v100 apex.html` をCloudflare PagesでPWA配信する。既存の `apps/runos-pwa` は削除せず、TypeScript化・再実装検証用の基盤として残す。

理由:

- アプリごとにoriginが分かれ、localStorageとService Worker scopeを分離しやすい
- iPhoneホーム画面追加時に、アプリ名・アイコン・起動URLを個別確認しやすい
- 将来WanokuだけWorker/API連携を進める場合に、設定と権限を分けやすい
- RunOSのランニングデータとWanokuの釣行データを同一originに置かない方が安全

## 3. RunOS PWA 公開設定

公開状態: Cloudflare Pages初回公開済み

| 項目 | 値 |
|---|---|
| Root directory | repository root |
| Build command | `npm run build:runos` |
| Build output directory | `dist/runos-pwa` |
| Environment variables | `NODE_VERSION=20` |
| Production URL | 未記録。Cloudflare Pages画面から追記する |
| 最新deployment日時 | 未記録。Cloudflare Pages画面から追記する |

公開後に確認すること:

- Pagesの最新deploymentがSuccess
- HTTPS URLでRunOS PWAが表示される
- manifestが読み込まれる
- `sw.js` が登録される
- 画面のService Worker欄が登録成功または状態を表示する
- 保存デモが `runos-pwa.demo.settings` だけを使う
- legacyの `meridian.v1` を作成・更新していない
- ペース計算デモが動く
- 破損JSON注入で `runos-pwa.demo.settings.corrupt.<timestamp>` が表示される

## 3.1 RunOS Legacy PWA 公開設定

公開状態: Cloudflare Pages公開済み
公開方針: 短期のRunOS本線。完成済みの `runos/RunOS v100 apex.html` をビルド時に `dist/runos-legacy-pwa/index.html` へコピーし、配信用のmanifest、Service Worker、仮iconを付与する。

| 項目 | 値 |
|---|---|
| Root directory | repository root |
| Build command | `npm run build:runos-legacy` |
| Build output directory | `dist/runos-legacy-pwa` |
| Environment variables | `NODE_VERSION=20` |
| Production URL | 未記録。Cloudflare Pages画面から追記する |
| 最新deployment日時 | 未記録。Cloudflare Pages画面から追記する |

正しいCloudflare Pages設定:

- Root directory: repository root
- Build command: `npm run build:runos-legacy`
- Build output directory: `dist/runos-legacy-pwa`

誤設定例:

- Build command に `dist/runos-legacy-pwa` を入れない
- `dist/runos-legacy-pwa` はビルド成果物の出力先であり、実行コマンドではない
- Build command は必ず `npm run build:runos-legacy` とし、Cloudflare Pagesにはその結果生成される `dist/runos-legacy-pwa` を配信させる

ビルド時の扱い:

- 元HTML `runos/RunOS v100 apex.html` は変更しない
- 出力先の `index.html` にだけmanifest参照、iPhone用meta、Service Worker登録コードを付与する
- `meridian.v1` の保存形式・キー名・既存保存処理は変更しない
- Service Workerは `index.html`、`manifest.webmanifest`、`sw.js`、`icons/icon.svg` のような静的配信物だけをCache Storageへ入れる
- localStorage上の個人データ、FITファイル、バックアップJSON、`meridian.v1` はCache Storageへ入れない

公開成功後に確認すること:

- Pagesの最新deploymentがSuccess
- HTTPS URLで旧HTML版RunOSが `index.html` として表示される
- manifestが読み込まれる
- `sw.js` が登録される
- ApplicationタブでService WorkerのscopeがRunOS Legacy PWA配信先に収まっている
- 初回表示後、オフライン相当で再読み込みして最低限の画面が表示される
- 既存の `meridian.v1` 保存・読込挙動が変わっていない
- 保存失敗警告、破損退避、バックアップ書き出し導線が旧HTML版の実装どおり動く
- Cache Storageに個人データやバックアップJSONが保存されていない
- RunOS Legacy PWAを通常SafariタブとiPhoneホーム画面起動の両方で開ける

## 4. Wanoku PWA 公開設定

公開状態: Cloudflare Pages初回公開済み

| 項目 | 値 |
|---|---|
| Root directory | repository root |
| Build command | `npm run build:wanoku` |
| Build output directory | `dist/wanoku-pwa` |
| Environment variables | `NODE_VERSION=20` |
| Production URL | 未記録。Cloudflare Pages画面から追記する |
| 最新deployment日時 | 未記録。Cloudflare Pages画面から追記する |

公開後に確認すること:

- Pagesの最新deploymentがSuccess
- HTTPS URLでWanoku PWAが表示される
- manifestが読み込まれる
- `sw.js` が登録される
- 画面のService Worker欄が登録成功または状態を表示する
- 保存デモが `wanoku-pwa.demo.settings` だけを使う
- legacyの `settings`、`logs` 等の既存Storeキー群を作成・更新していない
- 風向差デモが動く
- 破損JSON注入で `wanoku-pwa.demo.settings.corrupt.<timestamp>` が表示される

## 5. ローカル確認

```bash
npm install
npm test
npm run build
```

個別確認:

```bash
npm run build:runos
npm run preview:runos
```

```bash
npm run build:runos-legacy
npm run preview:runos-legacy
```

```bash
npm run build:wanoku
npm run preview:wanoku
```

previewでは、Chrome / Edge DevToolsのApplicationタブでmanifest、Service Worker、demo localStorageキーだけを確認する。

## 6. Service Worker / manifest / offline / storage demo 確認

両PWA共通で確認する。

### Service Worker

- dev時は過剰キャッシュ防止のため登録をスキップする
- preview / Cloudflare Pages上では `sw.js` が登録される
- 画面上のService Worker状態欄に状況が表示される
- consoleに登録成功または失敗ログが出る
- 更新後に古いcacheが残り続けない
- RunOS Legacy PWAでは、Service Workerは静的配信物のみを最小キャッシュし、localStorageの個人データは扱わない

### manifest

Applicationタブで次を確認する。

- `name`
- `short_name`
- `start_url`
- `scope`
- `display`
- `theme_color`
- `background_color`
- `icons`

現在のアイコンはSVGプレースホルダーであり、正式アイコンは未作成。

### offline

- オンライン状態で一度表示する
- DevToolsまたは端末設定でオフライン相当にする
- 再読み込み時に最低限のアプリシェルが表示される
- RunOS Legacy PWAでは、旧HTML版の `index.html` がオフライン再表示できることを確認する
- 外部API接続はまだないため、外部データの鮮度表示は対象外

### storage demo

- RunOSは `runos-pwa.demo.settings` だけを使う
- Wanokuは `wanoku-pwa.demo.settings` だけを使う
- 破損JSON注入で `<key>.corrupt.<timestamp>` が表示される
- legacy実データキーへ接続していない
  - RunOS: `meridian.v1`
  - Wanoku: `settings`、`logs` 等

## 7. iPhoneホーム画面追加後の確認チェックリスト

RunOS Legacy PWA、RunOS PWA、Wanoku PWAをそれぞれ個別に確認する。短期のRunOS本線はRunOS Legacy PWAなので、RunOSは特にlegacy版を優先して確認する。

### 共通確認

- SafariでCloudflare PagesのHTTPS URLを開ける
- 共有メニューからホーム画面へ追加できる
- ホーム画面アイコンからstandalone風に起動する
- 起動URLが意図したPWAを指す
- manifestの `name` / `short_name` が期待どおり表示される
- Service Worker状態表示が成功または状況を示す
- safe areaとホームインジケーターにUIが重ならない
- アドレスバー有無による高さ変化で表示が崩れない
- 入力欄タップ時にキーボードで結果表示が隠れすぎない
- demo保存後、アプリ再起動で読込確認できる
- 破損JSON注入後、破損退避表示が出る
- オフラインまたは機内モード時に最低限のアプリシェルが表示される
- 通常Safariタブとホーム画面起動で保存挙動に差がないか確認する

### RunOS Legacy PWA確認

- 旧HTML版RunOSの主要画面がホーム画面起動でも表示される
- `meridian.v1` の保存・読込形式が変わっていない
- 保存失敗警告、破損データ退避、バックアップ書き出し導線がPWA配信後も表示される
- FIT取込、バックアップ書き出し、ファイル選択など、iPhone Safariで壊れやすい操作を最低1回確認する
- Cache Storageには静的配信物だけが入り、`meridian.v1` やバックアップJSONが入っていない
- Service Worker更新後も古いHTMLが残り続けないか、再読み込みとホーム画面再起動で確認する

注意:

- iPhone SafariのlocalStorageやCache StorageはOS都合で削除され得る
- ホーム画面追加時と通常Safariタブで保存領域や表示挙動が異なる可能性がある
- 正式アイコンは未作成
- 実データ接続前にバックアップ/復元導線を再確認する

## 8. 次フェーズ候補

優先順位は、保存安全性 → ロジック分離 → テスト → UI移行を維持する。

### 1. IndexedDB設計

- 実装前にスキーマ、移行、ロールバック、バックアップ形式を設計する
- 旧localStorageを即削除しない
- RunOSは活動メタデータ、FITストリーム、分析キャッシュを分ける
- Wanokuは設定、ログ、予測、外部情報、学習履歴を論理グループ化する
- まず `packages/storage` の契約にIndexedDB候補の型だけを追加する

### 2. バックアップ/復元

- PWA側でも通常バックアップと破損元データ書き出しを分ける
- RunOSは `meridian.v1` 互換の読込前にバックアップ導線を置く
- Wanokuは複数キー保存が非トランザクションであることをUIに反映する
- 復元時はスキーマ検証と失敗時の元データ保全を先に設計する

### 3. 軽量実データ入力画面

- 実データキーへ接続する前に、demoキーで入力・保存・復元の流れを確認する
- RunOS候補:
  - 手入力の短いラン記録
  - 距離、時間、メモのみ
  - FIT解析や既存 `meridian.v1` 接続はまだ行わない
- Wanoku候補:
  - 釣行メモの簡易入力
  - 日時、場所名、魚種、メモのみ
  - 潮汐、スコアリング、外部API接続はまだ行わない

### 4. RunOS Strava連携

- RunOS Legacy PWAを短期本線にしたまま、Strava連携はCloudflare Worker経由で進める
- Stravaのclient secretやaccess tokenはクライアントへ埋め込まない
- Worker側でOAuth、token更新、API呼び出し、エラー整形を扱う
- PWA側はWorkerの公開APIだけを呼び、失敗時は既存の手動入力・バックアップ導線を維持する
- Worker本体はまだ実装しない。先にOAuthフロー、保存先、token失効時の挙動、ユーザーへの表示を設計する

## 9. まだ行わないこと

- legacy HTMLの削除や置換
- RunOSの `meridian.v1` へのPWA接続
- Wanokuの既存Storeキー群へのPWA接続
- IndexedDB実装
- Cloudflare Worker実装
- 外部API接続
- RunOS Strava連携のクライアント直実装
- APIキーやsecretのクライアント埋め込み
- 正式アイコン作成
