import { SourceRecord } from "@poi-toolkit/core";
export type SourceProfile={source:string; total:number; located:number; named:number; repeatedCoordinates:number; fieldCoverage:Record<string,number>};
export function profileSource(source:string, records:SourceRecord[]):SourceProfile { const coordinates=new Map<string,number>(), fieldCoverage:Record<string,number>={}; let located=0,named=0; for(const r of records){if(r.geometry?.type==="Point"){located++;const key=JSON.stringify(r.geometry.coordinates);coordinates.set(key,(coordinates.get(key)??0)+1)}if(r.name)named++;for(const [key,value] of Object.entries(r.fields))if(value!==null&&value!==undefined&&value!=="")fieldCoverage[key]=(fieldCoverage[key]??0)+1;} return {source,total:records.length,located,named,repeatedCoordinates:[...coordinates.values()].filter(n=>n>1).reduce((a,n)=>a+n,0),fieldCoverage}; }
export function qualityGate(profile:SourceProfile, baseline?:SourceProfile):string[]{const failures:string[]=[];if(profile.total===0)failures.push(`${profile.source}: no records`);if(baseline&&profile.total<baseline.total*.7)failures.push(`${profile.source}: volume dropped by over 30%`);if(profile.repeatedCoordinates>profile.total*.2)failures.push(`${profile.source}: repeated coordinates exceed 20%`);return failures;}
export * from "./score.js";
export * from "./hardening.js";
export * from "./disposition.js";
