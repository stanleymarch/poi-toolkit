import { describe, expect, it } from "vitest";
import { collectEgrkn } from "../src/index.js";

describe("EGRKN", () => {
  it("uses the opaque cursor instead of the nextPage URL and normalizes coordinates", async () => {
    const urls: string[] = [];
    const fakeFetch = async (url: string) => {
      urls.push(url);
      const page = url.includes("cursor=opaque-next")
        ? { data: [] }
        : {
            data: [{ data: { general: { regNumber: "43-1", name: "Дом", region: { value: "Кировская область" }, address: { fullAddress: "Киров", mapPosition: { coordinates: [49.6, 58.6] } } } } }],
            cursor: "opaque-next",
            nextPage: "https://opendata.mkrf.ru/v2/egrkn/$?cursor=wrong-full-url",
          };
      return new Response(JSON.stringify(page), { status: 200 });
    };

    const result = await collectEgrkn({
      apiKey: "test",
      region: "Кировская область",
      fetch: fakeFetch as typeof globalThis.fetch,
      retries: 1,
    });

    expect(result.pages).toBe(2);
    expect(urls[1]).toContain("cursor=opaque-next");
    expect(urls[1]).not.toContain("wrong-full-url");
    expect(result.records[0].geometry).toEqual({ type: "Point", coordinates: [49.6, 58.6] });
  });

  it("fails on a repeated cursor instead of looping forever", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ data: [{}], cursor: "same" }));
    await expect(collectEgrkn({
      apiKey: "test",
      region: "Кировская область",
      fetch: fakeFetch as typeof globalThis.fetch,
      retries: 1,
    })).rejects.toThrow("repeated cursor");
  });
});
