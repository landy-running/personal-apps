const DEFAULT_SCOPE = "activity:read";
const ALLOWED_SCOPES = new Set(["activity:read", "activity:read_all"]);
const DEFAULT_LOCAL_DEV_ORIGINS = [
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

const MOCK_STRAVA_ACTIVITIES = [
  {
    id: 10100000001,
    name: "Morning Easy Run",
    type: "Run",
    sport_type: "Run",
    distance: 8200,
    moving_time: 2820,
    elapsed_time: 2910,
    total_elevation_gain: 42,
    start_date: "2026-07-09T21:30:00Z",
    start_date_local: "2026-07-10T06:30:00+09:00",
    average_heartrate: 142,
    max_heartrate: 166,
    average_cadence: 83.5
  },
  {
    id: 10100000002,
    name: "Tempo Blocks",
    type: "Run",
    sport_type: "Run",
    workout_type: 3,
    distance: 11250,
    moving_time: 3480,
    elapsed_time: 3600,
    total_elevation_gain: 68,
    start_date: "2026-07-07T10:00:00Z",
    start_date_local: "2026-07-07T19:00:00+09:00",
    average_heartrate: 158,
    max_heartrate: 181,
    average_cadence: 86.1
  },
  {
    id: 10100000003,
    name: "Recovery Ride",
    type: "Ride",
    sport_type: "Ride",
    distance: 20400,
    moving_time: 4200,
    elapsed_time: 4300,
    total_elevation_gain: 110,
    start_date: "2026-07-06T23:00:00Z",
    start_date_local: "2026-07-07T08:00:00+09:00"
  }
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

function json(request, env, payload, init = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
      ...(init.headers || {})
    }
  });
}

function envStatus(env) {
  return {
    clientIdConfigured: Boolean(env.STRAVA_CLIENT_ID),
    clientSecretConfigured: Boolean(env.STRAVA_CLIENT_SECRET),
    redirectUriConfigured: Boolean(env.STRAVA_REDIRECT_URI),
    tokenStorage: env.TOKEN_STORAGE || "mock",
    runosLegacyPwaOriginConfigured: Boolean(env.RUNOS_LEGACY_PWA_ORIGIN),
    allowedOrigins: [...getAllowedOrigins(env)]
  };
}

function sanitizeScope(scope) {
  const requested = String(scope || DEFAULT_SCOPE)
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const accepted = requested.filter((part) => ALLOWED_SCOPES.has(part));
  return accepted.length > 0 ? accepted.join(",") : DEFAULT_SCOPE;
}

function buildAuthStartResponse(request, env) {
  const url = new URL(request.url);
  const scope = sanitizeScope(url.searchParams.get("scope"));
  const state = url.searchParams.get("state") || `mock-${crypto.randomUUID()}`;
  const redirectUri = env.STRAVA_REDIRECT_URI || `${url.origin}/auth/callback`;
  const clientId = env.STRAVA_CLIENT_ID || "mock-client-id";

  const authorizationUrl = new URL("https://www.strava.com/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("approval_prompt", "auto");
  authorizationUrl.searchParams.set("scope", scope);
  authorizationUrl.searchParams.set("state", state);

  return {
    mock: true,
    nextAction: "In production this endpoint may redirect to authorizationUrl.",
    authorizationUrl: authorizationUrl.toString(),
    state,
    requestedScope: scope,
    env: envStatus(env)
  };
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
      source: "strava_api_mock",
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

function filterMockActivities(request) {
  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after") || 0);
  const before = Number(url.searchParams.get("before") || 0);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get("per_page") || 30)));

  const filtered = MOCK_STRAVA_ACTIVITIES.filter((activity) => {
    const seconds = Math.floor(new Date(activity.start_date).getTime() / 1000);
    if (after && seconds <= after) return false;
    if (before && seconds >= before) return false;
    return true;
  });

  const start = (page - 1) * perPage;
  return {
    page,
    perPage,
    totalMockActivities: filtered.length,
    activities: filtered.slice(start, start + perPage)
  };
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
      return json(request, env, {
        ok: true,
        service: "runos-strava-worker",
        mock: true,
        env: envStatus(env)
      });
    }

    if (url.pathname === "/auth/start") {
      return json(request, env, buildAuthStartResponse(request, env));
    }

    if (url.pathname === "/auth/callback") {
      return json(request, env, {
        mock: true,
        message: "Callback received. Token exchange is intentionally not implemented yet.",
        hasCode: Boolean(url.searchParams.get("code")),
        error: url.searchParams.get("error") || null,
        state: url.searchParams.get("state") || null,
        grantedScope: url.searchParams.get("scope") || null,
        tokenStorage: env.TOKEN_STORAGE || "mock"
      });
    }

    if (url.pathname === "/activities") {
      const page = filterMockActivities(request);
      const previews = page.activities.map(toRunOsPreview);

      return json(request, env, {
        mock: true,
        source: "strava_api_mock",
        note: "No Strava request is made. Do not write this response to meridian.v1 without a user confirmation step.",
        paging: {
          page: page.page,
          perPage: page.perPage,
          totalMockActivities: page.totalMockActivities
        },
        rawActivities: page.activities,
        previews,
        importableCount: previews.filter((preview) => preview.importable).length,
        skippedCount: previews.filter((preview) => !preview.importable).length
      });
    }

    return json(request, env, {
      error: "not_found",
      endpoints: ["/health", "/auth/start", "/auth/callback", "/activities"]
    }, { status: 404 });
  }
};
