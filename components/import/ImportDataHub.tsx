import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, MapPin, Layers, Navigation, BarChart3, Plus, Settings, Download, Upload, Loader2, CheckCircle2, AlertTriangle, Pencil } from 'lucide-react';
import JSZip from 'jszip';
import { RegionMeta, DataType, ParameterCatalog } from '../../types';
import { freshFetch, saveFiles } from '../../services/importUtils';
import { loadCatalog, computeEffectiveDataTypes } from '../../services/catalog';
import RegionImporter from './RegionImporter';
import AquiferImporter from './AquiferImporter';
import WellImporter from './WellImporter';
import MeasurementImporter from './MeasurementImporter';
import DataTypeEditor from './DataTypeEditor';
import RegionEditor from './RegionEditor';
import AquiferEditor from './AquiferEditor';

interface ImportDataHubProps {
  onClose: () => void;
  onDataChanged: () => void;
  initialRegionId?: string | null;
}

interface RegionInfo extends RegionMeta {
  aquiferCount: number;
  wellCount: number;
  measurementCounts: Record<string, number>;
  effectiveDataTypes: DataType[];
  bounds: [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]
}

async function fetchRegionList(catalog: ParameterCatalog | null): Promise<RegionInfo[]> {
  const res = await fetch('/api/regions');
  if (!res.ok) return [];
  const rawMetas: any[] = await res.json();
  // Normalize legacy dataTypes → customDataTypes in memory
  const metas: RegionMeta[] = rawMetas.map(m => ({
    id: m.id,
    name: m.name,
    lengthUnit: m.lengthUnit || 'ft',
    singleUnit: !!m.singleUnit,
    customDataTypes: Array.isArray(m.customDataTypes)
      ? m.customDataTypes
      : Array.isArray(m.dataTypes)
        ? m.dataTypes.filter((dt: DataType) => dt.code !== 'wte')
        : [],
    dataFiles: Array.isArray(m.dataFiles) ? m.dataFiles : [],
  }));

  const infos: RegionInfo[] = [];
  for (const meta of metas) {
    const effectiveDataTypes = computeEffectiveDataTypes(meta, catalog);
    const info: RegionInfo = {
      ...meta,
      aquiferCount: 0,
      wellCount: 0,
      measurementCounts: {},
      effectiveDataTypes,
      bounds: [0, 0, 0, 0]
    };

    // Load region bounds from geojson
    try {
      const gjRes = await freshFetch(`/data/${meta.id}/region.geojson`);
      if (gjRes.ok) {
        const gj = await gjRes.json();
        const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        const visitCoords = (arr: any) => {
          if (typeof arr[0] === 'number') {
            const [lng, lat] = arr;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
          } else {
            for (const child of arr) visitCoords(child);
          }
        };
        for (const f of features) {
          const coords = f.geometry?.coordinates;
          if (!coords) continue;
          visitCoords(coords);
        }
        info.bounds = [minLat, minLng, maxLat, maxLng];
      }
    } catch {}

    // Count aquifers
    try {
      const aqRes = await freshFetch(`/data/${meta.id}/aquifers.geojson`);
      if (aqRes.ok) {
        const gj = await aqRes.json();
        const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
        const ids = new Set(features.map((f: any) => String(f.properties?.aquifer_id || '')));
        info.aquiferCount = ids.size;
      }
    } catch {}

    // Count wells
    try {
      const wRes = await freshFetch(`/data/${meta.id}/wells.csv`);
      if (wRes.ok) {
        const text = await wRes.text();
        info.wellCount = Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
      }
    } catch {}

    // Count measurements per data type — iterate scanned data files so the
    // counts reflect disk state, not a stale metadata list.
    for (const f of meta.dataFiles || []) {
      const m = /^data_(.+)\.csv$/.exec(f);
      if (!m) continue;
      const code = m[1];
      try {
        const mRes = await freshFetch(`/data/${meta.id}/${f}`);
        if (mRes.ok) {
          const text = await mRes.text();
          info.measurementCounts[code] = Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
        }
      } catch {}
    }

    infos.push(info);
  }
  return infos;
}

const ImportDataHub: React.FC<ImportDataHubProps> = ({ onClose, onDataChanged, initialRegionId }) => {
  const [regionList, setRegionList] = useState<RegionInfo[]>([]);
  const [catalog, setCatalog] = useState<ParameterCatalog | null>(null);
  const [activeRegionId, setActiveRegionId] = useState<string | null>(initialRegionId || null);
  const [activeWizard, setActiveWizard] = useState<'region' | 'aquifer' | 'well' | 'measurement' | 'datatypes' | null>(null);
  const [showRegionEditor, setShowRegionEditor] = useState(false);
  const [showAquiferEditor, setShowAquiferEditor] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Database export/import state
  const [dbAction, setDbAction] = useState<'idle' | 'exporting' | 'importing'>('idle');
  const [importDbFile, setImportDbFile] = useState<File | null>(null);
  const [importDbStep, setImportDbStep] = useState<'idle' | 'choose-mode' | 'confirm' | 'importing' | 'results'>('idle');
  const [importDbMode, setImportDbMode] = useState<'append' | 'replace'>('append');
  const [importDbResults, setImportDbResults] = useState<{
    imported: string[]; skipped: { name: string; reason: string }[]; errors: string[];
  } | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const loadRegions = async () => {
    setIsLoading(true);
    try {
      let cat = catalog;
      if (!cat) {
        try {
          cat = await loadCatalog();
          setCatalog(cat);
        } catch {}
      }
      const list = await fetchRegionList(cat);
      setRegionList(list);
    } catch (err) {
      console.warn('Failed to load region list:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadRegions(); }, []);

  // --- Database Export ---
  const handleExportDatabase = async () => {
    setDbAction('exporting');
    try {
      const zip = new JSZip();
      for (const region of regionList) {
        const prefix = region.id;
        const filesToFetch = [
          'region.json', 'region.geojson', 'aquifers.geojson', 'wells.csv',
          ...(region.dataFiles || []),
        ];
        for (const filename of filesToFetch) {
          try {
            const res = await freshFetch(`/data/${prefix}/${filename}`);
            if (res.ok) {
              const text = await res.text();
              zip.file(`${prefix}/${filename}`, text);
            }
          } catch {}
        }
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const date = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `aquiferx-database-${date}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setDbAction('idle');
    }
  };

  // --- Database Import ---
  const handleImportDbFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportDbFile(file);
    setImportDbResults(null);
    if (regionList.length === 0) {
      setImportDbMode('replace');
      setImportDbStep('confirm');
    } else {
      setImportDbStep('choose-mode');
    }
    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  const handleImportDbExecute = async () => {
    if (!importDbFile) return;
    setImportDbStep('importing');
    setDbAction('importing');
    const imported: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const errors: string[] = [];

    try {
      const zip = await JSZip.loadAsync(importDbFile);

      // Discover regions in the zip by finding region.json files
      const regionEntries: { prefix: string; meta: RegionMeta }[] = [];
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        if (path.endsWith('/region.json')) {
          try {
            const text = await entry.async('text');
            const meta = JSON.parse(text) as RegionMeta;
            const prefix = path.replace(/\/region\.json$/, '');
            regionEntries.push({ prefix, meta });
          } catch (err) {
            errors.push(`Failed to parse ${path}: ${err}`);
          }
        }
      }

      if (regionEntries.length === 0) {
        errors.push('No regions found in zip (no region.json files)');
        setImportDbResults({ imported, skipped, errors });
        setImportDbStep('results');
        setDbAction('idle');
        return;
      }

      // Replace mode: delete all existing regions first
      if (importDbMode === 'replace') {
        for (const existing of regionList) {
          try {
            const res = await fetch('/api/delete-folder', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder: existing.id })
            });
            if (!res.ok) {
              errors.push(`Failed to delete existing region "${existing.name}": ${await res.text()}`);
            }
          } catch (err) {
            errors.push(`Failed to delete existing region "${existing.name}": ${err}`);
          }
        }
      }

      // Build set of existing region names for append-mode dedup
      const existingNames = new Set(
        importDbMode === 'append' ? regionList.map(r => r.name.toLowerCase()) : []
      );

      for (const { prefix, meta } of regionEntries) {
        // Append mode: skip if name matches
        if (importDbMode === 'append' && existingNames.has(meta.name.toLowerCase())) {
          skipped.push({ name: meta.name, reason: 'Region with same name already exists' });
          continue;
        }

        try {
          // Collect all files under this prefix, normalizing region.json
          // from the legacy dataTypes shape if needed.
          const files: { path: string; content: string }[] = [];
          for (const [path, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            if (path.startsWith(prefix + '/')) {
              const relativePath = path;
              let text = await entry.async('text');
              // Migrate legacy region.json: dataTypes → customDataTypes
              if (path.endsWith('/region.json')) {
                try {
                  const raw = JSON.parse(text);
                  if (Array.isArray(raw.dataTypes) && !raw.customDataTypes) {
                    raw.customDataTypes = raw.dataTypes.filter((dt: any) => dt.code !== 'wte');
                    delete raw.dataTypes;
                    text = JSON.stringify(raw, null, 2);
                  }
                } catch {}
              }
              files.push({ path: `data/${relativePath}`, content: text });
            }
          }
          await saveFiles(files);
          imported.push(meta.name);
        } catch (err) {
          errors.push(`Failed to import "${meta.name}": ${err}`);
        }
      }

      // Refresh
      await loadRegions();
      onDataChanged();
    } catch (err) {
      errors.push(`Failed to read zip file: ${err}`);
    }

    setImportDbResults({ imported, skipped, errors });
    setImportDbStep('results');
    setDbAction('idle');
  };

  const resetImportDb = () => {
    setImportDbFile(null);
    setImportDbStep('idle');
    setImportDbMode('append');
    setImportDbResults(null);
  };

  const activeRegion = useMemo(() =>
    regionList.find(r => r.id === activeRegionId) || null,
  [regionList, activeRegionId]);

  const handleSubWizardComplete = () => {
    setActiveWizard(null);
    loadRegions();
    onDataChanged();
  };

  // Dimming logic
  const noRegion = !activeRegion;
  const isSingleUnit = activeRegion?.singleUnit || false;
  const noAquifers = (activeRegion?.aquiferCount || 0) === 0;
  const noWells = (activeRegion?.wellCount || 0) === 0;

  const dimAquifers = noRegion || isSingleUnit;
  const dimWells = noRegion || (!isSingleUnit && noAquifers);
  // Measurements card stays enabled even when wellCount === 0 — CSV imports
  // with lat/lng can bootstrap the well set. Aquifers must still exist for
  // multi-unit regions so measurements can be assigned.
  const dimMeasurements = noRegion || (!isSingleUnit && noAquifers);

  const totalMeasurements = activeRegion
    ? Object.values(activeRegion.measurementCounts).reduce((a: number, b: number) => a + b, 0)
    : 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[90vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <header className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-800">Manage Data</h2>
            <p className="text-xs text-slate-500 font-medium">Manage regions and their data</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportDatabase}
              disabled={regionList.length === 0 || dbAction !== 'idle'}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-md text-xs font-medium hover:bg-emerald-100 transition-colors disabled:opacity-40 disabled:pointer-events-none"
              title="Export all regions as a zip file"
            >
              {dbAction === 'exporting' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              Export Database
            </button>
            <label
              className={`flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 text-amber-700 rounded-md text-xs font-medium hover:bg-amber-100 transition-colors cursor-pointer ${dbAction !== 'idle' ? 'opacity-40 pointer-events-none' : ''}`}
              title="Import regions from a zip file"
            >
              <Upload size={14} />
              Import Database
              <input
                ref={importFileRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={handleImportDbFileSelect}
                disabled={dbAction !== 'idle'}
              />
            </label>
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
              <X size={20} />
            </button>
          </div>
        </header>

        <div className="p-6 overflow-y-auto flex-1">
          {/* Region selector */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <MapPin size={14} /> Regions
              </h3>
              <div className="flex items-center gap-2">
                {regionList.length > 0 && (
                  <button
                    onClick={() => setShowRegionEditor(true)}
                    className="flex items-center gap-1 px-3 py-1.5 bg-slate-100 text-slate-600 rounded-md text-xs font-medium hover:bg-slate-200 transition-colors"
                  >
                    <Pencil size={14} /> Edit Regions
                  </button>
                )}
                <button
                  onClick={() => setActiveWizard('region')}
                  className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-md text-xs font-medium hover:bg-blue-100 transition-colors"
                >
                  <Plus size={14} /> Add Region
                </button>
              </div>
            </div>

            {isLoading ? (
              <p className="text-sm text-slate-400 italic">Loading regions...</p>
            ) : regionList.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No regions yet. Add one to get started.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {regionList.map(r => (
                  <button
                    key={r.id}
                    onClick={() => setActiveRegionId(activeRegionId === r.id ? null : r.id)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      activeRegionId === r.id
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-blue-300 hover:bg-blue-50'
                    }`}
                  >
                    {r.name}
                    {r.singleUnit && <span className="ml-1 text-xs opacity-70">(single)</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Data cards */}
          <div className="grid grid-cols-3 gap-4">
            {/* Aquifers */}
            <div className={`border rounded-xl p-4 transition-opacity ${dimAquifers ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 rounded-lg bg-indigo-100 text-indigo-600"><Layers size={16} /></div>
                <h4 className="font-semibold text-slate-700 text-sm">Aquifers</h4>
              </div>
              <p className="text-2xl font-bold text-slate-800 mb-3">{activeRegion?.aquiferCount || 0}</p>
              {isSingleUnit ? (
                <p className="text-xs text-slate-400 italic">Single-unit mode</p>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => setActiveWizard('aquifer')}
                    className="flex-1 flex items-center gap-1 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-md text-xs font-medium hover:bg-indigo-100 transition-colors justify-center"
                  >
                    <Plus size={14} /> Add
                  </button>
                  {(activeRegion?.aquiferCount || 0) > 0 && (
                    <button
                      onClick={() => setShowAquiferEditor(true)}
                      className="p-1.5 bg-slate-100 text-slate-500 rounded-md hover:bg-slate-200 hover:text-slate-700 transition-colors"
                      title="Edit Aquifers"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Wells */}
            <div className={`border rounded-xl p-4 transition-opacity ${dimWells ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 rounded-lg bg-green-100 text-green-600"><Navigation size={16} /></div>
                <h4 className="font-semibold text-slate-700 text-sm">Wells</h4>
              </div>
              <p className="text-2xl font-bold text-slate-800 mb-3">{activeRegion?.wellCount || 0}</p>
              <button
                onClick={() => setActiveWizard('well')}
                className="flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-700 rounded-md text-xs font-medium hover:bg-green-100 transition-colors w-full justify-center"
              >
                <Plus size={14} /> Add Wells
              </button>
            </div>

            {/* Measurements */}
            <div className={`border rounded-xl p-4 transition-opacity ${dimMeasurements ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 rounded-lg bg-cyan-100 text-cyan-600"><BarChart3 size={16} /></div>
                <h4 className="font-semibold text-slate-700 text-sm">Measurements</h4>
              </div>
              <p className="text-2xl font-bold text-slate-800 mb-1">{totalMeasurements}</p>
              {activeRegion && activeRegion.effectiveDataTypes.length > 0 && (
                <div className="text-xs text-slate-400 mb-2">
                  {activeRegion.effectiveDataTypes.map(dt => (
                    <span key={dt.code} className="mr-2">
                      {dt.code}: {activeRegion.measurementCounts[dt.code] || 0}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setActiveWizard('measurement')}
                  className="flex-1 flex items-center gap-1 px-3 py-1.5 bg-cyan-50 text-cyan-700 rounded-md text-xs font-medium hover:bg-cyan-100 transition-colors justify-center"
                >
                  <Plus size={14} /> Add Measurements
                </button>
                <button
                  onClick={() => setActiveWizard('datatypes')}
                  className="p-1.5 bg-slate-100 text-slate-500 rounded-md hover:bg-slate-200 hover:text-slate-700 transition-colors"
                  title="Manage Data Types"
                >
                  <Settings size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <footer className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-slate-800 text-white rounded-lg font-bold text-sm hover:bg-slate-700"
          >
            Done
          </button>
        </footer>
      </div>

      {/* Database Import Modal */}
      {importDbStep !== 'idle' && (
        <div className="fixed inset-0 z-[105] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm" onClick={e => e.stopPropagation()}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>

            {/* Choose Mode */}
            {importDbStep === 'choose-mode' && (
              <>
                <h3 className="text-lg font-bold text-slate-800 mb-1">Import Database</h3>
                <p className="text-sm text-slate-500 mb-4">
                  You have {regionList.length} existing region{regionList.length !== 1 ? 's' : ''}. How should the import be handled?
                </p>
                <div className="space-y-3 mb-4">
                  <button
                    onClick={() => { setImportDbMode('append'); setImportDbStep('confirm'); }}
                    className="w-full flex items-center gap-3 p-4 border-2 border-blue-200 rounded-xl hover:bg-blue-50 transition-colors text-left"
                  >
                    <div className="p-2 rounded-lg bg-blue-100 text-blue-600"><Plus size={20} /></div>
                    <div>
                      <p className="font-semibold text-slate-800">Append</p>
                      <p className="text-xs text-slate-500">Add new regions, skip those with matching names</p>
                    </div>
                  </button>
                  <button
                    onClick={() => { setImportDbMode('replace'); setImportDbStep('confirm'); }}
                    className="w-full flex items-center gap-3 p-4 border-2 border-red-200 rounded-xl hover:bg-red-50 transition-colors text-left"
                  >
                    <div className="p-2 rounded-lg bg-red-100 text-red-600"><AlertTriangle size={20} /></div>
                    <div>
                      <p className="font-semibold text-slate-800">Replace</p>
                      <p className="text-xs text-slate-500">Delete all existing regions and import from zip</p>
                    </div>
                  </button>
                </div>
                <button onClick={resetImportDb} className="w-full py-2 text-sm text-slate-500 hover:text-slate-700">
                  Cancel
                </button>
              </>
            )}

            {/* Confirm */}
            {importDbStep === 'confirm' && (
              <>
                <h3 className="text-lg font-bold text-slate-800 mb-3">Confirm Import</h3>
                <div className="space-y-2 mb-4 text-sm">
                  <p className="text-slate-600"><span className="font-medium">File:</span> {importDbFile?.name}</p>
                  <p className="text-slate-600"><span className="font-medium">Mode:</span> {importDbMode === 'append' ? 'Append (skip duplicates)' : 'Replace (delete existing)'}</p>
                  {importDbMode === 'replace' && regionList.length > 0 && (
                    <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                      <p className="text-red-700 text-xs font-medium flex items-center gap-1.5">
                        <AlertTriangle size={14} />
                        This will permanently delete all {regionList.length} existing region{regionList.length !== 1 ? 's' : ''} before importing.
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => regionList.length > 0 ? setImportDbStep('choose-mode') : resetImportDb()}
                    className="flex-1 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleImportDbExecute}
                    className={`flex-1 py-2 rounded-lg text-sm font-bold text-white ${
                      importDbMode === 'replace' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    {importDbMode === 'replace' ? 'Replace & Import' : 'Import'}
                  </button>
                </div>
              </>
            )}

            {/* Importing */}
            {importDbStep === 'importing' && (
              <div className="flex flex-col items-center py-8">
                <Loader2 size={32} className="animate-spin text-blue-500 mb-4" />
                <p className="text-sm font-medium text-slate-600">
                  {importDbMode === 'replace' ? 'Replacing database...' : 'Importing regions...'}
                </p>
              </div>
            )}

            {/* Results */}
            {importDbStep === 'results' && importDbResults && (
              <>
                <h3 className="text-lg font-bold text-slate-800 mb-4">Import Complete</h3>
                <div className="space-y-3 max-h-64 overflow-y-auto mb-4">
                  {importDbResults.imported.length > 0 && (
                    <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                      <p className="text-xs font-semibold text-green-700 mb-1 flex items-center gap-1.5">
                        <CheckCircle2 size={14} /> Imported ({importDbResults.imported.length})
                      </p>
                      <ul className="text-xs text-green-600 space-y-0.5">
                        {importDbResults.imported.map(name => <li key={name}>{name}</li>)}
                      </ul>
                    </div>
                  )}
                  {importDbResults.skipped.length > 0 && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                      <p className="text-xs font-semibold text-amber-700 mb-1 flex items-center gap-1.5">
                        <AlertTriangle size={14} /> Skipped ({importDbResults.skipped.length})
                      </p>
                      <ul className="text-xs text-amber-600 space-y-0.5">
                        {importDbResults.skipped.map(s => <li key={s.name}>{s.name} — {s.reason}</li>)}
                      </ul>
                    </div>
                  )}
                  {importDbResults.errors.length > 0 && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                      <p className="text-xs font-semibold text-red-700 mb-1 flex items-center gap-1.5">
                        <AlertTriangle size={14} /> Errors ({importDbResults.errors.length})
                      </p>
                      <ul className="text-xs text-red-600 space-y-0.5">
                        {importDbResults.errors.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
                <button
                  onClick={resetImportDb}
                  className="w-full py-2 bg-slate-800 text-white rounded-lg text-sm font-bold hover:bg-slate-700"
                >
                  Done
                </button>
              </>
            )}

          </div>
        </div>
      )}

      {/* Sub-wizards */}
      {activeWizard === 'region' && (
        <RegionImporter
          existingRegionIds={regionList.map(r => r.id)}
          onComplete={(id) => { setActiveRegionId(id); handleSubWizardComplete(); }}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'aquifer' && activeRegion && (
        <AquiferImporter
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          existingAquiferCount={activeRegion.aquiferCount}
          onComplete={handleSubWizardComplete}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'well' && activeRegion && (
        <WellImporter
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          lengthUnit={activeRegion.lengthUnit}
          singleUnit={activeRegion.singleUnit}
          regionBounds={activeRegion.bounds}
          aquiferCount={activeRegion.aquiferCount}
          existingWellCount={activeRegion.wellCount}
          onComplete={handleSubWizardComplete}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'measurement' && activeRegion && (
        <MeasurementImporter
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          lengthUnit={activeRegion.lengthUnit}
          singleUnit={activeRegion.singleUnit}
          dataTypes={activeRegion.effectiveDataTypes}
          customDataTypes={activeRegion.customDataTypes}
          regionBounds={activeRegion.bounds}
          existingWellCount={activeRegion.wellCount}
          onComplete={handleSubWizardComplete}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'datatypes' && activeRegion && (
        <DataTypeEditor
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          lengthUnit={activeRegion.lengthUnit}
          customDataTypes={activeRegion.customDataTypes}
          singleUnit={activeRegion.singleUnit}
          onUpdate={() => { loadRegions(); onDataChanged(); }}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {showRegionEditor && (
        <RegionEditor
          regions={regionList}
          onSave={() => { loadRegions(); onDataChanged(); }}
          onClose={() => setShowRegionEditor(false)}
        />
      )}
      {showAquiferEditor && activeRegion && (
        <AquiferEditor
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          dataTypes={activeRegion.effectiveDataTypes}
          onSave={() => { loadRegions(); onDataChanged(); }}
          onClose={() => setShowAquiferEditor(false)}
        />
      )}
    </div>
  );
};

export default ImportDataHub;
