export const YOKOHAMA_FIXED_NODE_PROVIDER_ID = "yokohama-fishing-piers";
export const YOKOHAMA_FIXED_NODE_ROOT_URL = "https://yokohama-fishingpiers.jp/";

const YOKOHAMA_HOST = "yokohama-fishingpiers.jp";
const APPSYNC_HOST = /^[a-z0-9-]+\.appsync-api\.ap-northeast-1\.amazonaws\.com$/u;
const SOURCE_FIELDS = ["sentence", "weather", "waterTemp", "tide", "visitors", "createdAt", "updatedAt"];
const FISH_FIELDS = ["Name", "MinSize", "MaxSize", "Unit", "Count", "Place"];
export const YOKOHAMA_FIXED_NODE_SPECIES_GROUPS = Object.freeze({
  seabass: ["スズキ", "フッコ", "セイゴ", "シーバス"],
  sardine: ["イワシ", "カタクチイワシ", "マイワシ", "ウルメイワシ"],
  sappa: ["サッパ"],
  konoshiro: ["コノシロ"],
  aji: ["アジ", "マアジ"],
  saba: ["サバ", "マサバ", "ゴマサバ"],
  bora: ["ボラ", "イナ", "オボコ"],
  haze: ["ハゼ", "マハゼ"]
});

export class YokohamaFixedNodeSourceError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "YokohamaFixedNodeSourceError";
    this.code = code;
    this.facilityId = details.facilityId ?? null;
    this.httpStatus = details.httpStatus ?? null;
  }
}

export function extractYokohamaReadConfig(rootHtml, bundleJs) {
  if (typeof rootHtml !== "string" || typeof bundleJs !== "string") {
    throw sourceError("unexpected_schema", "Yokohama source documents must be strings.");
  }
  const bundlePath = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/iu.exec(rootHtml)?.[1]
    ?? /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["']/iu.exec(rootHtml)?.[1];
  if (!bundlePath) throw sourceError("yokohama-bundle-url-missing");
  const bundleUrl = normalizeYokohamaAssetUrl(bundlePath);
  const endpointValue = /aws_appsync_graphqlEndpoint["']?\s*:\s*["']([^"']+)["']/u.exec(bundleJs)?.[1];
  const apiKey = /aws_appsync_apiKey["']?\s*:\s*["']([^"']+)["']/u.exec(bundleJs)?.[1];
  const authMode = /aws_appsync_authenticationType["']?\s*:\s*["']([^"']+)["']/u.exec(bundleJs)?.[1];
  if (!endpointValue || !apiKey || authMode !== "API_KEY") throw sourceError("yokohama-read-config-missing");
  const endpoint = normalizeYokohamaAppSyncEndpoint(endpointValue);
  return { bundleUrl, endpoint, apiKey };
}

export function parseYokohamaLastPost(item, context = {}) {
  const facility = context.facility;
  if (
    !facility
    || facility.providerId !== YOKOHAMA_FIXED_NODE_PROVIDER_ID
    || facility.facilityId !== context.facilityId
    || typeof facility.providerFacilityKey !== "string"
  ) {
    throw new Error("A Yokohama DB registry facility is required.");
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) throw sourceError("unexpected_schema", "Yokohama daily record must be an object.");
  if (context.strictSchema === true) validateStrictRecordShape(item, facility);
  if (item.facility !== facility.providerFacilityKey) {
    throw sourceError("source_mismatch", "Yokohama source facility does not match the requested facility.", { facilityId: facility.facilityId });
  }
  if (typeof item.id !== "string" || item.id.trim() === "") throw sourceError("unexpected_schema", "Yokohama source record id is missing.");
  const observationDate = parseSlashDate(item.date);
  if (context.observationDate && observationDate !== context.observationDate) {
    throw sourceError("source_mismatch", "Yokohama source date does not match the requested date.", { facilityId: facility.facilityId });
  }
  const collectedAt = requireCanonicalUtcIso(context.collectedAt, "collectedAt");
  const species = [];
  for (let index = 1; index <= 30; index += 1) {
    const sourceName = cleanText(item[`fish${index}Name`]);
    if (!sourceName) continue;
    const count = finiteNonnegativeInteger(item[`fish${index}Count`]);
    const minSize = finiteNonnegativeNumber(item[`fish${index}MinSize`]);
    const maxSize = finiteNonnegativeNumber(item[`fish${index}MaxSize`]);
    const unit = cleanText(item[`fish${index}Unit`]);
    species.push({
      sourceName,
      canonicalGroup: canonicalFixedNodeSpeciesGroup(sourceName),
      count,
      countKnown: count !== null,
      minSize,
      maxSize,
      sizeUnit: unit || null,
      areaLabels: stringArray(item[`fish${index}Place`])
    });
  }
  const sentence = cleanText(item.sentence);
  const visitors = finiteNonnegativeInteger(item.visitors);
  const closureMentioned = hasClosureLanguage(sentence);
  const operatingStatus = closureMentioned && species.length === 0 && (visitors === null || visitors === 0)
    ? "closed"
    : (visitors !== null && visitors > 0) || species.length > 0
      ? "operating"
      : "unknown";
  const reportComplete = operatingStatus === "operating" && species.length > 0 && species.every((row) => row.countKnown);
  const publishedAt = canonicalizeUtcIso(item.createdAt);
  if (context.strictSchema === true && publishedAt && Date.parse(publishedAt) > Date.parse(collectedAt)) {
    throw sourceError("source_mismatch", "Yokohama record creation time is after collectedAt.", { facilityId: facility.facilityId });
  }
  return {
    providerId: facility.providerId,
    facilityId: facility.facilityId,
    facilityLabel: facility.displayName ?? facility.label ?? facility.facilityId,
    sourceFamily: "yokohama-appsync",
    sourceRecordId: `last-post:${item.id.trim()}`,
    sourceUrl: yokohamaFacilitySourceUrl(facility.providerFacilityKey),
    observationDate,
    observedAt: `${observationDate}T00:00:00+09:00`,
    temporalPrecision: "date-only-jst",
    publishedAt,
    publicationSemantics: "source-record-created-at",
    modifiedAt: canonicalizeUtcIso(item.updatedAt),
    collectedAt,
    weather: cleanText(item.weather),
    waterTemperatureC: finiteNumber(item.waterTemp),
    tideLabel: cleanText(item.tide),
    visitors,
    operatingStatus,
    reportComplete,
    species,
    closureMentioned,
    diagnostics: unique([
      ...(publishedAt ? ["publication-time-is-record-created-at"] : ["publication-time-missing"]),
      ...(operatingStatus === "unknown" ? ["operating-status-unknown"] : []),
      ...(!reportComplete && operatingStatus === "operating" ? ["species-table-incomplete"] : [])
    ]),
    parseStatus: "ok"
  };
}

export async function fetchYokohamaFixedNodeDailySource(options = {}) {
  const observationDate = requireIsoDate(options.observationDate);
  const collectedAt = requireCanonicalUtcIso(options.collectedAt, "collectedAt");
  const facilities = validateFacilities(options.facilities);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable.");
  const artifacts = [];
  const records = [];
  const failures = [];
  let facilitiesFetched = 0;
  let remoteReads = 0;

  const getText = async (url, headers = {}) => {
    remoteReads += 1;
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", headers });
    } catch {
      throw sourceError("http_error", "Yokohama source GET failed.");
    }
    if (!response?.ok) {
      throw sourceError("http_error", `Yokohama source GET failed with HTTP ${response?.status ?? "unknown"}.`, {
        httpStatus: Number.isInteger(response?.status) ? response.status : null
      });
    }
    const text = await response.text();
    artifacts.push(text);
    return text;
  };

  let config;
  try {
    const rootHtml = await getText(YOKOHAMA_FIXED_NODE_ROOT_URL);
    const bundlePath = extractYokohamaBundlePath(rootHtml);
    const bundleUrl = normalizeYokohamaAssetUrl(bundlePath);
    const bundleJs = await getText(bundleUrl);
    config = extractYokohamaReadConfig(rootHtml, bundleJs);
  } catch (error) {
    const failure = failureFromError(error);
    return {
      observationDate,
      collectedAt,
      facilitiesRequested: facilities.length,
      facilitiesFetched,
      records,
      failures: facilities.map((facility) => ({ ...failure, facilityId: facility.facilityId })),
      artifacts,
      remoteReads
    };
  }

  const query = buildYokohamaMonthlyQuery();
  const sourceMonth = observationDate.slice(0, 7).replace("-", "/");
  for (const facility of facilities) {
    try {
      const variables = { month: sourceMonth, facility: { eq: facility.providerFacilityKey }, limit: 100 };
      const url = buildYokohamaGraphqlGetUrl(config.endpoint, query, variables);
      const text = await getText(url, { accept: "application/json", "x-api-key": config.apiKey });
      facilitiesFetched += 1;
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw sourceError("parse_error", "Yokohama AppSync response is not valid JSON.", { facilityId: facility.facilityId });
      }
      const connection = payload?.data?.lastPostsByMonthAndFacility;
      if (payload?.errors?.length || !connection || !Array.isArray(connection.items) || connection.nextToken) {
        throw sourceError("unexpected_schema", "Yokohama AppSync response shape is invalid.", { facilityId: facility.facilityId });
      }
      if (connection.items.some((item) => item?.facility !== facility.providerFacilityKey)) {
        throw sourceError("source_mismatch", "Yokohama AppSync returned another facility.", { facilityId: facility.facilityId });
      }
      const sourceDate = observationDate.replace(/-/gu, "/");
      const matches = connection.items.filter((item) => item?.date === sourceDate);
      if (matches.length === 0) {
        throw sourceError("missing_source_record", "Yokohama source has no record for the requested date.", { facilityId: facility.facilityId });
      }
      if (matches.length !== 1) {
        throw sourceError("unexpected_schema", "Yokohama source returned duplicate records for one date.", { facilityId: facility.facilityId });
      }
      records.push(parseYokohamaLastPost(matches[0], {
        facility,
        facilityId: facility.facilityId,
        observationDate,
        collectedAt,
        strictSchema: true
      }));
    } catch (error) {
      failures.push({ facilityId: facility.facilityId, ...failureFromError(error) });
    }
  }
  return {
    observationDate,
    collectedAt,
    facilitiesRequested: facilities.length,
    facilitiesFetched,
    records,
    failures,
    artifacts,
    remoteReads
  };
}

export function buildYokohamaMonthlyQuery() {
  const fishFields = [];
  for (let index = 1; index <= 30; index += 1) {
    fishFields.push(
      `fish${index}Name`,
      `fish${index}MinSize`,
      `fish${index}MaxSize`,
      `fish${index}Unit`,
      `fish${index}Count`,
      `fish${index}Place`
    );
  }
  return `query FixedNodeDaily($month:String!,$facility:ModelStringKeyConditionInput,$limit:Int){lastPostsByMonthAndFacility(month:$month,facility:$facility,limit:$limit){items{id date month facility sentence weather waterTemp tide visitors ${fishFields.join(" ")} createdAt updatedAt} nextToken}}`;
}

export function buildYokohamaGraphqlGetUrl(endpoint, query, variables) {
  const url = new URL(normalizeYokohamaAppSyncEndpoint(endpoint));
  url.searchParams.set("query", query);
  url.searchParams.set("variables", JSON.stringify(variables));
  return url.href;
}

export function normalizeYokohamaAssetUrl(value) {
  const url = new URL(value, YOKOHAMA_FIXED_NODE_ROOT_URL);
  if (url.protocol !== "https:" || url.hostname !== YOKOHAMA_HOST || !/^\/assets\/index-[a-f0-9]+\.js$/u.test(url.pathname)) {
    throw new Error("Invalid Yokohama bundle URL.");
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

export function normalizeYokohamaAppSyncEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !APPSYNC_HOST.test(url.hostname) || url.pathname !== "/graphql") {
    throw sourceError("yokohama-appsync-endpoint-invalid");
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

export function canonicalFixedNodeSpeciesGroup(sourceName) {
  const normalized = cleanText(sourceName)?.replace(/[・\s]/gu, "") ?? "";
  for (const [group, aliases] of Object.entries(YOKOHAMA_FIXED_NODE_SPECIES_GROUPS)) {
    if (aliases.some((alias) => normalized === alias || normalized.startsWith(alias))) return group;
  }
  return null;
}

function validateStrictRecordShape(item, facility) {
  for (const field of ["id", "date", "month", "facility", ...SOURCE_FIELDS]) {
    if (!Object.prototype.hasOwnProperty.call(item, field)) {
      throw sourceError("unexpected_schema", `Yokohama record field is missing: ${field}.`, { facilityId: facility.facilityId });
    }
  }
  if (item.visitors !== null && (!Number.isInteger(item.visitors) || item.visitors < 0)) {
    throw sourceError("unexpected_schema", "Yokohama visitors must be a non-negative integer or null.", { facilityId: facility.facilityId });
  }
  for (let index = 1; index <= 30; index += 1) {
    for (const suffix of FISH_FIELDS) {
      const field = `fish${index}${suffix}`;
      if (!Object.prototype.hasOwnProperty.call(item, field)) {
        throw sourceError("unexpected_schema", `Yokohama species field is missing: ${field}.`, { facilityId: facility.facilityId });
      }
    }
    const name = item[`fish${index}Name`];
    const count = item[`fish${index}Count`];
    const minSize = item[`fish${index}MinSize`];
    const maxSize = item[`fish${index}MaxSize`];
    const unit = item[`fish${index}Unit`];
    const place = item[`fish${index}Place`];
    if (name !== null && typeof name !== "string") throw sourceError("unexpected_schema", "Yokohama fish name type is invalid.", { facilityId: facility.facilityId });
    if (typeof name === "string" && name.trim() === "") {
      throw sourceError("unexpected_schema", "Yokohama fish name must be non-empty or null.", { facilityId: facility.facilityId });
    }
    if (name === null && [count, minSize, maxSize, unit, place].some((value) => value !== null)) {
      throw sourceError("unexpected_schema", "Yokohama unnamed fish slot contains species data.", { facilityId: facility.facilityId });
    }
    if (count !== null && (!Number.isInteger(count) || count < 0)) throw sourceError("unexpected_schema", "Yokohama fish count type is invalid.", { facilityId: facility.facilityId });
    if (minSize !== null && (typeof minSize !== "number" || !Number.isFinite(minSize) || minSize < 0)) throw sourceError("unexpected_schema", "Yokohama minimum size type is invalid.", { facilityId: facility.facilityId });
    if (maxSize !== null && (typeof maxSize !== "number" || !Number.isFinite(maxSize) || maxSize < 0)) throw sourceError("unexpected_schema", "Yokohama maximum size type is invalid.", { facilityId: facility.facilityId });
    if (unit !== null && typeof unit !== "string") throw sourceError("unexpected_schema", "Yokohama size unit type is invalid.", { facilityId: facility.facilityId });
    if (place !== null && (!Array.isArray(place) || place.some((entry) => typeof entry !== "string"))) {
      throw sourceError("unexpected_schema", "Yokohama facility area type is invalid.", { facilityId: facility.facilityId });
    }
  }
  for (const field of ["createdAt", "updatedAt"]) {
    if (item[field] !== null && canonicalizeUtcIso(item[field]) === null) {
      throw sourceError("unexpected_schema", `Yokohama ${field} is invalid.`, { facilityId: facility.facilityId });
    }
  }
}

function validateFacilities(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("facilities must be a non-empty array.");
  const output = [];
  const ids = new Set();
  for (const facility of value) {
    if (
      !facility
      || facility.providerId !== YOKOHAMA_FIXED_NODE_PROVIDER_ID
      || typeof facility.facilityId !== "string"
      || typeof facility.providerFacilityKey !== "string"
      || ids.has(facility.facilityId)
    ) {
      throw new Error("facilities must contain unique Yokohama DB registry rows.");
    }
    ids.add(facility.facilityId);
    output.push(facility);
  }
  return output;
}

function yokohamaFacilitySourceUrl(providerFacilityKey) {
  if (!/^[a-z0-9-]+$/u.test(providerFacilityKey)) throw new Error("Invalid Yokohama provider facility key.");
  return `https://${YOKOHAMA_HOST}/${providerFacilityKey}/fishing-history`;
}

function extractYokohamaBundlePath(rootHtml) {
  const path = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/iu.exec(rootHtml)?.[1]
    ?? /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["']/iu.exec(rootHtml)?.[1];
  if (!path) throw sourceError("yokohama-bundle-url-missing");
  return path;
}

function parseSlashDate(value) {
  const match = /^(20\d{2})\/(\d{2})\/(\d{2})$/u.exec(String(value ?? ""));
  if (!match) throw sourceError("unexpected_schema", "Yokohama observation date is invalid.");
  return validateDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

function requireIsoDate(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/u.test(value)) throw new Error("observationDate must be YYYY-MM-DD.");
  const [year, month, day] = value.split("-").map(Number);
  if (validateDateParts(year, month, day) !== value) throw new Error("observationDate must be a valid date.");
  return value;
}

function validateDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw sourceError("unexpected_schema", "Observation date is invalid.");
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new Error(`${label} must be canonical UTC ISO datetime.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${label} must be canonical UTC ISO datetime.`);
  return value;
}

function canonicalizeUtcIso(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function hasClosureLanguage(value) {
  return /(?:休場|休園|臨時休業|営業中止|終日閉場|閉鎖のため休)/u.test(String(value ?? ""));
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\t\r\n ]+/gu, " ").trim();
  return text === "" ? null : text;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return unique(value.map(cleanText).filter(Boolean));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/,/gu, ""));
  return Number.isFinite(number) ? number : null;
}

function finiteNonnegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function finiteNonnegativeInteger(value) {
  const number = finiteNonnegativeNumber(value);
  return Number.isInteger(number) ? number : null;
}

function sourceError(code, message = code, details = {}) {
  return new YokohamaFixedNodeSourceError(code, message, details);
}

function failureFromError(error) {
  return {
    code: error?.code ?? "parse_error",
    httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null,
    message: String(error?.message ?? "Yokohama source failed.").slice(0, 200)
  };
}

function unique(values) {
  return [...new Set(values)];
}
