import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { MapDisplay } from '../types';
import { deleteAllMyData, getStorageInfo, StorageInfo } from '../services/dataStore';
import { setTheme, useTheme } from '../utils/theme';
import ConfirmDialog from './import/ConfirmDialog';

interface SettingsDialogProps {
  display: MapDisplay;
  onDisplayChange: (patch: Partial<MapDisplay>) => void;
  hasMyData: boolean;
  onDataChanged: () => void;
  onClose: () => void;
}

const formatBytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB`
    : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB`
      : `${(n / 1024 ** 3).toFixed(2)} GB`;

/** The panel's Settings button: appearance, and My Data as the browser holds it. */
const SettingsDialog: React.FC<SettingsDialogProps> = ({ display, onDisplayChange, hasMyData, onDataChanged, onClose }) => {
  const theme = useTheme();
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    getStorageInfo().then(setStorage).catch(() => {});
  }, [deleted]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !confirmDelete) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, confirmDelete]);

  const handleDelete = async () => {
    setConfirmDelete(false);
    await deleteAllMyData();
    setDeleted(true);
    onDataChanged();
  };

  return (
    <div className="fixed inset-0 z-[150] flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md my-[8vh] p-6 text-slate-700" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-slate-800">Settings</h2>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <section className="mb-6">
          <h3 className="text-sm font-bold text-slate-800 mb-3">Appearance</h3>
          <label className="flex items-center gap-3 mb-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="rfs-check w-4 h-4"
              checked={theme === 'light'}
              onChange={e => setTheme(e.target.checked ? 'light' : 'dark')}
            />
            Light mode
          </label>
          <label className="flex items-center gap-3 text-sm">
            <span className="min-w-[140px]">Map label size</span>
            <input
              type="number"
              min={6}
              max={24}
              step={1}
              value={display.labelFontSize}
              onChange={e => onDisplayChange({ labelFontSize: Math.max(6, Math.min(24, parseInt(e.target.value) || 9)) })}
              className="w-16 px-2 py-1 border border-slate-300 rounded text-sm text-center"
            />
            <span className="text-slate-400">px</span>
          </label>
        </section>

        <section className="mb-6">
          <h3 className="text-sm font-bold text-slate-800 mb-2">My Data in this browser</h3>
          <p className="text-[13px] text-slate-500 mb-3 leading-relaxed">
            My Data is stored by this browser on this computer. Clearing your browsing data removes it, so use
            Back up to keep a copy, and Restore to load it here or on another computer.
            {storage?.usage != null && <> This site is using {formatBytes(storage.usage)}.</>}
            {storage?.persisted === true && <> The browser has agreed to keep it when disk space runs low.</>}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={!hasMyData}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Delete all My Data
            </button>
            {deleted && <span className="text-[13px] text-slate-500">Deleted.</span>}
          </div>
        </section>

        <div className="flex justify-end">
          <button onClick={onClose} className="px-5 py-2 bg-slate-800 text-slate-50 rounded-lg text-sm font-medium hover:bg-slate-700">
            Close
          </button>
        </div>
      </div>

      {confirmDelete && (
        <div onClick={e => e.stopPropagation()}>
          <ConfirmDialog
            title="Delete all My Data?"
            message="Every region in My Data is removed from this browser. Sample Data is not affected. This cannot be undone, so back up first if you might want any of it again."
            confirmLabel="Delete everything"
            onConfirm={handleDelete}
            onCancel={() => setConfirmDelete(false)}
          />
        </div>
      )}
    </div>
  );
};

export default SettingsDialog;
