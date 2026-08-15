import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FieldClaim, GeometryEvidence, SourceRecord, egrknRecord, safeContainedPath } from "@poi-toolkit/core";
import { profileSource, qualityGate } from "@poi-toolkit/quality";
import { osmFieldClaims, osmGeometryEvidence, parseOsmGeoJsonSeq } from "@poi-toolkit/source-osm";
import { wikidataFieldClaims, wikidataGeometryEvidence, wikidataRecord } from "@poi-toolkit/source-wikidata";
import { wikivoyageFieldClaims, wikivoyageGeometryEvidence, wikivoyageRecord } from "@poi-toolkit/source-wikivoyage";
import { SourceRecordSchema } from "@poi-toolkit/core";

export type AddressClass = "exact" | "structured" | "relative" | "compound" | "missing" | "unstructured";
export type NativeGeometryClass = "object" | "complex" | "unknown";
export type UnresolvedGeometry = { sourceRecordId: string; reason: string };
export type NormalizeResult = { records: SourceRecord[]; geometryEvidence: GeometryEvidence[]; fieldClaims: FieldClaim[]; unresolvedGeometry: UnresolvedGeometry[]; quality: unknown };

/** Classifies EGRKN's textual address without promoting relative descriptions to exact locations. */
export function classifyEgrknAddress(address: string | null): AddressClass {
  if (!address?.trim()) return "missing";
  const value = address.toLowerCase();
  // JavaScript's `\\b` is ASCII-only, so use explicit Russian-aware token boundaries.
  if (/(?:^|[\s,;])в\s+районе(?:$|[\s,;])|(?:^|[\s,;])район(?:е|а)?(?:$|[\s,;])|\d+(?:[,.]\d+)?\s*(?:км|километр)|(?:^|[\s,;])(?:севернее|южнее|западнее|восточнее|около|вблизи|напротив)(?:$|[\s,;])/.test(value)) return "relative";
  if (/(?:^|[\s,;])(?:территори[яи]|ансамбл[ья]|комплекс[а-я]*|усадьб[а-я]*|монастыр[ья]|кладбищ[а-я]*|парк[а-я]*)(?:$|[\s,;])/.test(value)) return "compound";
  if (/(?:^|[\s,;])(?:д\.?|дом|строен[а-я]*|корп[а-я]*)\s*\d+[\dа-я/-]*/i.test(value)) return "exact";
  if (/(?:^|[\s,;])(?:г\.?|город|с\.?|село|деревн[а-я]*|ул\.?|улица|просп\.?|переул[а-я]*|площад[ья])(?:$|[\s,;])/i.test(value)) return "structured";
  return "unstructured";
}

export function classifyEgrknNativeGeometry(record: SourceRecord, addressClass: AddressClass): NativeGeometryClass {
  if (!record.geometry) return "unknown";
  const type = String(record.fields.objectType ?? "").toLowerCase();
  return addressClass === "compound" || /ансамбл|комплекс|территори|усадьб|монастыр|парк|кладбищ/.test(type) ? "complex" : "object";
}

export function normalizeEgrkn(rows: unknown[], rawPath = "raw/egrkn.ndjson", capturedAt = new Date().toISOString()): { records: SourceRecord[]; geometryEvidence: GeometryEvidence[]; fieldClaims: FieldClaim[]; unresolvedGeometry: UnresolvedGeometry[] } {
  const source = rows.map((row, index) => egrknRecord(row, `${rawPath}#${index + 1}`, capturedAt));
  const occurrences = new Map<string, number>();
  for (const record of source) if (record.geometry?.type === "Point") { const key = JSON.stringify(record.geometry.coordinates); occurrences.set(key, (occurrences.get(key) ?? 0) + 1); }
  const records: SourceRecord[] = [], geometryEvidence: GeometryEvidence[] = [], fieldClaims: FieldClaim[] = [], unresolvedGeometry: UnresolvedGeometry[] = [];
  for (const record of source) {
    const addressClass = classifyEgrknAddress(record.address);
    const nativeGeometry = classifyEgrknNativeGeometry(record, addressClass);
    const repeated = record.geometry?.type === "Point" && (occurrences.get(JSON.stringify(record.geometry.coordinates)) ?? 0) > 1;
    const normalized = { ...record, fields: { ...record.fields, addressClassification: addressClass, nativeGeometryClassification: nativeGeometry } };
    records.push(normalized);
    fieldClaims.push(...Object.entries(normalized.fields).map(([field, value]) => ({ sourceRecordId: normalized.id, field, value, provenance: normalized.rawRef, observedAt: normalized.capturedAt, license: normalized.license })));
    if (!normalized.geometry) { unresolvedGeometry.push({ sourceRecordId: normalized.id, reason: "missing-source-native-geometry" }); continue; }
    if (addressClass === "relative") unresolvedGeometry.push({ sourceRecordId: normalized.id, reason: "relative-address" });
    if (nativeGeometry === "unknown") unresolvedGeometry.push({ sourceRecordId: normalized.id, reason: "unknown-source-native-geometry" });
    if (repeated) unresolvedGeometry.push({ sourceRecordId: normalized.id, reason: "repeated-coordinate-group" });
    geometryEvidence.push({ sourceRecordId: normalized.id, geometry: normalized.geometry, method: "source-native", precision: repeated || nativeGeometry === "complex" ? "complex" : "object", precisionMeters: null, capturedAt: normalized.capturedAt });
  }
  return { records, geometryEvidence, fieldClaims, unresolvedGeometry };
}

export async function normalizeRun(runDir: string, capturedAt = new Date().toISOString()): Promise<NormalizeResult> {
  const child = (...parts: string[]) => safeContainedPath(runDir, ...parts);
  const all: SourceRecord[] = [], evidence: GeometryEvidence[] = [], claims: FieldClaim[] = [], unresolvedGeometry: UnresolvedGeometry[] = [];
  const egrkn = await readNdjsonIfPresent(await child("raw", "egrkn.ndjson"));
  if (egrkn) { const result = normalizeEgrkn(egrkn, "raw/egrkn.ndjson", capturedAt); appendInOrder(all, result.records); appendInOrder(evidence, result.geometryEvidence); appendInOrder(claims, result.fieldClaims); appendInOrder(unresolvedGeometry, result.unresolvedGeometry); }
  const osm = await readTextIfPresent(await child("raw", "osm.geojsonseq"));
  if (osm !== null) { const records = parseOsmGeoJsonSeq(osm, "raw/osm.geojsonseq", capturedAt); appendInOrder(all, records); for (const record of records) { const item = osmGeometryEvidence(record); if (item) evidence.push(item); else unresolvedGeometry.push({ sourceRecordId: record.id, reason: "missing-source-native-geometry" }); appendInOrder(claims, osmFieldClaims(record)); } }
  const wikidata = await readNdjsonIfPresent(await child("raw", "wikidata.ndjson"));
  if (wikidata) { const records = wikidata.map((row, index) => wikidataRecord(row as never, `raw/wikidata.ndjson#${index + 1}`, capturedAt)); appendInOrder(all, records); for (const record of records) { const item = wikidataGeometryEvidence(record); if (item) evidence.push(item); else unresolvedGeometry.push({ sourceRecordId: record.id, reason: "missing-source-native-geometry" }); appendInOrder(claims, wikidataFieldClaims(record)); } }
  const wikivoyage = await readNdjsonIfPresent(await child("raw", "wikivoyage.ndjson"));
  if (wikivoyage) { const records = wikivoyage.map((row, index) => wikivoyageRecord(row as never, `raw/wikivoyage.ndjson#${index + 1}`, capturedAt)); appendInOrder(all, records); for (const record of records) { const item = wikivoyageGeometryEvidence(record); if (item) evidence.push(item); else unresolvedGeometry.push({ sourceRecordId: record.id, reason: "missing-source-native-geometry" }); appendInOrder(claims, wikivoyageFieldClaims(record)); } }
  const wikivoyageNature = await readNdjsonIfPresent(await child("raw", "wikivoyage-nature.ndjson"));
  if (wikivoyageNature) { const records = wikivoyageNature.map((row, index) => SourceRecordSchema.parse({ ...(row as object), rawRef: `raw/wikivoyage-nature.ndjson#${index + 1}`, capturedAt })); appendInOrder(all, records); for (const record of records) { if (record.geometry) evidence.push({ sourceRecordId: record.id, geometry: record.geometry, method: "source-native", precision: record.fields.precise ? "object" : "complex", precisionMeters: null, capturedAt: record.capturedAt }); else unresolvedGeometry.push({ sourceRecordId: record.id, reason: "missing-source-native-geometry" }); appendInOrder(claims, Object.entries(record.fields).map(([field, value]) => ({ sourceRecordId: record.id, field, value, provenance: record.rawRef, observedAt: record.capturedAt, license: record.license }))); } }
  const mkrf = await readNdjsonIfPresent(await child("raw", "mkrf.ndjson"));
  if (mkrf) { const records = mkrf.map((row, index) => SourceRecordSchema.parse({ ...(row as object), rawRef: `raw/mkrf.ndjson#${index + 1}`, capturedAt })); appendInOrder(all, records); for (const record of records) { if (record.geometry) evidence.push({ sourceRecordId: record.id, geometry: record.geometry, method: "source-native", precision: "object", precisionMeters: null, capturedAt: record.capturedAt }); else unresolvedGeometry.push({ sourceRecordId: record.id, reason: "missing-source-native-geometry" }); appendInOrder(claims, Object.entries(record.fields).map(([field, value]) => ({ sourceRecordId: record.id, field, value, provenance: record.rawRef, observedAt: record.capturedAt, license: record.license }))); } }
  const profiles = [...new Set(all.map((record) => record.source))].map((source) => profileSource(source, all.filter((record) => record.source === source)));
  const quality = { profiles, failures: profiles.flatMap((profile) => qualityGate(profile)), unresolvedGeometry };
  await writeImmutable(await child("normalized", "source-records.ndjson"), all);
  await writeImmutable(await child("normalized", "geometry-evidence.ndjson"), evidence);
  await writeImmutable(await child("normalized", "field-claims.ndjson"), claims);
  await writeImmutable(await child("reports", "source-quality.json"), quality, true);
  return { records: all, geometryEvidence: evidence, fieldClaims: claims, unresolvedGeometry, quality };
}

/** Appends records without using argument-list expansion, which is bounded by the JS call stack. */
export function appendInOrder<T>(target: T[], values: Iterable<T>): void { for (const value of values) target.push(value); }

async function readNdjsonIfPresent(file: string): Promise<unknown[] | null> { const text = await readTextIfPresent(file); return text === null ? null : text.split(/\r?\n/).filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch { throw new Error(`Snapshot schema drift in ${file} line ${index + 1}: invalid JSON`); } }); }
async function readTextIfPresent(file: string): Promise<string | null> { try { return await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
async function writeImmutable(file: string, value: unknown, pretty = false): Promise<void> { await mkdir(join(file, ".."), { recursive: true }); try { await stat(file); throw new Error(`immutable normalized artifact already exists: ${file}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } const content = Array.isArray(value) && !pretty ? value.map((row) => JSON.stringify(row)).join("\n") + (value.length ? "\n" : "") : JSON.stringify(value, null, 2) + "\n"; await writeFile(file, content, { flag: "wx" }); }
