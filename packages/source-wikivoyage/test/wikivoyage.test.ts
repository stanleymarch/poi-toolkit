import { describe, expect, it } from "vitest";
import { collectWikivoyage, extractListings } from "../src/index.js";

const revisionResponse = (content: string) => ({
  query: {
    pages: [{
      revisions: [{
        revid: 123,
        timestamp: "2026-07-14T00:00:00Z",
        slots: { main: { content } },
      }],
    }],
  },
});

describe("Wikivoyage adapter", () => {
  it("parses balanced listing templates and preserves revision provenance", async () => {
    const content = "{{listing|type=see|name=Музей|lat=58,60|long=49,66|description={{lang|ru|Описание}}}}";
    const fakeFetch = (async () => new Response(JSON.stringify(revisionResponse(content)))) as typeof fetch;
    const result = await collectWikivoyage({ pages: ["Киров"], fetch: fakeFetch, retries: 1 });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      name: "Музей",
      geometry: { type: "Point", coordinates: [49.66, 58.6] },
    });
    expect(result.records[0].fields.pageUrl).toContain("oldid=123");
  });

  it("sends the canonical project User-Agent to Wikivoyage", async () => {
    let userAgent: string | null = null;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      userAgent = new Headers(init?.headers).get("User-Agent");
      return new Response(JSON.stringify(revisionResponse("")));
    }) as typeof fetch;

    await collectWikivoyage({ pages: ["Киров"], fetch: fakeFetch, retries: 1 });

    expect(userAgent).toBe("poi-toolkit/0.1 (https://github.com/stanleymarch/poi-toolkit)");
  });

  it("skips a configured page that does not exist", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ query: { pages: [{ missing: true }] } }))) as typeof fetch;
    const result = await collectWikivoyage({ pages: ["Несуществующая страница"], fetch: fakeFetch, retries: 1 });
    expect(result.records).toEqual([]);
    expect(result.skippedPages).toEqual(["Несуществующая страница"]);
  });

  it("rejects a revision response without content/provenance", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ query: { pages: [{}] } }))) as typeof fetch;
    await expect(collectWikivoyage({ pages: ["Киров"], fetch: fakeFetch, retries: 1 }))
      .rejects.toThrow("schema drift");
  });

  it("ignores malformed non-listing text", () => {
    expect(extractListings("Обычный текст {{не listing|name=Нет}}")).toEqual([]);
  });
});
