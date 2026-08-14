import type { SourceRecord } from "@poi-toolkit/core";

/**
 * P3: Disposition Ledger
 *
 * Every EGRKN source record that entered the geocoding pipeline gets a
 * documented final outcome. Records without a disposition block release
 * (missingDisposition), and quarantined coordinates must never leak into
 * evidence (leakedQuarantineGeometry).
 */

export type Disposition =
  /** Photon /structured (or /api fallback) returned house-level, address-compatible point. */
  | "accepted"
  /** Primary provider failed; explicit fallback succeeded. */
  | "fallback-accepted"
  /** Address conflict detected — coordinates quarantined, not in evidence. */
  | "quarantined-conflict"
  /** Only street/city/country level returned — insufficient precision. */
  | "low-precision"
  /** Provider returned zero results. */
  | "not-found"
  /** Address class is relative/compound/unstructured — never sent to geocoder. */
  | "ineligible-address"
  /** Provider returned an error (network, rate limit, auth). */
  | "provider-error"
  /** Record had native geometry before geocoding — no geocode attempt needed. */
  | "native-geometry";

export type DispositionEntry = {
  /** EGRKN sourceRecordId (e.g. "egrkn:431610613050005"). */
  sourceRecordId: string;
  /** Final disposition. */
  disposition: Disposition;
  /** Human-readable explanation. */
  reason: string | null;
  /** Provider that produced the final outcome (null for ineligible/native-geometry). */
  provider: "photon" | "nominatim" | "yandex" | null;
  /** Whether this record has accepted geometry in the evidence file. */
  hasEvidence: boolean;
  /** Whether this record is a blocking failure (quarantined with evidence leak = true). */
  isBlocking: boolean;
};

export type DispositionReport = {
  ruleVersion: "disposition-ledger-v1";
  builtAt: string;
  summary: Record<Disposition, number>;
  totalRecords: number;
  blockingCount: number;
  entries: DispositionEntry[];
};

// Type matching GeocodeAttempt from @poi-toolkit/geocode without importing it.
type Attempt = {
  provider: string;
  outcome: string;
  returnedAddress: string | null;
  confidence: string | null;
  reason: string | null;
  geometry?: { type: "Point"; coordinates: [number, number] } | null;
};
type AuditEntry = {
  sourceRecordId: string;
  address: string;
  accepted: boolean;
  attempts: Attempt[];
};
type EvidenceEntry = {
  sourceRecordId: string;
  addressCompatible: boolean;
  geometry?: { type: "Point"; coordinates: [number, number] };
};

function dispositionFromOutcome(outcome: string): Disposition {
  switch (outcome) {
    case "accepted": return "accepted";
    case "low-precision": return "low-precision";
    case "address-conflict": return "quarantined-conflict";
    case "not-found": return "not-found";
    case "ineligible-address": return "ineligible-address";
    case "error": return "provider-error";
    case "budget-exhausted": return "provider-error";
    default: return "provider-error";
  }
}

/**
 * Build a disposition ledger from geocode audit entries, evidence entries,
 * and normalized source records.
 *
 * Every EGRKN source record identified in the normalized data receives
 * exactly one DispositionEntry. Records that were never sent to geocoding
 * (native geometry, or beyond the call limit) are given a synthetic
 * disposition of "native-geometry".
 */
export function buildDispositionLedger(
  audit: AuditEntry[],
  evidence: EvidenceEntry[],
  normalized: SourceRecord[],
): DispositionReport {
  const now = new Date().toISOString();
  const entries: DispositionEntry[] = [];

  // Index evidence by sourceRecordId.
  const evidenceBySourceId = new Map<string, EvidenceEntry>();
  for (const ev of evidence) {
    evidenceBySourceId.set(ev.sourceRecordId, ev);
  }

  // Index audit by sourceRecordId.
  const auditBySourceId = new Map<string, AuditEntry>();
  for (const a of audit) {
    auditBySourceId.set(a.sourceRecordId, a);
  }

  // Collect all EGRKN sourceRecordIds from normalized.
  const egrknIds = new Set<string>();
  for (const norm of normalized) {
    if (norm.source === "egrkn") egrknIds.add(norm.id);
  }

  for (const sourceRecordId of egrknIds) {
    const auditEntry = auditBySourceId.get(sourceRecordId);
    const ev = evidenceBySourceId.get(sourceRecordId);

    // If there is no audit entry and no evidence, the record had native geometry
    // (or was beyond the call limit) — it was never sent to geocoding.
    if (!auditEntry) {
      entries.push({
        sourceRecordId,
        disposition: "native-geometry",
        reason: null,
        provider: null,
        hasEvidence: !!ev,
        isBlocking: false,
      });
      continue;
    }

    // Determine final outcome from the last attempt (primary + fallback).
    const attempts = auditEntry.attempts;
    const lastAttempt = attempts.at(-1);

    // Check if fallback was used (more than one attempt with a different provider).
    const hasFallback = attempts.length >= 2 && attempts[0].provider !== attempts[1].provider;
    const fallbackAccepted = hasFallback && lastAttempt?.outcome === "accepted";
    const primaryAccepted = !hasFallback && lastAttempt?.outcome === "accepted";

    let disposition: Disposition;
    if (primaryAccepted) {
      disposition = "accepted";
    } else if (fallbackAccepted) {
      disposition = "fallback-accepted";
    } else {
      disposition = dispositionFromOutcome(lastAttempt?.outcome ?? "error");
    }

    // Blocking check: quarantined-conflict records whose coordinates appear in evidence.
    const isBlocking = disposition === "quarantined-conflict" && !!ev?.geometry;

    // Build a human-readable reason summary.
    let reason: string | null = null;
    if (attempts.length === 1) {
      const a = attempts[0];
      reason = a.reason || a.outcome;
    } else {
      const parts = attempts.map((a) => `${a.provider}:${a.outcome}${a.reason ? `(${a.reason})` : ""}`);
      reason = parts.join(" → ");
    }

    entries.push({
      sourceRecordId,
      disposition,
      reason,
      provider: lastAttempt?.provider as DispositionEntry["provider"] ?? null,
      hasEvidence: !!ev,
      isBlocking,
    });
  }

  // Summary.
  const summary: Record<Disposition, number> = {
    accepted: 0, "fallback-accepted": 0, "quarantined-conflict": 0,
    "low-precision": 0, "not-found": 0, "ineligible-address": 0,
    "provider-error": 0, "native-geometry": 0,
  };
  for (const e of entries) {
    summary[e.disposition] = (summary[e.disposition] ?? 0) + 1;
  }

  return {
    ruleVersion: "disposition-ledger-v1",
    builtAt: now,
    summary,
    totalRecords: entries.length,
    blockingCount: entries.filter((e) => e.isBlocking).length,
    entries,
  };
}
