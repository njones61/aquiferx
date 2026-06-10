import React, { useState } from 'react';
import { X, ChevronRight, ChevronLeft, Upload, CheckCircle2, Loader2, FileArchive } from 'lucide-react';
import { RegionMeta } from '../../types';
import { processUploadedFile, UploadedFile, getFolderName, saveFiles } from '../../services/importUtils';
import JSZip from 'jszip';

interface RegionImporterProps {
  existingRegionIds: string[];
  onComplete: (regionId: string) => void;
  onClose: () => void;
}

const RegionImporter: React.FC<RegionImporterProps> = ({ existingRegionIds, onComplete, onClose }) => {
  const [mode, setMode] = useState<'choose' | 'create' | 'import'>('choose');
  const [step, setStep] = useState(1);

  // Create mode state
  const [regionName, setRegionName] = useState('');
  const [lengthUnit, setLengthUnit] = useState<'ft' | 'm'>('ft');
  const [singleUnit, setSingleUnit] = useState(false);
  const [boundaryFile, setBoundaryFile] = useState<UploadedFile | null>(null);
  const [nameError, setNameError] = useState('');

  // Import mode state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importValidation, setImportValidation] = useState<{ valid: boolean; errors: string[]; meta?: RegionMeta } | null>(null);
  const [importConflict, setImportConflict] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const validateName = (name: string) => {
    if (!name.trim()) { setNameError('Region name is required'); return false; }
    const folder = getFolderName(name);
    if (existingRegionIds.includes(folder)) { setNameError(`Region "${folder}" already exists`); return false; }
    setNameError('');
    return true;
  };

  const handleBoundaryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const uploaded = await processUploadedFile(file, 'region');
      setBoundaryFile(uploaded);
    } catch (err) {
      setError(`Failed to process file: ${err}`);
    }
  };

  const handleCreate = async () => {
    if (!boundaryFile || !regionName.trim()) return;
    setIsSaving(true);
    setError('');
    try {
      const folderId = getFolderName(regionName);
      const regionFeatures = boundaryFile.data.type === 'FeatureCollection'
        ? boundaryFile.data.features
        : [boundaryFile.data];

      const regionGeojson = {
        type: 'FeatureCollection',
        features: regionFeatures.map((f: any) => ({
          type: 'Feature',
          properties: { region_id: folderId, region_name: regionName },
          geometry: f.geometry || f
        }))
      };

      const regionMeta: RegionMeta = {
        id: folderId,
        name: regionName,
        lengthUnit,
        singleUnit,
        customDataTypes: [],
      };

      const files: { path: string; content: string }[] = [
        { path: `${folderId}/region.json`, content: JSON.stringify(regionMeta, null, 2) },
        { path: `${folderId}/region.geojson`, content: JSON.stringify(regionGeojson, null, 2) },
      ];

      // If singleUnit, auto-generate aquifers.geojson with aquifer_id=0
      if (singleUnit) {
        const aquifersGeojson = {
          type: 'FeatureCollection',
          features: regionFeatures.map((f: any) => ({
            type: 'Feature',
            properties: { aquifer_id: '0', aquifer_name: regionName },
            geometry: f.geometry || f
          }))
        };
        files.push({ path: `${folderId}/aquifers.geojson`, content: JSON.stringify(aquifersGeojson, null, 2) });
      }

      await saveFiles(files);
      onComplete(folderId);
    } catch (err) {
      setError(`Failed to save: ${err}`);
    }
    setIsSaving(false);
  };

  const handleImportUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.name.endsWith('.zip')) return;
    setImportFile(file);
    setImportValidation(null);
    setImportConflict(false);

    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const errors: string[] = [];

      // Find region.json
      let regionJsonFile: JSZip.JSZipObject | null = null;
      let prefix = '';
      zip.forEach((relativePath, zipEntry) => {
        if (relativePath.endsWith('region.json') && !zipEntry.dir) {
          regionJsonFile = zipEntry;
          prefix = relativePath.replace('region.json', '');
        }
      });

      if (!regionJsonFile) {
        errors.push('Missing region.json in zip package');
        setImportValidation({ valid: false, errors });
        return;
      }

      const metaText = await (regionJsonFile as JSZip.JSZipObject).async('text');
      const meta = JSON.parse(metaText) as RegionMeta;

      if (!meta.id || !meta.name) errors.push('region.json missing required fields (id, name)');

      // Check for region.geojson
      let hasGeojson = false;
      zip.forEach((relativePath) => {
        if (relativePath === `${prefix}region.geojson`) hasGeojson = true;
      });
      if (!hasGeojson) errors.push('Missing region.geojson in zip package');

      if (existingRegionIds.includes(meta.id)) {
        setImportConflict(true);
      }

      setImportValidation({ valid: errors.length === 0, errors, meta });
    } catch (err) {
      setImportValidation({ valid: false, errors: [`Failed to read zip: ${err}`] });
    }
  };

  const handleImport = async () => {
    if (!importFile || !importValidation?.meta) return;
    setIsSaving(true);
    setError('');
    try {
      const zip = await JSZip.loadAsync(await importFile.arrayBuffer());
      const meta = importValidation.meta;
      const folderId = meta.id;

      // Find prefix in zip. Keep the first region.json — overwriting on
      // every match meant a zip containing multiple regions imported a mix
      // of files validated against whichever region.json came last.
      let prefix = '';
      let regionJsonCount = 0;
      zip.forEach((relativePath) => {
        if (relativePath.endsWith('region.json')) {
          regionJsonCount++;
          if (regionJsonCount === 1) prefix = relativePath.replace('region.json', '');
        }
      });
      if (regionJsonCount > 1) {
        setError('This zip contains multiple regions. Import a single-region zip here, or use Import Database in Manage Data for multi-region archives.');
        setIsSaving(false);
        return;
      }

      const files: { path: string; content: string }[] = [];
      const entries: [string, JSZip.JSZipObject][] = [];
      zip.forEach((path, entry) => { if (!entry.dir) entries.push([path, entry]); });

      for (const [relativePath, entry] of entries) {
        if (!relativePath.startsWith(prefix)) continue;
        const fileName = relativePath.slice(prefix.length);
        if (!fileName) continue;
        let content = await entry.async('text');
        // Migrate legacy region.json: dataTypes → customDataTypes
        if (fileName === 'region.json') {
          try {
            const raw = JSON.parse(content);
            if (Array.isArray(raw.dataTypes) && !Array.isArray(raw.customDataTypes)) {
              raw.customDataTypes = raw.dataTypes.filter((dt: { code: string }) => dt.code !== 'wte');
              delete raw.dataTypes;
              content = JSON.stringify(raw, null, 2);
            }
          } catch {}
        }
        files.push({ path: `${folderId}/${fileName}`, content });
      }

      await saveFiles(files);
      onComplete(folderId);
    } catch (err) {
      setError(`Failed to import: ${err}`);
    }
    setIsSaving(false);
  };

  // Mode selection
  if (mode === 'choose') {
    return (
      <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-slate-800">Add Region</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
          </div>
          <div className="space-y-3">
            <button
              onClick={() => setMode('create')}
              className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-slate-200 hover:border-blue-400 hover:bg-blue-50 transition-colors text-left"
            >
              <Upload size={24} className="text-blue-600 flex-shrink-0" />
              <div>
                <div className="font-semibold text-slate-800">Create New Region</div>
                <div className="text-sm text-slate-500">Enter name and upload boundary file</div>
              </div>
            </button>
            <button
              onClick={() => setMode('import')}
              className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-slate-200 hover:border-green-400 hover:bg-green-50 transition-colors text-left"
            >
              <FileArchive size={24} className="text-green-600 flex-shrink-0" />
              <div>
                <div className="font-semibold text-slate-800">Import Region Package</div>
                <div className="text-sm text-slate-500">Upload a .zip file with region data</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Import mode
  if (mode === 'import') {
    return (
      <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-slate-800">Import Region Package</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
          </div>

          <label className="block mb-4">
            <input type="file" accept=".zip" onChange={handleImportUpload}
              className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
          </label>

          {importValidation && (
            <div className="mb-4">
              {importValidation.errors.length > 0 && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg mb-3">
                  {importValidation.errors.map((e, i) => (
                    <p key={i} className="text-sm text-red-700">{e}</p>
                  ))}
                </div>
              )}
              {importValidation.meta && importValidation.valid && (
                <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                  <p className="text-sm font-medium text-green-800">Valid package: {importValidation.meta.name}</p>
                  <p className="text-xs text-green-600">ID: {importValidation.meta.id} &middot; Unit: {importValidation.meta.lengthUnit}</p>
                  {importConflict && (
                    <p className="text-xs text-amber-700 mt-1 font-medium">Region ID already exists and will be overwritten.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

          <div className="flex justify-between">
            <button onClick={() => setMode('choose')} className="text-sm text-slate-600 hover:text-slate-800">
              <ChevronLeft size={16} className="inline" /> Back
            </button>
            <button
              onClick={handleImport}
              disabled={!importValidation?.valid || isSaving}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isSaving && <Loader2 size={14} className="animate-spin" />}
              {isSaving ? 'Importing...' : 'Import'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Create mode
  return (
    <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-800">Create New Region</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Region Name</label>
              <input
                type="text"
                value={regionName}
                onChange={(e) => { setRegionName(e.target.value); validateName(e.target.value); }}
                placeholder="e.g., California Central Valley"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
              {nameError && <p className="mt-1 text-xs text-red-600">{nameError}</p>}
              {regionName && !nameError && (
                <p className="mt-1 text-xs text-slate-500">Folder: <span className="font-mono">{getFolderName(regionName)}</span></p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Length Unit</label>
              <div className="flex space-x-2">
                {(['ft', 'm'] as const).map(u => (
                  <button key={u} type="button" onClick={() => setLengthUnit(u)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border ${lengthUnit === u ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                  >
                    {u === 'ft' ? 'Feet (ft)' : 'Meters (m)'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={singleUnit} onChange={e => setSingleUnit(e.target.checked)} className="w-4 h-4 accent-blue-600" />
                <div>
                  <span className="text-sm font-medium text-slate-700">Single-unit region</span>
                  <p className="text-xs text-slate-500">Treat entire region as one analysis unit (no aquifer subdivisions)</p>
                </div>
              </label>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">Upload the boundary file for "{regionName}".</p>
            <label className="block">
              <input type="file" accept=".geojson,.json,.zip" onChange={handleBoundaryUpload}
                className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
            </label>
            {boundaryFile && (
              <div className="flex items-center gap-2 text-sm text-green-700">
                <CheckCircle2 size={16} /> {boundaryFile.name}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

        <div className="flex justify-between mt-6">
          <button onClick={() => step === 1 ? setMode('choose') : setStep(1)} className="text-sm text-slate-600 hover:text-slate-800">
            <ChevronLeft size={16} className="inline" /> Back
          </button>
          {step === 1 ? (
            <button
              onClick={() => { if (validateName(regionName)) setStep(2); }}
              disabled={!regionName.trim()}
              className="flex items-center gap-1 px-6 py-2 bg-slate-800 text-white rounded-lg font-medium text-sm hover:bg-slate-700 disabled:opacity-50"
            >
              Next <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={!boundaryFile || isSaving}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {isSaving && <Loader2 size={14} className="animate-spin" />}
              {isSaving ? 'Saving...' : 'Create Region'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default RegionImporter;
