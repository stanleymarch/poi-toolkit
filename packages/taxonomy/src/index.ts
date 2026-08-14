import { FacetClaim, SourceRecord } from "@poi-toolkit/core";

export const TAXONOMY_RULE_VERSION = "facet-v1";

/** Universal hierarchical facet paths, source-neutral. */
export const FacetPaths = {
  // Cultural heritage
  HERITAGE_BUILDING: "culture.heritage.building",
  HERITAGE_ESTATE: "culture.heritage.estate",
  HERITAGE_FORTIFICATION: "culture.heritage.fortification",
  HERITAGE_ARCHAEOLOGY: "culture.heritage.archaeology",
  // Memorials
  MEMORIAL_MONUMENT: "culture.memorial.monument",
  // Religion
  RELIGIOUS_CHURCH: "culture.religious.church",
  RELIGIOUS_MONASTERY: "culture.religious.monastery",
  RELIGIOUS_SHRINE: "culture.religious.shrine",
  RELIGIOUS_CEMETERY: "culture.religious.cemetery",
  // Museums
  MUSEUM: "culture.museum",
  // Attractions
  ATTRACTION_VIEWPOINT: "attraction.viewpoint",
  ATTRACTION_ARTWORK: "attraction.artwork",
  ATTRACTION: "attraction.attraction",
  // Nature
  NATURE_SPRING: "nature.water.spring",
  NATURE_WATERFALL: "nature.water.waterfall",
  NATURE_LAKE: "nature.water.lake",
  NATURE_RIVER: "nature.water.river",
  NATURE_PEAK: "nature.landform.peak",
  NATURE_PROTECTED: "nature.protected_area",
  NATURE_PARK: "nature.park",
} as const;

export type NoiseClass = "accommodation" | "information" | "infrastructure" | "memorial_plaque" | "street" | "settlement" | "linear_water" | "junk_name" | "unanchored_generic";

export type NoiseDecision = { noise: boolean; class?: NoiseClass; reason?: string };

/**
 * Classify a source record into one or more universal facets with traits.
 * Deterministic and independent of ingestion order.
 */
export function classifyFacets(record: SourceRecord): FacetClaim[] {
  switch (record.source) {
    case "osm": return classifyOsm(record);
    case "egrkn": return classifyEgrkn(record);
    case "mkrf": return [mkrfClaim(record)];
    case "wikidata": return classifyWikidata(record);
    case "wikivoyage": return classifyWikivoyage(record);
    default: return [];
  }
}

/** Product-agnostic noise detection: streets, accommodation, plaques, linear rivers, junk names. */
export function detectNoise(record: SourceRecord): NoiseDecision {
  if (record.source === "osm") return detectOsmNoise(record);
  if (record.source === "wikidata") return detectWikidataNoise(record);
  if (record.source === "wikivoyage") return detectWikivoyageNoise(record);
  return { noise: false };
}

const baseClaim = (record: SourceRecord, path: string, kind: string | null, traits: string[], field: string, confidence: number = 0.9): FacetClaim => ({
  path, kind, traits, sourceRecordId: record.id, sourceField: field, rule: { id: "taxonomy", version: TAXONOMY_RULE_VERSION }, confidence,
});

// ── OSM ──────────────────────────────────────────────────────────────────────

function classifyOsm(record: SourceRecord): FacetClaim[] {
  const tags = (record.fields.tags ?? {}) as Record<string, string>;
  const claims: FacetClaim[] = [];
  const push = (path: string, kind: string | null, traits: string[], confidence = 0.9) => { if (!claims.some((c) => c.path === path)) claims.push(baseClaim(record, path, kind, traits, "tags", confidence)); };

  const tourism = tags.tourism, amenity = tags.amenity, building = tags.building, historic = tags.historic, natural = tags.natural, water = tags.water, waterway = tags.waterway, leisure = tags.leisure, boundary = tags.boundary, landuse = tags.landuse;

  // Museums. OSM tagging is imperfect: venues frequently retain tourism=gallery
  // or a protected-area tag while their Russian name explicitly identifies a museum.
  if (tourism === "museum" || amenity === "museum" || /музей|museum/i.test(record.name ?? "")) push(FacetPaths.MUSEUM, "museum", ["indoor"]);

  // Religion (before generic historic)
  const worship = { church: "church", cathedral: "cathedral", chapel: "chapel", mosque: "mosque", temple: "temple", synagogue: "synagogue" } as const;
  if (historic === "wayside_shrine" || historic === "wayside_cross" || historic === "wayside_chapel") push(FacetPaths.RELIGIOUS_SHRINE, historic, ["religious"]);
  if (amenity === "monastery") push(FacetPaths.RELIGIOUS_MONASTERY, "monastery", ["religious"]);
  if (building && building in worship) push(FacetPaths.RELIGIOUS_CHURCH, building, ["religious"]);
  if (historic === "monastery" || historic === "convent") push(FacetPaths.RELIGIOUS_MONASTERY, historic, ["religious"]);
  if (landuse === "religious" || amenity === "place_of_worship") push(FacetPaths.RELIGIOUS_CHURCH, building ?? "place_of_worship", ["religious"]);
  if (historic === "church") push(FacetPaths.RELIGIOUS_CHURCH, "church", ["religious"]);
  if (amenity === "grave_yard" || landuse === "cemetery") push(FacetPaths.RELIGIOUS_CEMETERY, "cemetery", ["religious"]);
  if (historic === "tomb" || historic === "crypt" || historic === "mausoleum") push(FacetPaths.RELIGIOUS_CEMETERY, historic, ["religious"]);
  else if (tags.religion && !claims.some((c) => c.path.startsWith("culture.religious"))) push(FacetPaths.RELIGIOUS_CHURCH, building ?? "place_of_worship", ["religious"], 0.6);

  // Memorials / public art
  const tourismHistoric = { monument: true, memorial: true, statue: true, artwork: true, stone: true, memorial_plaque: true };
  if (historic && historic in tourismHistoric) {
    if (historic === "memorial_plaque") push(FacetPaths.MEMORIAL_MONUMENT, "memorial_plaque", [], 0.5);
    else push(FacetPaths.MEMORIAL_MONUMENT, historic, []);
  }

  // Heritage (ОКН-type)
  const heritage = { castle: "fortification", manor: "estate", manor_house: "estate", ruins: "fortification", archaeological_site: "archaeology", fort: "fortification", fortification: "fortification", fortress: "fortification", citywalls: "fortification", city_wall: "fortification", city_gate: "fortification", battlefield: "fortification", palace: "building", castle_hill: "fortification", stone_age: "archaeology" };
  if (historic && historic in heritage) {
    const kind = (heritage as Record<string, string>)[historic];
    push(kind === "estate" ? FacetPaths.HERITAGE_ESTATE : kind === "fortification" ? FacetPaths.HERITAGE_FORTIFICATION : kind === "archaeology" ? FacetPaths.HERITAGE_ARCHAEOLOGY : FacetPaths.HERITAGE_BUILDING, historic, ["protected"]);
  }
  if (historic === "building" || historic === "house" || historic === "heritage") push(FacetPaths.HERITAGE_BUILDING, historic, ["protected"]);
  if (building && building in ({ castle: true, palace: true, fortress: true, ruins: true })) push(FacetPaths.HERITAGE_BUILDING, building, ["protected"]);

  // Attractions / tourism
  const tourismSkip = { hotel: true, motel: true, hostel: true, apartment: true, chalet: true, guest_house: true, information: true };
  if (tourism && !(tourism in tourismSkip) && tourism !== "museum") {
    if (tourism === "viewpoint") push(FacetPaths.ATTRACTION_VIEWPOINT, "viewpoint", []);
    else if (tourism === "artwork") push(FacetPaths.ATTRACTION_ARTWORK, "artwork", []);
    else push(FacetPaths.ATTRACTION, tourism, []);
  }

  // Nature
  const waterwayNature = { waterfall: true, weir: true, dam: true, rapids: true, lock_gate: true };
  if (natural === "spring") push(FacetPaths.NATURE_SPRING, "spring", ["water"]);
  if (waterway && waterway in waterwayNature) push(FacetPaths.NATURE_WATERFALL, waterway, ["water"]);
  if (natural === "peak" || natural === "cliff" || natural === "rock" || natural === "stone" || natural === "cave_entrance") push(FacetPaths.NATURE_PEAK, natural, []);
  if (water === "lake" || water === "pond" || water === "reservoir" || (natural === "water" && (!water || water === "lake" || water === "pond" || water === "reservoir"))) push(FacetPaths.NATURE_LAKE, water ?? "water", ["water"]);
  if (waterway === "river" || waterway === "stream" || waterway === "canal") push(FacetPaths.NATURE_RIVER, waterway, ["water"], 0.4);
  if (boundary === "protected_area" || leisure === "nature_reserve") push(FacetPaths.NATURE_PROTECTED, leisure ?? "protected_area", ["protected"]);
  if (leisure === "park" || leisure === "garden") push(FacetPaths.NATURE_PARK, leisure, []);

  return claims;
}

function detectOsmNoise(record: SourceRecord): NoiseDecision {
  const tags = (record.fields.tags ?? {}) as Record<string, string>;
  const tourism = tags.tourism, historic = tags.historic, waterway = tags.waterway, place = tags.place, highway = tags.highway;
  const name = record.name ?? "";
  const natural = tags.natural;
  const accommodation = { hotel: true, motel: true, hostel: true, apartment: true, chalet: true, guest_house: true, camp_site: true };
  if (tourism && tourism in accommodation) return { noise: true, class: "accommodation", reason: `tourism=${tourism}` };
  if (tourism === "information") return { noise: true, class: "information", reason: "tourism=information" };
  if (waterway && (waterway === "river" || waterway === "stream" || waterway === "ditch" || waterway === "drain" || waterway === "canal")) return { noise: true, class: "linear_water", reason: `waterway=${waterway}` };
  if (tags.water === "river") return { noise: true, class: "linear_water", reason: "water=river" };
  // River backwaters/cutoffs (затон, протока, старица, ерик) are not destination POIs like lakes/ponds.
  if (name && /затон|проток|стариц|ерик|воложк|плёс|рукав/.test(name) && (natural === "water" || tags.waterway))
    return { noise: true, class: "linear_water", reason: "river backwater/cutoff" };
  if (place && (place === "city" || place === "town" || place === "village" || place === "hamlet" || place === "suburb" || place === "locality")) return { noise: true, class: "settlement", reason: `place=${place}` };
  if (highway && !historic) return { noise: true, class: "street", reason: `highway=${highway}` };
  if (historic === "memorial_plaque") return { noise: true, class: "memorial_plaque", reason: "historic=memorial_plaque" };
  if (name && /^\d+$/.test(name.trim())) return { noise: true, class: "junk_name", reason: "numeric name" };
  if (name && /^[@#$%&*+=~`]+$/.test(name.trim())) return { noise: true, class: "junk_name", reason: "symbol-only name" };
  // A bare «Родник» is not a discoverable destination and frequently maps
  // several outlets of one spring as separate nodes. Keep it only when OSM
  // supplies an independent identity or a more specific name.
  if (/^родник$/i.test(name.trim()) && !tags.ref && !tags.wikidata && !tags.heritage)
    return { noise: true, class: "unanchored_generic", reason: "generic unnamed spring" };
  return { noise: false };
}

// ── EGRKN ────────────────────────────────────────────────────────────────────

function classifyEgrkn(record: SourceRecord): FacetClaim[] {
  const type = String(record.fields.objectType ?? "").toLowerCase().trim();
  const name = (record.name ?? "").toLowerCase();
  // Name-based classification takes precedence: EGRKN objectType "Памятник" is a legal
  // protection tier, not a physical type — a church, a house, and a memorial are all "Памятник".
  if (/церков|собор|часовн|колокольн|монастыр|мечет|храм/.test(name))
    return [baseClaim(record, /монастыр/.test(name) ? FacetPaths.RELIGIOUS_MONASTERY : FacetPaths.RELIGIOUS_CHURCH, null, ["religious", "protected", "government_registry"], "name")];
  if (/^(дом|здание|школа|усадьб|особняк|флигель|дворец|амбар)/.test(name))
    return [baseClaim(record, /усадьб/.test(name) ? FacetPaths.HERITAGE_ESTATE : FacetPaths.HERITAGE_BUILDING, null, ["protected", "government_registry"], "name")];
  if (/памятник|обелиск|мемориал|братская могил|могил|стел/.test(name))
    return [baseClaim(record, FacetPaths.MEMORIAL_MONUMENT, null, ["protected", "government_registry"], "name")];
  if (/городищ|селищ|курган|стоянк/.test(name))
    return [baseClaim(record, FacetPaths.HERITAGE_ARCHAEOLOGY, null, ["protected", "government_registry"], "name")];
  // Fall back to objectType when the name gives no signal.
  if (!type) return [baseClaim(record, FacetPaths.HERITAGE_BUILDING, null, ["protected", "government_registry"], "objectType", 0.5)];
  const religion = { церковь: "church", собор: "cathedral", часовня: "chapel", монастырь: "monastery", колокольня: "bell_tower", скит: "hermitage" };
  const memorial = { памятник: "monument", мемориал: "memorial", обелиск: "obelisk", "братская могила": "war_grave", могила: "grave" };
  const heritage = { дом: "building", усадьба: "estate", дворец: "palace", замок: "castle", особняк: "mansion", магазин: "building", гостиница: "building", больница: "building", школа: "building", театр: "building", библиотека: "building" };
  const archaeology = { городище: "gorodishe", селище: "settlement_site", курган: "kurgan", стоянка: "camp_site" };
  if (type in religion) return [baseClaim(record, religion[type as keyof typeof religion] === "monastery" ? FacetPaths.RELIGIOUS_MONASTERY : FacetPaths.RELIGIOUS_CHURCH, religion[type as keyof typeof religion], ["religious", "protected", "government_registry"], "objectType")];
  if (type in memorial) return [baseClaim(record, FacetPaths.MEMORIAL_MONUMENT, memorial[type as keyof typeof memorial], ["protected", "government_registry"], "objectType")];
  if (type in archaeology) return [baseClaim(record, FacetPaths.HERITAGE_ARCHAEOLOGY, archaeology[type as keyof typeof archaeology], ["protected", "government_registry"], "objectType")];
  if (type in heritage) return [baseClaim(record, FacetPaths.HERITAGE_BUILDING, heritage[type as keyof typeof heritage], ["protected", "government_registry"], "objectType")];
  return [baseClaim(record, FacetPaths.HERITAGE_BUILDING, type, ["protected", "government_registry"], "objectType", 0.7)];
}

// ── MKRF ─────────────────────────────────────────────────────────────────────

function mkrfClaim(record: SourceRecord): FacetClaim {
  return baseClaim(record, FacetPaths.MUSEUM, "museum", ["government_registry", "indoor"], "category", 0.95);
}

// ── Wikidata ─────────────────────────────────────────────────────────────────

const WIKIDATA_TYPE_FACETS: Record<string, { path: string; kind: string; traits?: string[] }> = {
  Q33506: { path: FacetPaths.MUSEUM, kind: "museum" }, Q17431399: { path: FacetPaths.MUSEUM, kind: "museum" },
  Q169930: { path: FacetPaths.RELIGIOUS_CHURCH, kind: "cathedral", traits: ["religious"] }, Q8461: { path: FacetPaths.RELIGIOUS_CHURCH, kind: "church", traits: ["religious"] }, Q1370598: { path: FacetPaths.RELIGIOUS_CHURCH, kind: "church", traits: ["religious"] }, Q16970: { path: FacetPaths.RELIGIOUS_CHURCH, kind: "church", traits: ["religious"] }, Q1024714: { path: FacetPaths.RELIGIOUS_CHURCH, kind: "cathedral", traits: ["religious"] }, Q160786: { path: FacetPaths.RELIGIOUS_MONASTERY, kind: "monastery", traits: ["religious"] }, Q44539: { path: FacetPaths.RELIGIOUS_MONASTERY, kind: "monastery", traits: ["religious"] }, Q848248: { path: FacetPaths.RELIGIOUS_SHRINE, kind: "shrine", traits: ["religious"] },
  Q570116: { path: FacetPaths.RELIGIOUS_CEMETERY, kind: "cemetery", traits: ["religious"] }, Q39614: { path: FacetPaths.RELIGIOUS_CEMETERY, kind: "cemetery", traits: ["religious"] }, Q838948: { path: FacetPaths.RELIGIOUS_CEMETERY, kind: "tomb", traits: ["religious"] },
  Q5003624: { path: FacetPaths.MEMORIAL_MONUMENT, kind: "memorial" }, Q1061410: { path: FacetPaths.MEMORIAL_MONUMENT, kind: "war_memorial" }, Q1185943: { path: FacetPaths.MEMORIAL_MONUMENT, kind: "obelisk" }, Q181624: { path: FacetPaths.MEMORIAL_MONUMENT, kind: "statue" }, Q179700: { path: FacetPaths.MEMORIAL_MONUMENT, kind: "statue" }, Q860656: { path: FacetPaths.MEMORIAL_MONUMENT, kind: "monument" }, Q215110: { path: FacetPaths.ATTRACTION_ARTWORK, kind: "sculpture" },
  Q5705250: { path: FacetPaths.HERITAGE_BUILDING, kind: "building", traits: ["protected"] }, Q16560: { path: FacetPaths.HERITAGE_FORTIFICATION, kind: "castle", traits: ["protected"] }, Q23413: { path: FacetPaths.HERITAGE_FORTIFICATION, kind: "castle", traits: ["protected"] }, Q12511: { path: FacetPaths.HERITAGE_BUILDING, kind: "palace", traits: ["protected"] }, Q5783376: { path: FacetPaths.HERITAGE_ESTATE, kind: "estate", traits: ["protected"] }, Q839954: { path: FacetPaths.HERITAGE_ARCHAEOLOGY, kind: "archaeological_site", traits: ["protected"] },
  Q11446: { path: FacetPaths.ATTRACTION_VIEWPOINT, kind: "viewpoint" }, Q51621: { path: FacetPaths.NATURE_PEAK, kind: "peak" }, Q23397: { path: FacetPaths.NATURE_LAKE, kind: "lake", traits: ["water"] }, Q4022: { path: FacetPaths.NATURE_RIVER, kind: "river", traits: ["water"] }, Q124714: { path: FacetPaths.NATURE_SPRING, kind: "spring", traits: ["water"] }, Q34038: { path: FacetPaths.NATURE_WATERFALL, kind: "waterfall", traits: ["water"] },
  Q4676877: { path: FacetPaths.NATURE_PROTECTED, kind: "protected_area", traits: ["protected"] }, Q179049: { path: FacetPaths.NATURE_PROTECTED, kind: "national_park", traits: ["protected"] },
};

function classifyWikidata(record: SourceRecord): FacetClaim[] {
  const claims: FacetClaim[] = [];
  const typeQid = qid(String(record.fields.type ?? ""));
  if (typeQid && WIKIDATA_TYPE_FACETS[typeQid]) {
    const entry = WIKIDATA_TYPE_FACETS[typeQid];
    claims.push(baseClaim(record, entry.path, entry.kind, entry.traits ?? [], "type"));
  }
  if (record.fields.heritage) claims.push(baseClaim(record, FacetPaths.HERITAGE_BUILDING, null, ["protected"], "heritage", 0.7));
  return claims;
}

function detectWikidataNoise(record: SourceRecord): NoiseDecision {
  const typeQid = qid(String(record.fields.type ?? ""));
  const name = (record.name ?? "").toLowerCase();
  // Q4022 (river) is noise, but destination water bodies (озеро, пруд, водохранилище, карьер)
  // typed as river in Wikidata are legitimate point-like nature features — keep them.
  // River backwaters (затон, протока, старица, ерик, воложка) are NOT destinations — exclude.
  if (typeQid === "Q4022" && /озер|пруд|водохранил|карьер|котлован/.test(name) && !/затон|проток|стариц|ерик|воложк|плёс/.test(name))
    return { noise: false };
  if (typeQid === "Q4022") return { noise: true, class: "linear_water", reason: "instance of river/backwater (Q4022)" };
  if (typeQid === "Q486972" || typeQid === "Q515" || typeQid === "Q532" || typeQid === "Q3957") return { noise: true, class: "settlement", reason: "instance of settlement/city/village" };
  return { noise: false };
}

// ── Wikivoyage ───────────────────────────────────────────────────────────────

function classifyWikivoyage(record: SourceRecord): FacetClaim[] {
  const type = String(record.fields.type ?? "").toLowerCase().trim();
  // Natural monuments (Природные памятники России pages) → protected-area nature facet.
  if (type === "nature" || record.fields.knid) {
    const listingType = String(record.fields.listingType ?? "nature").toLowerCase();
    const kind = listingType === "reserve" || listingType === "sanctuary" ? "protected_reserve" : "protected_monument";
    return [baseClaim(record, FacetPaths.NATURE_PROTECTED, kind, ["protected", "water"], "type", 0.85)];
  }
  // Name-based override: museums from any listing type get the museum facet.
  if (/музей|museum/i.test(record.name ?? "")) {
    return [baseClaim(record, FacetPaths.MUSEUM, "museum", ["indoor"], "name", 0.9)];
  }
  const map: Record<string, { path: string; kind: string }> = {
    see: { path: FacetPaths.ATTRACTION, kind: "sight" }, do: { path: FacetPaths.ATTRACTION, kind: "activity" },
    listing: { path: FacetPaths.ATTRACTION, kind: "listing" }, go: { path: FacetPaths.ATTRACTION, kind: "listing" },
  };
  if (type in map) return [baseClaim(record, map[type].path, map[type].kind, [], "type", 0.6)];
  return [baseClaim(record, FacetPaths.ATTRACTION, "listing", [], "type", 0.4)];
}

function detectWikivoyageNoise(record: SourceRecord): NoiseDecision {
  // Reject non-tourism listing types outright (eat/drink/sleep/buy/vicinity).
  const type = String(record.fields?.type ?? "").toLowerCase().trim();
  if (["eat", "drink", "sleep", "buy", "vicinity"].includes(type)) {
    return { noise: true, class: "infrastructure", reason: `wikivoyage ${type} listing excluded: ${(record.name ?? "").slice(0, 30)}` };
  }
  // Wikivoyage listings are not pre-filtered by type. Reject accommodation, food, and
  // service listings that leak into a tourism-POI product (hotels, cafes, shops, salons).
  const name = (record.name ?? "").toLowerCase();
  const serviceRe = /отель|hotel|гостиниц|хостел|hostel|кафе|кофе|кофейн|ресторан|restaurant|бар|пивн|паб|pub|бистро|столов|закусочн|буфет|пекарн|кондитерск|пицц|pizz|шашлыч|трактир|блинн|чебурек|хинкал|донер|кебаб|бургер|суши|sushi|вкусноблин|магни|магазин|shop|салон связи|сим-карт|банкомат|аптек|sauna|сауна|спа|spa|бассейн|заправк|азс|стоянк|парковк|автовокз|вокзал|аэропорт|ж\/д|почтамт|отделение банк|стоматолог|клиник|медцентр|спортзал|фитнес|барбершоп|парикмах|салон крас/;
  if (serviceRe.test(name)) return { noise: true, class: "infrastructure", reason: `wikivoyage service listing: ${name.slice(0, 30)}` };
  if (/^[@#$%&*]+$/.test(record.name?.trim() ?? "")) return { noise: true, class: "junk_name", reason: "symbol-only name" };
  return { noise: false };
}

function qid(value: string): string | null { const match = value.match(/(Q\d+)$/); return match?.[1] ?? null; }
