import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SourceRecordSchema } from "@poi-toolkit/core";
import { resolveRecords } from "../src/index.js";

const fixture = async () => JSON.parse(await readFile(new URL("../../../fixtures/resolver/regression.json", import.meta.url), "utf8"))
  .map((row: unknown) => SourceRecordSchema.parse(row));
describe("evidence-first resolver", () => {
  it("accepts only exact identifier policies", async () => {
    const result = resolveRecords(await fixture());
    expect(result.candidates.filter((item) => item.decision === "accepted").map((item) => item.rule.id)).toEqual(expect.arrayContaining([
      "osm-wikidata-tag", "egrkn-osm-ref", "wikivoyage-wikidata-wdid",
    ]));
    expect(result.candidates.filter((item) => item.rule.id === "egrkn-osm-evidence")).not.toContainEqual(expect.objectContaining({ decision: "accepted" }));
  });
  it("rejects known false type matches and unsafe geometry while retaining complex many-to-many candidates", async () => {
    const result = resolveRecords(await fixture());
    const falseCandidates = result.candidates.filter((item) => item.sourceRecordIds.includes("egrkn:100") && ["osm:n2", "osm:n3", "osm:n4", "osm:n5"].some((id) => item.sourceRecordIds.includes(id)));
    expect(falseCandidates).toHaveLength(4);
    expect(falseCandidates.every((item) => item.decision === "rejected" && item.relation === "different")).toBe(true);
    const complex = result.candidates.filter((item) => item.sourceRecordIds.includes("egrkn:200") && item.decision === "pending");
    expect(complex).toHaveLength(2);
    expect(complex.every((item) => item.relation === "contains")).toBe(true);
    expect(result.candidates.find((item) => item.sourceRecordIds.includes("egrkn:300"))?.autoLinkClass).toBe("unsafe-geometry");
  });
  it("records deterministic competing-candidate counts and score margins", async () => {
    const result = resolveRecords(await fixture());
    const sameName = result.candidates.find((item) => item.sourceRecordIds.includes("egrkn:400") && item.sourceRecordIds.includes("osm:w1"));
    expect(sameName?.decision).toBe("pending");
    expect(sameName?.featureVector.competingCandidateCount).toBeGreaterThan(1);
    expect(sameName?.featureVector.scoreMargin).toBeGreaterThan(0);
  });

  it("auto-accepts a high-confidence fuzzy match (name≥0.85, ≤30m, type match) as same", () => {
    const egrkn = SourceRecordSchema.parse({ id: "egrkn:500", source: "egrkn", sourceId: "500", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Церковь Покрова", address: "г. Киров, ул. Ленина, д. 1", geometry: { type: "Point", coordinates: [49.66, 58.60] }, fields: { objectType: "Церковь", addressClassification: "exact", nativeGeometryClassification: "object" }, license: null });
    const osm = SourceRecordSchema.parse({ id: "osm:n500", source: "osm", sourceId: "n500", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Церковь Покрова", address: null, geometry: { type: "Point", coordinates: [49.66001, 58.60001] }, fields: { tags: { building: "church", amenity: "place_of_worship", name: "Церковь Покрова" } }, license: null });
    const result = resolveRecords([egrkn, osm]);
    const candidate = result.candidates.find((c) => c.sourceRecordIds.includes("egrkn:500") && c.sourceRecordIds.includes("osm:n500"));
    expect(candidate?.decision).toBe("accepted");
    expect(candidate?.relation).toBe("same");
    expect(candidate?.autoLinkClass).toBe("high-confidence-fuzzy");
  });

  it("merges Osmium's derived area with its source closed way by stable ID", () => {
    const way = SourceRecordSchema.parse({ id: "osm:w504387753", source: "osm", sourceId: "w504387753", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Церковь", address: null, geometry: { type: "LineString", coordinates: [[49.66, 58.6], [49.661, 58.6], [49.66, 58.6]] }, fields: { tags: { amenity: "place_of_worship", name: "Церковь" } }, license: null });
    const area = SourceRecordSchema.parse({ id: "osm:a1008775506", source: "osm", sourceId: "a1008775506", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Церковь", address: null, geometry: { type: "Polygon", coordinates: [[[49.66, 58.6], [49.661, 58.6], [49.66, 58.6]]] }, fields: { tags: { amenity: "place_of_worship", name: "Церковь" } }, license: null });
    const candidate = resolveRecords([way, area]).candidates.find((c) => c.rule.id === "osm-area-way-identity");
    expect(candidate).toMatchObject({ decision: "accepted", relation: "same" });
  });

  it("merges a distinctive Wikivoyage venue with its OSM POI after a descriptive prefix", () => {
    const wikivoyage = SourceRecordSchema.parse({ id: "wikivoyage:kirov:1", source: "wikivoyage", sourceId: "kirov:1", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Арт-пространство «Фантазариум»", address: null, geometry: { type: "Point", coordinates: [49.66016, 58.60214] }, fields: {}, license: null });
    const osm = SourceRecordSchema.parse({ id: "osm:n13399414501", source: "osm", sourceId: "n13399414501", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Фантазариум", address: null, geometry: { type: "Point", coordinates: [49.6602834, 58.6023191] }, fields: { tags: { tourism: "gallery", name: "Фантазариум" } }, license: null });
    const candidate = resolveRecords([wikivoyage, osm]).candidates.find((c) => c.rule.id === "wikivoyage-osm-venue-name-proximity");
    expect(candidate).toMatchObject({ decision: "accepted", relation: "same", sourceRecordIds: ["osm:n13399414501", "wikivoyage:kirov:1"] });
  });

  it("repairs the corroborated Slobodskoy chapel identity without weakening fuzzy proximity", () => {
    const egrkn = SourceRecordSchema.parse({ id: "egrkn:431410176090006", source: "egrkn", sourceId: "431410176090006", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "egrkn#24", name: "Часовня - ротонда Иоанна Предтечи", address: "Слободской, Советская, 98", geometry: { type: "Point", coordinates: [50.18731408465456, 58.721410418682204] }, fields: { objectType: "Памятник", addressClassification: "structured", nativeGeometryClassification: "object" }, license: null });
    const osm = SourceRecordSchema.parse({ id: "osm:a1285849270", source: "osm", sourceId: "a1285849270", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "osm#126736", name: "Часовня Ионна Предтечи", address: null, geometry: { type: "Polygon", coordinates: [[[50.1855414, 58.7225378], [50.1857232, 58.7225328], [50.1855414, 58.7225378]]] }, fields: { tags: { building: "yes", historic: "wayside_shrine", religion: "christian" } }, license: null });
    const wikivoyage = SourceRecordSchema.parse({ id: "wikivoyage:Слободской:684961:21", source: "wikivoyage", sourceId: "Слободской:684961:21", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "wikivoyage#21", name: "Часовня-ротонда Иоанна Предтечи", address: null, geometry: { type: "Point", coordinates: [50.18563, 58.72253] }, fields: { page: "Слободской" }, license: null });
    const church = SourceRecordSchema.parse({ id: "osm:a2421057330", source: "osm", sourceId: "a2421057330", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "osm#144144", name: null, address: "Советская улица, 98", geometry: { type: "Polygon", coordinates: [[[50.18686, 58.7214245], [50.1879437, 58.7213896], [50.18686, 58.7214245]]] }, fields: { tags: { amenity: "place_of_worship", religion: "christian", "addr:housenumber": "98" } }, license: null });
    const result = resolveRecords([egrkn, osm, wikivoyage, church]);
    const curated = result.candidates.filter((candidate) => candidate.rule.id === "curated-source-identity");
    expect(curated).toHaveLength(2);
    expect(curated.every((candidate) => candidate.decision === "accepted" && candidate.relation === "same" && candidate.autoLinkClass === "curated-identity")).toBe(true);
    expect(curated.flatMap((candidate) => candidate.sourceRecordIds)).toEqual(expect.arrayContaining([egrkn.id, osm.id, wikivoyage.id]));
    expect(result.candidates.some((candidate) => candidate.sourceRecordIds.includes(egrkn.id) && candidate.sourceRecordIds.includes(church.id) && candidate.decision === "accepted")).toBe(false);

    const incomplete = resolveRecords([egrkn]);
    expect(incomplete.candidates.some((candidate) => candidate.rule.id === "curated-source-identity")).toBe(false);
  });

  it("links Wikivoyage listing with a closed-way OSM (area+way representations)", () => {
    // A Wikivoyage listing at a closed way that Osmium exports as both
    // w<ID> (LineString) and a<2×ID> (Polygon). The area-way identity must
    // link first, then the Wikivoyage proximity loop sees only the deduplicated
    // way and creates a correct venue link — both candidates present.
    const listing = SourceRecordSchema.parse({ id: "wikivoyage:test:1", source: "wikivoyage", sourceId: "test:1", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Культурное пространство «Фантазариум»", address: null, geometry: { type: "Point", coordinates: [49.6602, 58.6023] }, fields: {}, license: null });
    const way = SourceRecordSchema.parse({ id: "osm:w504387753", source: "osm", sourceId: "w504387753", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Фантазариум", address: null, geometry: { type: "LineString", coordinates: [[49.6601, 58.6022], [49.6604, 58.6022], [49.6604, 58.6025], [49.6601, 58.6025], [49.6601, 58.6022]] }, fields: { tags: { tourism: "gallery", name: "Фантазариум" } }, license: null });
    const area = SourceRecordSchema.parse({ id: "osm:a1008775506", source: "osm", sourceId: "a1008775506", capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name: "Фантазариум", address: null, geometry: { type: "Polygon", coordinates: [[[49.6601, 58.6022], [49.6604, 58.6022], [49.6604, 58.6025], [49.6601, 58.6025], [49.6601, 58.6022]]] }, fields: { tags: { tourism: "gallery", name: "Фантазариум" } }, license: null });
    const result = resolveRecords([listing, way, area]);
    const areaWay = result.candidates.find((c) => c.rule.id === "osm-area-way-identity");
    const venueLink = result.candidates.find((c) => c.rule.id === "wikivoyage-osm-venue-name-proximity");
    expect(areaWay).toMatchObject({ decision: "accepted", relation: "same", sourceRecordIds: ["osm:a1008775506", "osm:w504387753"] });
    expect(venueLink).toMatchObject({ decision: "accepted", relation: "same", sourceRecordIds: ["osm:w504387753", "wikivoyage:test:1"] });
  });
});
