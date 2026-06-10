import React, { useState, useEffect } from 'react';
import { X, Trash2, Loader2 } from 'lucide-react';
import { DataType } from '../../types';
import { freshFetch, saveFiles, parseCSV, toCsv, WELLS_CSV_HEADERS } from '../../services/importUtils';
import ConfirmDialog from './ConfirmDialog';

interface AquiferEditorProps {
  regionId: string;
  regionName: string;
  dataTypes: DataType[];
  onSave: () => void;
  onClose: () => void;
}

interface AquiferRow {
  id: string;
  name: string;
  origName: string;
  features: any[];
  nameError?: string;
}

const AquiferEditor: React.FC<AquiferEditorProps> = ({ regionId, regionName, dataTypes, onSave, onClose }) => {
  const [rows, setRows] = useState<AquiferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<AquiferRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load aquifers from geojson
  useEffect(() => {
    (async () => {
      try {
        const res = await freshFetch(`/data/${regionId}/aquifers.geojson`);
        if (!res.ok) { setLoading(false); return; }
        const gj = await res.json();
        const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
        // Group by aquifer_id
        const grouped = new Map<string, { name: string; features: any[] }>();
        for (const f of features) {
          const id = String(f.properties?.aquifer_id || '');
          const name = f.properties?.aquifer_name || id;
          if (!grouped.has(id)) grouped.set(id, { name, features: [] });
          grouped.get(id)!.features.push(f);
        }
        setRows(Array.from(grouped.entries()).map(([id, { name, features }]) => ({
          id, name, origName: name, features,
        })));
      } catch {}
      setLoading(false);
    })();
  }, [regionId]);

  const dirty = rows.some(r => r.name !== r.origName);
  const hasErrors = rows.some(r => r.nameError);

  const updateRow = (id: string, name: string) => {
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const trimmed = name.trim();
      let nameError: string | undefined;
      if (!trimmed) {
        nameError = 'Name is required';
      } else if (prev.some(o => o.id !== id && o.name.trim().toLowerCase() === trimmed.toLowerCase())) {
        nameError = 'Duplicate name';
      }
      return { ...r, name, nameError };
    }));
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteProgress(10);
    setError('');
    try {
      const aquiferId = deleteTarget.id;

      // Rebuild aquifers.geojson without the deleted aquifer
      const remainingRows = rows.filter(r => r.id !== aquiferId);
      const features = remainingRows.flatMap(r =>
        r.features.map((f: any) => ({
          ...f,
          properties: { ...f.properties, aquifer_id: r.id, aquifer_name: r.name },
        }))
      );
      const geojsonContent = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
      setDeleteProgress(20);

      // Load wells.csv and filter out wells for this aquifer. Must go
      // through the real CSV parser — naive split(',') shifts columns on
      // quoted names containing commas (common in USGS site names) and
      // deletes the wrong wells.
      let wellsCsvContent = toCsv(WELLS_CSV_HEADERS, []);
      const deletedWellIds = new Set<string>();
      try {
        const wRes = await freshFetch(`/data/${regionId}/wells.csv`);
        if (wRes.ok) {
          const { headers, rows } = parseCSV(await wRes.text());
          const kept: Record<string, string>[] = [];
          for (const r of rows) {
            if ((r.aquifer_id || '') === aquiferId) {
              if (r.well_id) deletedWellIds.add(r.well_id);
            } else {
              kept.push(r);
            }
          }
          wellsCsvContent = toCsv(headers.length > 0 ? headers : WELLS_CSV_HEADERS, kept);
        }
      } catch {}
      setDeleteProgress(40);

      // Rebuild data CSVs, removing measurements for deleted wells
      const dataFiles: { path: string; content: string }[] = [];
      for (const dt of dataTypes) {
        try {
          const mRes = await freshFetch(`/data/${regionId}/data_${dt.code}.csv`);
          if (mRes.ok) {
            const { headers, rows } = parseCSV(await mRes.text());
            if (headers.length > 0) {
              // Remove if well was deleted OR aquifer matches
              const kept = rows.filter(r =>
                !deletedWellIds.has(r.well_id || '') && (r.aquifer_id || '') !== aquiferId
              );
              dataFiles.push({ path: `${regionId}/data_${dt.code}.csv`, content: toCsv(headers, kept) });
            }
          }
        } catch {}
      }
      setDeleteProgress(70);

      // Save all files
      await saveFiles([
        { path: `${regionId}/aquifers.geojson`, content: geojsonContent },
        { path: `${regionId}/wells.csv`, content: wellsCsvContent },
        ...dataFiles,
      ]);
      setDeleteProgress(100);

      setRows(remainingRows);
      setDeleteTarget(null);
      onSave();
    } catch (err) {
      setError(`Failed to delete aquifer: ${err}`);
    } finally {
      setDeleting(false);
      setDeleteProgress(0);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      // Rebuild aquifers.geojson with updated names
      const features = rows.flatMap(r =>
        r.features.map((f: any) => ({
          ...f,
          properties: { ...f.properties, aquifer_id: r.id, aquifer_name: r.name.trim() },
        }))
      );
      const geojsonContent = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
      await saveFiles([{ path: `${regionId}/aquifers.geojson`, content: geojsonContent }]);
      onSave();
      onClose();
    } catch (err) {
      setError(`Failed to save: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
        <header className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-800">Edit Aquifers</h3>
            <p className="text-xs text-slate-500">{regionName}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
            <X size={18} />
          </button>
        </header>

        <div className="p-6 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-slate-400" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate-400 italic text-center py-8">No aquifers to edit.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-100">
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pl-3 w-16 text-center">Delete</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="py-2 pr-3">
                      <input
                        type="text"
                        value={r.name}
                        onChange={e => updateRow(r.id, e.target.value)}
                        className={`w-full px-2 py-1.5 border rounded-md text-sm ${
                          r.nameError
                            ? 'border-red-300 bg-red-50 focus:ring-red-400'
                            : 'border-slate-200 focus:ring-blue-400'
                        } focus:outline-none focus:ring-2`}
                      />
                      {r.nameError && (
                        <p className="text-xs text-red-500 mt-0.5">{r.nameError}</p>
                      )}
                    </td>
                    <td className="py-2 pl-3 text-center">
                      <button
                        onClick={() => setDeleteTarget(r)}
                        className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                        title={`Delete ${r.name}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        <footer className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || hasErrors || saving}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 disabled:opacity-40 disabled:pointer-events-none flex items-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
        </footer>
      </div>

      {/* Delete confirmation */}
      {deleteTarget && !deleting && (
        <ConfirmDialog
          title={`Delete "${deleteTarget.name}"?`}
          message="This cannot be undone. All wells and measurements associated with this aquifer will be permanently deleted."
          confirmLabel="Delete Aquifer"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Delete progress overlay */}
      {deleting && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-xs p-6">
            <p className="text-sm font-medium text-slate-700 mb-3">Deleting aquifer...</p>
            <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-red-500 h-full rounded-full transition-all duration-500 ease-out"
                style={{ width: `${deleteProgress}%` }}
              />
            </div>
            <p className="text-xs text-slate-400 mt-2 text-center">{deleteProgress}%</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default AquiferEditor;
