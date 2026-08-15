import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOsmGeoJsonSeq, parseOsmGeoJsonSeq } from "../src/index.js";
describe("osmium wrapper",()=>{
  it("requires a local PBF",async()=>{await expect(extractOsmGeoJsonSeq({pbf:"missing.osm.pbf",output:"out.geojsonseq",bbox:[1,2,3,4]})).rejects.toThrow();});
  it("extracts bbox, filters tags, exports GeoJSON sequence, and cleans temporary files",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"osm-")),pbf=join(dir,"input.osm.pbf"),output=join(dir,"osm.geojsonseq");
    await writeFile(pbf,"pbf");const commands:string[][]=[];
    await extractOsmGeoJsonSeq({pbf,output,bbox:[46,56.3,55,61],run:async (_bin,args)=>{commands.push(args);if(args[0]==="export")await writeFile(output,'{"type":"Feature"}\n');}});
    expect(commands[0]).toEqual(expect.arrayContaining(["extract","-b","46,56.3,55,61",pbf]));
    expect(commands[1]).toEqual(expect.arrayContaining([
      "tags-filter", "nwr/historic", "nwr/tourism",
      "nwr/water=lake", "nwr/water=pond", "nwr/water=reservoir",
      "nwr/geological", "nwr/leisure=nature_reserve",
    ]));
    expect(commands[2]).toEqual(["export",expect.any(String),"-f","geojsonseq","--add-unique-id=type_id","-o",output]);
    await expect(extractOsmGeoJsonSeq({pbf,output,bbox:[1,2,3,4],run:async()=>undefined})).rejects.toThrow("immutable");
  });
  it("parses record-separator GeoJSON sequences and rejects missing stable ids", () => {
    const records = parseOsmGeoJsonSeq(`\u001e{"type":"Feature","id":"n42","properties":{"name":"Башня","historic":"tower"},"geometry":{"type":"Point","coordinates":[49,58]}}\n`);
    expect(records[0]).toMatchObject({ sourceId: "n42", name: "Башня", fields: { tags: { historic: "tower" } } });
    expect(() => parseOsmGeoJsonSeq('{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[49,58]}}')).toThrow("missing unique id");
  });
});
