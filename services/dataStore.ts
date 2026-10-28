/**
 * Where region files live, for both kinds of data the app shows.
 *
 * Sample Data ships with the app under public/data/ and is read-only. Its
 * listing comes from public/data/index.json, written by
 * scripts/build-sample-index.mjs, because a static host cannot list a folder.
 *
 * My Data is the user's own, kept in IndexedDB in this browser. Each record is
 * one file under the same relative path the files have on disk and in a backup
 * zip ("{regionId}/wells.csv", "{regionId}/{aquifer}/raster_wte_x.json"), so
 * the format the importers write did not change when storage moved here.
 *
 * Every path starts with its region id, and a My Data region may not take a
 * sample region's id, so the first segment of a path says which store it is in.
 */

import JSZip from 'jszip';

export type DataSource = 'sample' | 'mine';

/** A region folder's region.json plus the data_{code}.csv files it holds. */
export interface RegionListing {
  [key: string]: any;
  id: string;
  name: string;
  dataFiles: string[];
  source: DataSource;
}

export interface StoredFile {
  text: string;
  /** Increments on every write; 0 for sample files, which never change. */
  version: number;
}

export interface SaveEntry {
  path: string;
  content: string;
  /** Reject the save if the file has been written since it was read at this version. */
  ifVersion?: number;
  /** Reject the save if the file exists (it was absent when read). */
  mustNotExist?: boolean;
}

export class SaveConflictError extends Error {
  constructor(public paths: string[]) {
    const names = paths.map(p => p.split('/').pop()).join(', ');
    super(
      `The data changed while you were working (${names}), probably from an import in another tab. ` +
      `Nothing was saved. Close and re-open this dialog to load the latest data, then try again.`
    );
  }
}

// ---------------------------------------------------------------------------
// Sample Data
// ---------------------------------------------------------------------------

interface SampleIndex {
  /** region.json fields plus dataFiles and every file path in the region */
  regions: { [key: string]: any; id: string; name: string; dataFiles: string[]; files: string[] }[];
  rasters: any[];
  models: any[];
}

const dataUrl = (path: string) => `${import.meta.env.BASE_URL}data/${path}`;

let samplePromise: Promise<SampleIndex> | null = null;
let sampleIds = new Set<string>();

function loadSampleIndex(): Promise<SampleIndex> {
  if (!samplePromise) {
    samplePromise = fetch(dataUrl('index.json'))
      .then(res => (res.ok ? res.json() : { regions: [], rasters: [], models: [] }))
      .catch(() => ({ regions: [], rasters: [], models: [] }))
      .then((index: SampleIndex) => {
        sampleIds = new Set(index.regions.map(r => r.id));
        return index;
      });
  }
  return samplePromise;
}

const regionOf = (path: string) => path.split('/')[0];

/** True for a path or region id in Sample Data. Valid once listRegions() has run. */
export const isSample = (pathOrId: string) => sampleIds.has(regionOf(pathOrId));

/** Ids a new My Data region may not take. */
export async function reservedRegionIds(): Promise<Set<string>> {
  await loadSampleIndex();
  return new Set(sampleIds);
}

// ---------------------------------------------------------------------------
// My Data (IndexedDB)
// ---------------------------------------------------------------------------

const DB_NAME = 'aquifer-analyst-my-data';
const FILES = 'files';
const SUMMARIES = 'summaries';
const META = 'meta';

interface FileRecord { path: string; text: string; version: number }
/** The listing fields of a raster or model, kept apart so listing never parses the grids. */
interface SummaryRecord { path: string; kind: 'raster' | 'model'; summary: any }

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore(FILES, { keyPath: 'path' });
        db.createObjectStore(SUMMARIES, { keyPath: 'path' });
        db.createObjectStore(META, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Every key under a folder: "utah/" through "utah/￿". */
const under = (folder: string) => IDBKeyRange.bound(`${folder}/`, `${folder}/￿`);

const RASTER_RE = /^([^/]+)\/([^/]+)\/raster_([a-z0-9_]+?)_(.+)\.json$/;
const MODEL_RE = /^([^/]+)\/([^/]+)\/model_.+\.json$/;

/** The fields /api/list-rasters and /api/list-models used to return. */
function summarize(path: string, text: string): SummaryRecord | null {
  const raster = path.match(RASTER_RE);
  const model = !raster && path.match(MODEL_RE);
  if (!raster && !model) return null;
  let data: any;
  try { data = JSON.parse(text); } catch { return null; }
  const file = path.split('/').pop()!;
  const regionId = regionOf(path);
  if (raster) {
    return {
      path, kind: 'raster', summary: {
        title: data.title || file,
        code: data.code || raster[4],
        aquiferId: data.aquiferId || '',
        aquiferName: data.aquiferName || '',
        regionId: data.regionId || regionId,
        filePath: path,
        dataType: data.dataType || raster[3],
        params: data.params || {},
        createdAt: data.createdAt || '',
        options: data.options || undefined,
        generatedAt: data.generatedAt || undefined,
      },
    };
  }
  return {
    path, kind: 'model', summary: {
      title: data.title || file,
      code: data.code || file.replace('.json', ''),
      aquiferId: data.aquiferId || '',
      aquiferName: data.aquiferName || '',
      regionId: data.regionId || regionId,
      filePath: path,
      dataType: data.dataType || 'wte',
      params: data.params || {},
      createdAt: data.createdAt || '',
      wellMetrics: data.wellMetrics || {},
    },
  };
}

// ---------------------------------------------------------------------------
// Backup status
// ---------------------------------------------------------------------------

export interface BackupStatus {
  /** ISO time of the last backup download, or null if there has never been one. */
  lastBackupAt: string | null;
  /** Saves and deletes since then; a save of several files at once counts as one. */
  changesSinceBackup: number;
}

const statusListeners = new Set<(s: BackupStatus) => void>();

/** Called after every change to My Data and every backup. Returns an unsubscribe. */
export function onBackupStatus(fn: (s: BackupStatus) => void): () => void {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const db = await openDb();
  const rec = await request(db.transaction(META, 'readonly').objectStore(META).get('backup'));
  return { lastBackupAt: rec?.lastBackupAt ?? null, changesSinceBackup: rec?.changesSinceBackup ?? 0 };
}

/** Bump the change count inside a write transaction that includes META. */
function countChange(tx: IDBTransaction, n: number) {
  const meta = tx.objectStore(META);
  const get = meta.get('backup');
  get.onsuccess = () => {
    const rec = get.result ?? { key: 'backup', lastBackupAt: null, changesSinceBackup: 0 };
    rec.changesSinceBackup += n;
    meta.put(rec);
  };
}

async function announceStatus() {
  const status = await getBackupStatus();
  for (const fn of statusListeners) fn(status);
}

/**
 * Ask the browser not to evict My Data under storage pressure. Granted
 * silently in Chrome and Edge for a site in regular use; Firefox may ask the
 * user. Worth trying once, on the first save.
 */
let persistRequested = false;
function requestPersistence() {
  if (persistRequested) return;
  persistRequested = true;
  navigator.storage?.persist?.().catch(() => { /* not supported; the backup is the safety net */ });
}

// ---------------------------------------------------------------------------
// The API the app uses
// ---------------------------------------------------------------------------

/** All regions, sample first, then the user's. */
export async function listRegions(): Promise<RegionListing[]> {
  const index = await loadSampleIndex();
  const sample: RegionListing[] = index.regions.map(({ files: _files, ...r }) => ({ ...r, source: 'sample' as const }));

  const db = await openDb();
  const tx = db.transaction(FILES, 'readonly');
  const store = tx.objectStore(FILES);
  const keys = (await request(store.getAllKeys())) as string[];
  const mine: RegionListing[] = [];
  for (const key of keys) {
    const m = key.match(/^([^/]+)\/region\.json$/);
    if (!m) continue;
    const rec = (await request(store.get(key))) as FileRecord;
    let meta: any;
    try { meta = JSON.parse(rec.text); } catch { continue; }
    const dataFiles = keys
      .filter(k => k.startsWith(`${m[1]}/data_`) && k.endsWith('.csv') && k.split('/').length === 2)
      .map(k => k.split('/')[1]);
    mine.push({ ...meta, id: meta.id ?? m[1], dataFiles, source: 'mine' });
  }
  mine.sort((a, b) => a.name.localeCompare(b.name));
  return [...sample, ...mine];
}

/** A file's text and version, or null if there is no such file. */
export async function readFile(path: string): Promise<StoredFile | null> {
  await loadSampleIndex();
  if (isSample(path)) {
    const res = await fetch(dataUrl(path));
    // A static host answers an unknown path with index.html; that is a miss
    const type = res.headers.get('content-type') || '';
    if (!res.ok || (type.includes('text/html') && !path.endsWith('.html'))) return null;
    return { text: await res.text(), version: 0 };
  }
  const db = await openDb();
  const rec = (await request(db.transaction(FILES, 'readonly').objectStore(FILES).get(path))) as FileRecord | undefined;
  return rec ? { text: rec.text, version: rec.version } : null;
}

export async function readText(path: string): Promise<string | null> {
  return (await readFile(path))?.text ?? null;
}

export async function readJson<T = any>(path: string): Promise<T | null> {
  const text = await readText(path);
  return text === null ? null : (JSON.parse(text) as T);
}

const refuseSample = (paths: string[]) => {
  const sample = paths.filter(isSample);
  if (sample.length) throw new Error(`Sample Data is read-only (${sample.join(', ')}). Copy the region to My Data to change it.`);
};

/** Write files to My Data, all or none. */
export async function saveFiles(entries: SaveEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await loadSampleIndex();
  refuseSample(entries.map(e => e.path));
  requestPersistence();

  const db = await openDb();
  const tx = db.transaction([FILES, SUMMARIES, META], 'readwrite');
  const files = tx.objectStore(FILES);
  const summaries = tx.objectStore(SUMMARIES);

  const current = await Promise.all(entries.map(e => request(files.get(e.path)) as Promise<FileRecord | undefined>));
  const conflicts = entries
    .filter((e, i) =>
      (e.mustNotExist && current[i]) ||
      (e.ifVersion !== undefined && (!current[i] || current[i]!.version !== e.ifVersion)))
    .map(e => e.path);
  if (conflicts.length) {
    tx.abort();
    throw new SaveConflictError(conflicts);
  }

  entries.forEach((e, i) => {
    files.put({ path: e.path, text: e.content, version: (current[i]?.version ?? 0) + 1 });
    const summary = summarize(e.path, e.content);
    if (summary) summaries.put(summary);
  });
  countChange(tx, 1);
  await done(tx);
  announceStatus();
}

export async function deleteFile(path: string): Promise<void> {
  await loadSampleIndex();
  refuseSample([path]);
  const db = await openDb();
  const tx = db.transaction([FILES, SUMMARIES, META], 'readwrite');
  tx.objectStore(FILES).delete(path);
  tx.objectStore(SUMMARIES).delete(path);
  countChange(tx, 1);
  await done(tx);
  announceStatus();
}

/** Delete a folder and everything under it, e.g. a whole region. */
export async function deleteFolder(folder: string): Promise<void> {
  await loadSampleIndex();
  refuseSample([folder]);
  const db = await openDb();
  const tx = db.transaction([FILES, SUMMARIES, META], 'readwrite');
  tx.objectStore(FILES).delete(under(folder));
  tx.objectStore(SUMMARIES).delete(under(folder));
  countChange(tx, 1);
  await done(tx);
  announceStatus();
}

/** Empty My Data entirely, backup status included. Sample Data is untouched. */
export async function deleteAllMyData(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([FILES, SUMMARIES, META], 'readwrite');
  tx.objectStore(FILES).clear();
  tx.objectStore(SUMMARIES).clear();
  tx.objectStore(META).clear();
  await done(tx);
  announceStatus();
}

export interface StorageInfo {
  /** Bytes this site uses in the browser, My Data and caches together; null if the browser won't say. */
  usage: number | null;
  /** Whether the browser has agreed not to evict it under storage pressure; null if unknown. */
  persisted: boolean | null;
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const [estimate, persisted] = await Promise.all([
    navigator.storage?.estimate?.().catch(() => null),
    navigator.storage?.persisted?.().catch(() => null),
  ]);
  return { usage: estimate?.usage ?? null, persisted: persisted ?? null };
}

async function listSummaries(regionId: string, kind: 'raster' | 'model'): Promise<any[]> {
  const index = await loadSampleIndex();
  if (isSample(regionId)) {
    return (kind === 'raster' ? index.rasters : index.models).filter(m => regionOf(m.filePath) === regionId);
  }
  const db = await openDb();
  const recs = (await request(db.transaction(SUMMARIES, 'readonly').objectStore(SUMMARIES).getAll(under(regionId)))) as SummaryRecord[];
  return recs.filter(r => r.kind === kind).map(r => r.summary);
}

export const listRasters = (regionId: string) => listSummaries(regionId, 'raster');
export const listModels = (regionId: string) => listSummaries(regionId, 'model');

/** Move a raster or model JSON to a new path, updating its code and title. */
export async function renameAnalysis(oldPath: string, newPath: string, newCode: string, newTitle: string): Promise<void> {
  const file = await readFile(oldPath);
  if (!file) throw new Error(`File not found: ${oldPath}`);
  const data = JSON.parse(file.text);
  data.code = newCode;
  data.title = newTitle;
  await saveFiles([{ path: newPath, content: JSON.stringify(data) }]);
  if (newPath !== oldPath) await deleteFile(oldPath);
}

/** Every file path under a region, in either store. */
export async function listRegionFiles(regionId: string): Promise<string[]> {
  const index = await loadSampleIndex();
  if (isSample(regionId)) {
    const region = index.regions.find(r => r.id === regionId);
    return region?.files ?? [];
  }
  const db = await openDb();
  return (await request(db.transaction(FILES, 'readonly').objectStore(FILES).getAllKeys(under(regionId)))) as string[];
}

// ---------------------------------------------------------------------------
// Backup, restore and copy
// ---------------------------------------------------------------------------

/** Add a region's files to a zip under "{newId ?? regionId}/...". */
async function addRegionToZip(zip: JSZip, regionId: string, newId = regionId) {
  for (const path of await listRegionFiles(regionId)) {
    const text = await readText(path);
    if (text !== null) zip.file(`${newId}${path.slice(regionId.length)}`, text);
  }
}

const saveBlob = (blob: Blob, filename: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/** Download every My Data region as one zip and mark the data as backed up. */
export async function downloadBackup(): Promise<void> {
  const regions = (await listRegions()).filter(r => r.source === 'mine');
  const zip = new JSZip();
  for (const r of regions) await addRegionToZip(zip, r.id);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  saveBlob(blob, `aquifer-analyst-my-data-${new Date().toISOString().slice(0, 10)}.zip`);

  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  tx.objectStore(META).put({ key: 'backup', lastBackupAt: new Date().toISOString(), changesSinceBackup: 0 });
  await done(tx);
  announceStatus();
}

/** Download one region, from either store, in the same format as a backup. */
export async function downloadRegion(regionId: string): Promise<void> {
  const zip = new JSZip();
  await addRegionToZip(zip, regionId);
  saveBlob(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), `${regionId}.zip`);
}

export interface RestorePlan {
  zip: JSZip;
  /** Region folders in the zip, with their names. */
  regions: { id: string; name: string; replaces: boolean; renamedTo?: string }[];
}

/** Read a backup zip and say what restoring it would do, without changing anything. */
export async function planRestore(file: Blob): Promise<RestorePlan> {
  const zip = await JSZip.loadAsync(file);
  const existing = new Set((await listRegions()).filter(r => r.source === 'mine').map(r => r.id));
  const reserved = await reservedRegionIds();
  const regions: RestorePlan['regions'] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    const m = path.match(/^([^/]+)\/region\.json$/);
    if (!m || entry.dir) continue;
    let name = m[1];
    try { name = JSON.parse(await entry.async('text')).name || name; } catch { /* keep the folder name */ }
    // A backup made before Sample Data existed may hold a region with a sample id
    const renamedTo = reserved.has(m[1]) ? uniqueId(`${m[1]}-copy`, new Set([...existing, ...reserved])) : undefined;
    regions.push({ id: m[1], name, replaces: !renamedTo && existing.has(m[1]), renamedTo });
  }
  return { zip, regions };
}

/** Write a planned restore into My Data. A region with the same id is replaced. */
export async function applyRestore(plan: RestorePlan): Promise<void> {
  for (const region of plan.regions) {
    const targetId = region.renamedTo ?? region.id;
    const entries: SaveEntry[] = [];
    for (const [path, entry] of Object.entries(plan.zip.files)) {
      if (entry.dir || !path.startsWith(`${region.id}/`)) continue;
      let text = await entry.async('text');
      if (path === `${region.id}/region.json`) text = normalizeRegionJson(text, targetId);
      entries.push({ path: `${targetId}${path.slice(region.id.length)}`, content: text });
    }
    if (region.replaces) await deleteFolder(targetId);
    await saveFiles(entries);
  }
}

/** Copy a region (normally a sample one) into My Data under a fresh id. Returns the id. */
export async function copyToMyData(regionId: string, newName?: string): Promise<string> {
  const regions = await listRegions();
  const source = regions.find(r => r.id === regionId);
  if (!source) throw new Error(`No region ${regionId}`);
  const taken = new Set([...regions.map(r => r.id), ...(await reservedRegionIds())]);
  const newId = uniqueId(source.source === 'sample' ? regionId : `${regionId}-copy`, taken);
  const entries: SaveEntry[] = [];
  for (const path of await listRegionFiles(regionId)) {
    let text = await readText(path);
    if (text === null) continue;
    if (path === `${regionId}/region.json`) text = normalizeRegionJson(text, newId, newName);
    else if (/\/(raster|model)_[^/]+\.json$/.test(path)) text = retargetAnalysis(text, newId);
    entries.push({ path: `${newId}${path.slice(regionId.length)}`, content: text });
  }
  await saveFiles(entries);
  return newId;
}

/** "utah" if free, otherwise "utah-2", "utah-3", ... */
export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Set a region.json's id (and optionally name), and migrate the legacy dataTypes field. */
function normalizeRegionJson(text: string, id: string, name?: string): string {
  try {
    const raw = JSON.parse(text);
    raw.id = id;
    if (name) raw.name = name;
    if (Array.isArray(raw.dataTypes) && !raw.customDataTypes) {
      raw.customDataTypes = raw.dataTypes.filter((dt: any) => dt.code !== 'wte');
      delete raw.dataTypes;
    }
    return JSON.stringify(raw, null, 2);
  } catch {
    return text;
  }
}

/**
 * Rasters and models record their region id, and a raster built from a model
 * records the model's path (params.temporal.modelFilePath); a copy must point
 * at the new region. Arrays of numbers (the grids) are skipped, not walked.
 */
function retargetAnalysis(text: string, regionId: string): string {
  const walk = (node: any) => {
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'object') node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'regionId' && typeof value === 'string') node[key] = regionId;
      else if (key === 'modelFilePath' && typeof value === 'string') node[key] = value.replace(/^[^/]+\//, `${regionId}/`);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  try {
    const data = JSON.parse(text);
    walk(data);
    return JSON.stringify(data);
  } catch {
    return text;
  }
}
