#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RIVER_CANAL_AUDIT_VERSION = "wanoku-river-canal-observability-audit.v1";
export const TEMPORAL_CLASSES = Object.freeze([
  "REALTIME",
  "HOURLY",
  "DAILY",
  "PERIODIC",
  "HISTORICAL_ONLY",
  "UNAVAILABLE"
]);
export const OBSERVABILITY_GRADES = Object.freeze(["STRONG", "MODERATE", "WEAK", "NONE"]);
export const OBSERVABILITY_SIGNALS = Object.freeze([
  "catch",
  "bait",
  "waterLevel",
  "discharge",
  "rain",
  "tide",
  "temperature",
  "salinityProxy",
  "DO",
  "drainage",
  "camera",
  "biologicalPrior"
]);

const CANONICAL_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const JST_LOCAL_MINUTE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/u;
const MAX_DELAY_MS = 10_000;

export const AUDIT_SOURCES = Object.freeze([
  source("mlit-hydrology-index", "official-hydrology", "https://www1.river.go.jp/contents.html", ["cgi-bin"]),
  source("mlit-iwabuchi-upper", "official-station", "https://www1.river.go.jp/cgi-bin/SiteInfoDetail.exe?ID=303041283309040", ["303041283309040"]),
  source("mlit-iizuka-bridge", "official-station", "https://www1.river.go.jp/cgi-bin/SiteInfoDetail.exe?ID=303031283305490", ["303031283305490"]),
  source("mlit-onagigawa", "official-station", "https://www1.river.go.jp/cgi-bin/SiteInfoDetail.exe?ID=303041283309110", ["303041283309110"]),
  source("mlit-edogawa-weir-upper", "official-station", "https://www1.river.go.jp/cgi-bin/SiteInfoDetail.exe?ID=303031283305030", ["303031283305030"]),
  source("tokyo-water-disaster", "official-realtime", "https://www.kasen-suibo.metro.tokyo.lg.jp/im/uryosuii/tsim0105g_203002.html?lat=35.7394&lng=139.77373888888891&tgid=203002", ["隅田川", "小台"]),
  source("chiba-crisis-gauges", "official-realtime", "https://www.pref.chiba.lg.jp/kakan/h20-suibou/kikikanrisuii.html", ["危機管理型水位計", "真間川"]),
  source("chiba-river-cameras", "official-realtime", "https://www.pref.chiba.lg.jp/kakan/h20-suibou/kasencamera.html", ["河川監視カメラ", "海老川"]),
  source("tokyo-water-quality", "official-periodic", "https://www.kankyo.metro.tokyo.lg.jp/water/tokyo_bay/measurements/news_flash", ["水質測定結果", "速報"]),
  source("chiba-water-quality", "official-periodic", "https://www.pref.chiba.lg.jp/suiho/kasentou/koukyouyousui/data/data_1.html", ["水質測定結果", "真間川"]),
  source("koto-river-network", "official-topology", "https://www.city.koto.lg.jp/470604/kasen/info.html", ["小名木川", "横十間川"]),
  source("tokyo-river-biological-survey", "official-biological", "https://www.kankyo.metro.tokyo.lg.jp/water/tokyo_bay/creature/river_organisms", ["河川", "生物"]),
  source("mlit-edogawa-river-census", "official-biological", "https://www.ktr.mlit.go.jp/edogawa/edogawa00100.html", ["河川水辺の国勢調査", "中川"]),
  source("mlit-arakawa-river-census", "official-biological", "https://www.ktr.mlit.go.jp/arajo/arajo_index013.html", ["河川水辺", "荒川"]),
  source("anglers-arakawa", "public-catch-candidate", "https://anglers.jp/areas/986/fishings", ["荒川", "シーバス"]),
  source("anglers-nakagawa", "public-catch-candidate", "https://anglers.jp/areas/357/fishings", ["中川", "シーバス"]),
  source("anglers-shin-nakagawa", "public-catch-candidate", "https://anglers.jp/areas/2351/fishings", ["新中川", "シーバス"]),
  source("anglers-kyu-edogawa-mouth", "public-catch-candidate", "https://anglers.jp/areas/515", ["旧江戸川河口", "シーバス"]),
  source("anglers-sumida", "public-catch-candidate", "https://anglers.jp/areas/1052/fishings", ["隅田川", "シーバス"]),
  source("anglers-edogawa-lower", "public-catch-candidate", "https://anglers.jp/areas/2350/fishings", ["江戸川下流", "シーバス"]),
  source("anglers-koto-canal", "public-catch-candidate", "https://anglers.jp/areas/1215", ["あけぼの運河", "シーバス"]),
  source("anglers-hanamigawa", "public-catch-candidate", "https://anglers.jp/areas/3362/fishings", ["花見川", "シーバス"])
]);

const SOURCE_BY_URL = new Map(AUDIT_SOURCES.map((entry) => [entry.url, entry]));

const CORRIDOR_SEEDS = Object.freeze([
  corridor("arakawa", "ARA", "荒川", "Tokyo", "river", ["MOUTH", "LOWER", "MID-LOWER", "MIDDLE"], [
    "Nakagawa sluice pair separates the Nakagawa branch from the Arakawa main channel.",
    "Iwabuchi gate separates the Sumida branch from the Arakawa flood channel."
  ]),
  corridor("nakagawa", "NKG", "中川", "Tokyo", "river", ["MOUTH", "LOWER", "MID-LOWER", "MIDDLE"], [
    "Nakagawa sluice front/back gauges preserve the hydraulic boundary instead of merging the two water bodies."
  ]),
  corridor("shin-nakagawa", "SNK", "新中川", "Tokyo", "river", ["MOUTH", "LOWER", "MIDDLE"], [
    "Branches from Nakagawa near Takasago and joins Kyu-Edogawa near Imai; no direct official realtime station was verified in this audit."
  ]),
  corridor("kyu-edogawa", "KED", "旧江戸川", "Tokyo/Chiba", "river", ["MOUTH", "LOWER", "MID-LOWER", "MIDDLE"], [
    "Edogawa water gate is a hydraulic control at the Edogawa/Kyu-Edogawa split."
  ]),
  corridor("sumida", "SUM", "隅田川", "Tokyo", "river", ["MOUTH", "LOWER", "MID-LOWER", "MIDDLE"], [
    "The upstream connection to Arakawa is gate-controlled at Iwabuchi."
  ]),
  corridor("edogawa", "EDO", "江戸川", "Tokyo/Chiba", "river", ["MOUTH", "LOWER", "MID-LOWER", "MIDDLE"], [
    "Gyotoku movable weir and Edogawa water gate divide lower-river hydraulic behavior."
  ]),
  corridor("koto-internal", "KCI", "江東内部河川・運河群", "Tokyo", "canal-network", ["BAY", "WEST-BRANCH", "EAST-BRANCH", "CROSS-BRANCH"], [
    "West and east internal-river areas contain gates, locks, and pump drainage; they are not treated as one unseparated canal."
  ]),
  corridor("hanamigawa", "HNM", "花見川 / 印旛放水路", "Chiba", "floodway-river", ["MOUTH", "LOWER", "MID-LOWER", "MIDDLE"], [
    "The floodway connection toward Lake Inba is operationally controlled; public event logs were not verified."
  ]),
  corridor("ebigawa", "EBI", "海老川", "Chiba", "river", ["MOUTH", "LOWER", "MIDDLE"], []),
  corridor("mamagawa", "MAM", "真間川", "Chiba", "river-network", ["MOUTH", "LOWER", "MIDDLE"], [
    "Branch and drainage infrastructure requires network treatment rather than straight-line grouping."
  ]),
  corridor("miakegawa", "MIA", "見明川", "Chiba", "river", ["MOUTH", "LOWER"], [])
]);

export const CORRIDORS = Object.freeze(CORRIDOR_SEEDS.map((seed) => Object.freeze({
  ...seed,
  segments: Object.freeze(seed.roles.map((role, index) => Object.freeze({
    segmentId: buildSegmentId(seed.code, index),
    corridorId: seed.corridorId,
    role,
    waterBody: seed.waterBody,
    coordinates: null,
    boundaryBasis: boundaryBasis(seed.corridorId, role)
  })))
})));

const SEGMENT_BY_ID = new Map(CORRIDORS.flatMap((entry) => entry.segments).map((entry) => [entry.segmentId, entry]));

export const OFFICIAL_STATIONS = Object.freeze([
  mlitStation("303041283309040", "岩淵水門（上）", "arakawa", "ARA-3", "荒川", [metric("waterLevel", "REALTIME", "10 minutes"), metric("discharge", "HISTORICAL_ONLY", "hourly/daily tables when published")], "1924-04-01", 21.08, dms(35, 47, 15, 139, 43, 38, "https://www1.river.go.jp/cgi-bin/SiteInfoDetail.exe?ID=303041283309040")),
  mlitStation("303041283309180", "岩淵水門（下）", "sumida", "SUM-3", "隅田川", [metric("waterLevel", "REALTIME", "10 minutes")], null, null, dms(35, 47, 3, 139, 44, 9, "https://www1.river.go.jp/cgi-bin/SiteInfo.exe?ID=303041283309180")),
  mlitStation("303031283305490", "飯塚橋", "nakagawa", "NKG-3", "中川", [metric("waterLevel", "REALTIME", "10 minutes"), metric("discharge", "HISTORICAL_ONLY", "hourly/daily tables when published")], "1971-11-01", 16.28, dms(35, 46, 43, 139, 51, 0, "https://www1.river.go.jp/cgi-bin/SiteInfoDetail.exe?ID=303031283305490")),
  mlitStation("303041283309100", "中川水門（表）", "arakawa", "ARA-1", "荒川", [metric("waterLevel", "REALTIME", "10 minutes")], "1924-01-01", 6.93, dms(35, 43, 13, 139, 50, 39, "https://www1.river.go.jp/cgi-bin/SiteInfoDetail.exe?ID=303041283309100")),
  mlitStation("303041283309101", "中川水門（裏）", "nakagawa", "NKG-0", "中川", [metric("waterLevel", "REALTIME", "10 minutes")], null, null, null),
  mlitStation("303041283309110", "小名木川", "koto-internal", "KCI-2", "荒川", [metric("waterLevel", "REALTIME", "10 minutes"), metric("discharge", "HISTORICAL_ONLY", "hourly/daily tables when published")], "1938-08-24", 2.6, dms(35, 40, 58, 139, 50, 53, "https://www1.river.go.jp/cgi-bin/SiteInfoDetail.exe?ID=303041283309110")),
  mlitStation("303031283305230", "江戸川水門下", "kyu-edogawa", "KED-2", "旧江戸川", [metric("waterLevel", "REALTIME", "10 minutes")], null, null, dms(35, 42, 2, 139, 55, 4, "https://www1.river.go.jp/cgi-bin/SiteInfo.exe?ID=303031283305230")),
  mlitStation("303031283305030", "可動堰上", "edogawa", "EDO-1", "江戸川", [metric("waterLevel", "REALTIME", "10 minutes"), metric("discharge", "HISTORICAL_ONLY", "hourly/daily tables when published")], "1957-12-01", 3.47, dms(35, 42, 11, 139, 55, 16, "https://www1.river.go.jp/cgi-bin/SiteInfoDetail.exe?ID=303031283305030")),
  namedStation("tokyo-water-disaster", "tgid:203002", "小台", "sumida", "SUM-2", "隅田川", [metric("waterLevel", "REALTIME", "5 minutes"), metric("camera", "REALTIME", "5 minutes")]),
  namedStation("chiba-standard-water-level", "name:amado", "天戸", "hanamigawa", "HNM-3", "印旛放水路", [metric("waterLevel", "REALTIME", "published realtime network")]),
  namedStation("chiba-standard-water-level", "name:nagasaku", "長作", "hanamigawa", "HNM-2", "印旛放水路", [metric("waterLevel", "REALTIME", "published realtime network")]),
  namedStation("chiba-standard-water-level", "name:kemigawa", "検見川", "hanamigawa", "HNM-1", "印旛放水路", [metric("waterLevel", "REALTIME", "published realtime network")]),
  namedStation("chiba-standard-water-level", "name:funabashi-honcho", "船橋本町", "ebigawa", "EBI-1", "海老川", [metric("waterLevel", "REALTIME", "published realtime network")]),
  chibaGauge("1200000020", "真間川（鬼越）", "mamagawa", "MAM-2", "真間川"),
  chibaGauge("1200000111", "真間川（須和田）", "mamagawa", "MAM-1", "真間川"),
  chibaGauge("1200000037", "真間川（真間）", "mamagawa", "MAM-0", "真間川"),
  chibaGauge("1200000021", "海老川", "ebigawa", "EBI-1", "海老川"),
  chibaGauge("1200000112", "見明川", "miakegawa", "MIA-1", "見明川"),
  chibaCamera("3073006", "真間川（鬼越）", "mamagawa", "MAM-2", "真間川"),
  chibaCamera("3073087", "真間川（須和田）", "mamagawa", "MAM-1", "真間川"),
  chibaCamera("3073007", "海老川", "ebigawa", "EBI-1", "海老川"),
  chibaCamera("3073090", "見明川", "miakegawa", "MIA-1", "見明川"),
  namedStation("tokyo-water-quality", "120102", "飯塚橋", "nakagawa", "NKG-3", "中川", [metric("waterQuality", "PERIODIC", "scheduled grab samples")]),
  namedStation("tokyo-water-quality", "150102", "小台橋", "sumida", "SUM-2", "隅田川", [metric("waterQuality", "PERIODIC", "scheduled grab samples")]),
  namedStation("tokyo-water-quality", "150103", "白鬚橋", "sumida", "SUM-1", "隅田川", [metric("waterQuality", "PERIODIC", "scheduled grab samples")]),
  namedStation("chiba-water-quality", "120", "新花見川橋", "hanamigawa", "HNM-0", "印旛放水路（下流）", [metric("waterQuality", "PERIODIC", "6-24 scheduled measurements/year depending on field")]),
  namedStation("chiba-water-quality", "121", "八千代橋", "ebigawa", "EBI-0", "海老川", [metric("waterQuality", "PERIODIC", "12-24 scheduled measurements/year depending on field")])
]);

export const PUBLIC_CATCH_CANDIDATES = Object.freeze([
  catchCandidate("arakawa", "river/lower/estuary", ["https://anglers.jp/areas/986/fishings", "https://anglers.jp/areas/2509"], true),
  catchCandidate("nakagawa", "river-level", ["https://anglers.jp/areas/357/fishings"], true),
  catchCandidate("shin-nakagawa", "river-level", ["https://anglers.jp/areas/2351/fishings"], true),
  catchCandidate("kyu-edogawa", "estuary/river-level", ["https://anglers.jp/areas/515"], true),
  catchCandidate("sumida", "river/lower/estuary", ["https://anglers.jp/areas/1052/fishings", "https://anglers.jp/areas/2675/fishings", "https://anglers.jp/areas/1050/fishings"], true),
  catchCandidate("edogawa", "lower-river", ["https://anglers.jp/areas/2350/fishings"], true),
  catchCandidate("koto-internal", "canal/spot", ["https://anglers.jp/areas/1215"], true),
  catchCandidate("hanamigawa", "river/estuary", ["https://anglers.jp/areas/3362/fishings"], true),
  catchCandidate("ebigawa", "none-found-in-targeted-public-search", [], false),
  catchCandidate("mamagawa", "none-found-in-targeted-public-search", [], false),
  catchCandidate("miakegawa", "none-found-in-targeted-public-search", [], false)
]);

const PROFILE_BY_CORRIDOR = Object.freeze({
  arakawa: profile({
    catch: signal("STRONG", "REALTIME", "Public river, lower-river, and estuary area pages expose dated species posts; formal acquisition terms/bias remain unaudited."),
    bait: signal("WEAK", "REALTIME", "Public pages expose lure/bait hints but not a controlled bait-abundance observation."),
    waterLevel: signal("STRONG", "REALTIME", "Multiple 10-minute MLIT gauges include a gate pair and long history."),
    discharge: signal("MODERATE", "HISTORICAL_ONLY", "MLIT flow tables exist at selected stations; realtime discharge availability was not asserted."),
    rain: signal("STRONG", "REALTIME", "MLIT and Tokyo rainfall networks provide 5-10 minute regional observations."),
    tide: signal("STRONG", "REALTIME", "Mouth-side JMA tide plus gate-pair water levels can preserve phase differences."),
    temperature: signal("MODERATE", "PERIODIC", "Official grab-sample water temperature is a seasonal prior, not a live value."),
    salinityProxy: signal("WEAK", "PERIODIC", "Conductivity/salinity-related periodic fields may support a seasonal prior only."),
    DO: signal("MODERATE", "PERIODIC", "Official periodic DO is available at lower-river sampling points."),
    drainage: signal("WEAK", "UNAVAILABLE", "Gate topology is known but public operation event logs were not verified."),
    camera: signal("MODERATE", "REALTIME", "Official river cameras exist, but image inference is outside scope."),
    biologicalPrior: signal("STRONG", "PERIODIC", "MLIT river census and Tokyo surveys provide periodic species/method/date evidence.")
  }),
  nakagawa: profile({
    catch: signal("MODERATE", "REALTIME", "A dated river-level public area exists but does not resolve Wanoku macro segments."),
    bait: signal("WEAK", "REALTIME", "Public lure/bait display is candidate metadata, not a measured bait field."),
    waterLevel: signal("STRONG", "REALTIME", "Iizuka and the Nakagawa-gate back gauge provide direct 10-minute observations."),
    discharge: signal("MODERATE", "HISTORICAL_ONLY", "Iizuka exposes historical flow tables; live flow was not verified."),
    rain: signal("STRONG", "REALTIME", "Tokyo/MLIT catchment rain networks are available."),
    tide: signal("MODERATE", "REALTIME", "Gate-pair levels plus bay tide support a future tidal-penetration proxy."),
    temperature: signal("MODERATE", "PERIODIC", "Iizuka official water-quality sampling supplies periodic temperature."),
    salinityProxy: signal("WEAK", "PERIODIC", "No live conductivity front was found; periodic chemistry is proxy-only."),
    DO: signal("MODERATE", "PERIODIC", "Official periodic DO is present at Iizuka."),
    drainage: signal("WEAK", "UNAVAILABLE", "Nakagawa gate structure is known; operation timestamps/amounts are unavailable."),
    camera: signal("WEAK", "REALTIME", "Regional official cameras exist but direct segment coverage is incomplete."),
    biologicalPrior: signal("STRONG", "PERIODIC", "MLIT Edogawa-system river census includes Nakagawa.")
  }),
  "shin-nakagawa": profile({
    catch: signal("MODERATE", "REALTIME", "A dated species-visible river area exists."),
    bait: signal("WEAK", "REALTIME", "Public popular-lure data is not a standardized bait observation."),
    waterLevel: signal("WEAK", "REALTIME", "No direct station was verified; only Nakagawa and Kyu-Edogawa endpoint proxies exist."),
    discharge: signal("NONE", "UNAVAILABLE", "No direct public discharge station was verified."),
    rain: signal("MODERATE", "REALTIME", "Nearby Tokyo rain gauges cover storm timing but not channel flow."),
    tide: signal("WEAK", "REALTIME", "Endpoint water levels can be tested as a proxy; direct tidal signature is unverified."),
    temperature: signal("WEAK", "PERIODIC", "Regional periodic surveys may inform seasonality; direct live data is absent."),
    salinityProxy: signal("NONE", "UNAVAILABLE", "No direct conductivity/salinity series was verified."),
    DO: signal("WEAK", "PERIODIC", "Periodic regional water-quality data is sparse for the direct channel."),
    drainage: signal("NONE", "UNAVAILABLE", "No public operation series was verified."),
    camera: signal("NONE", "UNAVAILABLE", "No direct official camera was verified."),
    biologicalPrior: signal("MODERATE", "PERIODIC", "Regional river biological surveys can provide occupancy priors, not live movement.")
  }),
  "kyu-edogawa": profile({
    catch: signal("STRONG", "REALTIME", "A high-volume dated estuary/river public area exists with species visibility."),
    bait: signal("WEAK", "REALTIME", "Public lure/bait metadata is uncontrolled."),
    waterLevel: signal("STRONG", "REALTIME", "Edogawa water-gate lower gauge provides direct 10-minute levels."),
    discharge: signal("WEAK", "HISTORICAL_ONLY", "Upstream Edogawa flow can proxy freshwater forcing; direct branch discharge is absent."),
    rain: signal("STRONG", "REALTIME", "Tokyo and Chiba rainfall networks cover the basin."),
    tide: signal("STRONG", "REALTIME", "Direct lower-gate level and bay tide capture tidal signature while preserving control separation."),
    temperature: signal("MODERATE", "PERIODIC", "Tokyo/Chiba official water-quality records are periodic."),
    salinityProxy: signal("WEAK", "PERIODIC", "Periodic chemistry can indicate seawater influence; no live front exists."),
    DO: signal("MODERATE", "PERIODIC", "Official periodic DO is available in the lower system."),
    drainage: signal("WEAK", "UNAVAILABLE", "Gate existence is known; public operation records were not found."),
    camera: signal("MODERATE", "REALTIME", "Official cameras cover parts of the lower Edogawa system."),
    biologicalPrior: signal("STRONG", "PERIODIC", "MLIT/municipal biological surveys cover the Edogawa system.")
  }),
  sumida: profile({
    catch: signal("STRONG", "REALTIME", "River, lower, and estuary public areas expose dates and species."),
    bait: signal("WEAK", "REALTIME", "Public lure/bait hints are not standardized bait abundance."),
    waterLevel: signal("STRONG", "REALTIME", "Iwabuchi lower and Odai provide direct realtime levels with camera coverage."),
    discharge: signal("WEAK", "HISTORICAL_ONLY", "Arakawa upstream discharge is only a forcing proxy; direct lower Sumida flow is absent."),
    rain: signal("STRONG", "REALTIME", "Tokyo rainfall gauges update every five minutes."),
    tide: signal("STRONG", "REALTIME", "Direct level signature and bay tide are available; Iwabuchi control is explicit."),
    temperature: signal("MODERATE", "PERIODIC", "Odai/Shirahige official periodic temperature is available."),
    salinityProxy: signal("WEAK", "PERIODIC", "Periodic conductivity/salinity-related chemistry is not a live front."),
    DO: signal("MODERATE", "PERIODIC", "Odai/Shirahige periodic DO supports habitat priors."),
    drainage: signal("WEAK", "UNAVAILABLE", "Iwabuchi control exists but operation event history was not verified."),
    camera: signal("STRONG", "REALTIME", "Odai official still imagery and realtime level are co-published."),
    biologicalPrior: signal("MODERATE", "PERIODIC", "Tokyo river biological survey provides periodic evidence.")
  }),
  edogawa: profile({
    catch: signal("STRONG", "REALTIME", "A dated lower-river public area exposes species and spot references."),
    bait: signal("WEAK", "REALTIME", "Popular lure/bait display is not survey-grade."),
    waterLevel: signal("STRONG", "REALTIME", "Gyotoku weir gauges and a long MLIT record cover lower-river levels."),
    discharge: signal("STRONG", "HISTORICAL_ONLY", "Multiple long-running MLIT flow stations support basin forcing analysis; live use needs a separate audit."),
    rain: signal("STRONG", "REALTIME", "MLIT/Chiba realtime rain network covers the basin."),
    tide: signal("MODERATE", "REALTIME", "Weir-side levels plus bay tide support a controlled tidal proxy."),
    temperature: signal("MODERATE", "PERIODIC", "Chiba annual CSVs include scheduled water-quality observations."),
    salinityProxy: signal("WEAK", "PERIODIC", "Periodic chemistry is available but no realtime saline-front sensor was found."),
    DO: signal("MODERATE", "PERIODIC", "Official periodic DO supports seasonal habitat priors."),
    drainage: signal("WEAK", "UNAVAILABLE", "Weir/gate topology is known; operation event details are not publicly structured in audited sources."),
    camera: signal("MODERATE", "REALTIME", "Official lower-basin cameras are available."),
    biologicalPrior: signal("STRONG", "PERIODIC", "MLIT Edogawa river census includes species, survey date, and method.")
  }),
  "koto-internal": profile({
    catch: signal("MODERATE", "REALTIME", "Canal/spot public areas exist, but coverage is fragmented by named branch."),
    bait: signal("WEAK", "REALTIME", "Public lure/bait hints are not controlled bait observations."),
    waterLevel: signal("MODERATE", "REALTIME", "An Arakawa-side Onagigawa gauge and Tokyo network provide boundary levels; internal branches remain uneven."),
    discharge: signal("WEAK", "HISTORICAL_ONLY", "Boundary flow records do not expose branch-by-branch pump discharge."),
    rain: signal("STRONG", "REALTIME", "Tokyo five-minute rain gauges directly cover Koto."),
    tide: signal("MODERATE", "REALTIME", "Bay and boundary levels are available, but gates/locks can hydraulically separate branches."),
    temperature: signal("MODERATE", "PERIODIC", "Multiple official canal water-quality sampling points exist."),
    salinityProxy: signal("WEAK", "PERIODIC", "Periodic conductivity/chemistry is usable only as a seasonal prior."),
    DO: signal("MODERATE", "PERIODIC", "Periodic official DO exists at several internal channels."),
    drainage: signal("WEAK", "UNAVAILABLE", "Pump/gate names and capacities are documented; status, amount, start/end, trigger, and history were not found as public data."),
    camera: signal("WEAK", "REALTIME", "Some official boundary cameras exist; internal network coverage is incomplete."),
    biologicalPrior: signal("MODERATE", "PERIODIC", "Tokyo river biological survey covers selected internal waterways.")
  }),
  hanamigawa: profile({
    catch: signal("MODERATE", "REALTIME", "Public river and estuary postings expose date/species, but macro-segment identity is unresolved."),
    bait: signal("WEAK", "REALTIME", "Public lure/bait hints are not survey-grade."),
    waterLevel: signal("STRONG", "REALTIME", "Amado, Nagasaku, and Kemigawa official gauges span the corridor."),
    discharge: signal("WEAK", "UNAVAILABLE", "No structured public pump/discharge event series was verified."),
    rain: signal("STRONG", "REALTIME", "Chiba realtime rainfall network covers the floodway."),
    tide: signal("MODERATE", "REALTIME", "Lower levels plus bay tide can test penetration, subject to floodway controls."),
    temperature: signal("MODERATE", "PERIODIC", "Shin-Hanamigawa Bridge has scheduled official water-quality observations."),
    salinityProxy: signal("WEAK", "PERIODIC", "Periodic chemistry can support a seasonal lower-floodway prior only."),
    DO: signal("MODERATE", "PERIODIC", "Official scheduled DO is available."),
    drainage: signal("WEAK", "UNAVAILABLE", "Floodway/pump infrastructure is documented; structured operation status/history was not verified."),
    camera: signal("WEAK", "REALTIME", "Regional official cameras exist, but direct macro-segment coverage is incomplete."),
    biologicalPrior: signal("MODERATE", "PERIODIC", "Chiba water-environment plans and surveys provide periodic habitat evidence.")
  }),
  ebigawa: profile({
    catch: signal("NONE", "UNAVAILABLE", "No dedicated public ANGLERS river-area candidate was found in the bounded search."),
    bait: signal("NONE", "UNAVAILABLE", "No dedicated public area candidate was verified."),
    waterLevel: signal("STRONG", "REALTIME", "Standard and crisis-management gauges provide direct levels."),
    discharge: signal("NONE", "UNAVAILABLE", "No public discharge series was verified."),
    rain: signal("STRONG", "REALTIME", "Chiba realtime rainfall network covers Funabashi."),
    tide: signal("MODERATE", "REALTIME", "Lower level plus Funabashi bay tide can support a future proxy."),
    temperature: signal("MODERATE", "PERIODIC", "Yachiyo Bridge has scheduled official measurements."),
    salinityProxy: signal("WEAK", "PERIODIC", "Periodic chemistry exists; live saline influence is unavailable."),
    DO: signal("MODERATE", "PERIODIC", "Scheduled official DO is available."),
    drainage: signal("NONE", "UNAVAILABLE", "No structured public event series was verified."),
    camera: signal("STRONG", "REALTIME", "A direct official camera updates every five minutes."),
    biologicalPrior: signal("MODERATE", "PERIODIC", "Official fish-presence material exists, but it is not a live catch signal.")
  }),
  mamagawa: profile({
    catch: signal("NONE", "UNAVAILABLE", "No dedicated public ANGLERS river-area candidate was found in the bounded search."),
    bait: signal("NONE", "UNAVAILABLE", "No public area candidate was verified."),
    waterLevel: signal("STRONG", "REALTIME", "Three crisis gauges cover mouth-to-middle behavior."),
    discharge: signal("NONE", "UNAVAILABLE", "No public discharge series was verified."),
    rain: signal("STRONG", "REALTIME", "Chiba realtime rainfall observations cover the basin."),
    tide: signal("WEAK", "REALTIME", "Mouth level can be compared with bay tide, but branch/drainage controls remain unresolved."),
    temperature: signal("MODERATE", "PERIODIC", "Chiba annual water-quality CSVs include scheduled measurements."),
    salinityProxy: signal("WEAK", "PERIODIC", "Periodic chemistry is a seasonal prior, not a live salinity front."),
    DO: signal("MODERATE", "PERIODIC", "Official periodic water-quality data is available."),
    drainage: signal("WEAK", "UNAVAILABLE", "Drainage facilities are known, but public operation events were not verified."),
    camera: signal("STRONG", "REALTIME", "Two direct official cameras update every five minutes."),
    biologicalPrior: signal("WEAK", "HISTORICAL_ONLY", "Official habitat/fish descriptions exist, but survey-level date/method coverage is limited in this audit.")
  }),
  miakegawa: profile({
    catch: signal("NONE", "UNAVAILABLE", "No dedicated public ANGLERS river-area candidate was found in the bounded search."),
    bait: signal("NONE", "UNAVAILABLE", "No public area candidate was verified."),
    waterLevel: signal("STRONG", "REALTIME", "A direct crisis-management gauge is available."),
    discharge: signal("NONE", "UNAVAILABLE", "No public discharge series was verified."),
    rain: signal("STRONG", "REALTIME", "Chiba realtime rainfall observations cover Urayasu."),
    tide: signal("MODERATE", "REALTIME", "Direct lower level can be compared with bay tide."),
    temperature: signal("NONE", "UNAVAILABLE", "No direct official recurring water-quality station was verified."),
    salinityProxy: signal("NONE", "UNAVAILABLE", "No direct conductivity/salinity series was verified."),
    DO: signal("NONE", "UNAVAILABLE", "No direct recurring official DO station was verified."),
    drainage: signal("NONE", "UNAVAILABLE", "No structured operation series was verified."),
    camera: signal("STRONG", "REALTIME", "A direct official camera updates every five minutes."),
    biologicalPrior: signal("NONE", "UNAVAILABLE", "No corridor-specific survey with date/method/species was verified in this audit.")
  })
});

export const MOVEMENT_READINESS = Object.freeze([
  readiness("arakawa", "A", "READY", "Long water-level/flow history, direct gate topology, rainfall, periodic habitat data, and public catch areas."),
  readiness("nakagawa", "A", "READY", "Direct lower/middle gauges, historical flow, gate-pair topology, and river-level catch candidate."),
  readiness("shin-nakagawa", "B", "READY_WITH_PROXY", "Catch visibility and known branch topology exist, but hydrology relies on endpoint proxies."),
  readiness("kyu-edogawa", "A", "READY", "Direct tidal water level, known gate control, regional discharge/rain, habitat priors, and strong catch candidate."),
  readiness("sumida", "A", "READY", "Dense level/camera/rain coverage, explicit Iwabuchi control, periodic quality, and multi-scale catch areas."),
  readiness("edogawa", "A", "READY", "Long hydrology history, weir topology, basin rain/flow, biological prior, and lower-river catch candidate."),
  readiness("koto-internal", "B", "READY_WITH_PROXY", "Topology and periodic quality are rich, but pump event telemetry and uniform branch hydrology are absent."),
  readiness("hanamigawa", "B", "READY_WITH_PROXY", "Three level gauges, rain, periodic quality, and catch candidate exist; controlled discharge events are missing."),
  readiness("ebigawa", "C", "SPARSE", "Level/camera/rain and periodic quality are usable, but discharge and dedicated catch area are absent."),
  readiness("mamagawa", "C", "SPARSE", "Level/camera/rain are strong; discharge, event logs, and dedicated catch area remain absent."),
  readiness("miakegawa", "C", "SPARSE", "Direct level/camera/rain exist, but catch, discharge, water quality, and biological priors are unverified.")
]);

export function parseRiverCanalAuditArgs(argv = process.argv.slice(2)) {
  const options = { delayMs: 50 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--delay-ms") options.delayMs = parseInteger(readValue(), "delay-ms", 0, MAX_DELAY_MS);
    else if (arg === "--collected-at") options.collectedAt = requireCanonicalUtcIso(readValue(), "collected-at");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function buildStationStableId(providerId, stationId) {
  if (typeof providerId !== "string" || providerId.trim() === "") throw new Error("providerId is required.");
  if (typeof stationId !== "string" || stationId.trim() === "") throw new Error("stationId is required.");
  return `${providerId}:${stationId}`;
}

export function buildSegmentId(corridorCode, index) {
  if (!/^[A-Z]{3}$/u.test(corridorCode)) throw new Error("corridorCode must be three uppercase ASCII letters.");
  if (!Number.isInteger(index) || index < 0 || index > 99) throw new Error("segment index must be 0..99.");
  return `${corridorCode}-${index}`;
}

export function normalizeJstTimestamp(value) {
  const match = JST_LOCAL_MINUTE.exec(String(value ?? ""));
  if (!match) throw new Error("timestamp must be YYYY-MM-DD HH:mm in JST.");
  const [, year, month, day, hour, minute] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+09:00`);
  if (!Number.isFinite(parsed.getTime())) throw new Error("timestamp is invalid.");
  const roundTrip = new Date(parsed.getTime() + 9 * 60 * 60 * 1000);
  if (
    roundTrip.getUTCFullYear() !== Number(year)
    || roundTrip.getUTCMonth() + 1 !== Number(month)
    || roundTrip.getUTCDate() !== Number(day)
    || roundTrip.getUTCHours() !== Number(hour)
    || roundTrip.getUTCMinutes() !== Number(minute)
  ) throw new Error("timestamp is invalid.");
  return parsed.toISOString();
}

export function normalizePublishedValue(value) {
  if (value === null || value === undefined) return { value: null, missingReason: "not-provided" };
  const text = String(value).trim();
  if (text === "" || /^(?:--?|×|−)$/u.test(text) || /(?:休止|欠測|未観測|閉局|データなし)/u.test(text)) {
    return { value: null, missingReason: "source-missing" };
  }
  const normalizedNumber = Number(text.replace(/,/gu, ""));
  return Number.isFinite(normalizedNumber)
    ? { value: normalizedNumber, missingReason: null }
    : { value: text, missingReason: null };
}

export function assertNoDuplicateStations(stations) {
  const seen = new Set();
  for (const station of stations) {
    const stableId = buildStationStableId(station.providerId, station.stationId);
    if (seen.has(stableId)) throw new Error(`Duplicate station stable ID: ${stableId}`);
    seen.add(stableId);
  }
  return true;
}

export function assertCoordinatesHaveEvidence(stations) {
  for (const station of stations) {
    if (station.officialCoordinates === null) continue;
    const coordinates = station.officialCoordinates;
    if (!Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude) || !coordinates.evidenceUrl || coordinates.sourceFormat !== "official-dms") {
      throw new Error(`Coordinate evidence missing for ${station.stableId}.`);
    }
  }
  return true;
}

export function normalizeAuditReadUrl(value) {
  const url = new URL(value);
  url.hash = "";
  const normalized = url.href;
  if (!SOURCE_BY_URL.has(normalized)) throw new Error("Source URL is not in the river/canal audit allowlist.");
  return normalized;
}

export function buildSegmentGraph() {
  const nodes = [
    graphNode("BAY-TOKYO-EAST", "bay-macro", "東京湾東側bay-side macro zone"),
    graphNode("BAY-TOKYO-CENTRAL", "bay-macro", "東京湾中央bay-side macro zone"),
    graphNode("BAY-CHIBA-WEST", "bay-macro", "千葉西岸bay-side macro zone"),
    graphNode("INBA-MARSH", "external-water-body", "印旛沼 connection reference"),
    ...CORRIDORS.flatMap((entry) => entry.segments.map((segment) => ({
      nodeId: segment.segmentId,
      nodeType: "river-segment",
      label: `${entry.label} ${segment.role}`,
      corridorId: entry.corridorId,
      waterBody: entry.waterBody,
      coordinates: null
    })))
  ];
  const edges = [];
  for (const entry of CORRIDORS) {
    for (let index = 0; index < entry.segments.length - 1; index += 1) {
      edges.push(graphEdge(`${entry.code}-UP-${index}`, entry.segments[index].segmentId, entry.segments[index + 1].segmentId, "upstream-downstream", false, null));
    }
  }
  edges.push(
    graphEdge("BAY-ARA", "BAY-TOKYO-EAST", "ARA-0", "bay-connection", false, null),
    graphEdge("BAY-NKG", "BAY-TOKYO-EAST", "NKG-0", "bay-connection", true, "中川水門"),
    graphEdge("BAY-KED", "BAY-TOKYO-EAST", "KED-0", "bay-connection", false, null),
    graphEdge("BAY-SUM", "BAY-TOKYO-CENTRAL", "SUM-0", "bay-connection", false, null),
    graphEdge("BAY-EDO", "BAY-TOKYO-EAST", "EDO-0", "bay-connection", true, "行徳可動堰"),
    graphEdge("BAY-KCI", "BAY-TOKYO-CENTRAL", "KCI-0", "bay-connection", true, "辰巳・東雲・豊洲等の水門群"),
    graphEdge("BAY-HNM", "BAY-CHIBA-WEST", "HNM-0", "bay-connection", false, null),
    graphEdge("BAY-EBI", "BAY-CHIBA-WEST", "EBI-0", "bay-connection", false, null),
    graphEdge("BAY-MAM", "BAY-TOKYO-EAST", "MAM-0", "bay-connection", true, "根本水門等の流域排水施設"),
    graphEdge("BAY-MIA", "BAY-TOKYO-EAST", "MIA-0", "bay-connection", false, null),
    graphEdge("BRANCH-NKG-ARA", "NKG-0", "ARA-1", "branch-connection", true, "中川水門"),
    graphEdge("BRANCH-SUM-ARA", "SUM-3", "ARA-3", "branch-connection", true, "岩淵水門"),
    graphEdge("BRANCH-SNK-NKG", "SNK-2", "NKG-2", "branch-connection", false, null),
    graphEdge("BRANCH-SNK-KED", "SNK-0", "KED-2", "branch-connection", false, null),
    graphEdge("BRANCH-EDO-KED", "EDO-1", "KED-2", "branch-connection", true, "江戸川水門"),
    graphEdge("BRANCH-KCI-SUM", "KCI-1", "SUM-1", "branch-connection", true, "隅田川側水門群"),
    graphEdge("BRANCH-KCI-ARA", "KCI-2", "ARA-0", "branch-connection", true, "荒川ロックゲート・小名木川排水機場"),
    graphEdge("BRANCH-HNM-INBA", "HNM-3", "INBA-MARSH", "controlled-floodway", true, "大和田排水機場・印旛放水路管理施設")
  );
  return {
    nodes,
    edges,
    externalHabitatLinks: [
      habitatLink("ARA-0", "sumida-arakawa-mouth-01"),
      habitatLink("NKG-0", "sumida-arakawa-mouth-01"),
      habitatLink("SUM-0", "tokyo-inner-bay-01"),
      habitatLink("KED-0", "tokyo-inner-bay-01"),
      habitatLink("EDO-0", "tokyo-inner-bay-01"),
      habitatLink("KCI-0", "tokyo-inner-bay-01"),
      habitatLink("HNM-0", "makuhari-shallow-01"),
      habitatLink("EBI-0", "funabashi-inner-01"),
      habitatLink("MAM-0", "funabashi-inner-01"),
      habitatLink("MIA-0", "funabashi-inner-01")
    ]
  };
}

export function buildObservabilityMatrix() {
  return CORRIDORS.flatMap((entry) => entry.segments.flatMap((segment) => OBSERVABILITY_SIGNALS.map((signalName) => {
    const base = PROFILE_BY_CORRIDOR[entry.corridorId][signalName];
    const directStation = OFFICIAL_STATIONS.some((station) => station.segmentId === segment.segmentId && station.metrics.some((item) => metricMatchesSignal(item.field, signalName)));
    const corridorStation = OFFICIAL_STATIONS.some((station) => station.corridorId === entry.corridorId && station.metrics.some((item) => metricMatchesSignal(item.field, signalName)));
    let grade = base.grade;
    let reason = base.reason;
    if (["waterLevel", "discharge", "camera"].includes(signalName) && corridorStation && !directStation && grade !== "NONE") {
      grade = downgradeGrade(grade);
      reason = `${reason} No direct station is assigned to this macro segment; the grade uses a corridor-neighbor proxy.`;
    }
    if (signalName === "tide" && ["MIDDLE", "MID-LOWER"].includes(segment.role) && grade !== "NONE") {
      grade = downgradeGrade(grade);
      reason = `${reason} Inland segment tidal reach must be validated from phase lag before operational use.`;
    }
    return {
      corridorId: entry.corridorId,
      segmentId: segment.segmentId,
      segmentRole: segment.role,
      signal: signalName,
      grade,
      temporalClass: base.temporalClass,
      reason
    };
  })));
}

export function buildRiverCanalObservabilityAudit({ collectedAt, probes = [] }) {
  requireCanonicalUtcIso(collectedAt, "collectedAt");
  assertNoDuplicateStations(OFFICIAL_STATIONS);
  assertCoordinatesHaveEvidence(OFFICIAL_STATIONS);
  const graph = buildSegmentGraph();
  const matrix = buildObservabilityMatrix();
  return {
    schemaVersion: RIVER_CANAL_AUDIT_VERSION,
    auditMode: "READ_ONLY_GET",
    collectedAt,
    corridors: CORRIDORS,
    officialSources: AUDIT_SOURCES.filter((entry) => !entry.kind.startsWith("public-catch")),
    stations: OFFICIAL_STATIONS,
    stationSummary: summarizeStations(OFFICIAL_STATIONS),
    temporalSemantics: {
      realtime: "Published current observations at their stated 5-10 minute/event-mode interval.",
      periodicWaterQuality: "Seasonal habitat prior only; never exposed as current environment.",
      biologicalSurvey: "Long-term occupancy prior only; never a live fish/catch observation.",
      missingValues: "Source missing/paused markers normalize to null with an explicit missingReason.",
      timezone: "JST source labels are normalized to canonical UTC using an explicit +09:00 offset."
    },
    historicalDepth: {
      mlitHydrology: "Verified station starts range from 1924 to 1971 for the selected long-running gauges; per-station values are retained where published.",
      tokyoWaterQuality: "Annual/final and current preliminary publications are available; audited station coverage includes at least 2014 and FY2024/2025 surfaces.",
      chibaWaterQuality: "FY2016-FY2024 CSV/PDF database plus a separate FY2015-and-earlier archive; exact first year varies by station.",
      crisisGauges: "Operational current pages are verified; historical depth is not asserted by the listing page.",
      biological: "Periodic survey archives; cadence and first year vary by program."
    },
    graph,
    publicCatchCoverage: PUBLIC_CATCH_CANDIDATES,
    observabilityMatrix: matrix,
    observabilitySummary: summarizeMatrix(matrix),
    movementReadiness: MOVEMENT_READINESS,
    tidalPenetrationAssessment: tidalAssessments(),
    drainageAssessment: {
      kotoInternal: "Infrastructure names/capacities are documented, but status, discharge amount, start/end, trigger, and historical operation logs remain UNAVAILABLE as structured public data.",
      hanamigawa: "Floodway/pump control is documented, but structured public operation events remain UNAVAILABLE.",
      imageRule: "No pump/gate event is inferred from camera images."
    },
    coastalLinkageRule: "External Habitat Graph links represent bay-side macro adjacency only; a fixed coastal node and a river segment are never treated as the same point.",
    limitations: [
      "No coordinates were assigned unless an official station page published the DMS value and evidence URL.",
      "Realtime water level does not imply realtime discharge.",
      "Periodic water quality is not current environment.",
      "Biological surveys are not live catch observations.",
      "ANGLERS terms, acquisition feasibility, sampling bias, and segment mapping are deferred to the Macro Audit.",
      "Absence of a dedicated ANGLERS area in bounded search is not proof that no user posts exist."
    ],
    probes,
    remoteReads: summarizeProbes(probes),
    remoteWrites: 0
  };
}

export async function runRiverCanalObservabilityAudit(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable.");
  const delayMs = options.delayMs ?? 50;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) throw new Error(`delayMs must be 0..${MAX_DELAY_MS}.`);
  const collectedAt = requireCanonicalUtcIso(options.collectedAt ?? new Date().toISOString(), "collectedAt");
  const sources = options.sources ?? AUDIT_SOURCES;
  const probes = [];
  for (const entry of sources) {
    const url = normalizeAuditReadUrl(entry.url);
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "follow", headers: { accept: "text/html,application/xhtml+xml" } });
      const body = await response.text();
      probes.push({
        sourceId: entry.sourceId,
        kind: entry.kind,
        url,
        method: "GET",
        status: Number.isInteger(response.status) ? response.status : null,
        ok: response.ok === true,
        contentType: readHeader(response.headers, "content-type"),
        byteLength: Buffer.byteLength(body, "utf8"),
        markersFound: entry.expectedMarkers.filter((marker) => body.includes(marker)),
        error: null
      });
    } catch (error) {
      probes.push({
        sourceId: entry.sourceId,
        kind: entry.kind,
        url,
        method: "GET",
        status: null,
        ok: false,
        contentType: null,
        byteLength: 0,
        markersFound: [],
        error: String(error?.name ?? "fetch-error")
      });
    }
    if (delayMs > 0) await delay(delayMs);
  }
  return buildRiverCanalObservabilityAudit({ collectedAt, probes });
}

function source(sourceId, kind, url, expectedMarkers) {
  return Object.freeze({ sourceId, kind, url: new URL(url).href, expectedMarkers: Object.freeze(expectedMarkers) });
}

function corridor(corridorId, code, label, jurisdiction, waterBody, roles, hydraulicNotes) {
  return Object.freeze({ corridorId, code, label, jurisdiction, waterBody, roles: Object.freeze(roles), hydraulicNotes: Object.freeze(hydraulicNotes) });
}

function metric(field, temporalClass, updateInterval) {
  if (!TEMPORAL_CLASSES.includes(temporalClass)) throw new Error(`Invalid temporal class: ${temporalClass}`);
  return Object.freeze({ field, temporalClass, updateInterval });
}

function mlitStation(stationId, label, corridorId, segmentId, river, metrics, observationStart, distanceFromMouthKm, officialCoordinates) {
  return station("mlit-hydrology", stationId, label, corridorId, segmentId, river, metrics, observationStart, distanceFromMouthKm, officialCoordinates, "native station code");
}

function namedStation(providerId, stationId, label, corridorId, segmentId, river, metrics) {
  const identityBasis = stationId.startsWith("name:") ? "source-published station name; native numeric ID not exposed in audited list" : "source-published station/device code";
  return station(providerId, stationId, label, corridorId, segmentId, river, metrics, null, null, null, identityBasis);
}

function chibaGauge(stationId, label, corridorId, segmentId, river) {
  return station("chiba-crisis-water-level", stationId, label, corridorId, segmentId, river, [metric("waterLevel", "REALTIME", "10 minutes while rising; otherwise daily")], null, null, null, "river.go.jp obsCd linked by Chiba Prefecture");
}

function chibaCamera(stationId, label, corridorId, segmentId, river) {
  return station("chiba-river-camera", stationId, label, corridorId, segmentId, river, [metric("camera", "REALTIME", "5 minutes")], null, null, null, "river.go.jp sysCamId linked by Chiba Prefecture");
}

function station(providerId, stationId, label, corridorId, segmentId, river, metrics, observationStart, distanceFromMouthKm, officialCoordinates, identityBasis) {
  if (!CORRIDOR_SEEDS.some((entry) => entry.corridorId === corridorId)) throw new Error(`Unknown station corridor: ${corridorId}`);
  if (!SEGMENT_BY_ID.has(segmentId)) throw new Error(`Unknown station segment: ${segmentId}`);
  const sourceMetadata = stationSourceMetadata(providerId, stationId);
  return Object.freeze({
    providerId,
    stationId,
    stableId: buildStationStableId(providerId, stationId),
    identityBasis,
    label,
    corridorId,
    segmentId,
    river,
    metrics: Object.freeze(metrics),
    observationStart,
    distanceFromMouthKm,
    officialCoordinates,
    sourceUrl: sourceMetadata.sourceUrl,
    sourceStructure: sourceMetadata.sourceStructure,
    missingValueSemantics: "Source pause/missing markers are null, never zero."
  });
}

function stationSourceMetadata(providerId, stationId) {
  if (providerId === "mlit-hydrology") return {
    sourceUrl: `https://www1.river.go.jp/cgi-bin/SiteInfo.exe?ID=${stationId}`,
    sourceStructure: "HTML station metadata plus separate realtime 10-minute and historical hourly/daily HTML tables"
  };
  if (providerId === "tokyo-water-disaster") return {
    sourceUrl: AUDIT_SOURCES.find((entry) => entry.sourceId === "tokyo-water-disaster").url,
    sourceStructure: "HTML current water-level/rain/camera page with five-minute refresh and explicit pause/missing labels"
  };
  if (providerId === "chiba-standard-water-level") return {
    sourceUrl: "https://www.pref.chiba.lg.jp/bousai/documents/r7shiryou2-6.pdf",
    sourceStructure: "Official PDF station inventory; current observations are linked through the national river information HTML application"
  };
  if (providerId === "chiba-crisis-water-level") return {
    sourceUrl: AUDIT_SOURCES.find((entry) => entry.sourceId === "chiba-crisis-gauges").url,
    sourceStructure: "Chiba HTML inventory linking source obsCd to the national river information HTML application"
  };
  if (providerId === "chiba-river-camera") return {
    sourceUrl: AUDIT_SOURCES.find((entry) => entry.sourceId === "chiba-river-cameras").url,
    sourceStructure: "Chiba HTML inventory linking source sysCamId to the national river camera HTML application"
  };
  if (providerId === "tokyo-water-quality") return {
    sourceUrl: AUDIT_SOURCES.find((entry) => entry.sourceId === "tokyo-water-quality").url,
    sourceStructure: "Preliminary spreadsheet and annual final CSV/PDF publications"
  };
  if (providerId === "chiba-water-quality") return {
    sourceUrl: AUDIT_SOURCES.find((entry) => entry.sourceId === "chiba-water-quality").url,
    sourceStructure: "Annual basin-partitioned CSV and station PDF publications"
  };
  throw new Error(`Unknown station provider source metadata: ${providerId}`);
}

function dms(latDeg, latMin, latSec, lonDeg, lonMin, lonSec, evidenceUrl) {
  return Object.freeze({
    latitude: round(latDeg + latMin / 60 + latSec / 3600, 7),
    longitude: round(lonDeg + lonMin / 60 + lonSec / 3600, 7),
    sourceFormat: "official-dms",
    sourceValue: `N ${latDeg} ${latMin} ${latSec}; E ${lonDeg} ${lonMin} ${lonSec}`,
    evidenceUrl
  });
}

function catchCandidate(corridorId, areaLevel, areaUrls, found) {
  return Object.freeze({
    corridorId,
    providerId: "anglers-public",
    found,
    areaLevel,
    areaUrls: Object.freeze(areaUrls),
    dateVisible: found,
    speciesVisible: found,
    formalAcquisitionReady: false,
    limitation: found ? "Area existence only; terms, bias, stable identity, and segment mapping are deferred." : "No dedicated area found in bounded search; this is not proof of no posts."
  });
}

function profile(overrides) {
  const missing = OBSERVABILITY_SIGNALS.filter((name) => !overrides[name]);
  if (missing.length > 0) throw new Error(`Profile missing signals: ${missing.join(", ")}`);
  return Object.freeze(overrides);
}

function signal(grade, temporalClass, reason) {
  if (!OBSERVABILITY_GRADES.includes(grade)) throw new Error(`Invalid observability grade: ${grade}`);
  if (!TEMPORAL_CLASSES.includes(temporalClass)) throw new Error(`Invalid temporal class: ${temporalClass}`);
  return Object.freeze({ grade, temporalClass, reason });
}

function readiness(corridorId, grade, status, reason) {
  return Object.freeze({ corridorId, grade, status, reason });
}

function graphNode(nodeId, nodeType, label) {
  return { nodeId, nodeType, label, corridorId: null, waterBody: nodeType, coordinates: null };
}

function graphEdge(edgeId, fromNodeId, toNodeId, connectionType, gateControlled, controlName) {
  return { edgeId, fromNodeId, toNodeId, connectionType, direction: "hydraulic-bidirectional-unless-event-controlled", gateControlled, controlName };
}

function habitatLink(segmentId, habitatNodeId) {
  return { segmentId, habitatNodeId, relationship: "bay-side-macro-adjacency", coLocated: false };
}

function boundaryBasis(corridorId, role) {
  const basis = {
    arakawa: "MLIT gauge/gate spacing and bay connection",
    nakagawa: "Nakagawa gate, Iizuka gauge, and Shin-Nakagawa branch",
    "shin-nakagawa": "Nakagawa branch and Kyu-Edogawa confluence",
    "kyu-edogawa": "estuary, Edogawa water gate, and branch confluences",
    sumida: "bay connection, lower sampling/catch areas, and Iwabuchi gate",
    edogawa: "Gyotoku movable weir, Edogawa water gate, and lower-river gauges",
    "koto-internal": "bay gates, west/east pump areas, cross-channel locks",
    hanamigawa: "bay mouth, three water-level stations, and controlled floodway connection",
    ebigawa: "bay mouth, water-quality point, and realtime gauge/camera",
    mamagawa: "bay mouth, three realtime gauges, and branch/drainage topology",
    miakegawa: "bay mouth and direct realtime gauge/camera"
  }[corridorId];
  return `${basis}; macro role ${role}.`;
}

function metricMatchesSignal(field, signalName) {
  if (field === signalName) return true;
  return field === "waterQuality" && ["temperature", "salinityProxy", "DO"].includes(signalName);
}

function downgradeGrade(grade) {
  const index = OBSERVABILITY_GRADES.indexOf(grade);
  return OBSERVABILITY_GRADES[Math.min(index + 1, OBSERVABILITY_GRADES.length - 1)];
}

function summarizeStations(stations) {
  const byCorridor = Object.fromEntries(CORRIDORS.map((entry) => [entry.corridorId, stations.filter((station) => station.corridorId === entry.corridorId).length]));
  const byProvider = Object.fromEntries([...new Set(stations.map((station) => station.providerId))].sort().map((providerId) => [providerId, stations.filter((station) => station.providerId === providerId).length]));
  return { total: stations.length, byCorridor, byProvider };
}

function summarizeMatrix(matrix) {
  return Object.fromEntries(OBSERVABILITY_SIGNALS.map((signalName) => [signalName, Object.fromEntries(OBSERVABILITY_GRADES.map((grade) => [grade, matrix.filter((cell) => cell.signal === signalName && cell.grade === grade).length]))]));
}

function summarizeProbes(probes) {
  const official = probes.filter((probe) => !probe.kind.startsWith("public-catch")).length;
  const publicCatch = probes.filter((probe) => probe.kind.startsWith("public-catch")).length;
  const successful = probes.filter((probe) => probe.ok).length;
  const markerComplete = probes.filter((probe) => {
    const sourceEntry = AUDIT_SOURCES.find((entry) => entry.sourceId === probe.sourceId);
    return sourceEntry && probe.markersFound.length === sourceEntry.expectedMarkers.length;
  }).length;
  return { total: probes.length, official, publicCatch, successful, failed: probes.length - successful, markerComplete };
}

function tidalAssessments() {
  return [
    { corridorId: "arakawa", evidence: "Mouth/inner gauges and gate-pair water levels", proxyFeasibility: "HIGH" },
    { corridorId: "nakagawa", evidence: "Nakagawa gate back + Iizuka + bay tide", proxyFeasibility: "HIGH" },
    { corridorId: "shin-nakagawa", evidence: "Endpoint proxy only", proxyFeasibility: "LOW" },
    { corridorId: "kyu-edogawa", evidence: "Direct lower water level + gate + bay tide", proxyFeasibility: "HIGH" },
    { corridorId: "sumida", evidence: "Odai/Iwabuchi lower + bay tide", proxyFeasibility: "HIGH" },
    { corridorId: "edogawa", evidence: "Weir levels + bay tide", proxyFeasibility: "MODERATE" },
    { corridorId: "koto-internal", evidence: "Boundary levels but gate/pump separation", proxyFeasibility: "MODERATE" },
    { corridorId: "hanamigawa", evidence: "Three corridor gauges + bay tide; floodway controls unresolved", proxyFeasibility: "MODERATE" },
    { corridorId: "ebigawa", evidence: "Direct lower level + bay tide", proxyFeasibility: "MODERATE" },
    { corridorId: "mamagawa", evidence: "Three gauges; drainage topology unresolved", proxyFeasibility: "LOW" },
    { corridorId: "miakegawa", evidence: "Direct lower level + bay tide", proxyFeasibility: "MODERATE" }
  ];
}

function readHeader(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name);
  return null;
}

function parseInteger(value, label, min, max) {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be an integer.`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${label} must be ${min}..${max}.`);
  return parsed;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO.test(value)) throw new Error(`${label} must be canonical UTC ISO datetime.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${label} must be canonical UTC ISO datetime.`);
  return value;
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-river-canal-observability-audit.mjs

Optional:
  --delay-ms <0..10000>
  --collected-at <canonical UTC ISO>

This command performs allowlisted GET requests only and writes no files or databases.`);
}

async function main() {
  const options = parseRiverCanalAuditArgs();
  if (options.help) return printHelp();
  const report = await runRiverCanalObservabilityAudit(options);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`river_canal_observability_audit_failed: ${error?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
