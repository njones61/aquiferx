import React from 'react';
import { Loader2 } from 'lucide-react';
import { UseCrsPickerReturn } from '../../hooks/useCrsPicker';

interface CrsPickerPanelProps {
  crs: UseCrsPickerReturn;
  /** Tailwind class overrides for tinting (defaults to sky). */
  accent?: {
    border: string;
    text: string;
    button: string;
    bgLight: string;
    hover: string;
  };
}

const defaultAccent: NonNullable<CrsPickerPanelProps['accent']> = {
  border: 'border-sky-200',
  text: 'text-sky-700',
  button: 'bg-sky-600 hover:bg-sky-700',
  bgLight: 'bg-white',
  hover: 'hover:bg-sky-100',
};

const CrsPickerPanel: React.FC<CrsPickerPanelProps> = ({ crs, accent = defaultAccent }) => {
  const presetKnown = crs.COMMON_CRS_OPTIONS.some(o => o.code === crs.coordinateCrs);
  return (
    <div>
      <label className="text-xs text-slate-600 block mb-1">Coordinate system</label>
      {crs.crsInputMode === 'preset' ? (
        <div className="flex items-center gap-2">
          <select
            value={presetKnown ? crs.coordinateCrs : '__other__'}
            onChange={e => {
              if (e.target.value === '__other__') return;
              crs.handleCrsPresetChange(e.target.value);
            }}
            className={`flex-1 px-2 py-1 border ${accent.border} rounded text-xs ${accent.bgLight}`}
          >
            {crs.COMMON_CRS_OPTIONS.map(o => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
            {!presetKnown && <option value="__other__">{crs.crsName}</option>}
            <option value="__epsg__">Enter an EPSG code (the number of a coordinate system)…</option>
          </select>
          <button
            onClick={crs.handleAutoDetectCrs}
            disabled={crs.isAutoDetecting}
            className={`px-2 py-1 ${accent.bgLight} border ${accent.border} rounded text-xs ${accent.text} ${accent.hover} disabled:opacity-50 flex items-center gap-1`}
          >
            {crs.isAutoDetecting && <Loader2 size={10} className="animate-spin" />}
            Auto-detect
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={crs.epsgCodeInput}
            onChange={e => crs.setEpsgCodeInput(e.target.value)}
            placeholder="e.g. 3448"
            className={`flex-1 px-2 py-1 border ${accent.border} rounded text-xs`}
          />
          <button
            onClick={crs.handleEpsgLookup}
            disabled={crs.isLookingUpCrs || !crs.epsgCodeInput.trim()}
            className={`px-2 py-1 ${accent.button} text-white rounded text-xs font-medium disabled:opacity-50 flex items-center gap-1`}
          >
            {crs.isLookingUpCrs && <Loader2 size={10} className="animate-spin" />}
            Look up
          </button>
          <button
            onClick={() => { crs.setCrsInputMode('preset'); crs.setCrsLookupError(''); }}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
        </div>
      )}
      {crs.crsLookupError && <p className="text-xs text-red-600 mt-1">{crs.crsLookupError}</p>}
      {crs.crsPreview && (
        <p className={`text-xs mt-1 ${crs.crsPreview.ok ? 'text-green-700' : 'text-amber-700'}`}>
          {crs.crsPreview.ok ? '✓' : '✗'} Preview: first row → {crs.crsPreview.text}
          {crs.crsPreview.ok ? ' (inside region)' : ' — outside region, try a different CRS or Auto-detect'}
        </p>
      )}
    </div>
  );
};

export default CrsPickerPanel;
