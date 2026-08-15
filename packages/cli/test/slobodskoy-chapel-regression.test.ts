import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SourceRecordSchema } from "@poi-toolkit/core";
import { resolveRecords } from "../../resolver/src/index.js";
import { buildEntityGroups, synthesizeEntities } from "../../synthesis/src/index.js";

const fixture = async () => JSON.parse(await readFile(new URL("../../../fixtures/resolver/slobodskoy-chapel.json", import.meta.url), "utf8"))
  .map((row: unknown) => SourceRecordSchema.parse(row));

const sortGroups = (groups: Array<Array<{ id: string }>>) => groups
  .map((group) => group.map((record) => record.id).sort())
  .sort((first, second) => first[0].localeCompare(second[0]));

describe("Slobodskoy chapel source regression", () => {
  it("creates exactly one chapel entity, keeps the nearby church and necropolis gate distinct, and selects the canonical title", async () => {
    const records = await fixture();
    const resolution = resolveRecords(records);
    const groups = buildEntityGroups(records, resolution.candidates);

    expect(sortGroups(groups)).toEqual([
      ["egrkn:431410176090006", "osm:a1285849270", "osm:w642924635", "wikivoyage:Слободской:684961:21"],
      ["egrkn:461410034040006"],
      ["osm:a2421057330"],
    ]);

    expect(resolution.candidates).toContainEqual(expect.objectContaining({
      sourceRecordIds: ["osm:a1285849270", "wikivoyage:Слободской:684961:21"],
      decision: "accepted",
      relation: "same",
      rule: { id: "curated-source-identity", version: "evidence-first-v1" },
    }));
    expect(resolution.candidates.some((candidate) => candidate.decision === "accepted"
      && candidate.sourceRecordIds.includes("egrkn:431410176090006")
      && candidate.sourceRecordIds.includes("osm:a2421057330"))).toBe(false);

    const entities = await synthesizeEntities(records, resolution.candidates, { commonsResolver: async () => [] });
    const chapel = entities.find((entity) => entity.sourceRecordIds.includes("wikivoyage:Слободской:684961:21"));
    expect(chapel).toMatchObject({
      sourceRecordIds: ["egrkn:431410176090006", "osm:a1285849270", "osm:w642924635", "wikivoyage:Слободской:684961:21"],
      geometry: { policy: "osm", sourceRecordId: "osm:w642924635" },
      name: {
        value: "Часовня-ротонда Иоанна Предтечи",
        sourceRecordId: "wikivoyage:Слободской:684961:21",
        rule: { id: "name-curated-source-repair" },
      },
    });
    expect(chapel?.description?.sourceRecordId).toBe("wikivoyage:Слободской:684961:21");
  });
});
