import React, { useState } from 'react';
import { X, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { processUploadedFile, UploadedFile, saveFiles, deleteFile } from '../../services/importUtils';
import { listRegions, readJson } from '../../services/dataStore';
import ColumnMapperModal from './ColumnMapperModal';
import ConfirmDialog from './ConfirmDialog';

interface AquiferImporterProps {
  regionId: string;
  regionName: string;
  existingAquiferCount: number;
  onComplete: () => void;
  onClose: () => void;
}

const FIELD_DEFS = [
  // Left unmapped (or blank on a feature), the aquifer gets the next free number
  { key: 'aquifer_id', label: 'Aquifer ID (optional)', required: false },
  { key: 'aquifer_name', label: 'Aquifer Name', required: true },
];

type ImportMode = 'append' | 'replace';

const AquiferImporter: React.FC<AquiferImporterProps> = ({
  regionId, regionName, existingAquiferCount, onComplete, onClose
}) => {
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [showMapper, setShowMapper] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>(existingAquiferCount > 0 ? 'append' : 'replace');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);
  const [skippedCount, setSkippedCount] = useState(0);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const uploaded = await processUploadedFile(f, 'aquifer');
      setFile(uploaded);
      setShowMapper(true);
      setSkippedCount(0);
    } catch (err) {
      setError(`Failed to process file: ${err}`);
    }
  };

  const updateMapping = (key: string, value: string) => {
    if (!file) return;
    setFile({ ...file, mapping: { ...file.mapping, [key]: value } });
  };

  const doSave = async () => {
    if (!file) return;
    setIsSaving(true);
    setError('');
    try {
      const features = file.data.type === 'FeatureCollection' ? file.data.features : [file.data];

      let existingFeatures: any[] = [];
      if (importMode === 'append') {
        try {
          const gj = await readJson(`${regionId}/aquifers.geojson`);
          if (gj) existingFeatures = gj.type === 'FeatureCollection' ? gj.features : [gj];
        } catch {}
      }

      // Aquifers without an ID are numbered after the highest numeric ID
      // already in the region or the file
      const idCol = file.mapping['aquifer_id'];
      const givenIds = [
        ...existingFeatures.map((f: any) => String(f.properties?.aquifer_id ?? '')),
        ...(idCol ? features.map((f: any) => String(f.properties?.[idCol] ?? '')) : []),
      ];
      let nextId = Math.max(0, ...givenIds.map(id => /^\d+$/.test(id) ? parseInt(id, 10) : 0)) + 1;
      const newFeatures = features.map((f: any) => {
        const given = idCol ? String(f.properties?.[idCol] ?? '').trim() : '';
        return {
          type: 'Feature',
          properties: {
            aquifer_id: given || String(nextId++),
            aquifer_name: f.properties?.[file.mapping['aquifer_name']] || ''
          },
          geometry: f.geometry
        };
      });

      if (importMode === 'replace') {
        // Delete wells and all data files, then write new aquifers
        try { await deleteFile(`${regionId}/wells.csv`); } catch {}
        // Delete all data_*.csv files the region holds
        try {
          const me = (await listRegions()).find(r => r.id === regionId);
          for (const f of me?.dataFiles ?? []) {
            try { await deleteFile(`${regionId}/${f}`); } catch {}
          }
        } catch {}

        await saveFiles([{
          path: `${regionId}/aquifers.geojson`,
          content: JSON.stringify({ type: 'FeatureCollection', features: newFeatures }, null, 2)
        }]);
      } else {
        // Append: skip IDs the region already has
        const existingIds = new Set(existingFeatures.map((f: any) => String(f.properties?.aquifer_id || '')));
        const toAdd = newFeatures.filter((f: any) => !existingIds.has(String(f.properties?.aquifer_id || '')));
        setSkippedCount(newFeatures.length - toAdd.length);

        const merged = [...existingFeatures, ...toAdd];
        await saveFiles([{
          path: `${regionId}/aquifers.geojson`,
          content: JSON.stringify({ type: 'FeatureCollection', features: merged }, null, 2)
        }]);
      }
      onComplete();
    } catch (err) {
      setError(`Failed to save: ${err}`);
    }
    setIsSaving(false);
  };

  const handleSave = () => {
    if (importMode === 'replace' && existingAquiferCount > 0) {
      setShowReplaceConfirm(true);
    } else {
      doSave();
    }
  };

  const isReady = file && file.mapping['aquifer_name'];

  return (
    <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Add Aquifers</h2>
            <p className="text-sm text-slate-500">{regionName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        <p className="text-sm text-slate-500 mb-4">Upload a GeoJSON or zipped Shapefile with aquifer boundaries.</p>

        {/* Import mode */}
        {existingAquiferCount > 0 && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Import Mode</label>
            <div className="flex gap-2">
              <button
                onClick={() => setImportMode('append')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  importMode === 'append' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Append
              </button>
              <button
                onClick={() => setImportMode('replace')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  importMode === 'replace' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Replace All
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {importMode === 'append'
                ? 'New aquifers will be added. Duplicates (by ID) are skipped.'
                : 'All existing aquifers, wells, and measurements will be deleted first.'}
            </p>
            {importMode === 'replace' && (
              <div className="flex items-start gap-2 mt-2 p-2 bg-red-50 border border-red-200 rounded-lg">
                <AlertTriangle size={14} className="text-red-500 mt-0.5 shrink-0" />
                <p className="text-xs text-red-700">This will also delete all wells and measurement data for this region.</p>
              </div>
            )}
          </div>
        )}

        <label className="block mb-4">
          <input type="file" accept=".geojson,.json,.zip" onChange={handleUpload}
            className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
        </label>

        {file && (
          <div className="mb-4">
            <div className="flex items-center gap-2 text-sm text-green-700 mb-2">
              <CheckCircle2 size={16} /> {file.name}
            </div>
            {skippedCount > 0 && (
              <p className="text-xs text-amber-600 mb-1">{skippedCount} duplicate aquifer(s) will be skipped.</p>
            )}
            <button onClick={() => setShowMapper(true)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
              Edit Column Mapping
            </button>
          </div>
        )}

        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={!isReady || isSaving}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving && <Loader2 size={14} className="animate-spin" />}
            {isSaving ? 'Saving...' : 'Save Aquifers'}
          </button>
        </div>
      </div>

      {showMapper && file && (
        <ColumnMapperModal
          file={file}
          fieldDefinitions={FIELD_DEFS}
          onUpdateMapping={updateMapping}
          onClose={() => setShowMapper(false)}
          title="Map Aquifer Columns"
        />
      )}

      {showReplaceConfirm && (
        <ConfirmDialog
          title="Replace All Aquifers?"
          message={`This will delete all ${existingAquiferCount} existing aquifer(s) along with their wells and measurement data. This cannot be undone.`}
          confirmLabel="Replace All"
          variant="danger"
          onConfirm={() => { setShowReplaceConfirm(false); doSave(); }}
          onCancel={() => setShowReplaceConfirm(false)}
        />
      )}
    </div>
  );
};

export default AquiferImporter;
