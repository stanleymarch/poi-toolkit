import { describe, expect, it } from "vitest";
import { SourceRecordSchema } from "@poi-toolkit/core";
import { assignSubjectBoundary, findContainedCandidates, findExactCrossSourceCandidates, parseBuildingAddress, validateBuildingAddress } from "../src/index.js";

const record = (id: string, name: string, geometry: unknown, tags: Record<string, string> = {}) =>
  SourceRecordSchema.parse({ id, source: "osm", sourceId: id.slice(4), capturedAt: "2026-07-19T00:00:00.000Z", rawRef: "test", name, address: null, geometry, fields: { tags }, license: "ODbL" });

const building = (id: string, name: string) => record(id, name, {
  type: "LineString", coordinates: [[49, 58], [49.001, 58], [49.001, 58.001], [49, 58.001], [49, 58]],
}, { building: "yes" });

const point = (id: string, name: string, coordinates: [number, number]) => record(id, name, { type: "Point", coordinates }, { tourism: "museum" });

describe("building address safety", () => {
  it("preserves letter, corpus and structure in the address fingerprint", () => {
    expect(parseBuildingAddress("г. Киров, ул. Ленина, д. 10 лит. А, корп. 2, стр. 3")).toMatchObject({ street: "ленина", house: "10", letter: "а", corpus: "2", structure: "3" });
    expect(parseBuildingAddress("Ново-Садовая улица, 154")).toMatchObject({ street: "ново-садовая", house: "154" });
  });

  it("rejects a geocoder result that drops a required letter", () => {
    const result = validateBuildingAddress("г. Киров, ул. Ленина, д. 10 литера А", "Киров, улица Ленина, дом 10");
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain("letter mismatch");
  });

  it("accepts the same house with its matching letter", () => {
    expect(validateBuildingAddress("ул. Ленина, д. 10А", "Киров, ул. Ленина, дом 10 литера А").compatible).toBe(true);
  });

  it("rejects an unrequested compact corpus such as 67 кД", () => {
    expect(parseBuildingAddress("д. 67 кД")).toMatchObject({ house: "67", corpus: "д" });
    const result = validateBuildingAddress("г. Киров, ул. Спасская, д. 67", "д. 67 кД, Спасская улица, Киров");
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain("corpus mismatch");
  });
});

describe("PFO subject containment", () => {
  const boundaries = [
    { id: "subject:a", region: "Регион А", geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } },
    { id: "subject:b", region: "Регион Б", geometry: { type: "MultiPolygon" as const, coordinates: [[[[3, 3], [5, 3], [5, 5], [3, 5], [3, 3]]]] } },
  ];

  it("assigns a point only when contained by a canonical subject polygon", () => {
    expect(assignSubjectBoundary({ type: "Point", coordinates: [1, 1] }, boundaries)).toMatchObject({ region: "Регион А", boundaryId: "subject:a" });
    expect(assignSubjectBoundary({ type: "Point", coordinates: [4, 4] }, boundaries)).toMatchObject({ region: "Регион Б", boundaryId: "subject:b" });
    expect(assignSubjectBoundary({ type: "Point", coordinates: [8, 8] }, boundaries)).toMatchObject({ region: null, boundaryId: null });
  });

  it("uses an interior point for a concave polygon instead of its vertex mean", () => {
    const cShape = { type: "Polygon" as const, coordinates: [[[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [4, 3], [4, 4], [0, 4], [0, 0]]] };
    const assignment = assignSubjectBoundary(cShape, [{ id: "c", region: "C", geometry: cShape }]);
    expect(assignment).toMatchObject({ region: "C", boundaryId: "c" });
  });
});

describe("cross-source identity dedup", () => {
  it("merges an OSM anchor and exact-name registry record within 30m", () => {
    const osm = record("osm:n1", "Троицкая церковь", { type: "Point", coordinates: [49, 58] }, { amenity: "place_of_worship" });
    const registry = SourceRecordSchema.parse({ id: "egrkn:1", source: "egrkn", sourceId: "1", capturedAt: "2026-07-19T00:00:00.000Z", rawRef: "test", name: "Троицкая церковь", address: null, geometry: { type: "Point", coordinates: [49.0001, 58] }, fields: {}, license: "test" });
    expect(findExactCrossSourceCandidates([osm, registry])).toEqual([expect.objectContaining({ decision: "accepted", sourceRecordIds: ["egrkn:1", "osm:n1"] })]);
  });

  it("uses only address-compatible house-level geocode for geometry-less registry records", () => {
    const osm = record("osm:n1", "Дом купца", { type: "Point", coordinates: [49, 58] }, { historic: "building" });
    const registry = SourceRecordSchema.parse({ id: "egrkn:1", source: "egrkn", sourceId: "1", capturedAt: "2026-07-19T00:00:00.000Z", rawRef: "test", name: "Дом купца", address: "ул. Ленина, д. 10", geometry: null, fields: {}, license: "test" });
    const evidence = new Map([["egrkn:1", { geometry: { type: "Point" as const, coordinates: [49.0001, 58] as [number, number] }, confidence: "high", addressCompatible: true }]]);
    expect(findExactCrossSourceCandidates([osm, registry], evidence)).toHaveLength(1);
    evidence.set("egrkn:1", { geometry: { type: "Point", coordinates: [49.0001, 58] }, confidence: "high", addressCompatible: false });
    expect(findExactCrossSourceCandidates([osm, registry], evidence)).toEqual([]);
  });

  it("does not merge records with conflicting house letters", () => {
    const osm = SourceRecordSchema.parse({ id: "osm:n1", source: "osm", sourceId: "n1", capturedAt: "2026-07-19T00:00:00.000Z", rawRef: "test", name: "Дом купца", address: "ул. Ленина, д. 10Б", geometry: { type: "Point", coordinates: [49, 58] }, fields: {}, license: "test" });
    const registry = SourceRecordSchema.parse({ id: "egrkn:1", source: "egrkn", sourceId: "1", capturedAt: "2026-07-19T00:00:00.000Z", rawRef: "test", name: "Дом купца", address: "ул. Ленина, д. 10 литера А", geometry: { type: "Point", coordinates: [49.0001, 58] }, fields: {}, license: "test" });
    expect(findExactCrossSourceCandidates([osm, registry])).toEqual([]);
  });
});

describe("building-contained dedup", () => {
  it("accepts same non-generic name inside one building", () => {
    const candidates = findContainedCandidates([building("osm:w1", "Музей Вятки"), point("osm:n1", "Музей Вятки", [49.0005, 58.0005])]);
    expect(candidates).toEqual([expect.objectContaining({ sourceRecordIds: ["osm:n1", "osm:w1"], decision: "accepted" })]);
  });

  it("does not merge generic residential-building names", () => {
    expect(findContainedCandidates([building("osm:w1", "Дом жилой"), point("osm:n1", "Дом жилой", [49.0005, 58.0005])])).toEqual([]);
  });

  it("does not merge different names in the same building", () => {
    expect(findContainedCandidates([building("osm:w1", "Музей Вятки"), point("osm:n1", "Кафе Вятка", [49.0005, 58.0005])])).toEqual([]);
  });
});
