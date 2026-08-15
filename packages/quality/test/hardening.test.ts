import { describe, expect, it } from "vitest";
import { auditReleaseHardening, type HardenedEntity } from "../src/hardening.js";
import { buildDispositionLedger } from "../src/disposition.js";

const entity = (overrides: Partial<HardenedEntity> = {}): HardenedEntity => ({
  id: "entity:1", name: "Озеро", category: "nature", geometry: { type: "Point", coordinates: [49, 58] }, photo: null, sourceRecordIds: ["osm:n1"], ...overrides,
});

describe("release hardening gates", () => {
  it("accepts a clean OSM nature entity", () => {
    expect(auditReleaseHardening([entity()]).blockingFailures).toEqual([]);
  });

  it("blocks registry museums without photos, standalone wikivoyage nature, food and junk", () => {
    const report = auditReleaseHardening([
      entity({ id: "museum", name: "Музей", category: "museum", sourceRecordIds: ["mkrf:1"] }),
      entity({ id: "nature", name: "Агроботсад", sourceRecordIds: ["wikivoyage:Киров:1"] }),
      entity({ id: "food", name: "Смена Пицца", category: "sights", sourceRecordIds: ["wikivoyage:Киров:2"] }),
      entity({ id: "junk", name: "А", category: "sights" }),
    ], { addressBuildingConflicts: 1 });
    expect(report.counts).toMatchObject({ registryMuseumWithoutPhoto: 1, standaloneWikivoyageNature: 1, foodServiceListings: 1, junkNames: 1, addressBuildingConflicts: 1 });
    expect(report.blockingFailures).toHaveLength(5);
  });

  it("blocks release when accepted geocode evidence has no complete audit", () => {
    const report = auditReleaseHardening([entity()], { geocodeAuditFailures: 1 });
    expect(report.counts.geocodeAuditFailures).toBe(1);
    expect(report.blockingFailures).toContain("geocodeAuditFailures: 1");
  });

  it("reports unassigned subject regions as warning not blocker", () => {
    const report = auditReleaseHardening([entity()], { unassignedSubjectRegions: 1 });
    expect(report.counts.unassignedSubjectRegions).toBe(1);
    expect(report.blockingFailures).not.toContain("unassignedSubjectRegions: 1");
  });

  it("reports subject region conflicts as warning not blocker", () => {
    const report = auditReleaseHardening([entity()], { subjectRegionConflicts: 1 });
    expect(report.counts.subjectRegionConflicts).toBe(1);
    expect(report.blockingFailures).not.toContain("subjectRegionConflicts: 1");
  });

  it("blocks a specific same-name duplicate within 30 metres but not generic houses", () => {
    const dup = auditReleaseHardening([
      entity({ id: "a", name: "Троицкая церковь", category: "religion" }),
      entity({ id: "b", name: "Троицкая церковь", category: "religion", geometry: { type: "Point", coordinates: [49.0001, 58] } }),
    ]);
    expect(dup.counts.specificNearDuplicates).toBe(1);
    const generic = auditReleaseHardening([
      entity({ id: "a", name: "Дом жилой", category: "heritage" }),
      entity({ id: "b", name: "Дом жилой", category: "heritage", geometry: { type: "Point", coordinates: [49.0001, 58] } }),
    ]);
    expect(generic.counts.specificNearDuplicates).toBe(0);
  });
});

describe("release hardening gates — disposition", () => {
  it("reports missingDisposition for EGRKN entities not in disposition ledger", () => {
    const report = auditReleaseHardening([
      entity({ id: "e1", sourceRecordIds: ["egrkn:1"] }),
    ]);
    expect(report.counts.missingDisposition).toBe(1);
    expect(report.blockingFailures).toContain("missingDisposition: 1");
  });

  it("reports 0 missingDisposition when disposition covers all entities", () => {
    const disp = buildDispositionLedger(
      [],
      [],
      [{ id: "egrkn:1", source: "egrkn", sourceId: "1", capturedAt: "", rawRef: "", name: "", fields: {} }],
    );
    const report = auditReleaseHardening([
      entity({ id: "e1", sourceRecordIds: ["egrkn:1"] }),
    ], { disposition: disp });
    expect(report.counts.missingDisposition).toBe(0);
  });

  it("blocks on leakedQuarantineGeometry when quarantine evidence leaks", () => {
    const disp = buildDispositionLedger(
      [{ sourceRecordId: "egrkn:1", address: "addr", accepted: false, attempts: [{ provider: "photon", outcome: "address-conflict", returnedAddress: null, confidence: null, reason: "house mismatch", geometry: { type: "Point", coordinates: [49, 58] } }] }],
      [{ sourceRecordId: "egrkn:1", addressCompatible: false, geometry: { type: "Point", coordinates: [49, 58] } }],
      [{ id: "egrkn:1", source: "egrkn", sourceId: "1", capturedAt: "", rawRef: "", name: "", fields: {} }],
    );
    expect(disp.blockingCount).toBeGreaterThan(0);
    const report = auditReleaseHardening([
      entity({ id: "e1", sourceRecordIds: ["egrkn:1"] }),
    ], { disposition: disp });
    expect(report.counts.leakedQuarantineGeometry).toBe(1);
    expect(report.blockingFailures).toContain("leakedQuarantineGeometry: 1");
  });

  it("regression: blocks museum name in sights category (Васнецовs bug)", () => {
    const museum = entity({ id: "e1", name: "Вятский художественный музей им. Васнецовых", category: "sights" });
    const report = auditReleaseHardening([museum]);
    expect(report.counts.museumCategoryMismatch).toBe(1);
    expect(report.blockingFailures).toContain("museumCategoryMismatch: 1");
  });

  it("does NOT block museum in museum category", () => {
    const museum = entity({ id: "e1", name: "Музей космонавтики", category: "museum" });
    const report = auditReleaseHardening([museum]);
    expect(report.counts.museumCategoryMismatch).toBe(0);
  });

  it("does NOT block museum in heritage category (house-museum)", () => {
    const house = entity({ id: "e1", name: "Дом-музей Ленина", category: "heritage" });
    const report = auditReleaseHardening([house]);
    expect(report.counts.museumCategoryMismatch).toBe(0);
  });
});
