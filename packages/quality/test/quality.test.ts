import { describe, expect, it } from "vitest";
import { profileSource, qualityGate } from "../src/index.js";
import type { SourceRecord } from "@poi-toolkit/core";
const row=(id:string):SourceRecord=>({id,source:"egrkn",sourceId:id,capturedAt:"2026-01-01T00:00:00.000Z",rawRef:"x",name:"N",address:null,geometry:{type:"Point",coordinates:[1,2]},fields:{region:"K"},license:null});
describe("quality",()=>it("detects repeated coordinates",()=>{const profile=profileSource("egrkn",[row("1"),row("2")]);expect(profile.repeatedCoordinates).toBe(2);expect(qualityGate(profile)).toContain("egrkn: repeated coordinates exceed 20%");}));
