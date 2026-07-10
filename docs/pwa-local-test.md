# PWAローカル確認メモ

最終確認日: 2026-07-10  
対象: RunOS PWA / wanoku-navi PWA

このメモは、PWA移行用の最小シェルをローカルで確認する手順です。legacy HTML、実データキー、IndexedDB、外部APIには接続しません。

## 1. 初回セットアップ

```bash
npm install
```

## 2. 自動確認

```bash
npm test
npm run build
```

## 3. 開発サーバー

RunOS:

```bash
npm run dev:runos
```

wanoku-navi:

```bash
npm run dev:wanoku
```

開発サーバーでは、過剰キャッシュを避けるためService Worker登録をスキップします。画面のService Worker欄に「開発環境では登録をスキップ」と表示されることを確認します。

## 4. previewサーバー

先に `npm run build` を実行してから確認します。

RunOS:

```bash
npm run preview:runos
```

wanoku-navi:

```bash
npm run preview:wanoku
```

previewではビルド済み成果物を配信するため、Service Worker登録確認に使います。

## 5. PCブラウザ確認

ChromeまたはEdgeで次を確認します。

- 保存デモが `runos-pwa.demo.settings` / `wanoku-pwa.demo.settings` だけを使う
- 破損JSON注入で `<key>.corrupt.<timestamp>` が表示される
- RunOSのペース計算デモで距離、分、秒から平均ペースが表示される
- wanoku-naviの風向差デモで2つの角度から `angleDiff` 結果が表示される
- DevTools consoleに保存サイズログとService Worker登録成功/失敗ログが出る

## 6. Applicationタブ確認

Chrome / Edge DevTools の Application タブで次を確認します。

- Manifest
  - `name`
  - `short_name`
  - `start_url`
  - `scope`
  - `display`
  - `theme_color`
  - `background_color`
  - `icons`
- Service Workers
  - preview時に `sw.js` が登録される
  - dev時に古い登録が残っていない
- Storage
  - demoキーだけが作成される
  - legacyの `meridian.v1` やwanoku Storeキー群へ接続していない

## 7. iPhoneホーム画面確認前の注意点

- Service Worker確認にはHTTPSまたはlocalhost相当の配信が必要
- ホーム画面追加前にmanifest、icon、scope、start_urlを確認する
- 通常Safariタブとホーム画面起動で保存領域・画面高さが異なる可能性がある
- localStorageは消える可能性があるため、実データ接続前にバックアップ導線を確認する
- iPhone実機での確認前に、legacy HTMLの実データキーへ接続しない
- 正式アイコンは未作成で、現在はSVGプレースホルダーである

## 8. デプロイ候補

- Cloudflare Pages
  - wanoku-naviで将来Worker連携やAPIキー保護を行うなら第一候補
  - 現時点ではWorker未実装のため、静的PWAとして先に検証する
- Vercel
  - preview URLでPWAシェルを確認しやすい
  - UI移行の途中確認に向く
- GitHub Pages
  - 静的PWAとして最も単純
  - サブパス配信時はmanifestの `start_url` / `scope` とVite `base` を必ず確認する

現構成で最初に試すなら、静的確認はGitHub PagesまたはVercel、将来のwanoku Worker連携を見据えるならCloudflare Pagesが扱いやすいです。
