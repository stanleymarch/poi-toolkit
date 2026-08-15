import { SourceManifestSchema, SourceRecord, SourceRecordSchema } from "@poi-toolkit/core";

export const MKRF_MANIFEST = SourceManifestSchema.parse({
  id: "mkrf",
  version: "v2-museums",
  requiredSecrets: ["MKRF_API_KEY"],
  license: { name: "Ministry of Culture open-data terms", url: "https://opendata.mkrf.ru/", osmCompatible: "unknown" },
  attribution: "Музеи и галереи — Министерство культуры РФ (opendata.mkrf.ru)",
  updateMode: "snapshot",
});

const baseUrl = "https://opendata.mkrf.ru/v2/museums/$";
export type MkrfOptions = {
  apiKey: string;
  clipBbox?: [number, number, number, number];
  regionKeywords?: string[];
  fetch?: typeof fetch;
  pageSize?: number;
  maxPages?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  onPage?: (items: SourceRecord[]) => Promise<void> | void;
};
export type MkrfResult = { records: SourceRecord[]; pages: number };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;

/** Fetch all-Russia museums and keep only those inside the territory (coords in bbox, or address mentions a region keyword). */
export async function collectMkrf(options: MkrfOptions): Promise<MkrfResult> {
  const request = options.fetch ?? fetch;
  const limit = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 10_000;
  const retries = options.retries ?? 8;
  const sleep = options.sleep ?? wait;
  if (!options.apiKey) throw new Error("MKRF_API_KEY is required for museum collection");

  let cursor: string | undefined;
  let pages = 0;
  const seenCursors = new Set<string>();
  const records: SourceRecord[] = [];

  for (;;) {
    if (pages >= maxPages) throw new Error(`MKRF completeness guard: reached ${maxPages} pages`);
    const params = new URLSearchParams({ l: String(limit) });
    if (cursor) params.set("cursor", cursor);

    let page: Record<string, unknown> | undefined;
    let lastError = "";
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const response = await request(`${baseUrl}?${params}`, { headers: { "X-API-KEY": options.apiKey, Accept: "application/json" } });
        const text = await response.text();
        lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
        if (response.ok && text) {
          page = JSON.parse(text) as Record<string, unknown>;
          if (!Array.isArray(page.data)) throw new Error("MKRF schema drift: data is not an array");
          break;
        }
        if (![400, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(lastError);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === retries - 1) throw new Error(`MKRF failed after ${retries} attempts: ${lastError}`);
      }
      await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
    }
    if (!page) throw new Error(`MKRF failed after ${retries} attempts: ${lastError}`);

    pages += 1;
    const items = page.data as unknown[];
    const capturedAt = new Date().toISOString();
    const pageRecords: SourceRecord[] = [];
    for (const raw of items) {
      const record = normalizeMkrfRecord(raw, capturedAt);
      if (record && inTerritory(record, options)) pageRecords.push(record);
    }
    records.push(...pageRecords);
    await options.onPage?.(pageRecords);

    const nextCursor = typeof page.cursor === "string" && page.cursor ? page.cursor : undefined;
    if (!items.length || !nextCursor) break;
    if (seenCursors.has(nextCursor)) throw new Error("MKRF completeness guard: repeated cursor");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { records, pages };
}

function normalizeMkrfRecord(raw: unknown, capturedAt: string): SourceRecord | null {
  const general = nested(raw, "data", "general") ?? nested(raw, "general");
  if (!general) return null;
  const name = str(general.name);
  if (!name) return null;
  const mkrfId = str(general.id) ?? str((raw as Record<string, unknown>)?.nativeId) ?? str((raw as Record<string, unknown>)?._id);
  if (!mkrfId) return null;

  const address = nested(general, "address") ?? {};
  const coords = (nested(address, "mapPosition") ?? {}).coordinates;
  const [lon, lat] = Array.isArray(coords) && coords.length >= 2 ? [Number(coords[0]), Number(coords[1])] : [NaN, NaN];
  const geometry = Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90 ? { type: "Point" as const, coordinates: [lon, lat] as [number, number] } : null;

  const contacts = nested(general, "contacts") ?? {};
  const organization = nested(general, "organization") ?? {};
  const locale = nested(general, "locale") ?? {};
  const externalInfo = (general.externalInfo ?? []) as Array<Record<string, unknown>>;

  return SourceRecordSchema.parse({
    id: `mkrf:${mkrfId}`, source: "mkrf", sourceId: String(mkrfId), capturedAt, rawRef: `raw/mkrf.ndjson#${mkrfId}`,
    name, address: str(address.fullAddress),
    geometry,
    fields: {
      objectType: "museum",
      region: str(locale.name) ?? str(nested(organization, "subordination")?.name),
      description: stripHtml(general.description),
      website: str(contacts.website),
      email: str(contacts.email),
      vkUrl: vkUrl(organization),
      cultureRuUrl: externalInfo.find((ei) => String(ei.serviceName ?? "").toLowerCase() === "культура.рф")?.url ? str(externalInfo.find((ei) => String(ei.serviceName ?? "").toLowerCase() === "культура.рф")!.url) : null,
      imageUrl: str(nested(general, "image")?.url),
      categoryType: str(nested(general, "category")?.name),
      egrknUrl: null,
    },
    license: "Ministry of Culture open-data terms",
  });
}

function inTerritory(record: SourceRecord, options: MkrfOptions): boolean {
  const g = record.geometry;
  if (g?.type === "Point" && options.clipBbox) {
    const [lon, lat] = g.coordinates;
    const [w, s, e, n] = options.clipBbox;
    if (lon >= w && lon <= e && lat >= s && lat <= n) return true;
  }
  if (options.regionKeywords?.length) {
    const hay = `${record.address ?? ""} ${String(record.fields.region ?? "")}`.toLowerCase();
    return options.regionKeywords.some((kw) => hay.includes(kw.toLowerCase()));
  }
  return false;
}

function nested(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current = value as Record<string, unknown> | undefined;
  for (const key of keys) { if (!current || typeof current !== "object") return undefined; current = current[key] as Record<string, unknown> | undefined; }
  return current;
}
function str(value: unknown): string | null { if (value === null || value === undefined) return null; const s = String(value).trim(); return s || null; }
function stripHtml(value: unknown): string | null { const s = str(value); if (!s) return null; const text = s.replace(TAG_RE, " ").replace(WS_RE, " ").trim(); return text || null; }
function vkUrl(organization: Record<string, unknown>): string | null {
  const groups = (organization.socialGroups ?? []) as Array<Record<string, unknown>>;
  const vk = groups.find((sg) => sg.network === "vk" && !sg.isPersonal && sg.networkId);
  return vk ? `https://vk.com/club${vk.networkId}` : null;
}

export { baseUrl as MKRF_BASE_URL };
