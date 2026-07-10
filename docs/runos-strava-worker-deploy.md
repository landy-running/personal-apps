# RunOS Strava Worker デプロイ手順

最終確認日: 2026-07-10  
対象: `workers/runos-strava-worker`

この文書は、RunOS Legacy PWA向けStrava WorkerモックをCloudflareへデプロイするための手順です。現時点ではStrava本接続を行わず、`/health`、`/auth/start`、`/auth/callback`、`/activities` のモック応答だけを確認します。

## 1. 前提

- RunOS本線は `runos/RunOS v100 apex.html` をPWA配信するRunOS Legacy PWA
- Workerは `workers/runos-strava-worker`
- `client_secret`、`refresh_token`、`access_token` はPWA/HTML/localStorageへ置かない
- `meridian.v1` へは書き込まない
- Strava本接続、token交換、token保存はまだ行わない

## 2. npm scripts

追加済みscript:

```bash
npm run worker:runos-strava:dev
npm run worker:runos-strava:deploy
```

これらは `npx wrangler` を使います。初回実行時はWranglerの取得やCloudflareログインが必要になる場合があります。

## 3. ローカル起動

```bash
npm run worker:runos-strava:dev
```

または直接実行:

```bash
npx wrangler dev --config workers/runos-strava-worker/wrangler.toml
```

ローカル確認URL例:

```text
http://localhost:8787/health
http://localhost:8787/auth/start
http://localhost:8787/auth/callback?code=mock-code&scope=activity:read&state=mock-state
http://localhost:8787/activities
```

## 4. Cloudflareデプロイ

Cloudflareへログイン:

```bash
npx wrangler login
```

モックのままデプロイ:

```bash
npm run worker:runos-strava:deploy
```

または直接実行:

```bash
npx wrangler deploy --config workers/runos-strava-worker/wrangler.toml
```

デプロイ後のWorker URL例:

```text
https://runos-strava-worker.<account>.workers.dev
```

## 5. 環境変数とsecret

`workers/runos-strava-worker/wrangler.toml` にはsecretを書かない。

モック段階で使う環境変数:

| 名前 | 例 | 用途 |
|---|---|---|
| `TOKEN_STORAGE` | `mock` | token保存なしのモック動作 |
| `RUNOS_LEGACY_PWA_ORIGIN` | `https://<runos-legacy-pwa>.pages.dev` | CORSで許可するRunOS Legacy PWA公開URL |
| `LOCAL_DEV_ORIGINS` | `http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173` | CORSで許可する開発URL |

本接続前に追加する環境変数・secret:

| 名前 | 設定方法 | 注意 |
|---|---|---|
| `STRAVA_CLIENT_ID` | Cloudflare環境変数 | 公開情報だがWorker側だけで扱う |
| `STRAVA_REDIRECT_URI` | Cloudflare環境変数 | Stravaアプリ設定と一致させる |
| `STRAVA_CLIENT_SECRET` | `wrangler secret put STRAVA_CLIENT_SECRET` | repoへ書かない |

secret設定例:

```bash
npx wrangler secret put STRAVA_CLIENT_SECRET --config workers/runos-strava-worker/wrangler.toml
```

## 6. endpoint確認

以下の例ではWorker URLを `https://runos-strava-worker.<account>.workers.dev` とします。

### `/health`

```bash
curl https://runos-strava-worker.<account>.workers.dev/health
```

確認観点:

- `ok: true`
- `mock: true`
- `env.tokenStorage: "mock"`
- `env.runosLegacyPwaOriginConfigured` が本番では `true`
- secret値そのものがレスポンスに出ていない

### `/auth/start`

```bash
curl "https://runos-strava-worker.<account>.workers.dev/auth/start?scope=activity:read&state=manual-check"
```

確認観点:

- `authorizationUrl` が返る
- `requestedScope` が `activity:read`
- `client_secret` がレスポンスに出ていない
- 現段階ではStravaへredirectしない

### `/auth/callback`

```bash
curl "https://runos-strava-worker.<account>.workers.dev/auth/callback?code=mock-code&scope=activity:read&state=manual-check"
```

確認観点:

- callback受信のモック結果が返る
- token交換は行われない
- `refresh_token` や `access_token` が返らない

### `/activities`

```bash
curl "https://runos-strava-worker.<account>.workers.dev/activities?page=1&per_page=30"
```

確認観点:

- `mock: true`
- `rawActivities` と `previews` が返る
- ランニング活動は `importable: true`
- 非ランニング活動は `importable: false`
- `runosActivity` はプレビュー用であり、`meridian.v1` へ直接書かない

## 7. CORS方針

許可するOrigin:

- RunOS Legacy PWAのCloudflare Pages公開URL
  - `RUNOS_LEGACY_PWA_ORIGIN` に設定する
  - 例: `https://<runos-legacy-pwa>.pages.dev`
- localhost開発URL
  - `http://localhost:4173`
  - `http://127.0.0.1:4173`
  - `http://localhost:5173`
  - `http://127.0.0.1:5173`

拒否するOrigin:

- 上記以外すべて
- 不明な外部サイト
- Wanoku PWA
- 任意の `file://` 起動元

方針:

- ブラウザからの未許可Origin付きリクエストは403
- `Access-Control-Allow-Origin` は許可Originのときだけ返す
- `Access-Control-Allow-Credentials` は使わない
- PWAからAuthorization headerを送らない
- 本接続前にCloudflare Pagesの実URLを `RUNOS_LEGACY_PWA_ORIGIN` に設定する

## 8. Stravaアプリ設定項目

本接続前にStrava Developersで確認する。

| 項目 | 方針 |
|---|---|
| redirect URI / callback domain | Workerの `/auth/callback` と一致させる |
| scope | 既定は `activity:read` |
| `activity:read_all` | 非公開活動も対象にする場合のみ、明示説明後に要求 |
| client id | Worker環境変数 `STRAVA_CLIENT_ID` |
| client secret | Cloudflare secret `STRAVA_CLIENT_SECRET` |

まだ要求しないscope:

- `activity:write`
- `profile:write`
- RunOSの読み取り同期に不要なscope

## 9. 本接続前チェックリスト

- RunOS Legacy PWA公開URLが確定している
- `RUNOS_LEGACY_PWA_ORIGIN` が設定済み
- Stravaアプリのcallback domain / redirect URIがWorker URLと一致している
- `STRAVA_CLIENT_SECRET` をrepoへ書いていない
- token保存先をKVにするかD1にするか決めている
- state検証方針が決まっている
- tokenやAuthorization headerをログに出さない
- `/activities` の結果を `meridian.v1` へ直接書かず、プレビュー確認にする

## 10. まだ行わないこと

- Strava本接続
- OAuth token交換
- refresh token保存
- RunOS HTML変更
- `meridian.v1` 書き込み
- Wanoku連携
