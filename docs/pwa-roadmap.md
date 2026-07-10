# PWA化ロードマップ

最終確認日: 2026-07-10  
対象: RunOS / wanoku-navi

この文書は、既存の単一HTMLをlegacy版として残しながら、Vite + TypeScript + PWA構成へ段階移行するための計画です。現時点では実装を開始せず、`AGENTS.md`、現行設計メモ、保存仕様、テストケース文書を前提にした作業順を定義します。

## 1. 前提と非目標

- 現行HTMLは削除・改名・直接分割しない。
- legacy版は新PWAの比較対象、復旧手段、仕様確認元として残す。
- 優先順位は既存ロードマップどおり、保存安全性 → ロジック分離 → テスト → UI移行とする。
- Vite / TypeScript / PWA化を理由に、保存形式、計算式、スコアリング、外部API仕様を同時変更しない。
- IndexedDB、Service Worker、manifestは将来の実装候補だが、この文書では方針整理に留める。

## 2. 目標構成

推奨する最終形は、legacy版と新PWA版を並行保持する構成です。

```text
runos/
  RunOS v100 apex.html        # legacy版。比較対象として維持
wanoku-navi/
  wanoku navi v27 yakou.html  # legacy版。比較対象として維持
apps/
  runos-pwa/                  # Vite + TypeScript + PWA版
  wanoku-pwa/                 # Vite + TypeScript + PWA版
packages/
  shared/                     # 日付、保存、バックアップ、エラー表現など
  runos-core/                 # RunOSの純粋計算、保存型、変換処理
  wanoku-core/                # wanoku-naviの純粋計算、保存型、変換処理
docs/
  *.md                        # 現行仕様、テストケース、移行計画
```

初期段階では、`apps/*-pwa` はlegacy HTMLを置き換えるものではありません。まずはTypeScriptで保存境界と純粋ロジックを検証できる場所として作ります。

## 3. RunOS のPWA要件

- `meridian.v1` の現行localStorage形式を読み取れる互換層を持つ。
- PWA側が保存を始める前に、通常バックアップを書き出せる導線を維持する。
- FIT由来ストリーム、GPS、ラップ、心拍など大容量データは、将来的にIndexedDBへ分離する。
- IndexedDB移行時も `meridian.v1` を即削除せず、移行成功確認とロールバック方針を持つ。
- オフライン時も、既存の活動閲覧、主要指標、計画確認、バックアップ書き出しは使えるようにする。
- 天候、位置情報など外部通信が必要な機能は、失敗表示と前回値・未取得状態を明確にする。
- FIT解析や重い指標計算は、まずテストで現行結果を固定し、その後にWorker化を検討する。

## 4. wanoku-navi のPWA要件

- 現行Storeキー群を読み取れる互換層を持つ。
- `Store.mode`、破損ロック、メモリ保存モード相当の状態をPWA側でも表現できるようにする。
- 複数キー保存は現行どおり非トランザクションであるため、IndexedDB移行時は論理グループ単位のトランザクション設計を先に行う。
- オフライン時も、スポット、ログ、潮汐計算、保存済み予測、バックアップ書き出しは最低限使えるようにする。
- JMA、AI、外部釣果、地図タイルは通信失敗を通常ケースとして扱う。
- APIキーはクライアント配布物へ埋め込まない。必要な場合はCloudflare Worker等の管理されたバックエンド経由にする。
- Worker本体が現リポジトリにない前提を維持し、存在しないWorkerに依存した完了判定をしない。
- 地図タイルのオフラインキャッシュは、規約、容量、iPhone Safariのキャッシュ削除を考慮して慎重に扱う。

## 5. iPhone Safari / ホーム画面追加の確認項目

- HTTPS配信でService Workerが登録できること。
- ホーム画面追加後に `display: standalone` 相当で起動できること。
- 通常Safariタブとホーム画面起動で、保存領域、画面高さ、戻る操作に差がないか確認すること。
- `viewport-fit=cover`、safe area、下部固定UI、ホームインジケーターの重なりを確認すること。
- `100vh` 依存を避け、`dvh` / `svh` / 実測高さの必要性を確認すること。
- ソフトウェアキーボード表示中の入力欄、ボトムシート、スクロール位置を確認すること。
- JSON / CSV / FITのファイル選択とBlobバックアップ保存を確認すること。
- オフライン起動、低速回線、再読み込み、Service Worker更新直後の挙動を確認すること。
- localStorage / IndexedDB / Cache Storage が容量制限やOS都合で削除され得る前提で警告とバックアップ導線を残すこと。
- iOS Safariではバックグラウンド同期、Push、永続ストレージ保証を前提にしないこと。

## 6. manifest / icons / Service Worker / offline cache / IndexedDB / backup 方針

### manifest

- RunOSとwanoku-naviで別manifestを持つ。
- `name`、`short_name`、`start_url`、`scope`、`display`、`theme_color`、`background_color` を明示する。
- 配信パスがサブディレクトリになるGitHub Pages等では、`start_url` と `scope` のズレに注意する。

### icons

- 192px、512px、maskable icon、apple touch iconを用意する。
- iPhoneホーム画面で判別しやすいよう、RunOSとwanoku-naviは別アイコンにする。
- アイコン作成は実装タスクとして分離し、PWA設定や保存移行と同じ差分に混ぜない。

### Service Worker

- まずはViteの静的アセットとアプリシェルだけをキャッシュする。
- 保存データ、APIキー、個人情報をService Worker cacheへ不用意に入れない。
- 更新時は旧キャッシュ削除、バージョン表示、再読み込み案内を設計する。
- 外部APIは原則 network-first または失敗時フォールバックとし、古い情報を最新情報として見せない。

### offline cache

- 最小構成はHTML、JS、CSS、manifest、icons、必要な静的データ。
- 地図タイル、AI応答、外部釣果、天気応答は容量と鮮度の管理方針が決まるまで広範囲にキャッシュしない。
- RunOSのFITファイル本体やwanoku-naviのログは、Cache Storageではなく保存層で扱う。

### IndexedDB

- いきなり全面移行しない。
- 先に保存アダプター、スキーマバージョン、移行結果、ロールバック、バックアップの責務を定義する。
- RunOSは活動メタデータ、FITストリーム、分析キャッシュを分ける。
- wanoku-naviは設定、ログ、予測、外部情報、学習履歴を論理グループ化する。
- 旧localStorageは並行読込し、移行成功確認前に削除しない。

### backup

- PWA化後も明示的なJSONバックアップ書き出しを残す。
- IndexedDB移行前後で、旧形式と新形式のどちらを出力しているか画面上で分かるようにする。
- 破損元データの書き出しと通常バックアップを混同しない。
- PWA更新、保存層移行、初回IndexedDB書込の前にはバックアップ導線を出す。

## 7. 配信候補の比較

| 候補 | 向いている用途 | 強み | 注意点 |
|---|---|---|---|
| Cloudflare Pages | wanoku-navi中心、Worker連携が必要な構成 | Pages Functions / Workers / KV等と近く、APIキーをサーバー側へ寄せやすい | Worker本体とAPI契約を先に確定する必要がある |
| Vercel | Vite PWAのプレビュー、UI移行の検証 | Preview URL、環境変数、Serverless/Edge Functionsが扱いやすい | 長期的なWorker運用や外部API制限は別途設計が必要 |
| GitHub Pages | 静的PWA、legacy比較、ドキュメント公開 | 構成が単純で無料運用しやすい | 秘密鍵を置けず、APIプロキシも持てない。サブパス配信時のmanifest scopeに注意 |

wanoku-naviでAIや外部情報取得を安全に扱うなら、第一候補はCloudflare Pages + Workerです。RunOSのみの静的PWA検証なら、GitHub PagesやVercel Previewでも始めやすいです。

## 8. 最初の5タスク

1. **PWA新規配置先だけを決める**
   - `apps/runos-pwa`、`apps/wanoku-pwa`、`packages/*` の採用可否を決める。
   - legacy HTMLは変更しない。

2. **保存アダプターのTypeScript契約を設計する**
   - RunOSの `meridian.v1`、wanoku-naviのStoreキー群、破損退避、バックアップ、メモリモードを型として表す。
   - まだIndexedDB実装はしない。

3. **テストfixtureを先に用意する**
   - `docs/runos-test-cases.md` と `docs/wanoku-test-cases.md` から、固定入力と期待性質を小さなfixtureへ落とす。
   - UI移行より先に、現行結果の変化を検知できるようにする。

4. **純粋ロジックを小さくTypeScriptへ写す**
   - RunOSはペース変換や負荷指標の一部から始める。
   - wanoku-naviは `angleDiff`、潮汐の固定例、保存通知判定などから始める。
   - 既存HTMLの挙動と差がないことを確認する。

5. **最小PWAシェルを作る**
   - manifest、icons、Service Worker、オフライン起動だけを確認する。
   - 実データ保存や本格UI移行はまだ行わない。
   - iPhone Safariとホーム画面追加で表示、起動、更新、バックアップ導線を確認する。

## 9. 完了判定

このロードマップの初期段階は、次を満たしたら完了とします。

- legacy HTMLがそのまま残っている。
- 新PWA側の保存境界が、現行仕様書と矛盾していない。
- 主要ロジックの固定入力と期待結果がテスト可能になっている。
- iPhone Safari / ホーム画面追加で、起動、表示、保存、バックアップの確認手順がある。
- 問題が出た場合にlegacy版へ戻れる。
