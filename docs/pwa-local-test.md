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

## 3. RunOS PWA起動

```bash
npm run dev:runos
```

ブラウザで表示されたローカルURLを開き、次を確認します。

- 保存デモが `runos-pwa.demo.settings` だけを使う
- 破損JSON注入で `<key>.corrupt.<timestamp>` が表示される
- ペース計算デモで距離、分、秒から平均ペースが表示される

## 4. wanoku-navi PWA起動

```bash
npm run dev:wanoku
```

ブラウザで表示されたローカルURLを開き、次を確認します。

- 保存デモが `wanoku-pwa.demo.settings` だけを使う
- 破損JSON注入で `<key>.corrupt.<timestamp>` が表示される
- 風向差デモで2つの角度から `angleDiff` 結果が表示される

## 5. PCブラウザ確認

- DevTools consoleに保存サイズログが出ること
- リロード後もデモ保存が読めること
- 破損検知後に保存停止表示へ進めること
- `npm run build` の `dist/runos-pwa` と `dist/wanoku-pwa` が生成されること

## 6. iPhoneホーム画面確認前の注意点

- Service Worker確認にはHTTPSまたはlocalhost相当の配信が必要
- ホーム画面追加前に、manifest、icon、scope、start_urlを確認する
- 通常Safariタブとホーム画面起動で保存領域・画面高さが異なる可能性がある
- localStorageは消える可能性があるため、実データ接続前にバックアップ導線を確認する
- iPhone実機での確認前に、legacy HTMLの実データキーへ接続しない
