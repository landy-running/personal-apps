# Wanoku Ichihara Fixed-Node Source Audit v1

- Audit date: 2026-08-20 JST
- Facility: Original Maker Sea Fishing Park
- Wanoku facility ID: `ichihara-original-maker`
- Provider ID: `ichihara-umizuri`
- Scope: official public source investigation and collector contract only
- Verdict: `READY_FOR_ICHIHARA_COLLECTOR_DESIGN`

## Decision

The official server-rendered fishing archive and numeric daily-detail URLs are sufficient for an Ichihara provider-specific collector. The existing fixed-node identity, revision, zero/unknown, visitor-normalization, source-run, and as-of contracts can be reused. HTML acquisition, final-report detection, closure interpretation, decorated species labels, and non-fish pseudo rows must remain provider-specific.

Ichihara is an observational **Tokyo Bay East-side fixed coastal sentinel**. Yokohama remains the West-side sentinel. This contract does not infer a bay-wide state, gradient, movement, lead/lag, occupancy, or planner score.

## Official source architecture

| Item | Confirmed result |
| --- | --- |
| Canonical archive | <https://ichihara-umizuri.com/fishing/> |
| Daily detail | `https://ichihara-umizuri.com/fishing/<positive-numeric-id>/` |
| Archive traversal | Public server-rendered HTML, 20 daily cards per `/fishing/page/<n>/` page in inspected pages. A month/species search form also exists, but pagination is the simpler confirmed GET-only path. |
| Date mapping | Each listing card and detail page exposes one JST calendar date. The listing date must equal the detail date. |
| Stable source endpoint | The HTML archive and detail routes are the confirmed stable source. No JSON/API endpoint was confirmed, so collector design must not depend on one. |
| Authentication/session | No authentication or pre-existing session was required for successful public reads. No cookie-dependent behavior was observed. |
| Page technology | SSR HTML. The repository currently calls this family `ichihara-wordpress`, but the audit does not rely on an unconfirmed CMS/API implementation. |
| Current collection cost | Normally 2 GETs: archive page 1 and the selected detail. A later same-day refresh is a separate run/GET because the page is mutable. |
| Terms/robots | The visible official guide contains facility-use rules, not an automation license. The audit browser could not retrieve `robots.txt`; therefore use sequential low-rate GETs, identify the client, stop on 429/5xx, and re-check robots/terms before an operator run. |

The official guide confirms Monday closure, holiday shifting, daily operation from July through October, year-end closure, and weather closures: <https://ichihara-umizuri.com/guide/>. These rules explain many archive date gaps but must not be used to synthesize reports.

## Archive and date coverage

- Page 1 contained 20 reports for 2026-08-01 through 2026-08-20. The 2026-08-20 page was an in-progress 07:00 report, not a final daily report.
- Page 2 contained 20 reports for 2026-07-11 through 2026-07-30. A date absent from pagination is `MISSING_SOURCE_RECORD`, not automatically `closed`.
- Page 10 began at 2026-01-25, making that item approximately report 181 from the current head. This gives an observed archive density of about 87% over the 208 calendar days from 2026-01-25 through 2026-08-20.
- Page 40 exposed 20 reports from 2024-03-03 through 2024-03-27, with expected date gaps. Thus **2024-03-03 is the earliest reliably confirmed accessible date in this focused audit**, not a claim that the archive starts there.
- Full closures may have a detail page (for example 2026-05-04 and 2026-02-08), while scheduled closures may have no daily page. A missing date and an explicit closure page are different states.
- No full archive crawl was performed. The recommended first backfill starts well inside the confirmed continuous region.

## Representative detail pages

Twenty-four official detail pages were inspected directly. They cover summer, spring, winter, weekday/weekend, high/low attendance, high/low catches, aliases, full closure, delayed opening, and early closure.

| Date | ID | Evidence sampled |
| --- | ---: | --- |
| 2026-08-20 | [29031](https://ichihara-umizuri.com/fishing/29031/) | Same-day 07:00 partial report, admission rate rather than total visitors |
| 2026-08-16 | [28915](https://ichihara-umizuri.com/fishing/28915/) | Weekend, 305 visitors, `セイゴ`, `イワシ`, bait mix |
| 2026-08-08 | [28705](https://ichihara-umizuri.com/fishing/28705/) | Weekend, `カイズ`, decorated narrative, 100 `サッパ` |
| 2026-08-06 | [28646](https://ichihara-umizuri.com/fishing/28646/) | `カタボシイワシ`, `イワシ`, `サッパ`, `アジ` |
| 2026-07-18 | [28159](https://ichihara-umizuri.com/fishing/28159/) | `カタクチイワシ`, `セイゴ`, `スズキ` |
| 2026-06-12 | [27216](https://ichihara-umizuri.com/fishing/27216/) | 15:00 early closure after warning, catches and final visitor total |
| 2026-05-24 | [26726](https://ichihara-umizuri.com/fishing/26726/) | Sunday, three seabass size labels, `カイズ` |
| 2026-05-17 | [26528](https://ichihara-umizuri.com/fishing/26528/) | 545 visitors, crowd restriction, decorated `サッパ` label |
| 2026-05-10 | [26325](https://ichihara-umizuri.com/fishing/26325/) | 488 visitors, temporary admission stop, all three seabass labels |
| 2026-05-04 | [26143](https://ichihara-umizuri.com/fishing/26143/) | Full weather closure, blank water temperature, non-fish pseudo row |
| 2026-04-29 | [25951](https://ichihara-umizuri.com/fishing/25951/) | 491 visitors, 680 generic `イワシ`, decorated `セイゴ` |
| 2026-04-14 | [25594](https://ichihara-umizuri.com/fishing/25594/) | Weekday, 73 visitors, `フッコ` + `スズキ` |
| 2026-03-01 | [24704](https://ichihara-umizuri.com/fishing/24704/) | One-hour delayed opening; high seabass count |
| 2026-02-15 | [24449](https://ichihara-umizuri.com/fishing/24449/) | Winter Sunday, seabass size classes |
| 2026-02-08 | [24347](https://ichihara-umizuri.com/fishing/24347/) | Full snow closure, non-fish image-caption rows |
| 2026-01-23 | [24032](https://ichihara-umizuri.com/fishing/24032/) | 20 visitors, composite `フッコ・スズキ（モエビ餌）`, explicit source row count 0 |
| 2026-01-12 | [23807](https://ichihara-umizuri.com/fishing/23807/) | `マイワシ`, `ボラ`, holiday-shifted closure notice |
| 2026-01-08 | [23708](https://ichihara-umizuri.com/fishing/23708/) | 14:00 early closure, `入園者数`, `ボラ`, `ハゼ` |
| 2025-11-12 | [22334](https://ichihara-umizuri.com/fishing/22334/) | `ボラの大群` with blank count, large seabass/konoshiro day |
| 2025-10-21 | [21532](https://ichihara-umizuri.com/fishing/21532/) | `カタボシイワシ` and `カタクチイワシ` on one page |
| 2025-09-11 | [19954](https://ichihara-umizuri.com/fishing/19954/) | 16:30 early closure, `キビレ`, 33 visitors |
| 2025-08-21 | [19132](https://ichihara-umizuri.com/fishing/19132/) | 17:30 lightning closure after operation, `セイゴ`, `ハゼ` |
| 2025-07-31 | [18309](https://ichihara-umizuri.com/fishing/18309/) | 09:50 tsunami interruption, `ご来場者数`, source air-temperature order anomaly |
| 2024-12-01 | [11260](https://ichihara-umizuri.com/fishing/11260/) | Older template, winter hours, all eight-model context species represented |

## Field reliability matrix

`payload_json` in the current fixed-node schema is the strict canonical report object; it is not an extension bag. Fields without a current canonical column are not silently added to it.

| Field | Grade | Source representation / variants | Parsing and risk | Proposed Wanoku mapping |
| --- | --- | --- | --- | --- |
| Observation date | `RELIABLE_STRUCTURED` | `YYYY年MM月DD日(曜)` in listing and detail | Parse both and require equality; interpret as JST date only | `fixed_node_daily_reports.observation_date` |
| Publication/update timestamp | `UNAVAILABLE` | No source-contract timestamp exposed in inspected detail HTML | Search-engine dates are not source metadata; never synthesize midnight/day-end | `published_at = NULL`; revisions use actual `collected_at` |
| Operating/closure status | `PARTIAL` | Narrative phrases for delayed opening, entry stop, early/full closure; some closed dates absent | Provider-specific phrase classification; never classify from weather alone | `operating_status`; partial-operation facts remain diagnostics |
| Visitor count | `RELIABLE_TEXT` | `入場者数`, `入園者数`, `ご来場者数`; ASCII/full-width digits; `名`/`名様` | Parse only a final absolute count; do not parse `入場者率29%` | `visitor_count` or `NULL` |
| Weather | `RELIABLE_STRUCTURED` | Labeled value on detail | Free-text controlled vocabulary; listing omits temperatures | No current canonical fixed-node column; transient source fact only |
| Air temperature | `PARTIAL` | Two labeled numeric values, sometimes blank; 2025-07-31 order is anomalous | Preserve source order and raw text; do not infer min/max when inconsistent | No current canonical column |
| Water temperature | `PARTIAL` | `上`/`下` Celsius values, blank on some closure/current cards | Parse independently; no interpolation | No current canonical column |
| Wind direction | `RELIABLE_STRUCTURED` | Labeled Japanese direction; occasional compound/blank values | Preserve source label; no degree conversion | No current canonical column |
| Wind speed | `PARTIAL` | Range with `～` or `~`, optional decimals, sometimes blank | Parse range only when both ends numeric; preserve raw | No current canonical column |
| Tide | `RELIABLE_STRUCTURED` | Tide label plus high/low time slots | Times can be blank and 2024-03-06 has compound `長潮 若潮`; retain raw when invalid | No current canonical column |
| Warnings/advisories | `RELIABLE_STRUCTURED` | Labeled `あり`/`なし`; detailed cause/time in narrative | Boolean labels do not encode warning type | No current canonical column; use closure diagnostics only |
| Narrative/comment | `RELIABLE_TEXT` | Free text before catch table | Mutable during the day; wording variants are expected | Not persisted in strict v1 report; hash/source diagnostics only |
| Fish species label | `RELIABLE_STRUCTURED` | Repeated catch-row label | Decorations and composite labels require provider-specific normalization; non-fish rows exist | `source_labels_json`, then audited canonical species ID |
| Size/range | `PARTIAL` | Single/range values, `cm` variants, bare `35`, weight values, blanks | Accept centimeters only when unambiguous; do not convert kg to length | `min_size_cm` / `max_size_cm` or `NULL` |
| Total catch count | `PARTIAL` | `合計 <digits>匹`, source zero, or blank `合計 匹` | Numeric biological rows are reliable; blank/pseudo rows make completeness insufficient | `catch_count`; blank becomes `NULL`, never 0 |
| Fishing zone/location | `UNAVAILABLE` | Page-level `桟橋 木更津側` / `桟橋 千葉側` image headings | Not tied to each species/count row | `area_labels_json = []` in v1 |
| Images | `PARTIAL` | Page-level area and species image links/captions | Association and permanence are not strong enough for canonical facts | Do not ingest in v1; retain source URL only |

## Identity and revision contract

Use the existing model without changes:

```text
providerId       = ichihara-umizuri
facilityId       = ichihara-original-maker
observationDate  = detail page JST calendar date
sourceRecordId   = fishing:<numeric-id>
identity_key     = JSON([providerId, facilityId, observationDate, sourceRecordId])
semantic_hash    = hash(existing canonical fixed-node semantic content)
version_key      = identity_key + "|" + semantic_hash
```

- Numeric detail IDs are stable across listing and detail routes in the sample. The detail ID/date pair must be cross-checked; a duplicate date or ID is a hard parse failure.
- The 2026-08-20 page demonstrates in-day mutation: the same detail ID can initially contain an admission rate and partial catch list. A later changed page is the same identity and a new semantic version.
- `publishedAt` remains `null`; neither observation-date midnight nor collection time is publication time.
- `collectedAt` is the real UTC acquisition time for each GET batch. Historical backfill must not backdate it.
- One source run per current acquisition is appropriate. Historical generation should use one source run per source month, recording actual acquisition time and an aggregate raw hash for that month's fetched official artifacts.
- An identical semantic retry resolves to the existing report/version. Changed visitors, status, counts, or normalized species content produce a new semantic hash/report version under the same identity.
- Existing as-of reads must continue to require `collected_at <= knowledgeAt`; a later-acquired historical page cannot leak into earlier knowledge.

## Species normalization contract

Exact raw labels are retained in `sourceLabels`. Normalize Unicode width/whitespace/punctuation only for matching. Decorations may be stripped only by explicit provider rules. A composite row maps once and its count is never duplicated for each token.

| sourceLabel | candidateWanokuSpeciesId | Confidence | Handling | Reason |
| --- | --- | --- | --- | --- |
| `スズキ` | `japanese-seabass` | HIGH | `MAP` | Directly observed as the adult size label |
| `フッコ` | `japanese-seabass` | HIGH | `MAP` | Directly observed intermediate size label |
| `セイゴ` | `japanese-seabass` | HIGH | `MAP` | Directly observed juvenile size label |
| `釣れた！(セイゴ)` | `japanese-seabass` | HIGH | `MAP` | Explicit parenthetical species wrapper |
| `フッコ・スズキ（モエビ餌）` | `japanese-seabass` | HIGH | `MAP` | One composite seabass row; map and count once |
| `シーバス` (not observed in the 24-page sample) | `japanese-seabass` | MEDIUM | `REVIEW_REQUIRED` | Existing Yokohama alias, but activate for Ichihara only with an official fixture |
| `イワシ` | `sardine` | HIGH | `MAP` | Official source uses a generic sardine label; Wanoku's existing ID is an operational aggregate |
| `マイワシ` | `sardine` | HIGH | `MAP` | Explicitly observed source label |
| `カタクチイワシ` | `sardine` | HIGH | `MAP` | Explicitly observed and already an existing Wanoku alias |
| `ウルメイワシ` (not observed in sample) | `sardine` | MEDIUM | `REVIEW_REQUIRED` | Existing Yokohama alias; Ichihara evidence is still required |
| `カタボシイワシ` | `sardine` | LOW | `KEEP_SEPARATE` | Distinct observed label; do not silently merge its count into the current sardine aggregate |
| `サッパ` | `sappa` | HIGH | `MAP` | Exact observed source label |
| `初めて釣りました(サッパ)` | `sappa` | HIGH | `MAP` | Explicit parenthetical species wrapper |
| `コノシロ` | `konoshiro` | HIGH | `MAP` | Exact observed source label |
| `アジ` | `aji` | HIGH | `MAP` | Exact observed source label |
| `マアジ` (not observed in sample) | `aji` | MEDIUM | `REVIEW_REQUIRED` | Existing Yokohama alias; require official Ichihara fixture |
| `サバ` | `saba` | HIGH | `MAP` | Exact observed source label |
| `ボラ` | `bora` | HIGH | `MAP` | Exact observed source label |
| `ボラの大群` | `bora` | MEDIUM | `MAP` | Qualitative presence only when count is blank; `catchCount = NULL` and report is not complete |
| `ハゼ` | `haze` | HIGH | `MAP` | Exact observed source label |
| `マハゼ` (not observed in sample) | `haze` | MEDIUM | `REVIEW_REQUIRED` | Existing Yokohama alias; require official Ichihara fixture |
| `クロダイ` | `NULL` | HIGH | `KEEP_SEPARATE` | Observed chinu fact, but no current eight-species ID |
| `カイズ` | `NULL` | HIGH | `KEEP_SEPARATE` | Observed juvenile black-sea-bream label; no current ID |
| `キビレ` | `NULL` | HIGH | `KEEP_SEPARATE` | Observed distinct chinu-related label; no current ID |
| `大荒れの海`, `青潮の海`, snow/bridge captions | `NULL` | HIGH | `IGNORE_FOR_V1` | Non-fish image-caption rows, often with blank count |

**Seabass decision:** sum all numeric `スズキ` + `フッコ` + `セイゴ` rows, including explicitly audited decorated/composite forms, into one `japanese-seabass` observation. Take the minimum/maximum valid centimeter values across mapped rows and preserve every raw source label. Do not infer a count from narrative-only mentions.

**Sardine/bait decision:** map generic `イワシ`, `マイワシ`, and `カタクチイワシ` to `sardine`; keep `カタボシイワシ` separate in raw source diagnostics for v1. Map `サッパ`, `コノシロ`, and `アジ` independently. Unknown or unaudited bait-looking labels require review; do not broaden matching to arbitrary `*イワシ`.

## Explicit-zero contract

Ichihara omission may become explicit zero only after all of these gates pass:

1. The detail date is before the acquisition's current JST date, or the page has an unambiguous final-day visitor total and closing language.
2. The facility operated during the represented interval. A partial early closure remains `operating` with a diagnostic; a never-opened full closure is `closed`.
3. The complete catch section was found and every biological fish row has a valid species label and numeric count. Blank-count qualitative rows make the report `incomplete`.
4. No duplicated/truncated catch blocks, list/detail mismatch, or unclassified row that could belong to a target canonical species exists.
5. Alias coverage for the requested canonical species is `sufficient` under the audited provider dictionary.

Then, and only then, an omitted canonical species is:

```text
presence_state = absent
catch_count = 0
completeness = complete
alias_coverage = sufficient
```

Otherwise use `presence_state = unknown`, `catch_count = NULL`, and the conservative completeness/alias value. A source row that explicitly says count 0 is not evidence that every omitted species is zero. Full closure and missing-date records never produce species zeroes. Current-day partial pages such as 2026-08-20 never produce omission zeroes.

The sampled final reports consistently pair a daily visitor total with a numeric catch table covering the narrative species, which supports conditional historical zeroes after these gates. It does not support unconditional zeroes for every detail page.

## Visitor normalization

- Final reports use total-day wording variants: `本日の入場者数`, `本日の入園者数`, and `本日のご来場者数`, with ASCII or full-width digits and `名`/`名様`.
- Same-day progress wording such as `入場者率29%` is not a visitor count.
- Counts remain meaningful on delayed/shortened days, but effort duration and capacity are censored. Samples ranged from 3/7/20/24 visitors on interrupted or low winter days to 488/491/545 on crowded spring days.
- `catchRate100 = catchCount / visitorCount * 100` is supported only for final, complete, operating reports with `visitorCount > 0`. It is a per-admission exposure normalization, not catch per active angler or per angler-hour; children, observers, repeat entry, rod limits, crowd controls, and shortened operation remain denominator caveats.

## Recommended first historical backfill

Use `2025-09-01` through `2026-08-19` inclusive. This is 353 calendar days, spans 12 source months, stays inside confirmed archive coverage, matches the existing west-side comparison horizon closely, and excludes the mutable 2026-08-20 current-day page.

Planning estimates, not pre-write counts:

| Measure | Estimate |
| --- | ---: |
| Calendar days | 353 |
| Accessible detail reports | about 307; planning range 300-315 |
| Operating reports | about 295-307; exact count requires classification |
| Explicit closure/interruption reports | about 5-15; exact count requires classification |
| Missing/scheduled-closure dates | about 38-53 |
| `fixed_node_daily_reports` | about 307 |
| `fixed_node_species_observations` | about 2,456 (8 per accepted report) |
| `source_runs` | 12 (one per source month) |
| Logical rows | about 2,775 |
| Physical B-tree entries | about 14,489 using the existing Yokohama estimate: run x5 + report x7 + species x5 |
| Listing GETs | about 17, including one boundary page |
| Detail GETs | about 307 |
| Total GETs | about 324, sequential and resumable |

The 307 estimate uses the observed 181-report position at 2026-01-25 over 208 calendar days. The future collector must first inventory listing IDs, stop at the lower date bound, deduplicate IDs/dates, then fetch only accepted details. It must not infer scheduled closures into rows.

## Yokohama comparison

| Concern | Classification | Ichihara contract relative to Yokohama |
| --- | --- | --- |
| Facility registry and eight species IDs | `REUSE` | Existing `ichihara-original-maker` registry row and core IDs |
| Fixed-node report builder/persistence | `REUSE` | Same identity, semantic hash, version, atomic species persistence, and as-of rules |
| Source-run model and raw hash | `REUSE` | Actual acquisition time and execution provenance |
| Explicit zero invariant | `REUSE` | Operating + complete + sufficient alias coverage only |
| Visitor `catchRate100` helper | `REUSE` | Same formula and positive-denominator gate |
| Source acquisition | `PROVIDER_SPECIFIC` | Ichihara SSR archive/detail GETs vs Yokohama root/bundle/AppSync JSON |
| Parser | `PROVIDER_SPECIFIC` | HTML blocks, text variants, decorated labels, pseudo rows, malformed units |
| Report finality | `ADAPT` | Ichihara current-day page mutates and lacks source timestamps |
| Closure classification | `ADAPT` | Reuse states, add Ichihara phrase rules for never-opened vs partial operation |
| Species normalization | `ADAPT` | Reuse canonical IDs; use audited Ichihara exact/decorated aliases |
| Visitor extraction | `ADAPT` | Text/full-width variants instead of typed JSON integer |
| Source timestamps | `PROVIDER_SPECIFIC` | Ichihara `publishedAt = NULL`; Yokohama exposes created/updated values |
| Area mapping | `PROVIDER_SPECIFIC` | Ichihara page image headings are not species-row locations |
| Current collection cost | `PROVIDER_SPECIFIC` | Ichihara normally 2 GETs; no hidden API setup requests |
| Historical backfill | `PROVIDER_SPECIFIC` | Hundreds of detail GETs vs monthly structured Yokohama queries |

Do not create a generic provider/plugin framework. Reuse the canonical builder and persistence boundary; keep the HTML source adapter explicit.

## Main risks and collector gates

1. A current-day detail is mutable and may expose rate/partial catches before final totals.
2. Full closures, partial closures, delayed openings, admission stops, and ordinary operating days require different status diagnostics.
3. Non-fish image captions can occupy fish-row markup and often have blank counts.
4. Decorated/composite labels must not be dropped or double-counted.
5. Units and typography vary (`cm`, `cｍ`, `㎝`, `~`, `～`, full-width digits, bare values, kg).
6. Publication/update timestamps are unavailable; only acquisition vintage is trustworthy.
7. The archive can omit a date; schedule knowledge must not fabricate a closure report.
8. A future source label that could be a canonical alias must downgrade alias coverage until reviewed.
9. `robots.txt` was not retrievable through the audit browser; production/operator review of site policy remains a non-semantic preflight.

## Unresolved decisions

No decision currently blocks collector design. Two conservative follow-ups belong in collector fixtures/preflight rather than this schema contract:

- Confirm any future official Ichihara occurrences of `シーバス`, `ウルメイワシ`, `マアジ`, and `マハゼ` before activating those aliases for explicit-zero coverage.
- Re-check official robots/terms immediately before a historical operator run; use the sequential ~324-GET plan only if permitted.
