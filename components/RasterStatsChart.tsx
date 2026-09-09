import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';
import { Settings } from 'lucide-react';
import { RasterFrameStats } from '../types';

interface RasterStatsChartProps {
  stats: RasterFrameStats[];
  dataTypeName: string;
  dataTypeUnit: string;
  referenceDate?: number;
}

const RasterStatsChart: React.FC<RasterStatsChartProps> = ({
  stats, dataTypeName, dataTypeUnit, referenceDate
}) => {
  const [showStd, setShowStd] = useState(true);
  const [showMedian, setShowMedian] = useState(false);
  const [showIqr, setShowIqr] = useState(false);
  const [showMinMax, setShowMinMax] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsOpen]);

  const chartData = useMemo(() =>
    stats.filter(s => s.count > 0).map(s => {
      const stdLow = Math.round((s.mean - s.std) * 100) / 100;
      const stdHigh = Math.round((s.mean + s.std) * 100) / 100;
      return {
        date: new Date(s.date).getTime(),
        mean: s.mean,
        median: s.median,
        count: s.count,
        std: s.std,
        p25: s.p25,
        p75: s.p75,
        min: s.min,
        max: s.max,
        // Stacked band data: base + height. Zero out hidden bands so they don't affect Y domain.
        mmBase: showMinMax ? s.min : 0,
        mmBand: showMinMax ? s.max - s.min : 0,
        iqrBase: showIqr ? s.p25 : 0,
        iqrBand: showIqr ? s.p75 - s.p25 : 0,
        stdBase: showStd ? stdLow : 0,
        stdBand: showStd ? stdHigh - stdLow : 0,
      };
    }),
  [stats, showStd, showIqr, showMinMax]);

  const yDomain = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const d of chartData) {
      // Mean is always shown
      lo = Math.min(lo, d.mean);
      hi = Math.max(hi, d.mean);
      if (showMedian) { lo = Math.min(lo, d.median); hi = Math.max(hi, d.median); }
      if (showStd) { lo = Math.min(lo, d.stdBase); hi = Math.max(hi, d.stdBase + d.stdBand); }
      if (showIqr) { lo = Math.min(lo, d.p25); hi = Math.max(hi, d.p75); }
      if (showMinMax) { lo = Math.min(lo, d.min); hi = Math.max(hi, d.max); }
    }
    const pad = (hi - lo) * 0.05 || 1;
    return [Math.floor(lo - pad), Math.ceil(hi + pad)];
  }, [chartData, showStd, showMedian, showIqr, showMinMax]);

  if (chartData.length === 0) return <div className="text-sm text-[var(--text-faint)] p-4">No statistics available.</div>;

  return (
    <div className="w-full h-full relative">
      <div className="absolute top-0 right-0 z-10" ref={settingsRef}>
        <button
          onClick={() => setSettingsOpen(p => !p)}
          className="p-1 rounded transition-colors text-[var(--text-faint)] hover:text-[var(--accent)] hover:bg-[var(--surface2)]"
          title="Chart settings"
        >
          <Settings size={14} />
        </button>
        {settingsOpen && (
          <div className="rfs-card absolute right-0 top-7 z-10 p-3 space-y-2 min-w-[180px]">
            <label className="flex items-center gap-2 cursor-pointer text-xs text-[var(--text-dim)]">
              <input type="checkbox" checked={showStd} onChange={e => setShowStd(e.target.checked)} className="accent-blue-500 rounded" />
              Mean ± Std Dev
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-xs text-[var(--text-dim)]">
              <input type="checkbox" checked={showMedian} onChange={e => setShowMedian(e.target.checked)} className="accent-purple-500 rounded" />
              Median
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-xs text-[var(--text-dim)]">
              <input type="checkbox" checked={showIqr} onChange={e => setShowIqr(e.target.checked)} className="accent-teal-500 rounded" />
              P25–P75 (IQR)
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-xs text-[var(--text-dim)]">
              <input type="checkbox" checked={showMinMax} onChange={e => setShowMinMax(e.target.checked)} className="accent-orange-500 rounded" />
              Min–Max
            </label>
          </div>
        )}
      </div>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis
            dataKey="date" type="number" domain={['dataMin', 'dataMax']}
            tickFormatter={(t: number) => new Date(t).getFullYear().toString()}
            stroke="#94a3b8" fontSize={10}
          />
          <YAxis
            stroke="#94a3b8" fontSize={10}
            domain={yDomain}
            tickFormatter={(v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            label={{ value: `${dataTypeName} (${dataTypeUnit})`, angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: 'var(--chart-text)', fontSize: 10 } }}
          />
          <Tooltip
            content={({ label, payload }) => {
              if (!payload || payload.length === 0) return null;
              const d = chartData.find(c => c.date === label);
              if (!d) return null;
              return (
                <div className="rfs-tip px-3 py-2 text-[10px] space-y-0.5">
                  <div className="text-[var(--text-faint)] mb-1">{new Date(label as number).toLocaleDateString()} — {d.count} wells</div>
                  <div className="text-blue-700 font-medium">Mean: {d.mean} {dataTypeUnit}</div>
                  {showStd && <div className="text-blue-400">Std Dev: ±{d.std.toFixed(1)}</div>}
                  {showMedian && <div className="text-purple-600">Median: {d.median}</div>}
                  {showIqr && <div className="text-teal-600">P25–P75: {d.p25} – {d.p75}</div>}
                  {showMinMax && <div className="text-orange-600">Min–Max: {d.min} – {d.max}</div>}
                </div>
              );
            }}
          />
          <Area type="monotone" dataKey="mmBase" stackId="mm" stroke="none" fill="transparent" fillOpacity={0} isAnimationActive={false} />
          <Area type="monotone" dataKey="mmBand" stackId="mm" stroke="none" fill="#fdba74" fillOpacity={showMinMax ? 0.2 : 0} isAnimationActive={false} />
          <Area type="monotone" dataKey="iqrBase" stackId="iqr" stroke="none" fill="transparent" fillOpacity={0} isAnimationActive={false} />
          <Area type="monotone" dataKey="iqrBand" stackId="iqr" stroke="none" fill="#5eead4" fillOpacity={showIqr ? 0.3 : 0} isAnimationActive={false} />
          <Area type="monotone" dataKey="stdBase" stackId="std" stroke="none" fill="transparent" fillOpacity={0} isAnimationActive={false} />
          <Area type="monotone" dataKey="stdBand" stackId="std" stroke="none" fill="#93c5fd" fillOpacity={showStd ? 0.35 : 0} isAnimationActive={false} />
          <Line type="monotone" dataKey="mean" stroke="#60a5fa" strokeWidth={2} dot={false} isAnimationActive={false} />
          {showMedian && (
            <Line type="monotone" dataKey="median" stroke="#c084fc" strokeWidth={1.5} strokeDasharray="4 2" dot={false} isAnimationActive={false} />
          )}
          {referenceDate && (
            <ReferenceLine x={referenceDate} stroke="#f87171" strokeDasharray="4 3" strokeWidth={1.5} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

export default RasterStatsChart;
