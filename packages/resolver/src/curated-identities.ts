import type { SourceRecord } from "@poi-toolkit/core";
import type { CandidateDossier } from "./index.js";

/**
 * Narrow, evidence-backed identity repairs for upstream records whose native
 * coordinate is demonstrably wrong. These are not fuzzy rules: each repair
 * requires the listed primary-source records to be present, so an incomplete
 * or newer input snapshot falls back to the conservative resolver behaviour.
 */
type CuratedIdentity = {
  sourceRecordIds: readonly string[];
  links: readonly (readonly [string, string])[];
  reason: readonly string[];
};

const CURATED_IDENTITIES: readonly CuratedIdentity[] = [
  {
    sourceRecordIds: ["egrkn:431410176090006", "osm:a1285849270"],
    links: [["egrkn:431410176090006", "osm:a1285849270"]],
    reason: [
      "curated identity repair: EGRKN's recorded point is 159m from the chapel's OSM geometry and falls beside Trinity Church",
      "use the OSM geometry; do not treat the EGRKN coordinate as the chapel location",
    ],
  },
  {
    sourceRecordIds: ["osm:a1285849270", "wikivoyage:Слободской:684961:21"],
    links: [["osm:a1285849270", "wikivoyage:Слободской:684961:21"]],
    reason: [
      "curated identity repair: retained Slobodskoy Wikivoyage listing names the chapel at the OSM geometry",
      "the OSM spelling «Ионна» and the Wikivoyage title «Иоанна» refer to the same chapel, not the nearby church or necropolis gate",
    ],
  },
];

export function curatedIdentityCandidates(records: SourceRecord[]): CandidateDossier[] {
  const ids = new Set(records.map((record) => record.id));
  const dossiers: CandidateDossier[] = [];
  for (const identity of CURATED_IDENTITIES) {
    if (!identity.sourceRecordIds.every((id) => ids.has(id))) continue;
    for (const [first, second] of identity.links) {
      const sourceRecordIds = first < second ? [first, second] : [second, first] as [string, string];
      dossiers.push({
        id: sourceRecordIds.join("~"),
        sourceRecordIds: sourceRecordIds as [string, string],
        relation: "same",
        decision: "accepted",
        rule: { id: "curated-source-identity", version: "evidence-first-v1" },
        score: null,
        featureVector: {
          geometrySafe: false,
          distanceMeters: null,
          nameSimilarity: 0,
          addressSimilarity: 0,
          typeCompatibility: 1,
          adminContext: 1,
          repeatedCentroid: false,
          relativeAddress: false,
          compoundAddress: false,
          competingCandidateCount: 0,
          scoreMargin: null,
        },
        reasons: [...identity.reason],
        autoLinkClass: "curated-identity",
      });
    }
  }
  return dossiers;
}
