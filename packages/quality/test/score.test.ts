import { describe, expect, it } from "vitest";
import { scoreRelease, type ScoreableEntity } from "../src/score.js";

const e = (overrides: Partial<ScoreableEntity> = {}): ScoreableEntity => ({
  category: "heritage", name: "Test", geometry: { type: "Point", coordinates: [49, 58] },
  geometryPolicy: "osm", photo: null, description: null, descriptionLicense: null,
  heritage: false, sourceRecordIds: ["osm:n1"], ...overrides,
});

describe("quality score", () => {
  it("scores a fully-enriched dataset higher than a bare one", () => {
    const bare = scoreRelease([e(), e(), e()], { nearDuplicates: 0, excludedCount: 0 });
    const enriched = scoreRelease([
      e({ photo: { license: "CC0", attribution: "Wikidata" }, description: "desc", descriptionLicense: "CC0", sourceRecordIds: ["osm:n1", "wikidata:Q1"] }),
      e({ photo: { license: "CC0", attribution: "Wikidata" }, description: "desc", descriptionLicense: "CC0", heritage: true }),
      e({ description: "desc", descriptionLicense: "ODbL", sourceRecordIds: ["osm:n2", "egrkn:1"] }),
    ], { nearDuplicates: 0, excludedCount: 0 });
    expect(enriched.overall).toBeGreaterThan(bare.overall);
    expect(enriched.coverage.photoPct).toBeGreaterThan(bare.coverage.photoPct);
  });

  it("penalizes near-duplicates", () => {
    const clean = scoreRelease([e(), e(), e()], { nearDuplicates: 0, excludedCount: 0 });
    const duppy = scoreRelease([e(), e(), e()], { nearDuplicates: 1, excludedCount: 0 });
    expect(duppy.dimensions.find((d) => d.name === "dedup-quality")!.score).toBeLessThan(clean.dimensions.find((d) => d.name === "dedup-quality")!.score);
  });

  it("requires photo attribution for provenance score", () => {
    const withAttr = scoreRelease([e({ photo: { license: "CC0", attribution: "X" } })], { nearDuplicates: 0, excludedCount: 0 });
    const withoutAttr = scoreRelease([e({ photo: { license: "", attribution: "" } })], { nearDuplicates: 0, excludedCount: 0 });
    expect(withAttr.dimensions.find((d) => d.name === "provenance-completeness")!.score).toBeGreaterThan(withoutAttr.dimensions.find((d) => d.name === "provenance-completeness")!.score);
  });
});
