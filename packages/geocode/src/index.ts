import { SourceRecord } from "@poi-toolkit/core";
import { addressKey, parseBuildingAddress, validateBuildingAddress } from "@poi-toolkit/geography";

export const YANDEX_GEOCODE_URL = "https://geocode-maps.yandex.ru/1.x/";
export const DEFAULT_PHOTON_URL = "http://localhost:2322";
export type GeocoderProvider = "photon" | "nominatim" | "yandex" | "osm-index";
export type GeocodeConfidence = "high" | "medium" | "low";
export type Bbox = [number, number, number, number];
export type AddressClass = "standard" | "relative" | "compound" | "unstructured";

/** JavaScript RegExp \b is ASCII-only and does not see Cyrillic characters as word
 *  characters. Use \w_____ helper to match word boundaries for the address_class.
 *  A word character here is [а-яёa-z\d]. */
const WORD = "[а-яёa-z\\d]";
const BOW = `(?:^|[^а-яёa-z\\d])`;   // start-of-word boundary
const EOW = `(?=$|[^а-яёa-z\\d])`; // end-of-word boundary

/** Reject address types that cannot reliably geocode to a single building.
 *  - compound: ranges ("1-5"), ownership tracts ("владение 3"), land parcels, multiple buildings
 *  - relative: spatial closeness ("рядом с", "около"), approximate pointers without a house number
 *  - unstructured: unparsable, locality-only, POI-named or empty */
export function classifyAddress(raw: string | null | undefined): AddressClass {
  const address = raw?.trim();
  if (!address) return "unstructured";
  const lower = address.toLowerCase().replace(/ё/g, "е");
  // NB: \b is ASCII-only — use BOW/EOW for Cyrillic-aware word boundaries.
  const word = (pattern: string) => new RegExp(`${BOW}(?:${pattern})${EOW}`, "i");
  if (word("владени[еяй]|участок|земельный").test(lower)) return "compound";
  if (word("рядом|около|напротив|возле|недалеко|севернее|южнее|западнее|восточнее|слева|справа").test(lower)) return "relative";
  // Check for relative "у" (near) marker — it has a different structure.
  if (/(?:^|[^а-яёa-z\d])у\s+(дома|церкви|озера|реки|леса|парка|моста)/i.test(lower) && !/\d[\s,]*(?:\d|[а-я])/.test(lower)) return "relative";
  const hasHouse = /[\s,;]\d+[\s\-,–\/]?[а-яa-z]?(?=$|[^а-яёa-z\d])/i.test(lower) || /(?:^|[\s,;])\d+\s*[а-яa-z]?(?=[\s,;]|$)/i.test(lower);
  const hasStreet = /(?:^|[^а-яёa-z\d])(улица|ул\.?|проспект|пр-?кт?\.?|переулок|пер\.?|площадь|пл\.?|набережная|наб\.?|шоссе|бульвар|б-?р(?=[^а-яёa-z\d])|аллея|проезд|тупик)(?=[^а-яёa-z\d])/i.test(lower);
  if (!hasStreet && !hasHouse) return "unstructured";
  if (!hasHouse) return "relative";
  // Detect a range marker (dash/slash between digits) inside a house-like fragment.
  // A trailing digit from the range is expected so we cannot require a non-word boundary after.
  if (/\d+\s*[\-–\/]\s*\d+/.test(lower.replace(/(?:^|[^а-яёa-z\d])(?:дом|д\.)/gi, ""))) return "compound";
  return "standard";
}

const HIGH_PRECISION = new Set(["exact", "number", "near", "house", "range"]);
const LOW_KIND = new Set(["province", "area", "country"]);

/** Classify Yandex precision/kind into the provider-neutral confidence level. */
export function classifyPrecision(precision: string, kind: string): GeocodeConfidence {
  if (LOW_KIND.has(kind)) return "low";
  if (HIGH_PRECISION.has(precision)) return "high";
  if (precision === "street") return "medium";
  return "low";
}

/** Photon and Nominatim are trusted only for an explicit house number. */
export function classifyOsmAddress(houseNumber: string | null, street: string | null): GeocodeConfidence {
  if (houseNumber?.trim()) return "high";
  if (street?.trim()) return "medium";
  return "low";
}

export type GeocodeResult = {
  lat: number;
  lon: number;
  precision: string;
  kind: string;
  confidence: GeocodeConfidence;
  formatted: string | null;
};

export type GeocodeAttempt = {
  provider: GeocoderProvider;
  outcome: "accepted" | "not-found" | "low-precision" | "address-conflict" | "ineligible-address" | "budget-exhausted" | "error";
  returnedAddress: string | null;
  confidence: GeocodeConfidence | null;
  reason: string | null;
  /** Present even when outcome rejects the coordinates — enables troubleshooting. */
  geometry?: { type: "Point"; coordinates: [number, number] } | null;
};

export type GeocodeAudit = {
  sourceRecordId: string;
  address: string;
  accepted: boolean;
  attempts: GeocodeAttempt[];
};

export type GeocodeEvidence = {
  sourceRecordId: string;
  address: string;
  returnedAddress: string | null;
  addressCompatible: boolean;
  conflictReason: string | null;
  geometry: { type: "Point"; coordinates: [number, number] };
  precision: string;
  kind: string;
  confidence: GeocodeConfidence;
  method: "geocoder" | "osm-address-match";
  provider: GeocoderProvider;
  attempts: GeocodeAttempt[];
  capturedAt: string;
};

export type AddressIndexEntry = { lon: number; lat: number; osmId: string; name: string | null; isBuilding: boolean; corpus: string | null; letter: string | null };
export type OsmAddressIndex = Map<string, AddressIndexEntry[]>;

export type GeocodeOptions = {
  provider?: GeocoderProvider;
  fallback?: GeocoderProvider | "none";
  /** Local Photon endpoint. Defaults to http://localhost:2322. */
  photonUrl?: string;
  /** Explicit self-hosted/operator-provided Nominatim endpoint. */
  nominatimUrl?: string;
  /** Required only when Yandex is primary or fallback. */
  apiKey?: string;
  bbox?: Bbox;
  /** Provider budget; omitted means unlimited local Photon/Nominatim or 1,000 Yandex requests. */
  limit?: number;
  fetch?: typeof fetch;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** OSM address index for exact building matching before geocoder. */
  osmAddressIndex?: OsmAddressIndex;
};

type ResolvedGeocodeOptions = GeocodeOptions & {
  provider: GeocoderProvider;
  fallback: GeocoderProvider | "none";
  photonUrl: string;
};

export function parseGeocoderProvider(value: string): GeocoderProvider {
  if (value === "photon" || value === "nominatim" || value === "yandex") return value;
  throw new Error(`Unsupported geocoder provider: ${value}`);
}

export function resolveGeocodeOptions(options: GeocodeOptions): ResolvedGeocodeOptions {
  const provider = options.provider ?? "photon";
  const fallback = options.fallback ?? "none";
  if (fallback !== "none" && fallback === provider) throw new Error("--fallback must differ from --provider");
  const usedProviders = [provider, ...(fallback === "none" ? [] : [fallback])];
  if (usedProviders.includes("nominatim") && !options.nominatimUrl?.trim()) throw new Error("NOMINATIM_URL is required when Nominatim is selected");
  if (usedProviders.includes("yandex") && !options.apiKey?.trim()) throw new Error("GEOCODER_API_KEY is required when Yandex is selected");
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) throw new Error("--limit must be a positive integer");
  return { ...options, provider, fallback, photonUrl: options.photonUrl?.trim() || DEFAULT_PHOTON_URL };
}

function url(base: string, path: string): URL {
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

function addressText(parts: Array<string | null | undefined>): string | null {
  const text = parts.filter((part): part is string => Boolean(part?.trim())).join(", ");
  return text || null;
}

async function responseJson(request: typeof fetch, target: URL, retries: number, sleep: (ms: number) => Promise<void>): Promise<unknown | null> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await request(target, { headers: { Accept: "application/json" } });
      if (response.ok) return await response.json();
      if (![429, 500, 502, 503, 504].includes(response.status)) return null;
    } catch {
      // Retry transient network errors using the same bounded backoff as Yandex.
    }
    if (attempt < retries - 1) await sleep(Math.min(10_000, 1_000 * 2 ** attempt));
  }
  return null;
}

function photonResultToGeocode(feature: { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }): GeocodeResult | null {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2 || !Number.isFinite(Number(coords[0])) || !Number.isFinite(Number(coords[1]))) return null;
  const props = feature.properties ?? {};
  const houseNumber = stringOrNull(props.housenumber);
  const street = stringOrNull(props.street);
  return {
    lon: Number(coords[0]), lat: Number(coords[1]),
    precision: houseNumber ? "house" : street ? "street" : String(props.type ?? "unknown"),
    kind: String(props.type ?? props.osm_value ?? "unknown"),
    confidence: classifyOsmAddress(houseNumber, street),
    formatted: addressText([houseNumber ? `д. ${houseNumber}` : null, street, stringOrNull(props.city), stringOrNull(props.district), stringOrNull(props.state), stringOrNull(props.country)]),
  };
}

async function fetchPhotonJson(target: URL, options: GeocodeOptions): Promise<PhotonResponse | null> {
  let data = await responseJson(options.fetch ?? fetch, target, options.retries ?? 3, options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))) as PhotonResponse | null;
  if (!data) {
    target.searchParams.delete("lang");
    data = await responseJson(options.fetch ?? fetch, target, options.retries ?? 3, options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))) as PhotonResponse | null;
  }
  return data;
}

/** Geocode using Photon /structured endpoint for precise address field matching. */
export async function geocodePhotonAddressStructured(street: string | null, house: string | null, city: string | null, state: string | null, options: GeocodeOptions): Promise<GeocodeResult | null> {
  const resolved = resolveGeocodeOptions({ ...options, provider: "photon", fallback: "none" });
  const target = url(resolved.photonUrl, "structured");
  const params: Record<string, string> = { limit: "1", lang: "ru" };
  if (house) params.housenumber = house;
  if (street) params.street = street;
  if (city) params.city = city;
  if (state) params.state = state;
  target.search = new URLSearchParams(params).toString();
  if (resolved.bbox) target.searchParams.set("bbox", resolved.bbox.join(","));
  const data = await fetchPhotonJson(target, options);
  if (data?.features?.[0]) return photonResultToGeocode(data.features[0]);
  return null;
}

/** Geocode one address through local Photon /api free-text fallback. */
export async function geocodePhotonAddress(address: string, options: GeocodeOptions): Promise<GeocodeResult | null> {
  if (!address.trim()) return null;
  const resolved = resolveGeocodeOptions({ ...options, provider: "photon", fallback: "none" });
  const target = url(resolved.photonUrl, "api");
  target.search = new URLSearchParams({ q: address, limit: "1", lang: "ru" }).toString();
  if (resolved.bbox) target.searchParams.set("bbox", resolved.bbox.join(","));
  const data = await fetchPhotonJson(target, options);
  if (data?.features?.[0]) return photonResultToGeocode(data.features[0]);
  return null;
}

/** Geocode one address through an explicitly configured Nominatim endpoint. */
export async function geocodeNominatimAddress(address: string, options: GeocodeOptions): Promise<GeocodeResult | null> {
  if (!address.trim()) return null;
  const resolved = resolveGeocodeOptions({ ...options, provider: "nominatim", fallback: "none" });
  const target = url(resolved.nominatimUrl!, "search");
  target.search = new URLSearchParams({ q: address, format: "jsonv2", addressdetails: "1", limit: "1" }).toString();
  if (resolved.bbox) {
    const [minLon, minLat, maxLon, maxLat] = resolved.bbox;
    target.searchParams.set("viewbox", `${minLon},${maxLat},${maxLon},${minLat}`);
    target.searchParams.set("bounded", "1");
  }
  const data = await responseJson(options.fetch ?? fetch, target, options.retries ?? 3, options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))) as NominatimResponse[] | null;
  const hit = data?.[0];
  if (!hit) return null;
  const lon = Number(hit.lon), lat = Number(hit.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const parts = hit.address ?? {};
  const houseNumber = stringOrNull(parts.house_number);
  const street = stringOrNull(parts.road ?? parts.pedestrian ?? parts.footway);
  return {
    lon, lat,
    precision: houseNumber ? "house" : street ? "street" : String(hit.addresstype ?? hit.type ?? "unknown"),
    kind: String(hit.addresstype ?? hit.type ?? "unknown"),
    confidence: classifyOsmAddress(houseNumber, street),
    formatted: addressText([houseNumber ? `д. ${houseNumber}` : null, street, stringOrNull(parts.city ?? parts.town ?? parts.village), stringOrNull(parts.county), stringOrNull(parts.state), stringOrNull(parts.country)]) ?? stringOrNull(hit.display_name),
  };
}

/** Geocode one address through Yandex. It is opt-in and uses its own key. */
export async function geocodeYandexAddress(address: string, options: GeocodeOptions): Promise<GeocodeResult | null> {
  if (!address.trim()) return null;
  const resolved = resolveGeocodeOptions({ ...options, provider: "yandex", fallback: "none" });
  const target = new URL(YANDEX_GEOCODE_URL);
  target.search = new URLSearchParams({ apikey: resolved.apiKey!, geocode: address, format: "json", results: "1" }).toString();
  if (resolved.bbox) {
    const [minLon, minLat, maxLon, maxLat] = resolved.bbox;
    target.searchParams.set("bbox", `${minLon},${minLat}~${maxLon},${maxLat}`);
  }
  const data = await responseJson(options.fetch ?? fetch, target, options.retries ?? 3, options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))) as YandexResponse | null;
  const geo = data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject;
  const pos = geo?.Point?.pos;
  if (!pos) return null;
  const [lonStr, latStr] = pos.split(" ");
  const lon = Number(lonStr), lat = Number(latStr);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const meta = geo?.metaDataProperty?.GeocoderMetaData ?? {};
  const precision = String(meta.precision ?? "");
  const kind = String(meta.kind ?? "");
  return { lat, lon, precision, kind, confidence: classifyPrecision(precision, kind), formatted: stringOrNull(meta.text) };
}

/** Backward-compatible alias for callers that explicitly use Yandex. */
export const geocodeAddress = geocodeYandexAddress;

async function geocodeWithProvider(address: string, provider: GeocoderProvider, options: ResolvedGeocodeOptions): Promise<GeocodeResult | null> {
  if (provider === "photon") return geocodePhotonAddress(address, options);
  if (provider === "nominatim") return geocodeNominatimAddress(address, options);
  return geocodeYandexAddress(address, options);
}

function evaluateAttempt(provider: GeocoderProvider, address: string, result: GeocodeResult | null): { attempt: GeocodeAttempt; result: GeocodeResult | null; compatible: boolean; reason: string | null } {
  if (!result) return { attempt: { provider, outcome: "not-found", returnedAddress: null, confidence: null, reason: null }, result: null, compatible: false, reason: null };
  const geometry: { type: "Point"; coordinates: [number, number] } = { type: "Point", coordinates: [result.lon, result.lat] };
  if (result.confidence !== "high") return { attempt: { provider, outcome: "low-precision", returnedAddress: result.formatted, confidence: result.confidence, reason: `precision: ${result.precision}`, geometry }, result, compatible: false, reason: null };
  const validation = validateBuildingAddress(address, result.formatted);
  if (!validation.compatible) return { attempt: { provider, outcome: "address-conflict", returnedAddress: result.formatted, confidence: result.confidence, reason: validation.reason, geometry }, result, compatible: false, reason: validation.reason };
  return { attempt: { provider, outcome: "accepted", returnedAddress: result.formatted, confidence: result.confidence, reason: null, geometry }, result, compatible: true, reason: null };
}

function defaultLimit(provider: GeocoderProvider): number {
  return provider === "yandex" ? 1000 : Number.POSITIVE_INFINITY;
}

/** Clean an EGRKN address for geocoding (strip "Россия, " prefix, trim length). */
export function prepareAddress(address: string): string {
  return address.replace(/^Россия,\s*/i, "").trim().slice(0, 200);
}

/** Extract city/town and state labels from a Russian postal address for structured geocoding. */
export function extractAddressParts(address: string): { city: string | null; state: string | null } {
  const parts = address.split(/[,;]/).filter(Boolean).map((part) => part.trim());
  let city: string | null = null;
  let state: string | null = null;
  for (const part of parts) {
    const cityMatch = part.match(/(?:^|[^а-яёa-z\d])(?:г|город|пгт|посёлок|поселок|с|село|д|деревня|п|поселок)\s*\.?\s+([а-яёa-z\-]+)(?=[^а-яёa-z\d]|$)/i);
    if (cityMatch && !city) city = cityMatch[1].trim();
    if (!state && /(?:область|край|республика|округ)/i.test(part) && part.length < 80) state = part.replace(/^\s*,\s*/, "").trim();
  }
  // Fallback: use the first part as state if it matches a known region pattern.
  if (!state && /[а-яё\s-]+(?:ская|цкая|цкий|ский|кая|ая|ое|ий)/i.test(parts[0] ?? "")) state = parts[0];
  return { city, state };
}

/**
 * Geocode EGRKN records using a selected provider and optional explicit fallback.
 * Evidence is accepted only after the existing house/corpus/structure/letter check.
 * P1: ineligible address classes (relative/compound/unstructured) are skipped
 * without geocoding; eligible addresses try Photon /structured first, then /api.
 */
export async function geocodeEgrknRecords(records: SourceRecord[], options: GeocodeOptions & { sleepMs?: number; onPage?: (evidence: GeocodeEvidence[]) => Promise<void> | void }): Promise<{ ineligible: number; high: number; medium: number; low: number; failed: number; conflicted: number; total: number; skipped: number; primaryCalls: number; fallbackCalls: number; yandexBudgetSkipped: number; evidence: GeocodeEvidence[]; audit: GeocodeAudit[] }> {
  const resolved = resolveGeocodeOptions(options);
  const sleepMs = options.sleepMs ?? (resolved.provider === "yandex" || resolved.fallback === "yandex" ? 350 : 0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const eligible = records.filter((record) => record.source === "egrkn" && record.address && !record.geometry);
  const limit = options.limit ?? defaultLimit(resolved.provider);
  const candidates = eligible.slice(0, limit);
  const evidence: GeocodeEvidence[] = [];
  const audit: GeocodeAudit[] = [];
  const yandexLimit = resolved.provider === "yandex" ? limit : resolved.fallback === "yandex" ? 1000 : Number.POSITIVE_INFINITY;
  let ineligible = 0, high = 0, medium = 0, low = 0, failed = 0, conflicted = 0, primaryCalls = 0, fallbackCalls = 0, yandexCalls = 0, yandexBudgetSkipped = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const record = candidates[i];
    const address = prepareAddress(record.address!);

    // P1: classify address before any provider call.
    const addressClass = classifyAddress(record.address);
    if (addressClass !== "standard") {
      ineligible += 1;
      const ineligibleAttempt: GeocodeAttempt = { provider: resolved.provider, outcome: "ineligible-address", returnedAddress: null, confidence: null, reason: `address class: ${addressClass}` };
      audit.push({ sourceRecordId: record.id, address: record.address!, accepted: false, attempts: [ineligibleAttempt] });
      continue;
    }

    // OSM address index: exact building match before any geocoder call.
    if (options.osmAddressIndex) {
      const idxResult = tryOsmAddressIndex(record, options.osmAddressIndex);
      if (idxResult) {
        if (idxResult.matched && idxResult.entry) {
          high += 1;
          evidence.push({
            sourceRecordId: record.id, address: record.address!,
            returnedAddress: `OSM building ${idxResult.entry.osmId}${idxResult.entry.name ? ": " + idxResult.entry.name : ""}`,
            addressCompatible: true, conflictReason: null,
            geometry: { type: "Point", coordinates: [idxResult.entry.lon, idxResult.entry.lat] },
            precision: "object", kind: "building", confidence: "high", method: "osm-address-match",
            provider: "osm-index",
            attempts: [{ provider: "osm-index", outcome: "accepted", returnedAddress: idxResult.entry.name ?? null, confidence: "high", reason: idxResult.reason }],
            capturedAt: record.capturedAt,
          });
          audit.push({ sourceRecordId: record.id, address: record.address!, accepted: true, attempts: [{ provider: "osm-index", outcome: "accepted", returnedAddress: idxResult.entry.name ?? null, confidence: "high", reason: idxResult.reason }] });
          continue;
        } else if (idxResult.ambiguous) {
          audit.push({ sourceRecordId: record.id, address: record.address!, accepted: false, attempts: [{ provider: "osm-index", outcome: "address-conflict", returnedAddress: null, confidence: null, reason: idxResult.reason }] });
          // Fall through to geocoder — ambiguous is not a hard reject
        }
      }
    }

    // P1: try Photon /structured first when using Photon.
    let primaryResult: GeocodeResult | null = null;
    if (resolved.provider === "photon") {
      const parts = extractAddressParts(record.address!);
      const parsed = record.address ? { street: null as string | null, house: null as string | null } : { street: null, house: null };
      // Reuse parseBuildingAddress from the validated contract — it also re-parses \n      // a full postal text. We only need street and house here.
      const textParts: { street?: string; house?: string } = {};
      const addressLower = record.address!.toLowerCase();
      const houseMatch = addressLower.match(/[\b\s,;](\d+)\s*([а-яa-z\-]?)\s*(?=$|[,;\s]|корп|стр|лит)/i);
      if (houseMatch) textParts.house = houseMatch[0].trim();
      primaryResult = await geocodePhotonAddressStructured(
        null, // street extracted by Photon from the structured query
        houseMatch?.[1] ?? null,
        parts.city,
        parts.state,
        options,
      );
    }
    if (!primaryResult) {
      primaryResult = await geocodeWithProvider(address, resolved.provider, resolved);
    }
    primaryCalls += 1;
    if (resolved.provider === "yandex") yandexCalls += 1;
    const primary = evaluateAttempt(resolved.provider, record.address!, primaryResult);
    const attempts = [primary.attempt];
    let chosen = primary;

    // P1: fallback only if the address was eligible (class === "standard").
    if (!primary.compatible && resolved.fallback !== "none") {
      if (resolved.fallback === "yandex" && yandexCalls >= yandexLimit) {
        yandexBudgetSkipped += 1;
        attempts.push({ provider: "yandex", outcome: "budget-exhausted", returnedAddress: null, confidence: null, reason: "Yandex request budget exhausted" });
      } else {
        const fallback = evaluateAttempt(resolved.fallback, record.address!, await geocodeWithProvider(address, resolved.fallback, resolved));
        fallbackCalls += 1;
        if (resolved.fallback === "yandex") yandexCalls += 1;
        attempts.push(fallback.attempt);
        if (fallback.compatible) chosen = fallback;
      }
    }

    audit.push({ sourceRecordId: record.id, address: record.address!, accepted: chosen.compatible, attempts });
    if (chosen.compatible && chosen.result) {
      high += 1;
      evidence.push({
        sourceRecordId: record.id,
        address: record.address!,
        returnedAddress: chosen.result.formatted,
        addressCompatible: true,
        conflictReason: null,
        geometry: { type: "Point", coordinates: [chosen.result.lon, chosen.result.lat] },
        precision: chosen.result.precision,
        kind: chosen.result.kind,
        confidence: chosen.result.confidence,
        method: "geocoder",
        provider: chosen.attempt.provider,
        attempts,
        capturedAt: record.capturedAt,
      });
    } else {
      const last = attempts.at(-1)!;
      if (last.outcome === "low-precision") medium += 1;
      else if (last.outcome === "address-conflict") conflicted += 1;
      else if (last.outcome === "not-found" || last.outcome === "error") failed += 1;
      else low += 1;
    }

    await sleep(sleepMs);
    if ((i + 1) % 50 === 0 && options.onPage) await options.onPage(evidence.slice(-50));
  }
  return { ineligible, high, medium, low, failed, conflicted, total: candidates.length, skipped: eligible.length - candidates.length, primaryCalls, fallbackCalls, yandexBudgetSkipped, evidence, audit };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Try to match an EGRKN record's address against the OSM address index.
 *  Returns null if the address can't be parsed, or a result describing the match. */
function tryOsmAddressIndex(record: SourceRecord, index: OsmAddressIndex): { matched: boolean; entry: AddressIndexEntry | null; ambiguous: boolean; reason: string } | null {
  if (!record.address) return null;
  const expected = parseBuildingAddress(record.address);
  const parts = extractAddressParts(record.address);
  const cityKey = addressKey(parts.city, expected.street, expected.house);
  const localityFreeKey = addressKey(null, expected.street, expected.house);
  if (!cityKey || !localityFreeKey) return null;

  // OSM building tags commonly omit addr:city. Prefer the full key, then allow
  // a locality-free key only with a strong building-name match — never merely
  // because another town happens to have the same street and house number.
  let entries = index.get(cityKey);
  let localityFree = false;
  if (!entries?.length && cityKey !== localityFreeKey) {
    entries = index.get(localityFreeKey);
    localityFree = true;
  }
  if (!entries?.length) return { matched: false, entry: null, ambiguous: false, reason: "not in OSM index" };

  const buildings = entries.filter((entry) => entry.isBuilding
    && (expected.corpus ?? null) === (entry.corpus?.toLowerCase().replace(/ё/g, "е") ?? null)
    && (expected.letter ?? null) === (entry.letter?.toLowerCase().replace(/ё/g, "е") ?? null));
  if (buildings.length === 0) return { matched: false, entry: null, ambiguous: false, reason: "only non-building or address-conflicting entries" };

  const nameMatch = buildings.find((entry) => entry.name && sameBuildingName(record.name, entry.name));
  if (nameMatch) return { matched: true, entry: nameMatch, ambiguous: false, reason: localityFree ? "locality-free building name match" : "building name match" };
  if (!localityFree && buildings.length === 1) return { matched: true, entry: buildings[0], ambiguous: false, reason: "single building at address" };
  return { matched: false, entry: null, ambiguous: buildings.length > 1, reason: localityFree ? "locality-free address needs building name match" : `ambiguous: ${buildings.length} buildings` };
}

function sameBuildingName(left: string | null, right: string): boolean {
  const tokens = (value: string | null) => (value ?? "").toLowerCase().replace(/ё/g, "е").match(/[а-яa-z]{4,}/g) ?? [];
  const leftTokens = tokens(left), rightTokens = tokens(right);
  const related = (a: string, b: string) => {
    let length = 0;
    while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
    return length >= 5;
  };
  let shared = 0;
  for (const a of leftTokens) if (rightTokens.some((b) => related(a, b))) shared += 1;
  return shared >= 2;
}

// Re-export for test access.


type PhotonResponse = { features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: Record<string, unknown> }> };
type NominatimResponse = { lon?: string; lat?: string; display_name?: string; type?: string; addresstype?: string; address?: Record<string, unknown> };
type YandexResponse = { response?: { GeoObjectCollection?: { featureMember?: Array<{ GeoObject?: { Point?: { pos?: string }; metaDataProperty?: { GeocoderMetaData?: { precision?: string; kind?: string; text?: string } } } }> } } };
