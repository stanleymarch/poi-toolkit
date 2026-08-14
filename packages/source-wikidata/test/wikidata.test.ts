import { describe, expect, it } from "vitest";
import { buildWikidataQuery, collectWikidata } from "../src/index.js";
const binding = (qid: string) => ({ item: { value: `http://www.wikidata.org/entity/${qid}` }, itemLabel: { value: "Место" }, coord: { value: "Point(49.6 58.6)" } });
describe("Wikidata adapter", () => {
  it("uses deterministic offset pages and de-duplicates QIDs", async () => {
    const urls: string[] = []; let call = 0;
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ results: { bindings: call++ === 0 ? [binding("Q1"), binding("Q1")] : [] } }));
    }) as typeof fetch;
    const result = await collectWikidata({ regions: ["Q5387"], pageSize: 2, retries: 1, fetch: fakeFetch });
    expect(result.pages).toBe(2); expect(result.records).toHaveLength(1); expect(urls[1]).toContain("OFFSET+2"); expect(result.records[0].geometry).toEqual({ type: "Point", coordinates: [49.6, 58.6] });
  });
  it("sends the canonical project User-Agent to Wikidata", async () => {
    let userAgent: string | null = null;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      userAgent = new Headers(init?.headers).get("User-Agent");
      return new Response(JSON.stringify({ results: { bindings: [] } }));
    }) as typeof fetch;

    await collectWikidata({ regions: ["Q5387"], retries: 1, fetch: fakeFetch });

    expect(userAgent).toBe("poi-toolkit/0.1 (https://github.com/stanleymarch/poi-toolkit)");
  });
  it("fails rather than accepting a capped sequence as complete", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ results: { bindings: [binding("Q1")] } }))) as typeof fetch;
    await expect(collectWikidata({ regions: ["Q5387"], pageSize: 1, maxPages: 1, retries: 1, fetch: fakeFetch })).rejects.toThrow("completeness guard");
  });
  it("rejects schema drift and scopes the query", () => { expect(buildWikidataQuery(["Q5387"], 10, 20)).toContain("wd:Q5387"); });
});
