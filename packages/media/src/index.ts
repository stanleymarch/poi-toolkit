import { MediaAsset, SourceRecord } from "@poi-toolkit/core";

export const MEDIA_RULE_VERSION = "media-v1";
export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const COMMONS_THUMB = "https://commons.wikimedia.org/wiki/Special:FilePath/";

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|tiff?|svg)$/i;
const FILE_PREFIX_RE = /^File:(.+)$/i;

export type MediaCandidate = {
  sourceRecordId: string;
  sourceField: string;
  /** "commons" (resolvable), "http" (direct URL, license unknown), "mkrf", "wikivoyage" */
  kind: "commons" | "http" | "mkrf" | "wikivoyage" | "egrkn";
  /** For commons: the File: page name or raw value. For http: the URL. */
  value: string;
  license: string | null;
  attribution: string | null;
};

/** Extract media candidates from any source record. EGRKN registry-card URLs are intentionally excluded. */
export function extractMediaCandidates(record: SourceRecord): MediaCandidate[] {
  switch (record.source) {
    case "osm": return extractOsmMedia(record);
    case "wikidata": return extractWikidataMedia(record);
    case "wikivoyage": return extractWikivoyageMedia(record);
    case "mkrf": return extractMkrfMedia(record);
    case "egrkn": return extractEgrknMedia(record);
    default: return [];
  }
}

function extractOsmMedia(record: SourceRecord): MediaCandidate[] {
  const tags = (record.fields.tags ?? {}) as Record<string, string>;
  const out: MediaCandidate[] = [];
  for (const key of ["image", "wikimedia_commons", "image:wikimedia"]) {
    const raw = tags[key]?.trim();
    if (!raw) continue;
    // upload.wikimedia.org / commons.wikimedia.org URLs ARE Commons images — extract the filename.
    const commonsUrlFile = extractCommonsFileNameFromUrl(raw);
    if (commonsUrlFile) {
      out.push({ sourceRecordId: record.id, sourceField: `tag:${key}`, kind: "commons", value: commonsUrlFile, license: "Wikimedia Commons", attribution: null });
    } else if (/^https?:\/\//i.test(raw)) {
      out.push({ sourceRecordId: record.id, sourceField: `tag:${key}`, kind: "http", value: raw, license: "OSM image reference (external)", attribution: "© OpenStreetMap contributors" });
    } else {
      const fileName = resolveCommonsFileName(raw);
      if (fileName) out.push({ sourceRecordId: record.id, sourceField: `tag:${key}`, kind: "commons", value: fileName, license: "Wikimedia Commons", attribution: null });
    }
  }
  return out;
}

function extractWikidataMedia(record: SourceRecord): MediaCandidate[] {
  const out: MediaCandidate[] = [];
  const image = String(record.fields.image ?? "").trim();
  if (image) {
    const fileName = resolveCommonsFileName(image);
    if (fileName) out.push({ sourceRecordId: record.id, sourceField: "image", kind: "commons", value: fileName, license: "Wikimedia Commons", attribution: null });
  }
  const commons = String(record.fields.commons ?? "").trim();
  if (commons) {
    // Category → not a single photo; skip for direct media, keep as source link elsewhere.
  }
  return out;
}

function extractWikivoyageMedia(record: SourceRecord): MediaCandidate[] {
  const image = String(record.fields.image ?? "").trim();
  if (!image) return [];
  const fileName = resolveCommonsFileName(image) ?? (IMAGE_EXT_RE.test(image) ? image.replace(/ /g, "_") : null);
  if (!fileName) return [];
  return [{ sourceRecordId: record.id, sourceField: "image", kind: "commons", value: fileName, license: "Wikimedia Commons", attribution: null }];
}

function extractMkrfMedia(record: SourceRecord): MediaCandidate[] {
  const url = String(record.fields.imageUrl ?? "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return [];
  return [{ sourceRecordId: record.id, sourceField: "imageUrl", kind: "mkrf", value: url, license: "Ministry of Culture open-data terms", attribution: "Министерство культуры РФ (opendata.mkrf.ru)" }];
}

/** EGRKN photo.url is a direct JPEG served by the registry (okn-mk.mkrf.ru/maps/show/id/XXX
 *  returns Content-Type: image/jpeg). It is a real image, not a page — publish directly. */
function extractEgrknMedia(record: SourceRecord): MediaCandidate[] {
  const url = String(record.fields.photoUrl ?? "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return [];
  return [{ sourceRecordId: record.id, sourceField: "photoUrl", kind: "egrkn", value: url, license: "Ministry of Culture open-data terms", attribution: "Министерство культуры РФ (okn-mk.mkrf.ru)" }];
}

function resolveCommonsFileName(raw: string): string | null {
  const match = raw.match(FILE_PREFIX_RE);
  if (match) return match[1].replace(/ /g, "_");
  if (IMAGE_EXT_RE.test(raw)) return raw.replace(/ /g, "_");
  return null;
}

/** Extract a Commons file name from an upload.wikimedia.org or commons.wikimedia.org URL. */
function extractCommonsFileNameFromUrl(url: string): string | null {
  // https://upload.wikimedia.org/wikipedia/commons/thumb/.../1920px-Name.jpg → Name.jpg
  // https://commons.wikimedia.org/wiki/File:Name.jpg → Name.jpg
  const fileMatch = url.match(/\/File:(.+?)($|[?#])/i);
  if (fileMatch) return decodeURIComponent(fileMatch[1]).replace(/ /g, "_");
  const thumbMatch = url.match(/\/(?:thumb\/)?(?:[0-9a-f]\/[0-9a-f]\/)?(?:[0-9]+px-)?([^/?#]+\.(?:jpe?g|png|webp|gif|tiff?|svg))$/i);
  if (thumbMatch && /wikimedia\.org/i.test(url)) return decodeURIComponent(thumbMatch[1]).replace(/ /g, "_");
  return null;
}

/** Build a direct thumb URL for a Commons file name. */
export function commonsThumbUrl(fileName: string, width = 640): string {
  return `${COMMONS_THUMB}${encodeURIComponent(fileName)}?width=${width}`;
}

export type CommonsMetadata = {
  fileName: string;
  thumbUrl: string;
  artist: string | null;
  license: string | null;
  licenseUrl: string | null;
  credit: string | null;
};

/**
 * Resolve Commons file metadata (artist, license) via the MediaWiki API in batches.
 * Failed lookups return null entries so callers keep alignment with the input order.
 */
export async function resolveCommonsMetadata(
  fileNames: string[],
  options: { fetch?: typeof fetch; userAgent?: string; retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<(CommonsMetadata | null)[]> {
  if (!fileNames.length) return [];
  const request = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? process.env.POI_TOOLKIT_USER_AGENT ?? "poi-toolkit/0.1 (https://github.com/stanleymarch/poi-toolkit)";
  const retries = options.retries ?? 5;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const titles = fileNames.map((name) => (name.startsWith("File:") ? name : `File:${name}`)).join("|");
  const query = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", titles,
    prop: "imageinfo", iiprop: "url|extmetadata|mime|size", iiurlwidth: "640",
  });
  let data: CommonsApiResponse | undefined;
  let lastError = "";
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await request(`${COMMONS_API}?${query}`, { headers: { Accept: "application/json", "User-Agent": userAgent } });
      if (response.status === 429 || [500, 502, 503, 504].includes(response.status)) {
        lastError = `HTTP ${response.status}`;
        await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`Commons metadata failed: HTTP ${response.status}`);
      data = (await response.json()) as CommonsApiResponse;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === retries - 1) return fileNames.map(() => null); // graceful degradation
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
    }
  }
  if (!data) return fileNames.map(() => null); // graceful degradation
  const pages = data.query?.pages ?? [];
  const byName = new Map<string, CommonsMetadata>();
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const meta = info.extmetadata ?? {};
    const fileName = (page.title ?? "").replace(/^File:/, "");
    byName.set(fileName, {
      fileName,
      thumbUrl: info.thumburl ?? commonsThumbUrl(fileName),
      artist: stripHtml(meta.Artist?.value),
      license: meta.LicenseShortName?.value?.trim() || null,
      licenseUrl: meta.LicenseUrl?.value?.trim() || null,
      credit: stripHtml(meta.Credit?.value),
    });
  }
  return fileNames.map((name) => byName.get(name) ?? null);
}

/** Promote a resolved Commons candidate to a publishable MediaAsset, or null if it lacks attribution/license. */
export function toCommonsAsset(candidate: MediaCandidate, meta: CommonsMetadata): MediaAsset | null {
  if (!meta.license) return null;
  return {
    url: meta.thumbUrl,
    sourcePageUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(candidate.value)}`,
    sourceRecordId: candidate.sourceRecordId,
    author: meta.artist,
    license: meta.license,
    licenseUrl: meta.licenseUrl,
    attribution: meta.artist ? `${meta.artist} — ${meta.license}` : `Wikimedia Commons — ${meta.license}`,
    width: null,
    height: null,
    rule: { id: "commons", version: MEDIA_RULE_VERSION },
  };
}

/** Promote an MKRF candidate to a publishable MediaAsset (open-data terms, no per-file license fetch needed). */
export function toMkrfAsset(candidate: MediaCandidate): MediaAsset {
  return {
    url: candidate.value,
    sourcePageUrl: `https://opendata.mkrf.ru/`,
    sourceRecordId: candidate.sourceRecordId,
    author: null,
    license: "Ministry of Culture open-data terms",
    licenseUrl: "https://opendata.mkrf.ru/",
    attribution: candidate.attribution ?? "Министерство культуры РФ (opendata.mkrf.ru)",
    width: null,
    height: null,
    rule: { id: "mkrf-image", version: MEDIA_RULE_VERSION },
  };
}

/** Promote an EGRKN registry-page photo candidate. The URL is an object page, not a direct
 *  image — the consumer resolves the page to the actual image, then fetches/caches it. */
export function toEgrknAsset(candidate: MediaCandidate): MediaAsset {
  return {
    url: candidate.value,
    sourcePageUrl: candidate.value,
    sourceRecordId: candidate.sourceRecordId,
    author: null,
    license: "Ministry of Culture open-data terms",
    licenseUrl: "https://opendata.mkrf.ru/",
    attribution: "Министерство культуры РФ (okn-mk.mkrf.ru)",
    width: null,
    height: null,
    rule: { id: "egrkn-page-photo", version: MEDIA_RULE_VERSION },
  };
}

/** Promote an OSM http-image candidate (external host) to a publishable MediaAsset with OSM-reference attribution. */
export function toHttpAsset(candidate: MediaCandidate): MediaAsset {
  return {
    url: candidate.value,
    sourcePageUrl: null,
    sourceRecordId: candidate.sourceRecordId,
    author: null,
    license: "External (license unverified)",
    licenseUrl: null,
    attribution: "© OpenStreetMap contributors (image reference)",
    width: null,
    height: null,
    rule: { id: "osm-http-image", version: MEDIA_RULE_VERSION },
  };
}

/** An http-image candidate with unknown license is NOT publishable; kept as evidence only. */
export function isPublishable(asset: MediaAsset): boolean {
  return Boolean(asset.license && asset.attribution);
}

function stripHtml(value: string | undefined): string | null {
  if (!value) return null;
  const text = value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return text || null;
}

type CommonsApiResponse = {
  query?: { pages?: Array<{ title?: string; imageinfo?: Array<{ thumburl?: string; extmetadata?: Record<string, { value?: string }> }> }> };
};
