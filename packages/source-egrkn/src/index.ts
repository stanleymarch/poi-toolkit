import { SourceManifestSchema, SourceRecord, egrknRecord } from "@poi-toolkit/core";

export const EGRKN_MANIFEST = SourceManifestSchema.parse({
  id: "egrkn",
  version: "v2",
  requiredSecrets: ["MKRF_API_KEY"],
  license: {
    name: "Ministry of Culture open data terms — verify before redistribution or OSM use",
    url: "https://opendata.mkrf.ru/",
    osmCompatible: "unknown",
  },
  attribution: "Единый государственный реестр объектов культурного наследия (Минкультуры России)",
  updateMode: "snapshot",
});

const baseUrl = "https://opendata.mkrf.ru/v2/egrkn/$";

export type EgrknOptions = {
  apiKey: string;
  region: string;
  regions?: string[];
  fetch?: typeof fetch;
  pageSize?: number;
  retries?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
  onPage?: (items: unknown[]) => Promise<void> | void;
};
export type EgrknResult = { raw: unknown[]; records: SourceRecord[]; pages: number };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function collectEgrkn(options: EgrknOptions): Promise<EgrknResult> {
  const request = options.fetch ?? fetch;
  const limit = options.pageSize ?? 100;
  const retries = options.retries ?? 8;
  const maxPages = options.maxPages ?? 10_000;
  const sleep = options.sleep ?? wait;
  if (!options.apiKey) throw new Error("MKRF_API_KEY is required for EGRKN collection");
  const regionList = options.regions?.length ? options.regions : [options.region];

  const raw: unknown[] = [];
  const seenRegNumbers = new Set<string>();
  let pages = 0;

  for (const region of regionList) {
    const regionResult = await fetchRegion(region, { request, limit, retries, maxPages, sleep, apiKey: options.apiKey, onPage: options.onPage });
    pages += regionResult.pages;
    for (const item of regionResult.raw) {
      const general = (item as Record<string, unknown>)?.data ? ((item as Record<string, unknown>).data as Record<string, unknown>).general : (item as Record<string, unknown>)?.general;
      const regNumber = String((general as Record<string, unknown>)?.regNumber ?? "");
      if (regNumber && seenRegNumbers.has(regNumber)) continue;
      if (regNumber) seenRegNumbers.add(regNumber);
      raw.push(item);
    }
  }

  const capturedAt = new Date().toISOString();
  return { raw, records: raw.map((row, index) => egrknRecord(row, `raw/egrkn.ndjson#${index + 1}`, capturedAt)), pages };
}

async function fetchRegion(region: string, ctx: { request: typeof fetch; limit: number; retries: number; maxPages: number; sleep: (ms: number) => Promise<void>; apiKey: string; onPage?: (items: unknown[]) => Promise<void> | void }): Promise<{ raw: unknown[]; pages: number }> {
  const { request, limit, retries, maxPages, sleep, apiKey, onPage } = ctx;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const raw: unknown[] = [];
  let regionPages = 0;
  for (;;) {
    if (raw.length / limit >= maxPages) throw new Error(`EGRKN completeness guard: reached ${maxPages} pages for ${region}`);
    const params = new URLSearchParams({
      f: JSON.stringify({ "data.general.region.value": { $search: region } }),
      l: String(limit),
    });
    if (cursor) params.set("cursor", cursor);

    let page: Record<string, unknown> | undefined;
    let lastError = "";
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const response = await request(`${baseUrl}?${params}`, {
          headers: { "X-API-KEY": apiKey, Accept: "application/json" },
        });
        const text = await response.text();
        lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
        if (response.ok && text) {
          page = JSON.parse(text) as Record<string, unknown>;
          if (!Array.isArray(page.data)) throw new Error("EGRKN schema drift: data is not an array");
          break;
        }
        if (![400, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(lastError);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === retries - 1) throw new Error(`EGRKN failed after ${retries} attempts: ${lastError}`);
      }
      await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
    }
    if (!page) throw new Error(`EGRKN failed after ${retries} attempts: ${lastError}`);

    regionPages += 1;
    const items = page.data as unknown[];
    await onPage?.(items);
    raw.push(...items);

    // `nextPage` is a complete URL. The API expects only the opaque `cursor`
    // value in the next request, so never pass nextPage as cursor.
    const nextCursor = typeof page.cursor === "string" && page.cursor ? page.cursor : undefined;
    if (!items.length || !nextCursor) break;
    if (seenCursors.has(nextCursor)) throw new Error("EGRKN completeness guard: repeated cursor");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { raw, pages: regionPages };
}

export { baseUrl as EGRKN_BASE_URL };
