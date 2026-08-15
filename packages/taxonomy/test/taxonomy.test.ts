import { describe, expect, it } from "vitest";
import { SourceRecordSchema } from "@poi-toolkit/core";
import { classifyFacets, detectNoise, FacetPaths } from "../src/index.js";

const osm = (id: string, tags: Record<string, string>, name: string | null = "Test") =>
  SourceRecordSchema.parse({ id, source: "osm", sourceId: id, capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name, address: null, geometry: { type: "Point", coordinates: [49, 58] }, fields: { tags }, license: "ODbL" });

const facetPaths = (record: ReturnType<typeof osm>) => classifyFacets(record).map((c) => c.path);

describe("taxonomy", () => {
  it("classifies OSM worship, museums, heritage, memorials, nature", () => {
    expect(facetPaths(osm("n1", { amenity: "place_of_worship", building: "church" }))).toContain(FacetPaths.RELIGIOUS_CHURCH);
    expect(facetPaths(osm("n2", { historic: "monastery" }))).toContain(FacetPaths.RELIGIOUS_MONASTERY);
    expect(facetPaths(osm("n3", { historic: "wayside_cross" }))).toContain(FacetPaths.RELIGIOUS_SHRINE);
    expect(facetPaths(osm("n4", { amenity: "grave_yard" }))).toContain(FacetPaths.RELIGIOUS_CEMETERY);
    expect(facetPaths(osm("n5", { tourism: "museum" }))).toContain(FacetPaths.MUSEUM);
    expect(facetPaths(osm("n5b", { tourism: "gallery" }, "Музей иллюзии"))).toContain(FacetPaths.MUSEUM);
    expect(facetPaths(osm("n6", { historic: "castle" }))).toContain(FacetPaths.HERITAGE_FORTIFICATION);
    expect(facetPaths(osm("n7", { historic: "archaeological_site" }))).toContain(FacetPaths.HERITAGE_ARCHAEOLOGY);
    expect(facetPaths(osm("n8", { historic: "manor" }))).toContain(FacetPaths.HERITAGE_ESTATE);
    expect(facetPaths(osm("n9", { historic: "monument" }))).toContain(FacetPaths.MEMORIAL_MONUMENT);
    expect(facetPaths(osm("n10", { natural: "spring" }))).toContain(FacetPaths.NATURE_SPRING);
    expect(facetPaths(osm("n11", { waterway: "waterfall" }))).toContain(FacetPaths.NATURE_WATERFALL);
    expect(facetPaths(osm("n12", { natural: "water", water: "lake" }))).toContain(FacetPaths.NATURE_LAKE);
    expect(facetPaths(osm("n13", { boundary: "protected_area" }))).toContain(FacetPaths.NATURE_PROTECTED);
    expect(facetPaths(osm("n14", { leisure: "park" }))).toContain(FacetPaths.NATURE_PARK);
    expect(facetPaths(osm("n15", { tourism: "viewpoint" }))).toContain(FacetPaths.ATTRACTION_VIEWPOINT);
  });

  it("flags accommodation, information, linear rivers, settlements, and plaques as noise", () => {
    expect(detectNoise(osm("n1", { tourism: "hotel" })).noise).toBe(true);
    expect(detectNoise(osm("n2", { tourism: "information" })).noise).toBe(true);
    expect(detectNoise(osm("n3", { waterway: "river" })).noise).toBe(true);
    expect(detectNoise(osm("n4", { place: "village" })).noise).toBe(true);
    expect(detectNoise(osm("n5", { highway: "residential" })).noise).toBe(true);
    expect(detectNoise(osm("n6", { historic: "memorial_plaque" })).noise).toBe(true);
    expect(detectNoise(osm("n7", { historic: "monument" })).noise).toBe(false);
    expect(detectNoise(osm("n8", { natural: "spring" }, "Родник"))).toMatchObject({ noise: true, class: "unanchored_generic" });
    expect(detectNoise(osm("n9", { natural: "spring", wikidata: "Q1" }, "Родник"))).toMatchObject({ noise: false });
  });

  it("classifies EGRKN object types into religion, memorial, heritage, archaeology", () => {
    const egrkn = (type: string) => SourceRecordSchema.parse({ id: "e:" + type, source: "egrkn", sourceId: type, capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: type, address: null, geometry: { type: "Point", coordinates: [49, 58] }, fields: { objectType: type }, license: "mkrf" });
    expect(classifyFacets(egrkn("Церковь"))[0].path).toBe(FacetPaths.RELIGIOUS_CHURCH);
    expect(classifyFacets(egrkn("Монастырь"))[0].path).toBe(FacetPaths.RELIGIOUS_MONASTERY);
    expect(classifyFacets(egrkn("Обелиск"))[0].path).toBe(FacetPaths.MEMORIAL_MONUMENT);
    expect(classifyFacets(egrkn("Городище"))[0].path).toBe(FacetPaths.HERITAGE_ARCHAEOLOGY);
    expect(classifyFacets(egrkn("Дом"))[0].path).toBe(FacetPaths.HERITAGE_BUILDING);
  });

  it("classifies EGRKN by name regardless of legal objectType Памятник", () => {
    const egrkn = (name: string) => SourceRecordSchema.parse({ id: "e:" + name, source: "egrkn", sourceId: name, capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name, address: null, geometry: { type: "Point", coordinates: [49, 58] }, fields: { objectType: "Памятник" }, license: "mkrf" });
    expect(classifyFacets(egrkn("Никольская церковь"))[0].path).toBe(FacetPaths.RELIGIOUS_CHURCH);
    expect(classifyFacets(egrkn("Деревянная мечеть"))[0].path).toBe(FacetPaths.RELIGIOUS_CHURCH);
    expect(classifyFacets(egrkn("Дом, где в 1918 году"))[0].path).toBe(FacetPaths.HERITAGE_BUILDING);
    expect(classifyFacets(egrkn("Усадьба купца"))[0].path).toBe(FacetPaths.HERITAGE_ESTATE);
    expect(classifyFacets(egrkn("Памятник Ленину"))[0].path).toBe(FacetPaths.MEMORIAL_MONUMENT);
    expect(classifyFacets(egrkn("Братская могила"))[0].path).toBe(FacetPaths.MEMORIAL_MONUMENT);
    expect(classifyFacets(egrkn("Городище"))[0].path).toBe(FacetPaths.HERITAGE_ARCHAEOLOGY);
  });

  it("classifies MKRF records as museums and Wikidata P31 types", () => {
    const mkrf = SourceRecordSchema.parse({ id: "mkrf:1", source: "mkrf", sourceId: "1", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Музей", address: null, geometry: { type: "Point", coordinates: [49, 58] }, fields: {}, license: "mkrf" });
    expect(classifyFacets(mkrf)[0].path).toBe(FacetPaths.MUSEUM);
    const wd = SourceRecordSchema.parse({ id: "wikidata:Q1", source: "wikidata", sourceId: "Q1", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "T", address: null, geometry: null, fields: { type: "http://www.wikidata.org/entity/Q169930" }, license: "CC0" });
    expect(classifyFacets(wd)[0].path).toBe(FacetPaths.RELIGIOUS_CHURCH);
    expect(detectNoise(SourceRecordSchema.parse({ id: "wikidata:Q2", source: "wikidata", sourceId: "Q2", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "T", address: null, geometry: null, fields: { type: "http://www.wikidata.org/entity/Q4022" }, license: "CC0" })).noise).toBe(true);
  });
});

describe("regression: real-world bugs", () => {
  const wv = (id: string, name: string, type: string) =>
    SourceRecordSchema.parse({ id, source: "wikivoyage", sourceId: id, capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name, address: null, geometry: { type: "Point", coordinates: [49, 58] }, fields: { type }, license: "CC-BY-SA" });

  it("filters Wikivoyage eat listings regardless of name (Куркума bug)", () => {
    // Куркума is a restaurant with no food keyword in its name —
    // must be filtered by listing type, not name regex
    const kurkuma = wv("wikivoyage:Киров:1:1", "Куркума", "eat");
    expect(detectNoise(kurkuma).noise).toBe(true);
    expect(detectNoise(kurkuma).class).toBe("infrastructure");

    // Compare: a 'see' listing is NOT noise
    const sight = wv("wikivoyage:Киров:1:2", "Фантазариум", "see");
    expect(detectNoise(sight).noise).toBe(false);
  });

  it("filters Wikivoyage drink and sleep listings", () => {
    expect(detectNoise(wv("wv:1", "Бар Х", "drink")).noise).toBe(true);
    expect(detectNoise(wv("wv:2", "Отель Y", "sleep")).noise).toBe(true);
    expect(detectNoise(wv("wv:3", "Магазин Z", "buy")).noise).toBe(true);
  });

  it("classifies Wikivoyage museums by name (Васнецовs bug)", () => {
    // «Вятский художественный музей им. Васнецовых» from Wikivoyage
    // should get museum facet, not attraction
    const museum = wv("wikivoyage:Киров:1:3", "Вятский художественный музей им. Васнецовых", "see");
    const facets = classifyFacets(museum);
    expect(facets.some((f) => f.path === FacetPaths.MUSEUM)).toBe(true);
  });

  it("classifies any name containing «музей» as museum", () => {
    const names = ["Музей космонавтики", "Краеведческий музей", "музей-усадьба", "Дом-музей Ленина"];
    for (const name of names) {
      const facets = classifyFacets(wv("wv:" + name, name, "see"));
      expect(facets.some((f) => f.path === FacetPaths.MUSEUM), `failed for: ${name}`).toBe(true);
    }
  });
});
