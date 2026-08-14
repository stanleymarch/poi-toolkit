import { describe, it, expect } from "vitest";
import { buildAddressIndex, matchAddress, addressKey, canonicalStreet, canonicalHouse } from "../src/index.js";
import { SourceRecordSchema } from "@poi-toolkit/core";
import type { SourceRecord } from "@poi-toolkit/core";

function osmRec(id: string, tags: Record<string, string>, geometry: unknown): SourceRecord {
  return SourceRecordSchema.parse({
    id, source: "osm", sourceId: id.replace("osm:", ""),
    capturedAt: "2026-01-01T00:00:00Z", rawRef: "test",
    name: tags.name ?? null, address: tags["addr:full"] ?? tags["addr:street"] ?? null,
    geometry: geometry as SourceRecord["geometry"],
    fields: { tags }, license: null,
  });
}

const POINT = (lon: number, lat: number) => ({ type: "Point" as const, coordinates: [lon, lat] as [number, number] });
const POLYGON = (coords: number[][]) => ({ type: "Polygon" as const, coordinates: [coords] });

describe("addressKey canonicalisation", () => {
  it("canonicalises street prefixes and suffixes", () => {
    expect(canonicalStreet("ул. Спасская")).toBe("спасская");
    expect(canonicalStreet("Спасская улица")).toBe("спасская");
    expect(canonicalStreet("Спасская ул.")).toBe("спасская");
    expect(canonicalStreet("проспект Ленина")).toBe("ленина");
  });

  it("canonicalises house numbers", () => {
    expect(canonicalHouse("67")).toBe("67");
    expect(canonicalHouse("д. 67")).toBe("67");
    expect(canonicalHouse("67Д")).toBe("67д");
  });

  it("builds lookup key from city, street, house", () => {
    expect(addressKey("Киров", "ул. Спасская", "67")).toBe("киров|спасская|67");
    expect(addressKey("г. Киров", "Спасская улица", "д. 67")).toBe("киров|спасская|67");
    expect(addressKey(null, "Спасская", "67")).toBe("_|спасская|67");
    expect(addressKey("Киров", null, "67")).toBeNull();
  });
});

describe("buildAddressIndex", () => {
  it("indexes only features with addr:housenumber AND addr:street", () => {
    const records = [
      osmRec("osm:w1", { "addr:housenumber": "67", "addr:street": "Спасская улица", "addr:city": "Киров", building: "yes", name: "Вятское реальное училище" }, POLYGON([[49.66, 58.60], [49.67, 58.60], [49.67, 58.61], [49.66, 58.61], [49.66, 58.60]])),
      osmRec("osm:n1", { "addr:housenumber": "67", "addr:street": "Спасская улица", amenity: "restaurant", name: "Куркума" }, POINT(49.6603, 58.6019)),
      osmRec("osm:n2", { name: "Без адреса" }, POINT(49.66, 58.60)),
    ];
    const index = buildAddressIndex(records);
    // Both addressed records should be indexed (building + restaurant)
    const allEntries = [...index.values()].flat();
    expect(allEntries.length).toBe(2);
    expect(allEntries.filter((e) => e.isBuilding)).toHaveLength(1);
    expect(allEntries.filter((e) => !e.isBuilding)).toHaveLength(1);
  });
});

describe("matchAddress — building preference", () => {
  // The Халтурин case: building polygon + restaurant at same address
  const records = [
    // Building polygon with address
    osmRec("osm:w1", { "addr:housenumber": "67", "addr:street": "Спасская улица", "addr:city": "Киров", building: "yes", name: "Вятское реальное училище" },
      POLYGON([[49.6600, 58.6018], [49.6605, 58.6018], [49.6605, 58.6022], [49.6600, 58.6022], [49.6600, 58.6018]])),
    // Restaurant at same address (NO building tag)
    osmRec("osm:n1", { "addr:housenumber": "67", "addr:street": "Спасская улица", "addr:city": "Киров", amenity: "restaurant", name: "Куркума" },
      POINT(49.6603, 58.6019)),
  ];
  const index = buildAddressIndex(records);

  it("prefers building polygon over restaurant POI", () => {
    const result = matchAddress(index, "Киров", "ул. Спасская", "67", "Здание Вятского реального училища");
    expect(result.matched).toBe(true);
    expect(result.entry?.isBuilding).toBe(true);
    expect(result.entry?.osmId).toBe("w1");
    expect(result.entry?.name).toBe("Вятское реальное училище");
  });

  it("matches building without expected name when single building", () => {
    const result = matchAddress(index, "Киров", "ул. Спасская", "67", null);
    expect(result.matched).toBe(true);
    expect(result.entry?.isBuilding).toBe(true);
  });

  it("does NOT match different corpus (67 vs 67кД)", () => {
    // Фантазариум is at 67 кД — different address key
    const result = matchAddress(index, "Киров", "ул. Спасская", "67кД", null);
    expect(result.matched).toBe(false);
    expect(result.reason).toContain("not in OSM index");
  });

  it("rejects address with only non-building entries", () => {
    const businessOnly = buildAddressIndex([
      osmRec("osm:n1", { "addr:housenumber": "99", "addr:street": "Тестовая", "addr:city": "Киров", amenity: "cafe", name: "Кафе" }, POINT(49.66, 58.60)),
    ]);
    const result = matchAddress(businessOnly, "Киров", "Тестовая", "99", null);
    expect(result.matched).toBe(false);
    expect(result.reason).toContain("non-building");
  });

  it("reports ambiguous when multiple buildings at same address without name", () => {
    const ambiguous = buildAddressIndex([
      osmRec("osm:w1", { "addr:housenumber": "10", "addr:street": "Ленина", "addr:city": "Киров", building: "yes" }, POINT(49.66, 58.60)),
      osmRec("osm:w2", { "addr:housenumber": "10", "addr:street": "Ленина", "addr:city": "Киров", building: "yes" }, POINT(49.67, 58.61)),
    ]);
    const result = matchAddress(ambiguous, "Киров", "Ленина", "10", null);
    expect(result.matched).toBe(false);
    expect(result.ambiguous).toBe(true);
  });

  it("disambiguates by name when multiple buildings", () => {
    const named = buildAddressIndex([
      osmRec("osm:w1", { "addr:housenumber": "10", "addr:street": "Ленина", "addr:city": "Киров", building: "yes", name: "Дом купца" }, POINT(49.66, 58.60)),
      osmRec("osm:w2", { "addr:housenumber": "10", "addr:street": "Ленина", "addr:city": "Киров", building: "yes", name: "Магазин" }, POINT(49.67, 58.61)),
    ]);
    const result = matchAddress(named, "Киров", "Ленина", "10", "Дом купца");
    expect(result.matched).toBe(true);
    expect(result.entry?.name).toBe("Дом купца");
  });
});
