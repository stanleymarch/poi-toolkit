import {
  FieldClaim,
  GeometryEvidence,
  SourceManifestSchema,
  SourceRecord,
  SourceRecordSchema,
} from "@poi-toolkit/core";

export const WIKIDATA_MANIFEST = SourceManifestSchema.parse({
  id: "wikidata",
  version: "sparql-v1",
  requiredSecrets: [],
  license: { name: "CC0 1.0 Universal", url: "https://www.wikidata.org/wiki/Wikidata:Copyright", osmCompatible: true },
  attribution: "Wikidata contributors (CC0); media files may have separate licenses",
  updateMode: "snapshot",
});

export const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
export const INTERESTING_TYPES = [
  "Q4022", "Q23397", "Q16521", "Q753110", "Q46831", "Q169930", "Q8502", "Q35657", "Q22698", "Q1968445", "Q179049", "Q1959314", "Q55075651", "Q131681", "Q571049", "Q42521", "Q111523", "Q14641621", "Q132232",
  "Q358", "Q1077892", "Q4299138", "Q16970", "Q1024714", "Q570116", "Q160786", "Q16560", "Q130721", "Q2503379", "Q47015862", "Q37984", "Q674846", "Q207694", "Q838948", "Q1155704", "Q498162", "Q178086", "Q179700", "Q860656", "Q28564", "Q215110", "Q5705250", "Q3465368",
];

type BindingValue = { type?: string; value?: string; datatype?: string };
export type WikidataBinding = Record<string, BindingValue | undefined>;
export type WikidataRaw = WikidataBinding;
export type WikidataOptions = {
  regions: string[];
  fetch?: typeof fetch;
  pageSize?: number;
  maxPages?: number;
  retries?: number;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
  onPage?: (items: WikidataRaw[]) => Promise<void> | void;
};
export type WikidataResult = { raw: WikidataRaw[]; records: SourceRecord[]; pages: number };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Stable QID-ordered pages prevent a silent LIMIT truncation from becoming a complete snapshot. */
export function buildWikidataQuery(regions: string[], limit: number, offset: number): string {
  if (!regions.length || regions.some((qid) => !/^Q\d+$/.test(qid))) throw new Error("Wikidata regions must be QIDs");
  const types = INTERESTING_TYPES.map((qid) => `wd:${qid}`).join(" ");
  const scopedRegions = regions.map((qid) => `wd:${qid}`).join(" ");
  return `SELECT DISTINCT ?item ?itemLabel ?itemDescription ?type ?typeLabel ?image ?commons ?coord ?heritage ?article ?inception ?officialWebsite ?vkHandle ?telegramHandle ?wikiArticle ?egrknId WHERE {
  VALUES ?type { ${types} }
  VALUES ?region { ${scopedRegions} }
  ?item wdt:P131* ?region .
  ?item wdt:P31 ?type .
  OPTIONAL { ?item wdt:P18 ?image . }
  OPTIONAL { ?item wdt:P373 ?commons . }
  OPTIONAL { ?item wdt:P1435 ?heritage . }
  OPTIONAL { ?item wdt:P625 ?coord . }
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P856 ?officialWebsite . }
  OPTIONAL { ?item wdt:P2002 ?vkHandle . }
  OPTIONAL { ?item wdt:P3789 ?telegramHandle . }
  OPTIONAL { ?wikiArticle schema:about ?item . ?wikiArticle schema:isPartOf <https://ru.wikipedia.org/> . }
  OPTIONAL { ?article schema:about ?item . ?article schema:inLanguage "ru" . ?article schema:isPartOf <https://ru.wikipedia.org/> . }
  OPTIONAL { ?item wdt:P7859 ?egrknId . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,en". }
}
ORDER BY STR(?item)
LIMIT ${limit}
OFFSET ${offset}`;
}

export async function collectWikidata(options: WikidataOptions): Promise<WikidataResult> {
  const request = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? 500;
  const maxPages = options.maxPages ?? 100;
  const retries = options.retries ?? 5;
  const sleep = options.sleep ?? wait;
  const raw: WikidataRaw[] = [];
  const qids = new Set<string>();
  let pages = 0;
  // Query each region separately to avoid WDQS timeouts on large multi-region VALUES.
  for (const region of options.regions) {
    let regionPages = 0;
    for (let offset = 0; regionPages < maxPages; offset += pageSize, regionPages += 1) {
      const query = buildWikidataQuery([region], pageSize, offset);
    let bindings: WikidataRaw[] | undefined;
    let lastError = "";
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const response = await request(`${WIKIDATA_ENDPOINT}?${new URLSearchParams({ query, format: "json" })}`, {
          headers: { Accept: "application/sparql-results+json", "User-Agent": options.userAgent ?? process.env.POI_TOOLKIT_USER_AGENT ?? "poi-toolkit/0.1 (https://github.com/stanleymarch/poi-toolkit)" },
        });
        const text = await response.text();
        if (!response.ok) {
          lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
          if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(lastError);
        } else {
          const parsed = JSON.parse(text) as { results?: { bindings?: unknown } };
          if (!Array.isArray(parsed.results?.bindings)) throw new Error("Wikidata schema drift: results.bindings is not an array");
          bindings = parsed.results.bindings as WikidataRaw[];
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === retries - 1) throw new Error(`Wikidata failed after ${retries} attempts: ${lastError}`);
      }
      await sleep(Math.min(64_000, 4_000 * 2 ** attempt));
    }
    if (!bindings) throw new Error(`Wikidata failed after ${retries} attempts: ${lastError}`);
    pages += 1;
    const unique = bindings.filter((row) => {
      const qid = qidOf(row.item?.value);
      return Boolean(qid) && !qids.has(qid!) && (qids.add(qid!), true);
    });
    raw.push(...unique);
    await options.onPage?.(unique);
    if (bindings.length < pageSize) break;
    }
    if (regionPages >= maxPages) throw new Error(`Wikidata completeness guard: reached ${maxPages} pages for region ${region}; increase maxPages or narrow the territory`);
  }
  return { raw, records: raw.map((row, index) => wikidataRecord(row, `raw/wikidata.ndjson#${index + 1}`)), pages };
}

export function wikidataRecord(raw: WikidataRaw, rawRef: string, capturedAt = new Date().toISOString()): SourceRecord {
  const qid = qidOf(raw.item?.value);
  if (!qid) throw new Error("Wikidata schema drift: binding item is not a QID URI");
  const coordinate = parseCoordinate(raw.coord?.value);
  return SourceRecordSchema.parse({
    id: `wikidata:${qid}`, source: "wikidata", sourceId: qid, capturedAt, rawRef,
    name: text(raw.itemLabel?.value), address: null,
    geometry: coordinate ? { type: "Point", coordinates: coordinate } : null,
    fields: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value?.value ?? null])),
    license: "CC0 1.0 Universal",
  });
}
export function wikidataGeometryEvidence(record: SourceRecord): GeometryEvidence | null {
  return record.geometry ? { sourceRecordId: record.id, geometry: record.geometry, method: "source-native", precision: "object", precisionMeters: null, capturedAt: record.capturedAt } : null;
}
export function wikidataFieldClaims(record: SourceRecord): FieldClaim[] {
  return Object.entries(record.fields).filter(([, value]) => value !== null).map(([field, value]) => ({ sourceRecordId: record.id, field, value, provenance: record.rawRef, observedAt: record.capturedAt, license: record.license }));
}
function qidOf(value: string | undefined): string | null { const match = value?.match(/\/(Q\d+)$/); return match?.[1] ?? null; }
function text(value: string | undefined): string | null { return value?.trim() || null; }
function parseCoordinate(value: string | undefined): [number, number] | null {
  const match = value?.match(/^Point\(([-\d.]+)\s+([-\d.]+)\)$/);
  if (!match) return null;
  const longitude = Number(match[1]); const latitude = Number(match[2]);
  return Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude, latitude] : null;
}
