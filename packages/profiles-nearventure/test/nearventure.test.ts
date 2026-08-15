import { describe, expect, it } from "vitest";
import { SourceRecord, SourceRecordSchema } from "@poi-toolkit/core";
import { synthesizeEntity } from "@poi-toolkit/synthesis";
import { primaryCategory, eligibility, projectNearventure, CATEGORY_LABELS } from "../src/index.js";

const rec = (id: string, source: SourceRecord["source"], name: string | null, fields: Record<string, unknown> = {}, geometry: SourceRecord["geometry"] = { type: "Point", coordinates: [49.66, 58.6] }) =>
  SourceRecordSchema.parse({ id, source, sourceId: id, capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name, address: null, geometry, fields, license: "test" });

const entity = (osm: ReturnType<typeof rec>) => synthesizeEntity([osm], { bbox: [46, 56, 55, 61] })!;

describe("nearventure profile", () => {
  it("maps facets to the six categories", () => {
    expect(primaryCategory(entity(rec("n1", "osm", "Храм", { tags: { amenity: "place_of_worship", building: "church" } })).facets, "Храм")?.category).toBe("religion");
    expect(primaryCategory(entity(rec("n2", "osm", "Музей", { tags: { tourism: "museum" } })).facets, "Музей")?.category).toBe("museum");
    expect(primaryCategory(entity(rec("n3", "osm", "Замок", { tags: { historic: "castle" } })).facets, "Замок")?.category).toBe("heritage");
    expect(primaryCategory(entity(rec("n4", "osm", "Памятник", { tags: { historic: "monument" } })).facets, "Памятник")?.category).toBe("monument");
    expect(primaryCategory(entity(rec("n5", "osm", "Смотровая", { tags: { tourism: "viewpoint" } })).facets, "Смотровая")?.category).toBe("sights");
    expect(primaryCategory(entity(rec("n6", "osm", "Родник", { tags: { natural: "spring" } })).facets, "Родник")?.category).toBe("nature");
  });

  it("overrides a building-named monument/sight to heritage", () => {
    const e = entity(rec("n1", "osm", "Дом Советов", { tags: { historic: "building" } }));
    expect(primaryCategory(e.facets, "Дом Советов")?.category).toBe("heritage");
    expect(primaryCategory(e.facets, "Дом Советов")?.rule).toBe("building-name-heritage-override");
  });

  it("classifies an EGRKN church named object as religion and a memorial house as heritage", () => {
    const church = synthesizeEntity([SourceRecordSchema.parse({ id: "egrkn:1", source: "egrkn", sourceId: "1", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Никольская церковь", address: null, geometry: { type: "Point", coordinates: [49, 58] }, fields: { objectType: "Памятник" }, license: "mkrf" })], { bbox: [46, 56, 55, 61] })!;
    expect(primaryCategory(church.facets, "Никольская церковь")?.category).toBe("religion");
    const house = synthesizeEntity([SourceRecordSchema.parse({ id: "egrkn:2", source: "egrkn", sourceId: "2", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Дом, где в 1918 году", address: null, geometry: { type: "Point", coordinates: [49, 58] }, fields: { objectType: "Памятник" }, license: "mkrf" })], { bbox: [46, 56, 55, 61] })!;
    expect(primaryCategory(house.facets, "Дом, где в 1918 году")?.category).toBe("heritage");
  });

  it("excludes noise, unnamed, and unsafe-geometry entities", () => {
    expect(eligibility(entity(rec("n1", "osm", "Отель", { tags: { tourism: "hotel" } }))).eligible).toBe(false);
    expect(eligibility(entity(rec("n2", "osm", null, { tags: { historic: "monument" } }))).eligible).toBe(false);
  });

  it("projects publishable entities with category, labels, and sourceRecordIds", () => {
    const e = entity(rec("n1", "osm", "Церковь Покрова", { tags: { building: "church", amenity: "place_of_worship" } }));
    const { published, excluded } = projectNearventure([e]);
    expect(published).toHaveLength(1);
    expect(published[0].category).toBe("religion");
    expect(published[0].categoryLabel).toBe(CATEGORY_LABELS.religion.label);
    expect(published[0].sourceRecordIds).toEqual(["n1"]);
    expect(excluded).toHaveLength(0);
  });
});
