import { describe, expect, it } from "vitest";
import { buildDispositionLedger } from "../src/disposition.js";
import type { SourceRecord } from "@poi-toolkit/core";

const norm = (id: string, overrides: Partial<SourceRecord> = {}): SourceRecord => ({
  id, source: "egrkn", sourceId: id.replace("egrkn:", ""),
  capturedAt: "2026-07-01T00:00:00Z", rawRef: "raw/egrkn.ndjson#1",
  name: "Здание", address: "Кировская область, г. Слободской, ул. Ленина, 1",
  fields: { category: "heritage" },
  ...overrides,
});

const auditEntry = (sourceRecordId: string, accepted: boolean, outcomes: string[] = ["accepted"], provider: string = "photon") => ({
  sourceRecordId,
  address: "Кировская область, г. Слободской, ул. Ленина, 1",
  accepted,
  attempts: outcomes.map((outcome) => ({
    provider: outcome === "accepted" ? provider : provider,
    outcome,
    returnedAddress: outcome === "accepted" ? "д. 1, улица Ленина, Слободской, Россия" : null,
    confidence: outcome === "accepted" ? "high" : null,
    reason: outcome === "address-conflict" ? "house mismatch: expected 1, got 2" : null,
  })),
});

const evidenceEntry = (sourceRecordId: string, compatible: boolean = true) => ({
  sourceRecordId,
  addressCompatible: compatible,
  geometry: { type: "Point" as const, coordinates: [49.0, 58.0] as [number, number] },
});

describe("buildDispositionLedger", () => {
  it("returns native-geometry for EGRKN records without audit", () => {
    const report = buildDispositionLedger([], [], [norm("egrkn:1")]);
    expect(report.summary["native-geometry"]).toBe(1);
    expect(report.entries[0].disposition).toBe("native-geometry");
    expect(report.entries[0].isBlocking).toBe(false);
  });

  it("returns accepted for accepted audit entries", () => {
    const report = buildDispositionLedger(
      [auditEntry("egrkn:1", true)],
      [evidenceEntry("egrkn:1")],
      [norm("egrkn:1")],
    );
    expect(report.summary.accepted).toBe(1);
    expect(report.entries[0].disposition).toBe("accepted");
    expect(report.entries[0].hasEvidence).toBe(true);
  });

  it("returns quarantined-conflict for address conflicts", () => {
    const report = buildDispositionLedger(
      [auditEntry("egrkn:1", false, ["address-conflict"])],
      [],
      [norm("egrkn:1")],
    );
    expect(report.summary["quarantined-conflict"]).toBe(1);
    expect(report.entries[0].disposition).toBe("quarantined-conflict");
    expect(report.entries[0].isBlocking).toBe(false);
  });

  it("blocks quarantined-conflict with leaked geometry", () => {
    const report = buildDispositionLedger(
      [auditEntry("egrkn:1", false, ["address-conflict"])],
      [evidenceEntry("egrkn:1")],
      [norm("egrkn:1")],
    );
    const entry = report.entries.find((e) => e.sourceRecordId === "egrkn:1")!;
    expect(entry.disposition).toBe("quarantined-conflict");
    expect(entry.isBlocking).toBe(true);
    expect(report.blockingCount).toBe(1);
  });

  it("returns low-precision for street-level matches", () => {
    const report = buildDispositionLedger(
      [auditEntry("egrkn:1", false, ["low-precision"])],
      [],
      [norm("egrkn:1")],
    );
    expect(report.summary["low-precision"]).toBe(1);
    expect(report.entries[0].disposition).toBe("low-precision");
  });

  it("returns not-found when provider returned nothing", () => {
    const report = buildDispositionLedger(
      [auditEntry("egrkn:1", false, ["not-found"])],
      [],
      [norm("egrkn:1")],
    );
    expect(report.summary["not-found"]).toBe(1);
  });

  it("returns ineligible-address for non-standard address classes", () => {
    const report = buildDispositionLedger(
      [auditEntry("egrkn:1", false, ["ineligible-address"])],
      [],
      [norm("egrkn:1")],
    );
    expect(report.summary["ineligible-address"]).toBe(1);
  });

  it("returns fallback-accepted when fallback succeeded", () => {
    const report = buildDispositionLedger(
      [{
        sourceRecordId: "egrkn:1",
        address: "Кировская область, г. Слободской, ул. Ленина, 1",
        accepted: true,
        attempts: [
          { provider: "photon", outcome: "address-conflict", returnedAddress: null, confidence: null, reason: "house mismatch" },
          { provider: "nominatim", outcome: "accepted", returnedAddress: "д. 1, улица Ленина, Слободской", confidence: "high", reason: null },
        ],
      }],
      [evidenceEntry("egrkn:1")],
      [norm("egrkn:1")],
    );
    expect(report.summary["fallback-accepted"]).toBe(1);
    expect(report.entries[0].disposition).toBe("fallback-accepted");
    expect(report.entries[0].provider).toBe("nominatim");
  });

  it("handles mixed audit: accepted + quarantined + native-geometry", () => {
    const report = buildDispositionLedger(
      [
        auditEntry("egrkn:1", true),
        auditEntry("egrkn:2", false, ["address-conflict"]),
      ],
      [evidenceEntry("egrkn:1")],
      [
        norm("egrkn:1"),
        norm("egrkn:2"),
        norm("egrkn:3"),
      ],
    );
    expect(report.summary.accepted).toBe(1);
    expect(report.summary["quarantined-conflict"]).toBe(1);
    expect(report.summary["native-geometry"]).toBe(1);
    expect(report.totalRecords).toBe(3);
  });
});
