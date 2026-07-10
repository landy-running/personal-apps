const DEFAULT_SCOPE = "activity:read,read";
const PRIVATE_SCOPE = "activity:read_all,read";
const TOKEN_KV_KEY = "runos:strava:token:primary";
const STATE_PREFIX = "runos:strava:oauth-state:";
const STATE_TTL_SECONDS = 10 * 60;
const REFRESH_SKEW_SECONDS = 5 * 60;
const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const DEFAULT_LOCAL_DEV_ORIGINS = [
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

function splitOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getAllowedOrigins(env) {
  return new Set([
    ...splitOrigins(env.RUNOS_LEGACY_PWA_ORIGIN),
    ...splitOrigins(env.LOCAL_DEV_ORIGINS || DEFAULT_LOCAL_DEV_ORIGINS.join(","))
  ]);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (origin && getAllowedOrigins(env).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function isCorsAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return !origin || getAllowedOrigins(env).has(origin);
}

function noStoreHeaders() {
  return { "Cache-Control": "no-store" };
}

function json(request, env, payload, init = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...noStoreHeaders(),
      ...corsHeaders(request, env),
      ...(init.headers || {})
    }
  });
}

function html(request, env, body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...noStoreHeaders(),
      ...corsHeaders(request, env),
      ...(init.headers || {})
    }
  });
}

function sanitizeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function envStatus(env) {
  return {
    clientIdConfigured: Boolean(env.STRAVA_CLIENT_ID),
    clientSecretConfigured: Boolean(env.STRAVA_CLIENT_SECRET),
    redirectUriConfigured: Boolean(env.STRAVA_REDIRECT_URI),
    tokenStorage: env.TOKEN_STORAGE || "kv",
    tokenKvConfigured: Boolean(env.STRAVA_TOKEN_KV),
    runosLegacyPwaOriginConfigured: Boolean(env.RUNOS_LEGACY_PWA_ORIGIN),
    allowedOrigins: [...getAllowedOrigins(env)]
  };
}

function requireConfig(env) {
  const missing = [];
  if (!env.STRAVA_CLIENT_ID) missing.push("STRAVA_CLIENT_ID");
  if (!env.STRAVA_CLIENT_SECRET) missing.push("STRAVA_CLIENT_SECRET");
  if (!env.STRAVA_REDIRECT_URI) missing.push("STRAVA_REDIRECT_URI");
  return missing;
}

function requireTokenKv(env) {
  return env.STRAVA_TOKEN_KV && typeof env.STRAVA_TOKEN_KV.get === "function"
    ? env.STRAVA_TOKEN_KV
    : null;
}

function configError(request, env, missing) {
  return json(request, env, {
    error: "worker_config_missing",
    missing,
    message: "Required Strava Worker environment variables are missing."
  }, { status: 500 });
}

function tokenStorageError(request, env) {
  return json(request, env, {
    error: "token_storage_unavailable",
    message: "Cloudflare KV binding STRAVA_TOKEN_KV is not configured."
  }, { status: 500 });
}

async function readJsonOrText(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 1000) };
  }
}

function stravaError(status, body) {
  return {
    error: "strava_api_error",
    status,
    strava: body || null
  };
}

function parseScope(scope) {
  return String(scope || "")
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasActivityReadScope(scope) {
  const scopes = parseScope(scope);
  return scopes.includes("activity:read") || scopes.includes("activity:read_all");
}

function hasActivityReadAllScope(scope) {
  return parseScope(scope).includes("activity:read_all");
}

async function loadToken(kv) {
  return kv.get(TOKEN_KV_KEY, "json");
}

async function saveToken(kv, token) {
  await kv.put(TOKEN_KV_KEY, JSON.stringify({
    ...token,
    updatedAt: new Date().toISOString()
  }));
}

function sanitizeTokenForStorage(tokenResponse, fallback = {}) {
  return {
    token_type: tokenResponse.token_type || fallback.token_type || "Bearer",
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || fallback.refresh_token,
    expires_at: Number(tokenResponse.expires_at || fallback.expires_at || 0),
    expires_in: Number(tokenResponse.expires_in || 0),
    scope: tokenResponse.scope || fallback.scope || "",
    athlete: tokenResponse.athlete || fallback.athlete || null,
    connectedAt: fallback.connectedAt || new Date().toISOString()
  };
}

function publicConnectionInfo(token) {
  if (!token) return { connected: false };
  return {
    connected: true,
    athleteId: token.athlete?.id || null,
    scope: token.scope || "",
    hasActivityReadAll: hasActivityReadAllScope(token.scope),
    expiresAt: token.expires_at || null,
    connectedAt: token.connectedAt || null,
    updatedAt: token.updatedAt || null
  };
}

async function exchangeAuthorizationCode(env, code) {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code"
    })
  });

  const body = await readJsonOrText(response);
  if (!response.ok) throw stravaError(response.status, body);
  return body;
}

async function refreshToken(env, kv, currentToken) {
  if (!currentToken?.refresh_token) {
    throw { error: "not_connected", message: "No refresh token is stored in Worker KV." };
  }

  const response = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: currentToken.refresh_token
    })
  });

  const body = await readJsonOrText(response);
  if (!response.ok) throw stravaError(response.status, body);

  const updated = sanitizeTokenForStorage(body, currentToken);
  await saveToken(kv, updated);
  return updated;
}

async function getValidToken(env, kv, options = {}) {
  const token = await loadToken(kv);
  if (!token) {
    throw { error: "not_connected", message: "Strava is not connected yet. Open /auth/start first." };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!options.forceRefresh && Number(token.expires_at || 0) > now + REFRESH_SKEW_SECONDS) {
    return token;
  }

  return refreshToken(env, kv, token);
}

async function callStravaApi(env, kv, path, searchParams = new URLSearchParams()) {
  let token = await getValidToken(env, kv);
  let url = `${STRAVA_API_BASE}${path}`;
  const query = searchParams.toString();
  if (query) url += `?${query}`;

  let response = await fetch(url, {
    headers: { "Authorization": `Bearer ${token.access_token}` }
  });

  if (response.status === 401) {
    token = await getValidToken(env, kv, { forceRefresh: true });
    response = await fetch(url, {
      headers: { "Authorization": `Bearer ${token.access_token}` }
    });
  }

  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw { ...stravaError(response.status, body), rateLimit: readRateLimitHeaders(response) };
  }

  return { body, rateLimit: readRateLimitHeaders(response) };
}

function readRateLimitHeaders(response) {
  return {
    limit: response.headers.get("x-ratelimit-limit"),
    usage: response.headers.get("x-ratelimit-usage")
  };
}

async function saveOauthState(kv, state, payload) {
  await kv.put(`${STATE_PREFIX}${state}`, JSON.stringify(payload), {
    expirationTtl: STATE_TTL_SECONDS
  });
}

async function consumeOauthState(kv, state) {
  const key = `${STATE_PREFIX}${state}`;
  const payload = await kv.get(key, "json");
  if (payload) await kv.delete(key);
  return payload;
}

function buildAuthRequest(url) {
  const requestedScope = url.searchParams.get("scope") || "";
  const includePrivate = url.searchParams.get("include_private") === "1"
    || hasActivityReadAllScope(requestedScope);

  return {
    includePrivate,
    scope: includePrivate ? PRIVATE_SCOPE : DEFAULT_SCOPE,
    approvalPrompt: includePrivate ? "force" : "auto"
  };
}

function buildAuthorizeUrl(env, state, authRequest) {
  const authorizationUrl = new URL(STRAVA_AUTHORIZE_URL);
  authorizationUrl.searchParams.set("client_id", env.STRAVA_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", env.STRAVA_REDIRECT_URI);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("approval_prompt", authRequest.approvalPrompt);
  authorizationUrl.searchParams.set("scope", authRequest.scope);
  authorizationUrl.searchParams.set("state", state);
  return authorizationUrl;
}

function isRunActivity(activity) {
  const sportType = String(activity.sport_type || activity.type || "").toLowerCase();
  return sportType.includes("run");
}

function classifyRun(activity, km) {
  const name = String(activity.name || "").toLowerCase();
  const workoutType = Number(activity.workout_type || 0);

  if (name.includes("race")) return "race";
  if (name.includes("interval") || workoutType === 3) return "interval";
  if (name.includes("tempo") || name.includes("threshold")) return "tempo";
  if (km >= 15) return "long";
  return "easy";
}

function toRunOsPreview(activity) {
  const km = Math.round((Number(activity.distance || 0) / 1000) * 100) / 100;
  const date = String(activity.start_date_local || activity.start_date || "").slice(0, 10);
  const importable = isRunActivity(activity) && Boolean(date) && km > 0 && Number(activity.moving_time) >= 60;

  if (!importable) {
    return {
      externalId: `strava:${activity.id}`,
      importable: false,
      skipReason: "ランニング活動ではない、または必須値が不足しています",
      source: "strava_api",
      rawSummary: activity
    };
  }

  const durSec = Math.round(Number(activity.moving_time));
  const duplicateKey = `${date}|${Math.round(km * 10)}`;

  return {
    externalId: `strava:${activity.id}`,
    duplicateKey,
    importable: true,
    runosActivity: {
      date,
      type: classifyRun(activity, km),
      km,
      durSec,
      hrAvg: Number.isFinite(Number(activity.average_heartrate))
        ? Math.round(Number(activity.average_heartrate))
        : null,
      hrMax: Number.isFinite(Number(activity.max_heartrate))
        ? Math.round(Number(activity.max_heartrate))
        : null,
      elevM: Number.isFinite(Number(activity.total_elevation_gain))
        ? Math.round(Number(activity.total_elevation_gain))
        : null,
      cadence: Number.isFinite(Number(activity.average_cadence))
        ? Math.round(Number(activity.average_cadence))
        : null,
      note: activity.name || "",
      source: "strava_api"
    },
    rawSummary: activity
  };
}

function buildActivitiesQuery(url) {
  const query = new URLSearchParams();
  const before = Number(url.searchParams.get("before") || 0);
  const after = Number(url.searchParams.get("after") || 0);
  const requestedPage = Number(url.searchParams.get("page") || 1);
  const page = Math.max(1, Math.floor(Number.isFinite(requestedPage) ? requestedPage : 1));
  const requestedPerPage = url.searchParams.get("per_page") || url.searchParams.get("perPage") || 30;
  const perPage = Math.max(1, Math.min(100, Math.floor(Number(requestedPerPage) || 30)));

  if (before > 0) query.set("before", String(Math.floor(before)));
  if (after > 0) query.set("after", String(Math.floor(after)));
  query.set("page", String(page));
  query.set("per_page", String(perPage));

  return {
    query,
    page,
    perPage,
    before: before > 0 ? Math.floor(before) : null,
    after: after > 0 ? Math.floor(after) : null
  };
}

function buildSuccessHtml(token) {
  const athlete = token.athlete || {};
  const name = [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || athlete.username || `Athlete ${athlete.id || ""}`.trim();
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RunOS Strava 接続成功</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0e15;color:#f6fffc;margin:0;padding:32px;line-height:1.7}
    .card{max-width:720px;margin:auto;background:#121826;border:1px solid #243244;border-radius:18px;padding:24px}
    .ok{color:#20d6b5;font-weight:800}
    code{background:#0b0e15;border:1px solid #243244;border-radius:8px;padding:2px 6px}
  </style>
</head>
<body>
  <main class="card">
    <h1 class="ok">Strava接続成功</h1>
    <p>RunOS Strava Workerに接続情報を保存しました。</p>
    <p>接続アスリート: <strong>${sanitizeHtml(name)}</strong></p>
    <p>許可scope: <code>${sanitizeHtml(token.scope || "")}</code></p>
    <p>refresh_token / access_token はこの画面にもPWAにも返していません。</p>
    <p>このタブを閉じてRunOSへ戻ってください。</p>
  </main>
</body>
</html>`;
}

async function handleAuthStart(request, env) {
  const missing = requireConfig(env);
  if (missing.length) return configError(request, env, missing);

  const kv = requireTokenKv(env);
  if (!kv) return tokenStorageError(request, env);

  const url = new URL(request.url);
  const authRequest = buildAuthRequest(url);
  const state = crypto.randomUUID();
  await saveOauthState(kv, state, {
    scope: authRequest.scope,
    includePrivate: authRequest.includePrivate,
    createdAt: new Date().toISOString()
  });

  return Response.redirect(buildAuthorizeUrl(env, state, authRequest).toString(), 302);
}

async function handleAuthCallback(request, env) {
  const missing = requireConfig(env);
  if (missing.length) return configError(request, env, missing);

  const kv = requireTokenKv(env);
  if (!kv) return tokenStorageError(request, env);

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return html(request, env, `<!doctype html><meta charset="utf-8"><title>Strava接続失敗</title><p>Strava接続が拒否または失敗しました: ${sanitizeHtml(error)}</p>`, { status: 400 });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const grantedScope = url.searchParams.get("scope") || "";

  if (!code || !state) {
    return html(request, env, "<!doctype html><meta charset=\"utf-8\"><title>Strava接続失敗</title><p>code または state が不足しています。</p>", { status: 400 });
  }

  const savedState = await consumeOauthState(kv, state);
  if (!savedState) {
    return html(request, env, "<!doctype html><meta charset=\"utf-8\"><title>Strava接続失敗</title><p>OAuth state が無効または期限切れです。/auth/start からやり直してください。</p>", { status: 400 });
  }

  try {
    const tokenResponse = await exchangeAuthorizationCode(env, code);
    const acceptedScope = tokenResponse.scope || grantedScope || "";
    const token = sanitizeTokenForStorage(tokenResponse, {
      scope: acceptedScope
    });

    if (!token.access_token || !token.refresh_token || !token.expires_at) {
      return html(request, env, "<!doctype html><meta charset=\"utf-8\"><title>Strava接続失敗</title><p>Strava token response の必須値が不足しています。</p>", { status: 502 });
    }

    if (!hasActivityReadScope(token.scope || grantedScope)) {
      return html(request, env, "<!doctype html><meta charset=\"utf-8\"><title>Strava接続失敗</title><p>activity:read が許可されていません。Strava認可画面で activity:read を許可してください。</p>", { status: 403 });
    }

    await saveToken(kv, token);
    return html(request, env, buildSuccessHtml(token));
  } catch (errorResponse) {
    return html(request, env, `<!doctype html><meta charset="utf-8"><title>Strava接続失敗</title><p>Strava token交換に失敗しました。</p><pre>${sanitizeHtml(JSON.stringify(errorResponse, null, 2))}</pre>`, { status: 502 });
  }
}

async function handleAthlete(request, env) {
  const missing = requireConfig(env);
  if (missing.length) return configError(request, env, missing);

  const kv = requireTokenKv(env);
  if (!kv) return tokenStorageError(request, env);

  try {
    const result = await callStravaApi(env, kv, "/athlete");
    const current = await loadToken(kv);
    if (current) {
      await saveToken(kv, { ...current, athlete: result.body });
    }

    return json(request, env, {
      connected: true,
      athlete: result.body,
      scope: current?.scope || "",
      hasActivityReadAll: hasActivityReadAllScope(current?.scope || ""),
      expiresAt: current?.expires_at || null,
      rateLimit: result.rateLimit
    });
  } catch (errorResponse) {
    return json(request, env, errorResponse, { status: errorResponse.status || 500 });
  }
}

async function handleActivities(request, env) {
  const missing = requireConfig(env);
  if (missing.length) return configError(request, env, missing);

  const kv = requireTokenKv(env);
  if (!kv) return tokenStorageError(request, env);

  const url = new URL(request.url);
  const params = buildActivitiesQuery(url);

  try {
    const result = await callStravaApi(env, kv, "/athlete/activities", params.query);
    const activities = Array.isArray(result.body) ? result.body : [];
    const previews = activities.map(toRunOsPreview);
    const token = await loadToken(kv);

    return json(request, env, {
      source: "strava_api",
      note: "Do not write this response to meridian.v1 without a user confirmation step.",
      connected: true,
      scope: token?.scope || "",
      hasActivityReadAll: hasActivityReadAllScope(token?.scope || ""),
      paging: {
        page: params.page,
        perPage: params.perPage,
        returnedCount: activities.length,
        hasMore: activities.length >= params.perPage,
        before: params.before,
        after: params.after
      },
      returnedCount: activities.length,
      hasMore: activities.length >= params.perPage,
      rateLimit: result.rateLimit,
      rawActivities: activities,
      previews,
      importableCount: previews.filter((preview) => preview.importable).length,
      skippedCount: previews.filter((preview) => !preview.importable).length
    });
  } catch (errorResponse) {
    return json(request, env, errorResponse, { status: errorResponse.status || 500 });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: isCorsAllowed(request, env) ? 204 : 403,
        headers: corsHeaders(request, env)
      });
    }

    const url = new URL(request.url);

    if (!isCorsAllowed(request, env)) {
      return json(request, env, {
        error: "cors_forbidden",
        message: "This origin is not allowed for the RunOS Strava Worker."
      }, { status: 403 });
    }

    if (request.method !== "GET") {
      return json(request, env, { error: "method_not_allowed" }, { status: 405 });
    }

    if (url.pathname === "/health") {
      const kv = requireTokenKv(env);
      let connection = { connected: false };
      if (kv) {
        connection = publicConnectionInfo(await loadToken(kv));
      }

      return json(request, env, {
        ok: true,
        service: "runos-strava-worker",
        mock: false,
        env: envStatus(env),
        connection
      });
    }

    if (url.pathname === "/auth/start") return handleAuthStart(request, env);
    if (url.pathname === "/auth/callback") return handleAuthCallback(request, env);
    if (url.pathname === "/athlete") return handleAthlete(request, env);
    if (url.pathname === "/activities") return handleActivities(request, env);

    return json(request, env, {
      error: "not_found",
      endpoints: ["/health", "/auth/start", "/auth/callback", "/athlete", "/activities"]
    }, { status: 404 });
  }
};
