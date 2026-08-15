import { type AdminHierarchy, FacetClaim } from "@poi-toolkit/core";
import { FacetPaths } from "@poi-toolkit/taxonomy";
import { SynthesizedEntity } from "@poi-toolkit/synthesis";

export const NEARVENTURE_PROFILE_VERSION = "nearventure-v1";
export const NEARVENTURE_CATEGORIES = ["heritage", "monument", "sights", "religion", "nature", "museum"] as const;
export type NearventureCategory = (typeof NEARVENTURE_CATEGORIES)[number];

export type EligibilityDecision = { eligible: boolean; reason: string };
export type CategoryDecision = { category: NearventureCategory; rule: string; ruleVersion: string };

/** Russian labels for the six Nearventure categories. */
export const CATEGORY_LABELS: Record<NearventureCategory, { label: string; labelLong: string }> = {
  heritage: { label: "Наследие", labelLong: "Объекты культурного наследия" },
  monument: { label: "Монументы", labelLong: "Мемориалы и памятники" },
  sights: { label: "Достопримечательности", labelLong: "Интересные места" },
  religion: { label: "Религия", labelLong: "Храмы, монастыри, некрополи" },
  nature: { label: "Природа", labelLong: "Озёра, леса, родники, ООПТ" },
  museum: { label: "Музеи", labelLong: "Музеи, галереи, выставки" },
};

const BUILDING_WORDS = new Set(["дом", "здание", "дворец", "усадьба", "комплекс", "ансамбль", "особняк"]);
const firstWord = (name: string): string => name.trim().toLowerCase().split(/[\s«»\-,.:;()«»]+/)[0] ?? "";

/**
 * Resolve exactly one Nearventure category from generic facets + name.
 * Single versioned decision table — replaces the conflicting legacy maps.
 */
export function primaryCategory(facets: FacetClaim[], name: string | null): CategoryDecision | null {
  const paths = new Set(facets.map((f) => f.path));
  const v = NEARVENTURE_PROFILE_VERSION;

  // Building-name heritage override: "Дом/Здание/Дворец/Усадьба/Комплекс/Ансамбль …" → heritage.
  if (name && BUILDING_WORDS.has(firstWord(name)) && (paths.has(FacetPaths.HERITAGE_BUILDING) || paths.has(FacetPaths.MEMORIAL_MONUMENT) || paths.has(FacetPaths.ATTRACTION))) {
    return { category: "heritage", rule: "building-name-heritage-override", ruleVersion: v };
  }
  // Museum wins.
  if (paths.has(FacetPaths.MUSEUM)) return { category: "museum", rule: "facet.museum", ruleVersion: v };
  // Religion.
  if (paths.has(FacetPaths.RELIGIOUS_CHURCH) || paths.has(FacetPaths.RELIGIOUS_MONASTERY) || paths.has(FacetPaths.RELIGIOUS_SHRINE) || paths.has(FacetPaths.RELIGIOUS_CEMETERY)) return { category: "religion", rule: "facet.religious", ruleVersion: v };
  // Heritage.
  if (paths.has(FacetPaths.HERITAGE_BUILDING) || paths.has(FacetPaths.HERITAGE_ESTATE) || paths.has(FacetPaths.HERITAGE_FORTIFICATION) || paths.has(FacetPaths.HERITAGE_ARCHAEOLOGY)) return { category: "heritage", rule: "facet.heritage", ruleVersion: v };
  // Memorial → monument (unless a building-name heritage override already applied).
  if (paths.has(FacetPaths.MEMORIAL_MONUMENT)) return { category: "monument", rule: "facet.memorial", ruleVersion: v };
  // Attractions → sights.
  if (paths.has(FacetPaths.ATTRACTION) || paths.has(FacetPaths.ATTRACTION_VIEWPOINT) || paths.has(FacetPaths.ATTRACTION_ARTWORK)) return { category: "sights", rule: "facet.attraction", ruleVersion: v };
  // Nature.
  if (paths.has(FacetPaths.NATURE_SPRING) || paths.has(FacetPaths.NATURE_WATERFALL) || paths.has(FacetPaths.NATURE_LAKE) || paths.has(FacetPaths.NATURE_PEAK) || paths.has(FacetPaths.NATURE_PROTECTED) || paths.has(FacetPaths.NATURE_PARK)) return { category: "nature", rule: "facet.nature", ruleVersion: v };
  // Linear rivers are noise and never reach here; no river facet maps to a publishable category.
  return null;
}

/** Eligibility: must have a resolvable category, a useful name, and safe geometry, and not be noise. */
export function eligibility(entity: SynthesizedEntity): EligibilityDecision {
  if (entity.noise.noise) return { eligible: false, reason: `noise: ${entity.noise.class}` };
  if (!entity.name) return { eligible: false, reason: "no useful name" };
  // Name-quality gate: reject single-character and pure-numeric names (OSM data noise,
  // survey/km markers). Names must contain at least one Cyrillic/Latin letter and be
  // longer than one character to be product-facing.
  const nameValue = entity.name.value.trim();
  const hasLetter = /[а-яёa-z]/i.test(nameValue);
  if (!hasLetter || nameValue.length < 2) return { eligible: false, reason: `low-quality name: "${nameValue.slice(0, 20)}"` };
  if (!entity.geometry.safe) return { eligible: false, reason: `unsafe geometry: ${entity.geometry.reason}` };
  const category = primaryCategory(entity.facets, entity.name.value);
  if (!category) return { eligible: false, reason: "no resolvable Nearventure category" };
  return { eligible: true, reason: category.rule };
}

export type NearventureProductEntity = {
  id: string;
  category: NearventureCategory;
  categoryLabel: string;
  categoryLabelLong: string;
  categoryRule: string;
  categoryRuleVersion: string;
  facets: string[];
  name: string;
  nameSourceRecordId: string;
  geometry: NonNullable<SynthesizedEntity["geometry"]["geometry"]>;
  geometryPolicy: SynthesizedEntity["geometry"]["policy"];
  geometryRule: string;
  description: string | null;
  descriptionSourceRecordId: string | null;
  descriptionLicense: string | null;
  photo: { url: string; license: string; attribution: string; author: string | null; licenseUrl: string | null } | null;
  heritage: boolean;
  heritageSignificance: string | null;
  urls: SynthesizedEntity["urls"];
  sourceRecordIds: string[];
  region: string | null;
  district: string | null;
  city: string | null;
};

/** Project a synthesized entity into a Nearventure product entity, or null if ineligible. */
export function project(entity: SynthesizedEntity, stableId: string): NearventureProductEntity | null {
  const decision = eligibility(entity);
  if (!decision.eligible || !entity.name || !entity.geometry.geometry) return null;
  const category = primaryCategory(entity.facets, entity.name.value)!;
  const labels = CATEGORY_LABELS[category.category];
  return {
    id: stableId,
    category: category.category,
    categoryLabel: labels.label,
    categoryLabelLong: labels.labelLong,
    categoryRule: category.rule,
    categoryRuleVersion: category.ruleVersion,
    facets: [...new Set(entity.facets.map((f) => f.path))],
    name: entity.name.value,
    nameSourceRecordId: entity.name.sourceRecordId,
    geometry: entity.geometry.geometry,
    geometryPolicy: entity.geometry.policy,
    geometryRule: entity.geometry.rule,
    description: entity.description?.value ?? null,
    descriptionSourceRecordId: entity.description?.sourceRecordId ?? null,
    descriptionLicense: entity.description?.license ?? null,
    photo: entity.photo ? { url: entity.photo.value.url, license: entity.photo.value.license, attribution: entity.photo.value.attribution, author: entity.photo.value.author, licenseUrl: entity.photo.value.licenseUrl } : null,
    heritage: entity.heritage.value,
    heritageSignificance: entity.heritage.significance,
    urls: entity.urls,
    sourceRecordIds: entity.sourceRecordIds,
    region: entity.adminHierarchy?.region ?? null,
    district: entity.adminHierarchy?.district ?? null,
    city: entity.adminHierarchy?.city ?? null,
  };
}

/** Project all synthesized entities, assigning stable IDs from the OSM anchor or the lowest source record id. */
export function projectNearventure(entities: SynthesizedEntity[]): { published: NearventureProductEntity[]; excluded: Array<{ sourceRecordIds: string[]; reason: string }> } {
  const published: NearventureProductEntity[] = [];
  const excluded: Array<{ sourceRecordIds: string[]; reason: string }> = [];
  for (const entity of entities) {
    const decision = eligibility(entity);
    const stableId = stableIdFor(entity);
    if (decision.eligible) {
      const product = project(entity, stableId);
      if (product) published.push(product);
      else excluded.push({ sourceRecordIds: entity.sourceRecordIds, reason: "projection returned null" });
    } else {
      excluded.push({ sourceRecordIds: entity.sourceRecordIds, reason: decision.reason });
    }
  }
  published.sort((a, b) => a.id.localeCompare(b.id));
  excluded.sort((a, b) => a.sourceRecordIds[0].localeCompare(b.sourceRecordIds[0]));
  return { published, excluded };
}

function stableIdFor(entity: SynthesizedEntity): string {
  const osm = entity.sourceRecordIds.find((id) => id.startsWith("osm:"));
  if (osm) return `entity:${osm.slice(4)}`;
  const mkrf = entity.sourceRecordIds.find((id) => id.startsWith("mkrf:"));
  if (mkrf) return `entity:mkrf:${mkrf.slice(5)}`;
  const wd = entity.sourceRecordIds.find((id) => id.startsWith("wikidata:"));
  if (wd) return `entity:${wd}`;
  return `entity:${entity.sourceRecordIds[0]}`;
}
