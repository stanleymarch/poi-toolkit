import { describe, expect, it } from "vitest";
import { SourceRecord, SourceRecordSchema } from "@poi-toolkit/core";
import { buildEntityGroups, synthesizeEntities, synthesizeEntity } from "../src/index.js";

const rec = (id: string, source: SourceRecord["source"], name: string | null, fields: Record<string, unknown> = {}, geometry: SourceRecord["geometry"] = { type: "Point", coordinates: [49.66, 58.6] }) =>
  SourceRecordSchema.parse({ id, source, sourceId: id, capturedAt: "2026-01-01T00:00:00.000Z", rawRef: "f", name, address: null, geometry, fields, license: "test" });

describe("synthesis", () => {
  it("keeps OSM identity and geometry while enriching from accepted Wikidata via transitive chain", async () => {
    const osm = rec("osm:n1", "osm", "Церковь", { tags: { wikidata: "Q1", historic: "church" } });
    const wd = rec("wikidata:Q1", "wikidata", "Церковь (Киров)", { itemDescription: "Православный храм в Кирове", type: "http://www.wikidata.org/entity/Q16970", image: "File:Church.jpg" });
    const candidates = [{ sourceRecordIds: ["osm:n1", "wikidata:Q1"] as [string, string], relation: "same", decision: "accepted" }];
    const [entity] = await synthesizeEntities([osm, wd], candidates, { commonsResolver: async () => [{ fileName: "Church.jpg", thumbUrl: "u", artist: "Ivan", license: "CC BY-SA 4.0", licenseUrl: null, credit: null }] });
    expect(entity.identity.value).toBe("osm:n1");
    expect(entity.hasOsmAnchor).toBe(true);
    expect(entity.geometry.policy).toBe("osm");
    expect(entity.geometry.safe).toBe(true);
    expect(entity.name?.value).toBe("Церковь");
    expect(entity.description?.value).toBe("Православный храм в Кирове");
    expect(entity.photo?.value.license).toBe("CC BY-SA 4.0");
  });

  it("rejects repeated EGRKN centroid and relative address geometry for standalone", async () => {
    const egrkn = rec("egrkn:1", "egrkn", "Дом", { addressClassification: "relative", nativeGeometryClassification: "object" });
    const [entity] = await synthesizeEntities([egrkn], [], { bbox: [46, 56, 55, 61], egrknCentroidCounts: new Map() });
    expect(entity.geometry.safe).toBe(false);
    expect(entity.standaloneEligible).toBe(false);
  });

  it("requires explicit address compatibility before trusting a geocoded EGRKN point", async () => {
    const egrkn = rec("egrkn:1", "egrkn", "Дом купца", { addressClassification: "structured", nativeGeometryClassification: "object" }, null);
    const unsafe = await synthesizeEntities([egrkn], [], { geocodedEvidence: new Map([["egrkn:1", { geometry: { type: "Point" as const, coordinates: [49.66, 58.6] as [number, number] }, confidence: "high" }]]) });
    expect(unsafe[0].geometry.safe).toBe(false);
    const safe = await synthesizeEntities([egrkn], [], { geocodedEvidence: new Map([["egrkn:1", { geometry: { type: "Point" as const, coordinates: [49.66, 58.6] as [number, number] }, confidence: "high", addressCompatible: true }]]) });
    expect(safe[0].geometry.safe).toBe(true);
  });

  it("admits a trusted MKRF museum standalone with safe geometry", async () => {
    const mkrf = rec("mkrf:1", "mkrf", "Краеведческий музей", { description: "История края", imageUrl: "https://opendata.mkrf.ru/m.jpg" });
    const [entity] = await synthesizeEntities([mkrf], [], { bbox: [46, 56, 55, 61] });
    expect(entity.hasOsmAnchor).toBe(false);
    expect(entity.geometry.safe).toBe(true);
    expect(entity.geometry.policy).toBe("verified-source");
    expect(entity.standaloneEligible).toBe(true);
    expect(entity.description?.value).toBe("История края");
    expect(entity.photo?.value.attribution).toContain("Министерство культуры");
  });

  it("ranks a Russian Wikivoyage description above a generic English Wikidata template", () => {
    const osm = rec("osm:n1", "osm", "Музей", { tags: { tourism: "museum" } });
    const wd = rec("wikidata:Q1", "wikidata", "Museum", { itemDescription: "museum in Russia", type: "http://www.wikidata.org/entity/Q33506" });
    const wv = rec("wikivoyage:P:1:1", "wikivoyage", "Музей", { description: "Крупнейший краеведческий музей области с богатыми коллекциями." });
    const candidates = [{ sourceRecordIds: ["osm:n1", "wikidata:Q1"] as [string, string], relation: "same", decision: "accepted" }];
    const entity = synthesizeEntity([osm, wd, wv], { bbox: [46, 56, 55, 61] })!;
    expect(entity.description?.value).toContain("краеведческий");
  });

  it("uses the corroborated canonical title and OSM geometry for the Slobodskoy chapel repair", () => {
    const egrkn = rec("egrkn:431410176090006", "egrkn", "Часовня - ротонда Иоанна Предтечи", { objectType: "Памятник", categoryType: "Федерального значения" }, { type: "Point", coordinates: [50.18731408465456, 58.721410418682204] });
    const osm = rec("osm:a1285849270", "osm", "Часовня Ионна Предтечи", { tags: { building: "yes", historic: "wayside_shrine", religion: "christian" } }, { type: "Polygon", coordinates: [[[50.1855414, 58.7225378], [50.1857232, 58.7225328], [50.1855414, 58.7225378]]] });
    const entity = synthesizeEntity([egrkn, osm])!;
    expect(entity.identity.value).toBe(osm.id);
    expect(entity.geometry).toMatchObject({ policy: "osm", sourceRecordId: osm.id, safe: true });
    expect(entity.name).toMatchObject({ value: "Часовня-ротонда Иоанна Предтечи", sourceRecordId: egrkn.id, rule: { id: "name-curated-source-repair" } });
    expect(entity.heritage).toMatchObject({ value: true, sourceRecordId: egrkn.id });
  });

  it("builds entity groups from accepted same relations", () => {
    const a = rec("osm:n1", "osm", "A"), b = rec("wikidata:Q1", "wikidata", "B"), c = rec("osm:n2", "osm", "C");
    const groups = buildEntityGroups([a, b, c], [{ sourceRecordIds: ["osm:n1", "wikidata:Q1"], relation: "same", decision: "accepted" }]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.some((r) => r.id === "osm:n1"))?.map((r) => r.id).sort()).toEqual(["osm:n1", "wikidata:Q1"]);
  });
});
