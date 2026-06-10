import React, { useState, useEffect, useMemo } from 'react';
import { X, Plus, Pencil, Trash2, Loader2, Info, BookOpen } from 'lucide-react';
import { DataType, RegionMeta, ParameterCatalog } from '../../types';
import { saveFiles, deleteFile } from '../../services/importUtils';
import { loadCatalog } from '../../services/catalog';
import ConfirmDialog from './ConfirmDialog';
import CatalogBrowser from '../CatalogBrowser';

interface DataTypeEditorProps {
  regionId: string;
  regionName: string;
  lengthUnit: 'ft' | 'm';
  customDataTypes: DataType[];
  singleUnit: boolean;
  onUpdate: (updatedCustomTypes: DataType[]) => void;
  onClose: () => void;
}

function generateCode(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
}

function isValidCode(code: string): boolean {
  return /^[a-z0-9_]{1,20}$/.test(code);
}

const DataTypeEditor: React.FC<DataTypeEditorProps> = ({
  regionId, regionName, lengthUnit, customDataTypes, singleUnit, onUpdate, onClose
}) => {
  const [types, setTypes] = useState<DataType[]>(customDataTypes);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [deleteCode, setDeleteCode] = useState<string | null>(null);

  // Custom add form
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newUnit, setNewUnit] = useState('');
  const [codeError, setCodeError] = useState('');

  // Edit form
  const [editName, setEditName] = useState('');
  const [editUnit, setEditUnit] = useState('');

  // Catalog (for collision validation)
  const [catalog, setCatalog] = useState<ParameterCatalog | null>(null);

  // Cross-region custom suggestions (non-catalog only)
  const [suggestions, setSuggestions] = useState<DataType[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [showCatalogBrowser, setShowCatalogBrowser] = useState(false);

  useEffect(() => {
    loadCatalog().then(setCatalog).catch(() => setCatalog({ parameters: {} }));
  }, []);

  const catalogCodes = useMemo(
    () => new Set(Object.keys(catalog?.parameters || {})),
    [catalog]
  );

  useEffect(() => {
    const fetchSuggestions = async () => {
      try {
        const res = await fetch('/api/regions');
        if (!res.ok) return;
        const allRegions: any[] = await res.json();
        const existing = new Set(types.map(t => t.code));
        const seen = new Set<string>();
        const sugs: DataType[] = [];
        for (const r of allRegions) {
          if (r.id === regionId) continue;
          const others: DataType[] = Array.isArray(r.customDataTypes)
            ? r.customDataTypes
            : Array.isArray(r.dataTypes)
              ? r.dataTypes
              : [];
          for (const dt of others) {
            if (existing.has(dt.code) || seen.has(dt.code) || dt.code === 'wte') continue;
            if (catalogCodes.has(dt.code)) continue;
            seen.add(dt.code);
            sugs.push(dt);
          }
        }
        setSuggestions(sugs);
      } catch {}
    };
    fetchSuggestions();
  }, [types, regionId, catalogCodes]);

  const validateCode = (code: string) => {
    if (!isValidCode(code)) { setCodeError('Must be lowercase alphanumeric + underscore, max 20 chars'); return false; }
    if (code === 'wte') { setCodeError('Cannot use reserved code "wte"'); return false; }
    if (catalogCodes.has(code)) {
      setCodeError(`"${code}" is a catalog parameter — don't add it as a custom. Just import a column as "${code}" and it will appear here automatically.`);
      return false;
    }
    if (types.some(t => t.code === code)) { setCodeError('Code already exists'); return false; }
    setCodeError('');
    return true;
  };

  const persistTypes = async (updatedTypes: DataType[]) => {
    setIsSaving(true);
    try {
      const meta: RegionMeta = { id: regionId, name: regionName, lengthUnit, singleUnit, customDataTypes: updatedTypes };
      await saveFiles([{ path: `${regionId}/region.json`, content: JSON.stringify(meta, null, 2) }]);
      setTypes(updatedTypes);
      onUpdate(updatedTypes);
    } catch (err) {
      setCodeError(`Failed to save: ${err}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddCustom = async () => {
    if (!newName.trim() || !validateCode(newCode)) return;
    const dt: DataType = { code: newCode, name: newName.trim(), unit: newUnit };
    await persistTypes([...types, dt]);
    setShowAddForm(false);
    setNewName('');
    setNewCode('');
    setNewUnit('');
  };

  const handleAddSuggestion = async (dt: DataType) => {
    await persistTypes([...types, dt]);
  };

  const startEdit = (dt: DataType) => {
    setEditingCode(dt.code);
    setEditName(dt.name);
    setEditUnit(dt.unit);
  };

  const handleEdit = async () => {
    if (!editingCode || !editName.trim()) return;
    const updated = types.map(t => t.code === editingCode ? { ...t, name: editName.trim(), unit: editUnit } : t);
    await persistTypes(updated);
    setEditingCode(null);
  };

  const handleDelete = async () => {
    if (!deleteCode) return;
    setIsSaving(true);
    try {
      await deleteFile(`${regionId}/data_${deleteCode}.csv`);
    } catch {}
    try {
      const updated = types.filter(t => t.code !== deleteCode);
      await persistTypes(updated);
    } finally {
      setDeleteCode(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Custom Data Types</h2>
            <p className="text-sm text-slate-500">{regionName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        {/* Help banner */}
        <div className="flex items-start gap-2 p-3 mb-4 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
          <Info size={14} className="mt-0.5 shrink-0" />
          <div>
            <p>
              Standard water quality parameters (nitrate, arsenic, pH, etc.) appear
              automatically when you import data for them — you don't need to add
              them here. This screen is only for <strong>custom types</strong> that
              aren't in the catalog, like BOD5 or trichloroethane.
            </p>
            <button
              onClick={() => setShowCatalogBrowser(true)}
              className="mt-2 inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 font-medium"
            >
              <BookOpen size={12} /> Browse Catalog
            </button>
          </div>
        </div>

        {/* Custom data types table */}
        {types.length > 0 ? (
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="text-left text-slate-500 border-b">
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Code</th>
                <th className="py-2 pr-3 font-medium">Unit</th>
                <th className="py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {types.map(dt => {
                const conflictsWithCatalog = catalogCodes.has(dt.code);
                return (
                  <tr key={dt.code} className="border-b border-slate-100">
                    {editingCode === dt.code ? (
                      <>
                        <td className="py-2 pr-3">
                          <input value={editName} onChange={e => setEditName(e.target.value)}
                            className="w-full px-2 py-1 border border-slate-300 rounded text-sm" autoFocus />
                        </td>
                        <td className="py-2 pr-3 text-slate-400 font-mono text-xs">{dt.code}</td>
                        <td className="py-2 pr-3">
                          <input value={editUnit} onChange={e => setEditUnit(e.target.value)}
                            className="w-20 px-2 py-1 border border-slate-300 rounded text-sm" />
                        </td>
                        <td className="py-2 text-right">
                          <button onClick={handleEdit} className="text-xs text-blue-600 hover:text-blue-800 mr-2">Save</button>
                          <button onClick={() => setEditingCode(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-2 pr-3 text-slate-700">
                          {dt.name}
                          {conflictsWithCatalog && (
                            <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-medium" title="Code collides with catalog">
                              catalog conflict
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs text-slate-500">{dt.code}</td>
                        <td className="py-2 pr-3 text-slate-600">{dt.unit}</td>
                        <td className="py-2 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <button onClick={() => startEdit(dt)} className="p-1 text-slate-400 hover:text-blue-600"><Pencil size={12} /></button>
                            <button onClick={() => setDeleteCode(dt.code)} className="p-1 text-slate-400 hover:text-red-600"><Trash2 size={12} /></button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-slate-400 italic mb-4">No custom types for this region.</p>
        )}

        {/* Add section */}
        {!showAddForm ? (
          <div className="mb-4">
            <button onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 font-medium">
              <Plus size={14} /> Add Custom Type
            </button>

            {suggestions.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-medium text-slate-500 mb-2">Custom types from other regions:</p>
                <div className="flex flex-wrap gap-2">
                  {suggestions.map(dt => (
                    <button key={dt.code} onClick={() => handleAddSuggestion(dt)}
                      className="px-2 py-1 bg-slate-100 text-slate-700 rounded-full text-xs hover:bg-blue-50 hover:text-blue-700 transition-colors">
                      + {dt.name} ({dt.unit})
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg mb-4">
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                <input value={newName} onChange={e => { setNewName(e.target.value); const g = generateCode(e.target.value); setNewCode(g); validateCode(g); }}
                  placeholder="e.g., BOD5" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Code</label>
                <input value={newCode} onChange={e => { setNewCode(e.target.value); validateCode(e.target.value); }}
                  placeholder="e.g., bod5" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono" />
                {codeError && <p className="text-xs text-red-600 mt-1">{codeError}</p>}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Unit</label>
                <input value={newUnit} onChange={e => setNewUnit(e.target.value)}
                  placeholder="e.g., mg/L" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => { setShowAddForm(false); setNewName(''); setNewCode(''); setNewUnit(''); setCodeError(''); }} className="px-3 py-1.5 text-sm text-slate-600">Cancel</button>
                <button onClick={handleAddCustom} disabled={!newName.trim() || !newCode || !!codeError || isSaving}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                  {isSaving && <Loader2 size={12} className="animate-spin" />} Add
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={onClose} className="px-6 py-2 bg-slate-800 text-white rounded-lg font-medium text-sm hover:bg-slate-700">Done</button>
        </div>
      </div>

      {deleteCode && (
        <ConfirmDialog
          title="Delete Custom Data Type"
          message={`Delete "${types.find(t => t.code === deleteCode)?.name}" and its data file (data_${deleteCode}.csv)?`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteCode(null)}
        />
      )}

      {showCatalogBrowser && <CatalogBrowser onClose={() => setShowCatalogBrowser(false)} />}
    </div>
  );
};

export default DataTypeEditor;
