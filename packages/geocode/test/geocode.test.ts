import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  classifyOsmAddress,
  classifyPrecision,
  extractAddressParts,
  geocodeEgrknRecords,
  geocodeNominatimAddress,
  geocodePhotonAddress,
  geocodePhotonAddressStructured,
  geocodeYandexAddress,
  prepareAddress,
  resolveGeocodeOptions,
} from "../src/index.js";
import { SourceRecordSchema } from "@poi-toolkit/core";

const noSleep = async () => {};
const record = (id = "1", address = "г. Киров, ул. Ленина, д. 10 литера А") => SourceRecordSchema.parse({
  id: `egrkn:${id}`, source: "egrkn", sourceId: id, capturedAt: "2026-07-19T00:00:00.000Z", rawRef: "test",
  name: "Дом", address, geometry: null, fields: {}, license: "test",
});

const photonHouse = (house = "10А") => ({
  type: "FeatureCollection",
  features: [{ geometry: { type: "Point", coordinates: [49.66, 58.6] }, properties: { housenumber: house, street: "улица Ленина", city: "Киров", type: "house" } }],
});
const yandexHouse = (text = "Киров, улица Ленина, дом 10 литера А") => ({
  response: { GeoObjectCollection: { featureMember: [{ GeoObject: { Point: { pos: "49.66 58.60" }, metaDataProperty: { GeocoderMetaData: { precision: "exact", kind: "house", text } } } }] } },
});

describe("geocode providers", () => {
  it("classifies house-level results as high and street/admin results as lower confidence", () => {
    expect(classifyPrecision("exact", "house")).toBe("high");
    expect(classifyPrecision("street", "street")).toBe("medium");
    expect(classifyPrecision("exact", "province")).toBe("low");
    expect(classifyOsmAddress("10А", "Ленина")).toBe("high");
    expect(classifyOsmAddress(null, "Ленина")).toBe("medium");
  });

  it("uses local Photon by default with a territory bbox and Russian language", async () => {
    let requested = "";
    const fakeFetch = (async (input: string | URL) => { requested = String(input); return new Response(JSON.stringify(photonHouse()), { status: 200 }); }) as typeof fetch;
    const result = await geocodePhotonAddress("Киров, Ленина 10А", { fetch: fakeFetch, bbox: [49, 58, 50, 59] });
    const endpoint = new URL(requested);
    expect(endpoint.origin + endpoint.pathname).toBe("http://localhost:2322/api");
    expect(Object.fromEntries(endpoint.searchParams)).toMatchObject({ q: "Киров, Ленина 10А", limit: "1", lang: "ru", bbox: "49,58,50,59" });
    expect(result).toMatchObject({ lon: 49.66, lat: 58.6, confidence: "high" });
  });

  it("retries Photon without a language override when an older local index rejects ru", async () => {
    const requests: string[] = [];
    const fakeFetch = (async (input: string | URL) => {
      const endpoint = new URL(String(input));
      requests.push(endpoint.toString());
      return endpoint.searchParams.has("lang")
        ? new Response(JSON.stringify({ lang: [{ message: "Language is not supported" }] }), { status: 400 })
        : new Response(JSON.stringify(photonHouse()), { status: 200 });
    }) as typeof fetch;
    const result = await geocodePhotonAddress("Киров, Ленина 10А", { fetch: fakeFetch, retries: 1 });
    expect(result?.confidence).toBe("high");
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]).searchParams.get("lang")).toBe("ru");
    expect(new URL(requests[1]).searchParams.has("lang")).toBe(false);
  });

  it("requires an explicit Nominatim endpoint and sends a bounded jsonv2 request", async () => {
    expect(() => resolveGeocodeOptions({ provider: "nominatim" })).toThrow("NOMINATIM_URL");
    let requested = "";
    const fakeFetch = (async (input: string | URL) => { requested = String(input); return new Response(JSON.stringify([{ lon: "49.66", lat: "58.60", address: { house_number: "10А", road: "улица Ленина", city: "Киров" } }]), { status: 200 }); }) as typeof fetch;
    const result = await geocodeNominatimAddress("Киров, Ленина 10А", { nominatimUrl: "http://nominatim:8080", fetch: fakeFetch, bbox: [49, 58, 50, 59] });
    const endpoint = new URL(requested);
    expect(endpoint.origin + endpoint.pathname).toBe("http://nominatim:8080/search");
    expect(Object.fromEntries(endpoint.searchParams)).toMatchObject({ format: "jsonv2", addressdetails: "1", limit: "1", bounded: "1", viewbox: "49,59,50,58" });
    expect(result?.confidence).toBe("high");
  });

  it("requires a key for Yandex and preserves its address precision", async () => {
    expect(() => resolveGeocodeOptions({ provider: "yandex" })).toThrow("GEOCODER_API_KEY");
    const fakeFetch = (async () => new Response(JSON.stringify(yandexHouse()), { status: 200 })) as typeof fetch;
    const result = await geocodeYandexAddress("Киров, Ленина 10А", { apiKey: "test", fetch: fakeFetch });
    expect(result).toMatchObject({ lat: 58.6, lon: 49.66, precision: "exact", confidence: "high" });
  });

  it("defaults Yandex to a 1000-request budget", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => record(String(index), `г. Киров, ул. Ленина, д. ${index + 1}`));
    const fakeFetch = (async () => new Response(JSON.stringify(yandexHouse("Киров, улица Ленина, дом 1")), { status: 200 })) as typeof fetch;
    const result = await geocodeEgrknRecords(rows, { provider: "yandex", apiKey: "test", fetch: fakeFetch, sleep: noSleep, sleepMs: 0 });
    expect(result).toMatchObject({ total: 1000, skipped: 1, primaryCalls: 1000 });
  });

  it("does not limit local Photon unless an operator supplies --limit", async () => {
    const rows = [record("1", "г. Киров, ул. Ленина, д. 10А"), record("2", "г. Киров, ул. Ленина, д. 11А")];
    let calls = 0;
    const fakeFetch = (async () => { calls += 1; return new Response(JSON.stringify(photonHouse(calls === 1 ? "10А" : "11А")), { status: 200 }); }) as typeof fetch;
    const result = await geocodeEgrknRecords(rows, { fetch: fakeFetch, sleep: noSleep, sleepMs: 0 });
    expect(result).toMatchObject({ total: 2, skipped: 0, high: 2, primaryCalls: 2, fallbackCalls: 0 });
  });

  it("uses an explicit fallback after a non-accepted primary result and preserves its audit trail", async () => {
    const fakeFetch = (async (input: string | URL) => {
      const endpoint = new URL(String(input));
      if (endpoint.hostname === "localhost") return new Response(JSON.stringify({ type: "FeatureCollection", features: [{ geometry: { type: "Point", coordinates: [49.66, 58.6] }, properties: { street: "улица Ленина", type: "street" } }] }), { status: 200 });
      return new Response(JSON.stringify(yandexHouse()), { status: 200 });
    }) as typeof fetch;
    const result = await geocodeEgrknRecords([record()], { provider: "photon", fallback: "yandex", apiKey: "test", fetch: fakeFetch, sleep: noSleep, sleepMs: 0 });
    expect(result).toMatchObject({ high: 1, primaryCalls: 1, fallbackCalls: 1 });
    expect(result.evidence[0]).toMatchObject({ provider: "yandex", addressCompatible: true });
    expect(result.evidence[0].attempts.map((attempt) => attempt.outcome)).toEqual(["low-precision", "accepted"]);
  });

  it("caps Yandex fallback calls at the free-tier budget", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => record(String(index), `г. Киров, ул. Ленина, д. ${index + 1}`));
    let yandexCalls = 0;
    const fakeFetch = (async (input: string | URL) => {
      const endpoint = new URL(String(input));
      if (endpoint.hostname === "localhost") return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), { status: 200 });
      yandexCalls += 1;
      return new Response(JSON.stringify({ response: { GeoObjectCollection: { featureMember: [] } } }), { status: 200 });
    }) as typeof fetch;
    const result = await geocodeEgrknRecords(rows, { provider: "photon", fallback: "yandex", apiKey: "test", fetch: fakeFetch, sleep: noSleep, sleepMs: 0 });
    expect(result).toMatchObject({ fallbackCalls: 1000, yandexBudgetSkipped: 1 });
    expect(yandexCalls).toBe(1000);
  });

  it("keeps a primary address conflict in the accepted fallback audit trail", async () => {
    const fakeFetch = (async (input: string | URL) => {
      const endpoint = new URL(String(input));
      if (endpoint.hostname === "localhost") return new Response(JSON.stringify(photonHouse("10")), { status: 200 });
      return new Response(JSON.stringify(yandexHouse()), { status: 200 });
    }) as typeof fetch;
    const result = await geocodeEgrknRecords([record()], { provider: "photon", fallback: "yandex", apiKey: "test", fetch: fakeFetch, sleep: noSleep, sleepMs: 0 });
    expect(result.evidence[0].attempts.map((attempt) => attempt.outcome)).toEqual(["address-conflict", "accepted"]);
    expect(result.audit[0]).toMatchObject({ accepted: true });
  });

  it("keeps an unresolved address conflict in the geocode audit", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify(photonHouse("10")), { status: 200 })) as typeof fetch;
    const result = await geocodeEgrknRecords([record()], { fetch: fakeFetch, sleep: noSleep, sleepMs: 0 });
    expect(result).toMatchObject({ high: 0, conflicted: 1 });
    expect(result.audit[0]).toMatchObject({ accepted: false });
    expect(result.audit[0].attempts[0].outcome).toBe("address-conflict");
  });

  it("rejects a same-provider fallback before performing requests", () => {
    expect(() => resolveGeocodeOptions({ provider: "photon", fallback: "photon" })).toThrow("must differ");
  });

  it("prepares an address by stripping the Russia prefix", () => {
    expect(prepareAddress("Россия, Кировская область, г. Киров")).toBe("Кировская область, г. Киров");
  });

  // ── P1 address classification ─────────────────────────────────────────

  describe("classifyAddress", () => {
    it("classifies a standard address with house number", () => {
      expect(classifyAddress("Кировская область, г. Киров, ул. Ленина, д. 10")).toBe("standard");
      expect(classifyAddress("г. Киров, ул. Московская, 25 литера А")).toBe("standard");
      expect(classifyAddress("Кировская область, Уржумский район, с. Каринка, ул. Школьная, 1")).toBe("standard");
    });

    it("classifies a compound address with range or владение", () => {
      expect(classifyAddress("Кировская область, г. Киров, ул. Ленина, д. 3-5")).toBe("compound");
      expect(classifyAddress("г. Киров, ул. Свободы, владение 12")).toBe("compound");
      expect(classifyAddress("Киров, ул. Ленина, 10/12")).toBe("compound");
    });

    it("classifies a relative address without house number", () => {
      expect(classifyAddress("Кировская область, г. Киров, ул. Ленина")).toBe("relative");
      expect(classifyAddress("рядом с домом 10 по ул. Ленина")).toBe("relative");
      expect(classifyAddress("Кировская область, г. Уржум, ул. Советская")).toBe("relative");
    });

    it("classifies an unstructured address", () => {
      expect(classifyAddress(null)).toBe("unstructured");
      expect(classifyAddress("")).toBe("unstructured");
      expect(classifyAddress("Не идентифицировано")).toBe("unstructured");
    });
  });

  describe("extractAddressParts", () => {
    it("extracts city and state from a postal address", () => {
      const parts = extractAddressParts("Кировская область, г. Киров, ул. Ленина, д. 10");
      expect(parts.city).toBe("Киров");
      expect(parts.state).toContain("Кировская");
    });

    it("extracts a village settlement label", () => {
      const parts = extractAddressParts("Кировская область, Уржумский район, с. Каринка, ул. Школьная, 1");
      expect(parts.city).toBe("Каринка");
    });
  });

  // ── P1 Photon /structured ─────────────────────────────────────────────

  describe("geocodePhotonAddressStructured", () => {
    it("sends a structured Photon query when street/house/city are known", async () => {
      let requested = "";
      const fakeFetch = (async (input: string | URL) => {
        requested = String(input);
        return new Response(JSON.stringify({ type: "FeatureCollection", features: [{ geometry: { type: "Point", coordinates: [49.66, 58.6] }, properties: { housenumber: "10", street: "улица Ленина", city: "Киров", type: "house" } }] }), { status: 200 });
      }) as typeof fetch;
      const result = await geocodePhotonAddressStructured("улица Ленина", "10", "Киров", "Кировская область", { fetch: fakeFetch });
      const endpoint = new URL(requested);
      expect(endpoint.origin + endpoint.pathname).toBe("http://localhost:2322/structured");
      expect(endpoint.searchParams.get("housenumber")).toBe("10");
      expect(endpoint.searchParams.get("street")).toBe("улица Ленина");
      expect(endpoint.searchParams.get("city")).toBe("Киров");
      expect(result).toMatchObject({ lon: 49.66, lat: 58.6, confidence: "high" });
    });

    it("returns null when /structured returns empty, allowing /api fallback", async () => {
      const fakeFetch = (async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), { status: 200 })) as typeof fetch;
      const result = await geocodePhotonAddressStructured("улица Ленина", "999", "Киров", "Кировская область", { fetch: fakeFetch });
      expect(result).toBeNull();
    });
  });

  // ── P1 ineligible-address audit & structured-first in geocodeEgrknRecords ──

  describe("geocodeEgrknRecords P1 address filtering", () => {
    const noSleep = async () => {};
    const egrknRecord = (id = "1", address = "г. Киров, ул. Ленина, д. 10 литера А") => SourceRecordSchema.parse({
      id: `egrkn:${id}`, source: "egrkn", sourceId: id, capturedAt: "2026-07-19T00:00:00.000Z", rawRef: "test",
      name: "Дом", address, geometry: null, fields: {}, license: "test",
    });

    it("skips ineligible addresses without sending any provider request", async () => {
      let calls = 0;
      const fakeFetch = (async () => { calls += 1; return new Response(JSON.stringify({ features: [] }), { status: 200 }); }) as typeof fetch;
      const result = await geocodeEgrknRecords([
        egrknRecord("1", "Киров, ул. Ленина"), // relative
        egrknRecord("2", "Киров, ул. Ленина, владение 3"), // compound
        egrknRecord("3", "Неизвестно"), // unstructured
      ], { fetch: fakeFetch, sleep: noSleep, sleepMs: 0 });
      expect(result.ineligible).toBe(3);
      expect(calls).toBe(0);
      expect(result.audit.every((entry) => entry.attempts[0].outcome === "ineligible-address")).toBe(true);
    });

    it("uses a city-less OSM building only after a strong building-name match", async () => {
      const hall = SourceRecordSchema.parse({
        id: "egrkn:hall", source: "egrkn", sourceId: "hall", capturedAt: "2026-07-19T00:00:00.000Z", rawRef: "test",
        name: "Здание Вятского реального училища, в котором учился Халтурин", address: "г. Киров, ул. Спасская, д. 67", geometry: null, fields: {}, license: "test",
      });
      let calls = 0;
      const fakeFetch = (async () => { calls += 1; return new Response(JSON.stringify({ features: [] }), { status: 200 }); }) as typeof fetch;
      const index = new Map([["_|спасская|67", [{ lon: 49.6602, lat: 58.6019, osmId: "w67", name: "Вятское реальное училище", isBuilding: true, corpus: null, letter: null }]]]);
      const result = await geocodeEgrknRecords([hall], { fetch: fakeFetch, osmAddressIndex: index, sleep: noSleep, sleepMs: 0 });
      expect(calls).toBe(0);
      expect(result.evidence[0]).toMatchObject({ method: "osm-address-match", provider: "osm-index", geometry: { coordinates: [49.6602, 58.6019] } });
    });

    it("preserves rejected coordinates in the audit attempt", async () => {
      const fakeFetch = (async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [{ geometry: { type: "Point", coordinates: [49.66, 58.6] }, properties: { housenumber: "1", street: "улица Ленина", city: "Киров", type: "house" } }] }), { status: 200 })) as typeof fetch;
      const result = await geocodeEgrknRecords([egrknRecord("1", "г. Киров, ул. Ленина, д. 10 литера А")], { fetch: fakeFetch, sleep: noSleep, sleepMs: 0 });
      const conflictAttempt = result.audit[0].attempts[0];
      expect(conflictAttempt.outcome).toBe("address-conflict");
      expect(conflictAttempt.geometry).toMatchObject({ type: "Point", coordinates: [49.66, 58.6] });
    });

    it("does not attempt fallback for an ineligible-address record", async () => {
      let yandexCalls = 0;
      const fakeFetch = (async (input: string | URL) => {
        const endpoint = new URL(String(input));
        if (endpoint.hostname === "localhost") return new Response(JSON.stringify({ features: [] }), { status: 200 });
        yandexCalls += 1;
        return new Response(JSON.stringify({ response: { GeoObjectCollection: { featureMember: [] } } }), { status: 200 });
      }) as typeof fetch;
      const result = await geocodeEgrknRecords([egrknRecord("1", "Киров, ул. Ленина")], { provider: "photon", fallback: "yandex", apiKey: "test", fetch: fakeFetch, sleep: noSleep, sleepMs: 0 });
      expect(result.ineligible).toBe(1);
      expect(yandexCalls).toBe(0);
      expect(result.audit[0].attempts).toHaveLength(1);
    });
  });
});
