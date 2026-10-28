import React, { useState } from 'react';
import { X, ChevronRight, ChevronLeft, Upload, CheckCircle2, Loader2 } from 'lucide-react';
import { RegionMeta } from '../../types';
import { processUploadedFile, UploadedFile, getFolderName, saveFiles } from '../../services/importUtils';
import { reservedRegionIds, uniqueId } from '../../services/dataStore';

interface RegionImporterProps {
  existingRegionIds: string[];
  onComplete: (regionId: string) => void;
  onClose: () => void;
}

const RegionImporter: React.FC<RegionImporterProps> = ({ existingRegionIds, onComplete, onClose }) => {
  const [step, setStep] = useState(1);

  // Create mode state
  const [regionName, setRegionName] = useState('');
  const [lengthUnit, setLengthUnit] = useState<'ft' | 'm'>('ft');
  const [singleUnit, setSingleUnit] = useState(false);
  const [boundaryFile, setBoundaryFile] = useState<UploadedFile | null>(null);
  const [nameError, setNameError] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const validateName = (name: string) => {
    if (!name.trim()) { setNameError('Region name is required'); return false; }
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
      // The id only has to be unique; a name already in use, or one a sample
      // region has, gets a numbered id rather than an error
      const taken = new Set([...existingRegionIds, ...(await reservedRegionIds())]);
      const folderId = uniqueId(getFolderName(regionName) || 'region', taken);
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
          <button onClick={() => step === 1 ? onClose() : setStep(1)} className="text-sm text-slate-600 hover:text-slate-800">
            <ChevronLeft size={16} className="inline" /> {step === 1 ? 'Cancel' : 'Back'}
          </button>
          {step === 1 ? (
            <button
              onClick={() => { if (validateName(regionName)) setStep(2); }}
              disabled={!regionName.trim()}
              className="flex items-center gap-1 px-6 py-2 bg-slate-800 text-slate-50 rounded-lg font-medium text-sm hover:bg-slate-700 disabled:opacity-50"
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
