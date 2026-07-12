const SERVICE_NAME = "wanoku-intel-worker";
const DEFAULT_WANOKU_PWA_ORIGIN = "https://wanoku-pwa.pages.dev";
const DEFAULT_LOCAL_DEV_ORIGINS = [
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

const SOURCES = [
  {
    id: "manual-sns",
    name: "手動投入SNS投稿",
    kind: "sns",
    reliabilityPrior: 0.55,
    policy: "手動URL投入を想定。X APIや無断スクレイピングを必須依存にしない。"
  },
  {
    id: "youtube-channel-alpha",
    name: "湾奥釣行YouTube",
    kind: "youtube",
    reliabilityPrior: 0.62,
    policy: "YouTube Data APIまたは手動URL投入を優先する。"
  },
  {
    id: "shop-report-beta",
    name: "湾奥釣具店釣果",
    kind: "shop",
    reliabilityPrior: 0.82,
    policy: "公式ページ/RSS/APIがある場合のみ利用する。"
  },
  {
    id: "official-environment",
    name: "公的環境データ",
    kind: "official",
    reliabilityPrior: 0.93,
    policy: "公式API/RSS/公開データを優先する。"
  }
];

const EVIDENCE = [
  {
    id: "sns-seabass-ariake-20260710",
    sourceId: "sns-post-001",
    source: SOURCES[0],
    observedAt: "2026-07-10T21:20:00+09:00",
    publishedAt: "2026-07-10T23:05:00+09:00",
    species: [{ species: "シーバス", count: 2, sizeCm: 58, behavior: "明暗で捕食" }],
    location: { label: "有明運河周辺", lat: 35.6368, lon: 139.7898, radiusM: 1200, confidence: 0.55 },
    locationConfidence: 0.55,
    sourceReliability: 0.52,
    timeConfidence: 0.76,
    duplicateGroupId: "grp-seabass-ariake-20260710",
    evidenceUrl: "https://example.com/sns/seabass-ariake-20260710",
    extractedFacts: ["実釣は7/10夜", "有明運河周辺", "シーバス2本", "ベイト多め"]
  },
  {
    id: "youtube-chinu-canal-20260708",
    sourceId: "yt-video-001",
    source: SOURCES[1],
    observedAt: "2026-07-08T19:00:00+09:00",
    publishedAt: "2026-07-11T18:00:00+09:00",
    species: [{ species: "チニング", count: 3, sizeCm: 42, behavior: "ボトムでバイト" }],
    location: { label: "港湾部の運河筋", lat: 35.6502, lon: 139.7891, radiusM: 2500, confidence: 0.48 },
    locationConfidence: 0.48,
    sourceReliability: 0.64,
    timeConfidence: 0.7,
    evidenceUrl: "https://www.youtube.com/watch?v=example001",
    extractedFacts: ["投稿日と実釣日が異なる", "運河筋", "チニング3枚", "ボトム"]
  },
  {
    id: "shop-aji-report-20260711",
    sourceId: "shop-report-20260711-aji",
    source: SOURCES[2],
    observedAt: "2026-07-11T04:30:00+09:00",
    publishedAt: "2026-07-11T10:00:00+09:00",
    species: [{ species: "アジ", count: 12, sizeCm: 18, behavior: "朝マズメ回遊" }],
    location: { label: "若洲方面", lat: 35.6163, lon: 139.8324, radiusM: 1800, confidence: 0.72 },
    locationConfidence: 0.72,
    sourceReliability: 0.84,
    timeConfidence: 0.86,
    evidenceUrl: "https://example.com/shop/reports/20260711-aji",
    extractedFacts: ["朝マズメ", "若洲方面", "アジ12匹", "小型中心"]
  },
  {
    id: "official-env-tokyobay-20260711",
    sourceId: "env-20260711-tokyobay",
    source: SOURCES[3],
    observedAt: "2026-07-11T09:00:00+09:00",
    publishedAt: "2026-07-11T09:20:00+09:00",
    species: [{ species: "environment", behavior: "水温・風・潮位" }],
    location: { label: "東京湾奥広域", lat: 35.62, lon: 139.82, radiusM: 12000, confidence: 0.9 },
    locationConfidence: 0.9,
    sourceReliability: 0.94,
    timeConfidence: 0.95,
    evidenceUrl: "https://example.com/official/environment/tokyobay",
    extractedFacts: ["水温27.1℃", "南風", "下げ潮", "降雨後の濁り"]
  },
  {
    id: "repost-seabass-ariake-20260710",
    sourceId: "rss-repost-001",
    source: { id: "summary-blog", name: "釣果まとめブログ", kind: "rss", reliabilityPrior: 0.42 },
    observedAt: "2026-07-10T21:20:00+09:00",
    publishedAt: "2026-07-11T08:00:00+09:00",
    species: [{ species: "シーバス", count: 2, sizeCm: 58 }],
    location: { label: "有明運河周辺", lat: 35.6367, lon: 139.7897, radiusM: 1500, confidence: 0.5 },
    locationConfidence: 0.5,
    sourceReliability: 0.42,
    timeConfidence: 0.62,
    duplicateGroupId: "grp-seabass-ariake-20260710",
    evidenceUrl: "https://example.com/rss/repost-seabass-ariake",
    extractedFacts: ["転載", "有明運河周辺", "シーバス2本"]
  }
];

function splitOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function allowedOrigins(env) {
  return new Set([
    env.WANOKU_PWA_ORIGIN || DEFAULT_WANOKU_PWA_ORIGIN,
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
  if (origin && allowedOrigins(env).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function isCorsAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins(env).has(origin);
}

function json(request, env, payload, init = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
      ...(init.headers || {})
    }
  });
}

function publicEnv(env) {
  return {
    wanokuPwaOriginConfigured: Boolean(env.WANOKU_PWA_ORIGIN),
    allowedOrigins: [...allowedOrigins(env)],
    mock: true
  };
}

function filterEvidence(url) {
  const species = url.searchParams.get("species");
  if (!species) return EVIDENCE;
  return EVIDENCE.filter((event) => event.species.some((item) => item.species === species));
}

function duplicateCandidates() {
  return [
    {
      leftId: "sns-seabass-ariake-20260710",
      rightId: "repost-seabass-ariake-20260710",
      score: 0.79,
      confidence: "likely",
      reasons: ["same duplicateGroupId", "near observed time", "near location", "overlapping species", "similar text/facts"]
    }
  ];
}

function mockPredictions() {
  return {
    id: "pred-mock-20260711-night",
    generatedAt: "2026-07-11T12:00:00+09:00",
    targetWindowStart: "2026-07-11T18:00:00+09:00",
    targetWindowEnd: "2026-07-12T06:00:00+09:00",
    modelVersion: "wanoku-intel-mock-v0",
    evidenceIds: EVIDENCE.map((event) => event.id),
    estimates: [
      {
        species: "シーバス",
        location: { label: "有明運河〜荒川河口の明暗帯", lat: 35.64, lon: 139.8, radiusM: 3500, confidence: 0.54 },
        probability: 0.61,
        confidence: 0.48,
        computedAt: "2026-07-11T12:00:00+09:00",
        drivers: [
          { factor: "recent evidence", contribution: 0.28, note: "SNSと転載候補を重複候補として扱い過大評価を抑制" },
          { factor: "environment", contribution: 0.18, note: "下げ潮・濁り・南風" },
          { factor: "habitat", contribution: 0.15, note: "明暗・運河筋・河口近接" }
        ]
      }
    ],
    movements: [
      {
        species: "シーバス",
        from: { label: "湾奥広域", lat: 35.62, lon: 139.82, radiusM: 12000, confidence: 0.45 },
        to: { label: "運河明暗帯", lat: 35.64, lon: 139.8, radiusM: 3500, confidence: 0.48 },
        directionDeg: 315,
        speedKmh: 1.2,
        confidence: 0.35,
        rationale: ["fixtureによる仮推定", "本番SNS/API接続やAI自由生成は未使用"]
      }
    ]
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

    if (!isCorsAllowed(request, env)) {
      return json(request, env, { error: "cors_forbidden" }, { status: 403 });
    }
    if (request.method !== "GET") {
      return json(request, env, { error: "method_not_allowed" }, { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json(request, env, {
        ok: true,
        service: SERVICE_NAME,
        env: publicEnv(env),
        endpoints: ["/health", "/sources", "/intel", "/evidence", "/predictions"]
      });
    }
    if (url.pathname === "/sources") {
      return json(request, env, { sources: SOURCES });
    }
    if (url.pathname === "/evidence") {
      return json(request, env, {
        evidence: filterEvidence(url),
        duplicateCandidates: duplicateCandidates(),
        note: "fixture/mock only; no production SNS API connection."
      });
    }
    if (url.pathname === "/predictions") {
      return json(request, env, { prediction: mockPredictions() });
    }
    if (url.pathname === "/intel") {
      return json(request, env, {
        sources: SOURCES,
        evidence: filterEvidence(url),
        duplicateCandidates: duplicateCandidates(),
        prediction: mockPredictions(),
        policy: "manual selected use only; no secret is returned to client."
      });
    }

    return json(request, env, { error: "not_found" }, { status: 404 });
  }
};
