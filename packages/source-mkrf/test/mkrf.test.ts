import { describe, expect, it } from "vitest";
import { collectMkrf } from "../src/index.js";

describe("MKRF adapter", () => {
  it("normalizes a museum record with coordinates, HTML description, and image", async () => {
    const urls: string[] = [];
    const fakeFetch = async (url: string) => {
      urls.push(url);
      const page = url.includes("cursor=next") ? { data: [] } : { data: [{ data: { general: { id: "42", name: "Краеведческий музей", description: "<p>История</p> края", address: { fullAddress: "г. Киров, ул. Ленина", mapPosition: { coordinates: [49.66, 58.6] } }, contacts: { website: "https://museum.ru" }, image: { url: "https://opendata.mkrf.ru/m.jpg" } } } }], cursor: "next" };
      return new Response(JSON.stringify(page), { status: 200 });
    };
    const result = await collectMkrf({ apiKey: "test", clipBbox: [46, 56, 55, 61], fetch: fakeFetch as typeof globalThis.fetch, retries: 1 });
    expect(result.pages).toBe(2);
    expect(result.records).toHaveLength(1);
    const r = result.records[0];
    expect(r.id).toBe("mkrf:42");
    expect(r.fields.description).toBe("История края");
    expect(r.fields.imageUrl).toBe("https://opendata.mkrf.ru/m.jpg");
    expect(r.geometry).toEqual({ type: "Point", coordinates: [49.66, 58.6] });
    expect(urls[1]).toContain("cursor=next");
  });

  it("keeps a museum inside bbox, drops one outside without region keyword", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ data: [
      { data: { general: { id: "1", name: "Внутри", address: { mapPosition: { coordinates: [49, 58] } } } } },
      { data: { general: { id: "2", name: "Снаружи", address: { mapPosition: { coordinates: [1, 1] } } } } },
    ] }), { status: 200 });
    const result = await collectMkrf({ apiKey: "test", clipBbox: [46, 56, 55, 61], fetch: fakeFetch as typeof globalThis.fetch, retries: 1 });
    expect(result.records.map((r) => r.id)).toEqual(["mkrf:1"]);
  });

  it("keeps an out-of-bbox museum whose address mentions a region keyword", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ data: [
      { data: { general: { id: "3", name: "Дальний музей", address: { fullAddress: "г. Москва" }, locale: { name: "Кировская область" } } } },
    ] }), { status: 200 });
    const result = await collectMkrf({ apiKey: "test", clipBbox: [46, 56, 55, 61], regionKeywords: ["кировск"], fetch: fakeFetch as typeof globalThis.fetch, retries: 1 });
    expect(result.records).toHaveLength(1);
  });

  it("fails on a repeated cursor instead of looping", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ data: [{ data: { general: { id: "1", name: "M" } } }], cursor: "same" }));
    await expect(collectMkrf({ apiKey: "test", fetch: fakeFetch as typeof globalThis.fetch, retries: 1 })).rejects.toThrow("repeated cursor");
  });
});
