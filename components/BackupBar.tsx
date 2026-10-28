import React, { useEffect, useRef, useState } from 'react';
import { Download, Upload, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  BackupStatus, getBackupStatus, onBackupStatus, downloadBackup, planRestore, applyRestore, RestorePlan,
} from '../services/dataStore';

interface BackupBarProps {
  /** Whether there is any My Data to back up. */
  hasMyData: boolean;
  onDataChanged: () => void;
}

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

/**
 * The foot of the left panel: when My Data was last downloaded, how much has
 * changed since, and the two buttons that move it in and out of the browser.
 */
const BackupBar: React.FC<BackupBarProps> = ({ hasMyData, onDataChanged }) => {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [restoreState, setRestoreState] = useState<'confirm' | 'working' | 'done' | 'error'>('confirm');
  const [restoreError, setRestoreError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getBackupStatus().then(setStatus).catch(() => {});
    return onBackupStatus(setStatus);
  }, []);

  const handleBackup = async () => {
    setBusy(true);
    try { await downloadBackup(); } finally { setBusy(false); }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const p = await planRestore(file);
      setRestoreError(p.regions.length ? '' : 'This file has no regions in it. A backup holds one folder per region, each with a region.json.');
      setRestoreState(p.regions.length ? 'confirm' : 'error');
      setPlan(p);
    } catch (err) {
      setRestoreError(`This file could not be read as a backup (${err instanceof Error ? err.message : err}).`);
      setRestoreState('error');
      setPlan({ zip: null as any, regions: [] });
    }
  };

  const handleRestore = async () => {
    if (!plan) return;
    setRestoreState('working');
    try {
      await applyRestore(plan);
      setRestoreState('done');
      onDataChanged();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : String(err));
      setRestoreState('error');
    }
  };

  const unsaved = status && status.changesSinceBackup > 0;
  const line = !status
    ? ''
    : !hasMyData
      ? 'My Data is empty'
      : status.lastBackupAt
        ? `Backed up ${ago(status.lastBackupAt)}${unsaved ? ` · ${status.changesSinceBackup} change${status.changesSinceBackup === 1 ? '' : 's'} since` : ''}`
        : 'Not backed up yet';

  return (
    <div className="px-4 py-3 border-t border-[var(--border)] bg-[var(--surface2)]">
      <p
        className={`text-[11px] mb-2 flex items-center gap-1.5 ${hasMyData && (unsaved || !status?.lastBackupAt) ? 'text-[var(--warn-text)]' : 'text-[var(--text-faint)]'}`}
        title="My Data lives in this browser. Download a backup to keep a copy you can restore on any computer."
      >
        {hasMyData && (unsaved || !status?.lastBackupAt) && <AlertTriangle size={12} />}
        {line}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button className="rfs-btn" onClick={handleBackup} disabled={!hasMyData || busy}
          title="Download all of My Data as a zip file">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Back up
        </button>
        <button className="rfs-btn" onClick={() => fileRef.current?.click()}
          title="Load a backup zip into My Data">
          <Upload size={14} /> Restore
        </button>
        <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={handleFile} />
      </div>

      {plan && (
        <div className="fixed inset-0 z-[105] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 text-slate-700">
            {restoreState === 'confirm' && (
              <>
                <h3 className="text-lg font-bold text-slate-800 mb-1">Restore backup</h3>
                <p className="text-sm text-slate-500 mb-3">
                  These regions will be added to My Data. A region already in My Data with the same ID is replaced.
                </p>
                <ul className="text-sm space-y-1 mb-4 max-h-60 overflow-y-auto">
                  {plan.regions.map(r => (
                    <li key={r.id} className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{r.name}</span>
                      <span className={`text-xs ${r.replaces ? 'text-red-600' : 'text-slate-400'}`}>
                        {r.replaces ? 'replaces existing' : r.renamedTo ? `added as ${r.renamedTo}` : 'new'}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-3">
                  <button onClick={() => setPlan(null)} className="flex-1 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">
                    Cancel
                  </button>
                  <button onClick={handleRestore} className="flex-1 py-2 rounded-lg text-sm font-bold text-white bg-blue-600 hover:bg-blue-700">
                    Restore
                  </button>
                </div>
              </>
            )}
            {restoreState === 'working' && (
              <div className="flex flex-col items-center py-8">
                <Loader2 size={32} className="animate-spin text-blue-500 mb-4" />
                <p className="text-sm font-medium text-slate-600">Restoring…</p>
              </div>
            )}
            {(restoreState === 'done' || restoreState === 'error') && (
              <>
                <h3 className="text-lg font-bold text-slate-800 mb-3 flex items-center gap-2">
                  {restoreState === 'done'
                    ? <><CheckCircle2 size={18} className="text-green-600" /> Restored</>
                    : <><AlertTriangle size={18} className="text-red-600" /> Restore failed</>}
                </h3>
                <p className="text-sm text-slate-600 mb-4">
                  {restoreState === 'done'
                    ? `${plan.regions.length} region${plan.regions.length === 1 ? '' : 's'} restored to My Data.`
                    : restoreError}
                </p>
                <button onClick={() => setPlan(null)} className="w-full py-2 bg-slate-800 text-slate-50 rounded-lg text-sm font-bold hover:bg-slate-700">
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default BackupBar;
