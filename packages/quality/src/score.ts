// Quality scoring is source-agnostic: it works on any entity shape with these fields.
export type ScoreableEntity = {
  category: string; name: string | null; geometry: unknown;
  geometryPolicy: string; photo: { license: string; attribution: string } | null;
  description: string | null; descriptionLicense: string | null;
  heritage: boolean; sourceRecordIds: string[];
  region: string | null;
};

export const QUALITY_RULE_VERSION = "quality-score-v1";

export type QualityDimension = { name: string; weight: number; score: number; detail: Record<string, number | string> };

/** Compute a 0–100 quality score for a release, broken into weighted dimensions. */
export function scoreRelease(entities: ScoreableEntity[], context: { nearDuplicates: number; excludedCount: number }): { overall: number; dimensions: QualityDimension[]; coverage: Record<string, number> } {
  const withRegion = entities.filter((e) => e.region).length;
  // Score: structural + enrichment + link + provenance + hierarchy.
  const total = entities.length || 1;

  // 1. Structural integrity (20%): every entity has valid category, name, geometry.
  const validCategory = entities.filter((e) => ["heritage", "monument", "sights", "religion", "nature", "museum"].includes(e.category)).length;
  const hasName = entities.filter((e) => e.name?.trim()).length;
  const hasGeometry = entities.filter((e) => e.geometry).length;
  const structural = (validCategory / total + hasName / total + hasGeometry / total) / 3 * 100;

  // 2. Enrichment coverage (20%): photo + description + cross-source enrichment.
  const withPhoto = entities.filter((e) => e.photo).length;
  const withDescription = entities.filter((e) => e.description).length;
  const withBoth = entities.filter((e) => e.photo && e.description).length;
  const withHeritage = entities.filter((e) => e.heritage).length;
  const multiSource = entities.filter((e) => e.sourceRecordIds.length > 1).length;
  const enrichment = (withPhoto / total * 0.35 + withDescription / total * 0.35 + withBoth / total * 0.15 + multiSource / total * 0.15) * 100;

  // 3. Link confidence (15%): how were entities linked? (geometryPolicy)
  const osmAnchored = entities.filter((e) => e.geometryPolicy === "osm").length;
  const verified = entities.filter((e) => e.geometryPolicy === "verified-source").length;
  const confidence = Math.min(100, (osmAnchored / total * 70 + verified / total * 30));

  // 4. Provenance completeness (15%): photos with attribution, descriptions with license.
  const photoAttributed = entities.filter((e) => e.photo && e.photo.license && e.photo.attribution).length;
  const descLicensed = entities.filter((e) => e.description && e.descriptionLicense).length;
  const provenance = ((withPhoto ? photoAttributed / withPhoto : 1) * 0.5 + (withDescription ? descLicensed / withDescription : 1) * 0.5) * 100;

  // 5. Hierarchy coverage (15%): region assignment completeness.
  const hierarchy = { withRegion };
  const hierarchyScore = (withRegion / total) * 100;

  // 6. Dedup quality (15%): 1 - containment-duplicate rate.
  const dupRate = context.nearDuplicates / total;
  const dedup = Math.max(0, (1 - dupRate) * 100);

  const dimensions: QualityDimension[] = [
    { name: "structural-integrity", weight: 20, score: Math.round(structural), detail: { validCategory, hasName, hasGeometry, total: entities.length } },
    { name: "enrichment-coverage", weight: 20, score: Math.round(enrichment), detail: { withPhoto, withDescription, withBoth, withHeritage, multiSource } },
    { name: "link-confidence", weight: 15, score: Math.round(confidence), detail: { osmAnchored, verifiedSource: verified } },
    { name: "provenance-completeness", weight: 15, score: Math.round(provenance), detail: { photoAttributed, descLicensed } },
    { name: "hierarchy-coverage", weight: 15, score: Math.round(hierarchyScore), detail: { ...hierarchy, total: entities.length, regionCoveragePct: Math.round(withRegion / total * 100) } },
    { name: "dedup-quality", weight: 15, score: Math.round(dedup), detail: { nearDuplicates: context.nearDuplicates, excluded: context.excludedCount } },
  ];
  const overall = Math.round(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / dimensions.reduce((sum, d) => sum + d.weight, 0));
  const coverage = { photoPct: Math.round(withPhoto / total * 100), descriptionPct: Math.round(withDescription / total * 100), bothPct: Math.round(withBoth / total * 100), heritagePct: Math.round(withHeritage / total * 100), multiSourcePct: Math.round(multiSource / total * 100), regionPct: Math.round(withRegion / total * 100) };
  return { overall, dimensions, coverage };
}
