import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, GeometrySchema, immutableNdjsonSnapshot, ImportManifestSchema, pointInAnyPolygon, readManifest } from "../src/index.js";
describe("file-first run",()=>{
  it("creates a valid manifest and immutable snapshot",async()=>{const root=await mkdtemp(join(tmpdir(),"poi-"));const {dir}=await createRun(root,"kirov-oblast","run-1");await immutableNdjsonSnapshot(dir,"egrkn",[{id:1}]);await expect(immutableNdjsonSnapshot(dir,"egrkn",[])).rejects.toThrow("immutable");expect((await readManifest(dir)).territory).toBe("kirov-oblast");expect(await readFile(join(dir,"raw","egrkn.ndjson"),"utf8")).toBe('{"id":1}\n');});
  it("refuses an existing run id",async()=>{const root=await mkdtemp(join(tmpdir(),"poi-"));await createRun(root,"kirov-oblast","run-1");await expect(createRun(root,"kirov-oblast","run-1")).rejects.toThrow("run already exists");});
  it("accepts numeric multi-geometries and rejects invalid coordinates",()=>{expect(GeometrySchema.safeParse({type:"MultiPolygon",coordinates:[[[[1,2],[3,4],[1,2]]]]}).success).toBe(true);expect(GeometrySchema.safeParse({type:"Point",coordinates:"not coordinates"}).success).toBe(false);expect(GeometrySchema.safeParse({type:"MultiPoint",coordinates:[[1,"bad"]]}).success).toBe(false);});
it("detects point-in-polygon for territory containment",()=>{
  const square=[{coordinates:[[[[0,0],[10,0],[10,10],[0,10],[0,0]]]]}];
  expect(pointInAnyPolygon(5,5,square)).toBe(true);
  expect(pointInAnyPolygon(15,5,square)).toBe(false);
  expect(pointInAnyPolygon(-1,-1,square)).toBe(false);
});
});

describe("import manifest schema",()=>{
  const sampleManifest=()=>({
    schemaVersion:1,
    kind:"nearventure.poi-product-import",
    datasetVersion:"pfo-run-1",
    generatedAt:"2026-07-26T12:00:00.000Z",
    territory:{slug:"pfo",profile:"nearventure-v1"},
    run:{id:"run-1"},
    toolkit:{version:"0.1.0",revision:"f27168e6f1a9d61e9a48b0569e51a05ebfa7bd66"},
    compatibility:{recordsFormat:"nearventure-poi-product-sql-v1",minImporterVersion:"1.0.0",maxImporterVersionExclusive:"2.0.0"},
    records:{path:"reports/poi_product_import.sql",count:2,bytes:120,sha256:"a".repeat(64)},
    counts:{categories:{heritage:1,monument:0,sights:0,religion:0,nature:0,museum:1},sourceRecords:{osm:1,egrkn:1}},
    provenance:{releaseManifest:{path:"release/manifest.json",sha256:"b".repeat(64)},collectionProvenance:{path:"reports/collection-provenance.json",sha256:"c".repeat(64)}},
    sourceAttribution:{notice:"© OpenStreetMap contributors (ODbL)",components:[{id:"osm",license:{name:"Open Database License 1.0",url:"https://www.openstreetmap.org/copyright"},attribution:"© OpenStreetMap contributors"},{id:"egrkn",license:{name:"Ministry of Culture open data terms",url:"https://opendata.mkrf.ru/"},attribution:"ЕГРКН (Минкультуры России)"}]},
  });
  const importSchema=async (name:string, mutate:(value:any)=>void)=>{
    it(`rejects ${name}`,()=>{
      const manifest=sampleManifest();
      mutate(manifest);
      expect(ImportManifestSchema.safeParse(manifest).success).toBe(false);
    });
  };
  it("accepts the canonical sample",()=>{expect(ImportManifestSchema.safeParse(sampleManifest()).success).toBe(true);});
  importSchema("an unknown top-level field",(m)=>void(m.extra=true));
  importSchema("an unknown kind",(m)=>void(m.kind="nearventure.other"));
  importSchema("an unknown schemaVersion",(m)=>void(m.schemaVersion=2));
  importSchema("an unknown recordsFormat",(m)=>void(m.compatibility.recordsFormat="sql-upsert"));
  importSchema("a non-40-hex toolkit revision",(m)=>void(m.toolkit.revision="unknown"));
  importSchema("a non-stable toolkit version",(m)=>void(m.toolkit.version="^1.0.0"));
  importSchema("a non-RFC3339 generatedAt",(m)=>void(m.generatedAt="2026-07-26 12:00:00"));
  importSchema("a non-canonical records path",(m)=>void(m.records.path="poi_product_import.sql"));
  importSchema("a bad records hash",(m)=>void(m.records.sha256="XYZ".repeat(24)));
  importSchema("an unknown provenance path",(m)=>void(m.provenance.releaseManifest.path="release/other.json"));
  importSchema("a category sum that misses records.count",(m)=>{m.records.count=5;});
  importSchema("a component id not in sourceRecords",(m)=>{m.sourceAttribution.components=[m.sourceAttribution.components[0]];});
  importSchema("a duplicate component id",(m)=>{m.sourceAttribution.components=[m.sourceAttribution.components[0],{...m.sourceAttribution.components[0]}];});
  importSchema("an empty sourceAttribution.notice",(m)=>void(m.sourceAttribution.notice=""));
  importSchema("a relative component license url",(m)=>void(m.sourceAttribution.components[0].license.url="/copyright"));
  importSchema("an empty sourceRecords map",(m)=>void(m.counts.sourceRecords={}));
  importSchema("an unknown sourceRecords key",(m)=>void(m.counts.sourceRecords.bad=1));
  importSchema("a non-positive records.count",(m)=>void(m.records.count=0));
});
