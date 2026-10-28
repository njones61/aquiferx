
import React, { useState, useMemo } from 'react';
import { X, Trash2, Save } from 'lucide-react';
import { Well, Measurement, DataType } from '../types';

interface DataEditorProps {
  well: Well;
  measurements: Measurement[];
  allMeasurements: Measurement[];
  regionId: string;
  dataType: DataType;
  onClose: () => void;
  onSave: (updatedMeasurements: Measurement[]) => void;
}

function computeOutlierBounds(values: number[], multiplier: number): { lower: number; upper: number } {
  if (values.length < 4) return { lower: -Infinity, upper: Infinity };
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  return { lower: q1 - multiplier * iqr, upper: q3 + multiplier * iqr };
}

const DataEditor: React.FC<DataEditorProps> = ({ well, measurements, allMeasurements, regionId, dataType, onClose, onSave }) => {
  // Local editable copy, sorted by date ascending
  const [rows, setRows] = useState<Measurement[]>(() =>
    [...measurements].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  );
  const [deletedIndices, setDeletedIndices] = useState<Set<number>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [iqrMultiplier, setIqrMultiplier] = useState(3);

  const outlierBounds = useMemo(() => {
    const activeValues = rows.filter((_, i) => !deletedIndices.has(i)).map(r => r.value);
    return computeOutlierBounds(activeValues, iqrMultiplier);
  }, [rows, deletedIndices, iqrMultiplier]);

  const outlierCount = useMemo(() =>
    rows.filter((r, i) => !deletedIndices.has(i) && (r.value < outlierBounds.lower || r.value > outlierBounds.upper)).length,
  [rows, deletedIndices, outlierBounds]);

  const handleValueChange = (index: number, val: string) => {
    const num = parseFloat(val);
    if (isNaN(num)) return;
    setRows(prev => prev.map((r, i) => i === index ? { ...r, value: num } : r));
  };

  const toggleDelete = (index: number) => {
    setDeletedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const survivingRows = rows.filter((_, i) => !deletedIndices.has(i));
      const otherMeasurements = allMeasurements.filter(m => !(m.wellId === well.id && m.regionId === well.regionId && m.aquiferId === well.aquiferId && m.dataType === dataType.code));
      const updatedAll = [...otherMeasurements, ...survivingRows];
      onSave(updatedAll);
      onClose();
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = useMemo(() => {
    if (deletedIndices.size > 0) return true;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].value !== measurements.find(m => m.date === rows[i].date && m.wellId === rows[i].wellId)?.value) {
        return true;
      }
    }
    return false;
  }, [rows, deletedIndices, measurements]);

  const columnLabel = `${dataType.name} (${dataType.unit})`;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Edit Measurements</h2>
            <p className="text-sm text-slate-500">{well.name} &middot; {rows.length - deletedIndices.size} records</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Outlier sensitivity control */}
        <div className="flex items-center gap-3 px-6 py-2 bg-slate-50 border-b border-slate-200 text-sm">
          <label className="text-slate-600">Outlier threshold:</label>
          <input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={iqrMultiplier}
            onChange={e => setIqrMultiplier(parseFloat(e.target.value))}
            className="w-32 accent-blue-600"
          />
          <span className="text-slate-500 cursor-help" title="Interquartile range: the spread of the middle half of the values, from the 25th to the 75th percentile">{iqrMultiplier}&times; IQR</span>
          <span className="text-red-600 font-medium ml-auto">
            {outlierCount} outlier{outlierCount === 1 ? '' : 's'}
          </span>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto px-6 py-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">{columnLabel}</th>
                <th className="py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const isDeleted = deletedIndices.has(i);
                const isOutlier = !isDeleted && (row.value < outlierBounds.lower || row.value > outlierBounds.upper);
                return (
                  <tr
                    key={`${row.date}-${i}`}
                    className={`border-b border-slate-100 transition-colors ${
                      isDeleted ? 'opacity-40 line-through bg-red-50' :
                      isOutlier ? 'bg-red-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="py-1.5 pr-4 text-slate-700">
                      {new Date(row.date).toLocaleDateString()}
                    </td>
                    <td className="py-1.5 pr-4">
                      <input
                        type="number"
                        step="any"
                        value={row.value}
                        disabled={isDeleted}
                        onChange={e => handleValueChange(i, e.target.value)}
                        className={`w-28 px-2 py-1 rounded border text-sm ${
                          isOutlier ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'
                        } focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:bg-slate-100 disabled:text-slate-400`}
                      />
                    </td>
                    <td className="py-1.5 text-center">
                      <button
                        onClick={() => toggleDelete(i)}
                        className={`p-1 rounded transition-colors ${
                          isDeleted ? 'text-blue-500 hover:text-blue-700' : 'text-slate-400 hover:text-red-500'
                        }`}
                        title={isDeleted ? 'Restore row' : 'Delete row'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-8 text-center text-slate-400">No measurements found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Outlier legend */}
        {outlierCount > 0 && (
          <div className="px-6 py-2 text-xs text-red-700 bg-red-50 border-t border-red-200">
            Rows highlighted in red are statistical outliers (outside {iqrMultiplier}&times; IQR).
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save size={14} />
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DataEditor;
