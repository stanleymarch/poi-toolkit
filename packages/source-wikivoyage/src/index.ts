import { FieldClaim, GeometryEvidence, SourceManifestSchema, SourceRecord, SourceRecordSchema } from "@poi-toolkit/core";

export const WIKIVOYAGE_MANIFEST = SourceManifestSchema.parse({
  id: "wikivoyage",
  version: "mediawiki-revision-v1",
  requiredSecrets: [],
  license: { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/", osmCompatible: "unknown" },
  attribution: "Wikivoyage contributors, CC BY-SA 4.0",
  updateMode: "snapshot",
});
export const WIKIVOYAGE_API = "https://ru.wikivoyage.org/w/api.php";
export type WikivoyageListing = Record<string, string> & { page: string; revisionId: string; revisionTimestamp: string; index: string };
export type WikivoyageRaw = { page: string; revisionId: string; revisionTimestamp: string; listing: WikivoyageListing };
export type WikivoyageOptions = { pages: string[]; fetch?: typeof fetch; retries?: number; userAgent?: string; sleep?: (ms: number) => Promise<void>; onPage?: (items: WikivoyageRaw[]) => Promise<void> | void };
export type WikivoyageResult = { raw: WikivoyageRaw[]; records: SourceRecord[]; pages: number; skippedPages: string[] };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fetches the page's current revision so every listing has stable page/revision provenance. */
export async function collectWikivoyage(options: WikivoyageOptions): Promise<WikivoyageResult> {
  if (!options.pages.length) return { raw: [], records: [], pages: 0, skippedPages: [] };
  const raw: WikivoyageRaw[] = [];
  const skippedPages: string[] = [];
  for (const page of options.pages) {
    const revision = await fetchRevision(page, options);
    if (!revision) {
      skippedPages.push(page);
      await options.onPage?.([]);
      continue;
    }
    const listings = extractListings(revision.content).map((listing, index) => ({
      ...listing, page, revisionId: revision.id, revisionTimestamp: revision.timestamp, index: String(index + 1),
    }));
    const pageRaw = listings.map((listing) => ({ page, revisionId: revision.id, revisionTimestamp: revision.timestamp, listing }));
    raw.push(...pageRaw);
    await options.onPage?.(pageRaw);
  }
  return { raw, records: raw.map((row, index) => wikivoyageRecord(row, `raw/wikivoyage.ndjson#${index + 1}`)), pages: options.pages.length, skippedPages };
}

export type WikivoyageNatureOptions = { pages: string[]; fetch?: typeof fetch; retries?: number; userAgent?: string; sleep?: (ms: number) => Promise<void>; onPage?: (records: SourceRecord[]) => Promise<void> | void };
export type WikivoyageNatureResult = { records: SourceRecord[]; pages: number; skippedPages: string[] };

/** Collect natural monuments (ООПТ) from Wikivoyage «Природные памятники России/Регион» pages.
 *  These are protected areas with registry numbers (knid), rarely with coordinates — they enrich
 *  via name/knid matching or geocoding, not direct geometry. */
export async function collectWikivoyageNature(options: WikivoyageNatureOptions): Promise<WikivoyageNatureResult> {
  const records: SourceRecord[] = [];
  const skippedPages: string[] = [];
  for (const page of options.pages) {
    const revision = await fetchRevisionNature(page, options);
    if (!revision) { skippedPages.push(page); continue; }
    const monuments = extractNaturalMonuments(revision.content);
    const pageRecords = monuments.map((m, index) => naturalMonumentRecord(m, page, revision.id, revision.timestamp, `${index + 1}`));
    records.push(...pageRecords);
    await options.onPage?.(pageRecords);
  }
  return { records, pages: options.pages.length, skippedPages };
}

async function fetchRevisionNature(page: string, options: WikivoyageNatureOptions): Promise<{ id: string; timestamp: string; content: string } | null> {
  const request = options.fetch ?? fetch; const retries = options.retries ?? 5; const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const query = new URLSearchParams({ action: "query", format: "json", formatversion: "2", prop: "revisions", titles: page, rvprop: "ids|timestamp|content", rvslots: "main", maxlag: "5" });
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await request(`${WIKIVOYAGE_API}?${query}`, { headers: { Accept: "application/json", "User-Agent": options.userAgent ?? process.env.POI_TOOLKIT_USER_AGENT ?? "poi-toolkit/0.1" } });
      if (!response.ok) { if (![429, 500, 502, 503, 504].includes(response.status)) return null; }
      else {
        const data = await response.json() as { query?: { pages?: Array<{ missing?: boolean; revisions?: Array<{ revid?: number; timestamp?: string; slots?: { main?: { content?: string } } }> }> } };
        const pageData = data.query?.pages?.[0];
        if (pageData?.missing === true) return null;
        const revision = pageData?.revisions?.[0];
        const content = revision?.slots?.main?.content;
        if (!revision?.revid || !revision.timestamp || typeof content !== "string") throw new Error(`Wikivoyage nature schema drift for ${page}`);
        return { id: String(revision.revid), timestamp: revision.timestamp, content };
      }
    } catch { if (attempt === retries - 1) throw new Error(`Wikivoyage nature ${page} failed after ${retries} attempts`); }
    await sleep(Math.min(64_000, 1_000 * 2 ** attempt));
  }
  return null;
}

export function naturalMonumentRecord(m: NaturalMonument, page: string, revisionId: string, revisionTimestamp: string, index: string): SourceRecord {
  const lat = m.lat, lon = m.long;
  const geometry = lat !== null && lon !== null ? { type: "Point" as const, coordinates: [lon, lat] as [number, number] } : null;
  return SourceRecordSchema.parse({
    id: `wikivoyage-nature:${page}:${m.knid ?? index}`, source: "wikivoyage", sourceId: m.knid ?? `${page}:${index}`,
    capturedAt: revisionTimestamp, rawRef: `raw/wikivoyage-nature.ndjson#${index}`,
    name: m.name, address: m.address, geometry,
    fields: { type: "nature", listingType: m.type, knid: m.knid, status: m.status, category: m.category, district: m.district, area: m.area, description: m.description, image: m.image, wdid: m.wdid, commonscat: m.commonscat, oopt: m.oopt, ooptid: m.ooptid, page, revisionId, revisionTimestamp, index, pageUrl: `https://ru.wikivoyage.org/wiki/${encodeURIComponent(page)}` },
    license: "CC BY-SA 4.0",
  });
}

async function fetchRevision(page: string, options: WikivoyageOptions): Promise<{ id: string; timestamp: string; content: string } | null> {
  const request = options.fetch ?? fetch; const retries = options.retries ?? 5; const sleep = options.sleep ?? wait;
  const query = new URLSearchParams({ action: "query", format: "json", formatversion: "2", prop: "revisions", titles: page, rvprop: "ids|timestamp|content", rvslots: "main", maxlag: "5" });
  let lastError = "";
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await request(`${WIKIVOYAGE_API}?${query}`, { headers: { Accept: "application/json", "User-Agent": options.userAgent ?? process.env.POI_TOOLKIT_USER_AGENT ?? "poi-toolkit/0.1 (https://github.com/stanleymarch/poi-toolkit)" } });
      const text = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
        if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(lastError);
      } else {
        const data = JSON.parse(text) as MediaWikiResponse;
        if (data.error?.code === "maxlag") lastError = `MediaWiki maxlag: ${data.error.info ?? "server lag"}`;
        else {
          const pageData = data.query?.pages?.[0];
          if (pageData?.missing === true) return null;
          const revision = pageData?.revisions?.[0];
          const content = revision?.slots?.main?.content;
          if (!revision?.revid || !revision.timestamp || typeof content !== "string") throw new Error(`Wikivoyage schema drift for ${page}: revision content/provenance missing`);
          return { id: String(revision.revid), timestamp: revision.timestamp, content };
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === retries - 1) throw new Error(`Wikivoyage ${page} failed after ${retries} attempts: ${lastError}`);
    }
    if (attempt === retries - 1) break;
    await sleep(Math.min(64_000, 1_000 * 2 ** attempt));
  }
  throw new Error(`Wikivoyage ${page} failed after ${retries} attempts: ${lastError}`);
}
type MediaWikiResponse = {
  error?: { code?: string; info?: string };
  query?: {
    pages?: Array<{
      missing?: boolean;
      revisions?: Array<{
        revid?: number;
        timestamp?: string;
        slots?: { main?: { content?: string } };
      }>;
    }>;
  };
};

export function extractListings(wikitext: string): Record<string, string>[] {
  return extractBalanced(wikitext, "{{listing").map(parseListing).filter((listing): listing is Record<string, string> => listing !== null);
}

/** Parse {{natural monument|...}} templates from Wikivoyage nature pages (Природные памятники России/Регион). */
export function extractNaturalMonuments(wikitext: string): NaturalMonument[] {
  return extractBalanced(wikitext, "{{natural monument")
    .map(parseNaturalMonument)
    .filter((m): m is NaturalMonument => m !== null && m.status !== "rejected");
}

export type NaturalMonument = {
  name: string; knid: string | null; lat: number | null; long: number | null; precise: boolean;
  type: string; status: string | null; category: string | null; district: string | null;
  address: string | null; area: number | null; description: string | null;
  image: string | null; wdid: string | null; commonscat: string | null; oopt: string | null; ooptid: string | null;
};
function parseNaturalMonument(source: string): NaturalMonument | null {
  const values = parseListing(source);
  if (!values || !values.name?.trim()) return null;
  const num = (s: string | undefined) => { const n = Number((s ?? "").trim().replace(",", ".")); return Number.isFinite(n) ? n : null; };
  return {
    name: values.name.trim(), knid: values.knid?.trim() || null,
    lat: num(values.lat), long: num(values.long), precise: values.precise?.trim() === "yes",
    type: (values.type ?? "nature").trim(), status: values.status?.trim() || null,
    category: values.category?.trim() || null, district: values.district?.trim() || null,
    address: values.address?.trim() || null, area: num(values.area),
    description: values.description?.trim() || null,
    image: values.image?.trim() || null, wdid: values.wdid?.trim() || null,
    commonscat: values.commonscat?.trim() || null, oopt: values.oopt?.trim() || null, ooptid: values.ooptid?.trim() || null,
  };
}
function extractBalanced(text: string, tag: string): string[] {
  const results: string[] = []; let start = 0;
  while (start < text.length) {
    const opening = text.toLowerCase().indexOf(tag, start); if (opening < 0) break;
    let depth = 1; let cursor = opening + tag.length;
    while (cursor < text.length && depth) { if (text.slice(cursor, cursor + 2) === "{{") { depth += 1; cursor += 2; } else if (text.slice(cursor, cursor + 2) === "}}") { depth -= 1; cursor += 2; } else cursor += 1; }
    if (!depth) { results.push(text.slice(opening + tag.length, cursor - 2)); start = cursor; } else start = opening + tag.length;
  }
  return results;
}
function parseListing(source: string): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const part of splitPipes(source)) { const separator = part.indexOf("="); if (separator > 0) values[part.slice(0, separator).trim().toLowerCase()] = part.slice(separator + 1).trim(); }
  return Object.keys(values).length >= 2 ? values : null;
}
function splitPipes(text: string): string[] {
  const parts: string[] = []; let current = ""; let depth = 0;
  for (let index = 0; index < text.length; index += 1) { const pair = text.slice(index, index + 2); if (pair === "{{") { depth += 1; current += pair; index += 1; } else if (pair === "}}") { depth -= 1; current += pair; index += 1; } else if (text[index] === "|" && depth === 0) { parts.push(current.trim()); current = ""; } else current += text[index]; }
  if (current.trim()) parts.push(current.trim()); return parts;
}

export function wikivoyageRecord(raw: WikivoyageRaw, rawRef: string, capturedAt = new Date().toISOString()): SourceRecord {
  const { listing } = raw; const lat = coordinate(listing.lat); const longitude = coordinate(listing.long);
  const geometry = lat === null || longitude === null ? null : { type: "Point" as const, coordinates: [longitude, lat] };
  return SourceRecordSchema.parse({ id: `wikivoyage:${raw.page}:${raw.revisionId}:${listing.index}`, source: "wikivoyage", sourceId: `${raw.page}:${raw.revisionId}:${listing.index}`, capturedAt, rawRef, name: listing.name?.trim() || null, address: listing.address?.trim() || null, geometry, fields: { ...listing, pageUrl: `https://ru.wikivoyage.org/w/index.php?title=${encodeURIComponent(raw.page)}&oldid=${raw.revisionId}` }, license: "CC BY-SA 4.0" });
}
export function wikivoyageGeometryEvidence(record: SourceRecord): GeometryEvidence | null { return record.geometry ? { sourceRecordId: record.id, geometry: record.geometry, method: "source-native", precision: "object", precisionMeters: null, capturedAt: record.capturedAt } : null; }
export function wikivoyageFieldClaims(record: SourceRecord): FieldClaim[] { return Object.entries(record.fields).map(([field, value]) => ({ sourceRecordId: record.id, field, value, provenance: record.rawRef, observedAt: record.capturedAt, license: record.license })); }
function coordinate(value: string | undefined): number | null { const number = Number(value?.trim().replace(",", ".")); return Number.isFinite(number) ? number : null; }
