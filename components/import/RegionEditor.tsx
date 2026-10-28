import React, { useState } from 'react';
import { X, Trash2, Loader2 } from 'lucide-react';
import { RegionMeta } from '../../types';
import { saveFiles } from '../../services/importUtils';
import { deleteFolder, readJson } from '../../services/dataStore';
import ConfirmDialog from './ConfirmDialog';

interface RegionEditorProps {
  regions: RegionMeta[];
  onSave: () => void;
  onClose: () => void;
}

interface EditableRegion extends RegionMeta {
  nameError?: string;
}

const RegionEditor: React.FC<RegionEditorProps> = ({ regions, onSave, onClose }) => {
  const [rows, setRows] = useState<EditableRegion[]>(
    regions.map(r => ({ ...r }))
  );
  const [deleteTarget, setDeleteTarget] = useState<EditableRegion | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const dirty = rows.some(r => {
    const orig = regions.find(o => o.id === r.id);
    if (!orig) return false;
    return r.name !== orig.name || r.lengthUnit !== orig.lengthUnit;
  });

  const hasErrors = rows.some(r => r.nameError);

  const updateRow = (id: string, patch: Partial<EditableRegion>) => {
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const updated = { ...r, ...patch };
      // Validate name
      if ('name' in patch) {
        const trimmed = patch.name?.trim() || '';
        if (!trimmed) {
          updated.nameError = 'Name is required';
        } else if (rows.some(o => o.id !== id && o.name.trim().toLowerCase() === trimmed.toLowerCase())) {
          updated.nameError = 'Duplicate name';
        } else {
          updated.nameError = undefined;
        }
      }
      return updated;
    }));
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteProgress(10);
    try {
      // Delete the region folder
      setDeleteProgress(30);
      await deleteFolder(deleteTarget.id);
      setDeleteProgress(80);
      setDeleteProgress(100);
      // Remove from list
      setRows(prev => prev.filter(r => r.id !== deleteTarget.id));
      setDeleteTarget(null);
      // Notify parent so data refreshes
      onSave();
    } catch (err) {
      setError(`Failed to delete region: ${err}`);
    } finally {
      setDeleting(false);
      setDeleteProgress(0);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      for (const row of rows) {
        const orig = regions.find(r => r.id === row.id);
        if (!orig) continue;
        if (row.name === orig.name && row.lengthUnit === orig.lengthUnit) continue;

        // Load the existing region.json and update it
        const meta = await readJson(`${row.id}/region.json`);
        if (!meta) throw new Error(`Failed to load region.json for ${row.id}`);
        meta.name = row.name.trim();
        meta.lengthUnit = row.lengthUnit;

        await saveFiles([{
          path: `${row.id}/region.json`,
          content: JSON.stringify(meta, null, 2),
        }]);
      }
      onSave();
      onClose();
    } catch (err) {
      setError(`Failed to save: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
        <header className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-800">Edit Regions</h3>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
            <X size={18} />
          </button>
        </header>

        <div className="p-6 overflow-y-auto flex-1">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 italic text-center py-8">No regions to edit.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-100">
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 px-3 w-28">Length Unit</th>
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
                        onChange={e => updateRow(r.id, { name: e.target.value })}
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
                    <td className="py-2 px-3">
                      <select
                        value={r.lengthUnit}
                        onChange={e => updateRow(r.id, { lengthUnit: e.target.value as 'ft' | 'm' })}
                        className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                      >
                        <option value="ft">Feet</option>
                        <option value="m">Meters</option>
                      </select>
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
          message="This cannot be undone. All aquifers, wells, and measurements associated with this region will be permanently deleted."
          confirmLabel="Delete Region"
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
            <p className="text-sm font-medium text-slate-700 mb-3">Deleting region...</p>
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

export default RegionEditor;
