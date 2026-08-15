import { describe, expect, it } from "vitest";
import { SourceRecordSchema } from "@poi-toolkit/core";
import { extractMediaCandidates, resolveCommonsMetadata, toCommonsAsset, toMkrfAsset, isPublishable, commonsThumbUrl } from "../src/index.js";

const osm = (id: string, tags: Record<string, string>) =>
  SourceRecordSchema.parse({ id, source: "osm", sourceId: id, capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "T", address: null, geometry: { type: "Point", coordinates: [49, 58] }, fields: { tags }, license: "ODbL" });

describe("media", () => {
  it("extracts Commons candidates from OSM image and wikimedia_commons tags", () => {
    const c = extractMediaCandidates(osm("n1", { image: "File:Kirov cathedral.jpg", "wikimedia_commons": "File:Kazan Kremlin.jpg" }));
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ kind: "commons", value: "Kirov_cathedral.jpg", sourceField: "tag:image" });
    expect(c[1]).toMatchObject({ kind: "commons", value: "Kazan_Kremlin.jpg" });
  });

  it("extracts http image candidates and MKRF media", () => {
    const c = extractMediaCandidates(osm("n1", { image: "https://example.com/photo.jpg" }));
    expect(c[0]).toMatchObject({ kind: "http", value: "https://example.com/photo.jpg" });
    const mkrf = SourceRecordSchema.parse({ id: "mkrf:1", source: "mkrf", sourceId: "1", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Музей", address: null, geometry: { type: "Point", coordinates: [49, 58] }, fields: { imageUrl: "https://opendata.mkrf.ru/museum.jpg" }, license: "mkrf" });
    const m = extractMediaCandidates(mkrf);
    expect(m[0]).toMatchObject({ kind: "mkrf", value: "https://opendata.mkrf.ru/museum.jpg" });
  });

  it("excludes EGRKN registry-card URLs", () => {
    const egrkn = SourceRecordSchema.parse({ id: "egrkn:1", source: "egrkn", sourceId: "1", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Дом", address: null, geometry: null, fields: { egrknUrl: "https://okn-mk.mkrf.ru/maps/show/id/1" }, license: "mkrf" });
    expect(extractMediaCandidates(egrkn)).toEqual([]);
  });

  it("resolves Commons metadata via a fake fetch and builds publishable assets", async () => {
    const fakeFetch = (async (url: string) => {
      const meta = {
        "query": { "pages": [{ "title": "File:Test.jpg", "imageinfo": [{ "thumburl": commonsThumbUrl("Test.jpg"), "extmetadata": { "Artist": { "value": "Ivan" }, "LicenseShortName": { "value": "CC BY-SA 4.0" }, "LicenseUrl": { "value": "https://creativecommons.org/licenses/by-sa/4.0/" } } }] }] },
      };
      return new Response(JSON.stringify(meta), { status: 200 });
    }) as typeof fetch;
    const [meta] = await resolveCommonsMetadata(["Test.jpg"], { fetch: fakeFetch });
    expect(meta).toMatchObject({ fileName: "Test.jpg", license: "CC BY-SA 4.0", artist: "Ivan" });
    const candidate = { sourceRecordId: "osm:n1", sourceField: "tag:image", kind: "commons" as const, value: "Test.jpg", license: null, attribution: null };
    const asset = toCommonsAsset(candidate, meta!);
    expect(asset).not.toBeNull();
    expect(isPublishable(asset!)).toBe(true);
    expect(asset!.attribution).toContain("CC BY-SA 4.0");
  });

  it("sends the canonical project User-Agent to Commons", async () => {
    let userAgent: string | null = null;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      userAgent = new Headers(init?.headers).get("User-Agent");
      return new Response(JSON.stringify({ query: { pages: [] } }));
    }) as typeof fetch;

    await resolveCommonsMetadata(["Test.jpg"], { fetch: fakeFetch });

    expect(userAgent).toBe("poi-toolkit/0.1 (https://github.com/stanleymarch/poi-toolkit)");
  });

  it("does not publish a Commons asset without a license", () => {
    const candidate = { sourceRecordId: "osm:n1", sourceField: "tag:image", kind: "commons" as const, value: "NoLicense.jpg", license: null, attribution: null };
    const asset = toCommonsAsset(candidate, { fileName: "NoLicense.jpg", thumbUrl: "x", artist: null, license: null, licenseUrl: null, credit: null });
    expect(asset).toBeNull();
  });

  it("promotes MKRF media with open-data attribution", () => {
    const candidate = { sourceRecordId: "mkrf:1", sourceField: "imageUrl", kind: "mkrf" as const, value: "https://opendata.mkrf.ru/museum.jpg", license: null, attribution: null };
    const asset = toMkrfAsset(candidate);
    expect(isPublishable(asset)).toBe(true);
    expect(asset.attribution).toContain("Министерство культуры");
  });
});
