
import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine, ReferenceArea
} from 'recharts';
import { Measurement, Well, DataType } from '../types';
import { interpolatePCHIP, kernelSmooth } from '../utils/interpolation';

const SERIES_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'
];

const GSE_COLOR = '#8B4513';


const SMOOTH_COLOR = '#f97316'; // orange

interface TimeSeriesChartProps {
  measurements: Measurement[];
  selectedWells: Well[];
  showGSE: boolean;
  showTrendLine: boolean;
  showSmooth: boolean;
  smoothMonths: number;
  usePCHIP?: boolean;
  dataType: DataType;
  lengthUnit?: 'ft' | 'm';
  referenceDate?: number;
  rasterTimeRange?: [number, number];
  trendWindowStart?: number;
  dateFilter?: { minYear: number; maxYear: number } | null;
  onEditMeasurement?: (wellId: string, date: number, newValue: number) => void;
  onDeleteMeasurement?: (wellId: string, date: number) => void;
  onEscapeUnhandled?: () => void;
}

interface SelectedPoint {
  wellId: string;
  date: number;
  value: number;
}

interface DotPosition extends SelectedPoint {
  cx: number;
  cy: number;
}

const HIT_RADIUS = 15;

const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({ measurements, selectedWells, showGSE, showTrendLine, showSmooth, smoothMonths, usePCHIP = true, dataType, lengthUnit = 'ft', referenceDate, rasterTimeRange, trendWindowStart, dateFilter, onEditMeasurement, onDeleteMeasurement, onEscapeUnhandled }) => {
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [editModal, setEditModal] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);
  const [editValue, setEditValue] = useState('');

  const wrapperRef = useRef<HTMLDivElement>(null);
  const dotPositionsRef = useRef<DotPosition[]>([]);

  // Drag-to-zoom state (zoom domain is React state; drag tracking is refs to avoid re-renders)
  const [zoomLeft, setZoomLeft] = useState<number | null>(null);
  const [zoomRight, setZoomRight] = useState<number | null>(null);
  const didDragRef = useRef(false);
  const dragOverlayRef = useRef<HTMLDivElement>(null);
  const modalsOpenRef = useRef(false);
  const isDraggingRef = useRef(false);
  const zoomStartTsRef = useRef<number | null>(null);
  const zoomEndTsRef = useRef<number | null>(null);
  const dataDomainRef = useRef<{ min: number; max: number }>({ min: 0, max: 1 });
  // Active zoom-drag teardown so unmounting mid-drag (tab switch) doesn't
  // leak the window listeners
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  // Dismiss on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editModal) setEditModal(false);
        else if (deleteModal) setDeleteModal(false);
        else if (contextMenu) setContextMenu(null);
        else if (selectedPoint) setSelectedPoint(null);
        else onEscapeUnhandled?.();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editModal, deleteModal, contextMenu, selectedPoint, onEscapeUnhandled]);

  // Reset zoom when wells or measurements change
  useEffect(() => {
    setZoomLeft(null);
    setZoomRight(null);
  }, [measurements, selectedWells]);

  const { chartData, wellIds } = useMemo(() => {
    if (measurements.length === 0 || selectedWells.length === 0) {
      return { chartData: [], wellIds: [] };
    }

    const byWell = new Map<string, Measurement[]>();
    for (const m of measurements) {
      if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
      byWell.get(m.wellId)!.push(m);
    }

    const orderedWellIds = selectedWells.map(w => w.id).filter(id => byWell.has(id));

    // PCHIP densification adds ~101 synthetic timestamps per well, and the
    // merged-row build is O(rows x wells) — for a large box selection that
    // multiplies into hundreds of thousands of chart rows and can freeze
    // the tab. Above this cap, plot raw measurements (linear) instead.
    const densify = usePCHIP && orderedWellIds.length <= 25;

    const wellSeries = new Map<string, { interpMap: Map<number, number>; actualSet: Set<number> }>();

    for (const wellId of orderedWellIds) {
      const wellMeasurements = byWell.get(wellId)!;
      const sorted = [...wellMeasurements]
        .filter(m => !isNaN(new Date(m.date).getTime()))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      if (sorted.length === 0) continue;

      const xValues = sorted.map(m => new Date(m.date).getTime());
      const yValues = sorted.map(m => m.value);
      const actualSet = new Set(xValues);
      const interpMap = new Map<number, number>();

      if (sorted.length === 1) {
        interpMap.set(xValues[0], yValues[0]);
      } else if (!densify) {
        // Linear: just plot the raw data points
        xValues.forEach((x, i) => interpMap.set(x, yValues[i]));
      } else {
        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);
        const range = maxX - minX;

        if (range === 0) {
          xValues.forEach((x, i) => interpMap.set(x, yValues[i]));
        } else {
          const step = range / 100;
          const targetX: number[] = [];
          for (let x = minX; x <= maxX; x += step) {
            targetX.push(x);
          }
          const interpolatedY = interpolatePCHIP(xValues, yValues, targetX);
          targetX.forEach((tx, i) => interpMap.set(tx, interpolatedY[i]));
          xValues.forEach((x, i) => interpMap.set(x, yValues[i]));
        }
      }

      wellSeries.set(wellId, { interpMap, actualSet });
    }

    const allTimestamps = new Set<number>();
    for (const { interpMap } of wellSeries.values()) {
      for (const t of interpMap.keys()) {
        allTimestamps.add(t);
      }
    }
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    const data = sortedTimestamps.map(t => {
      const point: Record<string, any> = { date: t };
      for (const wellId of orderedWellIds) {
        const series = wellSeries.get(wellId);
        if (series) {
          const val = series.interpMap.get(t);
          if (val !== undefined) {
            point[`val_${wellId}`] = val;
          }
          if (series.actualSet.has(t)) {
            point[`dot_${wellId}`] = val;
          }
        }
      }
      return point;
    });

    return { chartData: data, wellIds: orderedWellIds };
  }, [measurements, selectedWells, usePCHIP]);

  // Compute linear regression trend lines per well (requires >= 2 measurements)
  const trendData = useMemo(() => {
    if (!showTrendLine || measurements.length === 0 || selectedWells.length === 0) return null;

    const byWell = new Map<string, { x: number; y: number }[]>();
    for (const m of measurements) {
      const t = new Date(m.date).getTime();
      if (isNaN(t)) continue;
      // When trendWindowStart is set, only use points within the window for fitting
      if (trendWindowStart !== undefined && t < trendWindowStart) continue;
      if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
      byWell.get(m.wellId)!.push({ x: t, y: m.value });
    }

    const MS_PER_YEAR = 365.25 * 86400000;
    const lines = new Map<string, { startDate: number; startVal: number; endDate: number; endVal: number; slopePerYear: number }>();

    for (const [wellId, points] of byWell) {
      if (points.length < 2) continue;

      // Linear regression: y = mx + b
      const n = points.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
      for (const p of points) {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumXX += p.x * p.x;
      }
      const denom = n * sumXX - sumX * sumX;
      if (denom === 0) continue;

      const m = (n * sumXY - sumX * sumY) / denom;
      const b = (sumY - m * sumX) / n;

      // Extend trend line over the full window when trendWindowStart is set
      const startDate = trendWindowStart !== undefined ? trendWindowStart : Math.min(...points.map(p => p.x));
      const endDate = trendWindowStart !== undefined ? Date.now() : Math.max(...points.map(p => p.x));
      lines.set(wellId, {
        startDate,
        startVal: m * startDate + b,
        endDate,
        endVal: m * endDate + b,
        slopePerYear: m * MS_PER_YEAR,
      });
    }

    if (lines.size === 0) return null;
    return lines;
  }, [showTrendLine, measurements, selectedWells, trendWindowStart]);

  // Compute a single smoothed line per well using Nadaraya-Watson kernel regression
  // with PCHIP interpolation onto a monthly output grid for visual continuity.
  const smoothData = useMemo(() => {
    if (!showSmooth || measurements.length === 0 || wellIds.length === 0) return null;

    const byWell = new Map<string, Measurement[]>();
    for (const m of measurements) {
      if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
      byWell.get(m.wellId)!.push(m);
    }

    const result = new Map<string, Map<number, number>>();

    for (const wellId of wellIds) {
      const wellMeas = byWell.get(wellId);
      if (!wellMeas) continue;

      const sorted = [...wellMeas]
        .filter(m => !isNaN(new Date(m.date).getTime()))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      if (sorted.length < 2) continue;

      const xValues = sorted.map(m => new Date(m.date).getTime());
      const yValues = sorted.map(m => m.value);

      // Monthly output grid spanning the well's data range
      const outputTs: number[] = [];
      const cursor = new Date(xValues[0]);
      while (cursor.getTime() <= xValues[xValues.length - 1]) {
        outputTs.push(cursor.getTime());
        cursor.setMonth(cursor.getMonth() + 1);
      }

      const outputValues = kernelSmooth(xValues, yValues, outputTs, smoothMonths);

      const smoothMap = new Map<number, number>();
      for (let i = 0; i < outputTs.length; i++) {
        smoothMap.set(outputTs[i], outputValues[i]);
      }
      if (smoothMap.size > 0) result.set(wellId, smoothMap);
    }

    return result.size > 0 ? result : null;
  }, [showSmooth, smoothMonths, measurements, wellIds]);

  // Merge trend line endpoints and smooth data into chart data
  const finalChartData = useMemo(() => {
    if (!trendData && !smoothData) return chartData;

    // Index existing chart data by timestamp
    const byTime = new Map<number, Record<string, any>>();
    for (const point of chartData) {
      byTime.set(point.date as number, { ...point });
    }

    // Ensure trend endpoints exist and inject values
    if (trendData) {
      for (const { startDate, endDate } of trendData.values()) {
        if (!byTime.has(startDate)) byTime.set(startDate, { date: startDate });
        if (!byTime.has(endDate)) byTime.set(endDate, { date: endDate });
      }
      for (const [wellId, line] of trendData) {
        const startPoint = byTime.get(line.startDate);
        const endPoint = byTime.get(line.endDate);
        if (startPoint) startPoint[`trend_${wellId}`] = line.startVal;
        if (endPoint) endPoint[`trend_${wellId}`] = line.endVal;
      }
    }

    // Inject smooth values (creating new rows for grid timestamps that don't exist in chartData)
    if (smoothData) {
      for (const [wellId, smoothMap] of smoothData) {
        const key = `smooth_${wellId}`;
        for (const [t, v] of smoothMap) {
          if (!byTime.has(t)) byTime.set(t, { date: t });
          byTime.get(t)![key] = v;
        }
      }
    }

    return Array.from(byTime.values()).sort((a, b) => (a.date as number) - (b.date as number));
  }, [chartData, trendData, smoothData]);

  // Y-axis domain — must be declared before any early returns to satisfy React's
  // rules of hooks (same number of hooks on every render).
  const yDomain = useMemo(() => {
    if (!showGSE) return ['auto', 'auto'] as const;
    const gseValues = selectedWells
      .map(w => w.gse)
      .filter(v => v != null && !isNaN(v));
    if (gseValues.length === 0) return ['auto', 'auto'] as const;

    const allValues: number[] = [];
    for (const point of finalChartData) {
      for (const key of Object.keys(point)) {
        if ((key.startsWith('val_') || key.startsWith('trend_') || key.startsWith('smooth_')) && point[key] != null) {
          allValues.push(point[key] as number);
        }
      }
    }
    if (allValues.length === 0) return ['auto', 'auto'] as const;

    const dataMin = Math.min(...allValues);
    const dataMax = Math.max(...allValues, ...gseValues);
    const padding = (dataMax - dataMin) * 0.05 || 1;
    return [dataMin - padding, dataMax + padding];
  }, [showGSE, selectedWells, finalChartData]);

  modalsOpenRef.current = !!(contextMenu || editModal || deleteModal);
  // Sync data domain for pixel-to-timestamp fallback in zoom handler
  if (zoomLeft != null && zoomRight != null) {
    dataDomainRef.current = { min: zoomLeft, max: zoomRight };
  } else if (finalChartData.length > 0) {
    dataDomainRef.current = { min: finalChartData[0].date as number, max: finalChartData[finalChartData.length - 1].date as number };
  }

  // --- Drag-to-zoom: start handler (attached as React onMouseDown on the wrapper) ---
  // Overlay positioned via direct DOM manipulation for lag-free feedback.
  // Timestamps from Recharts events (primary) with pixel-based fallback.
  const getPlotBounds = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return null;
    // Find the main chart SVG (largest one — Legend icons are small SVGs)
    const allSvgs = wrapper.querySelectorAll('svg');
    let svg: SVGSVGElement | null = null;
    let maxArea = 0;
    for (const s of allSvgs) {
      const r = s.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > maxArea) { maxArea = area; svg = s as SVGSVGElement; }
    }
    if (!svg || maxArea < 100) return null;
    const grid = svg.querySelector('.recharts-cartesian-grid')
      || svg.querySelector('.recharts-cartesian-grid-bg');
    if (grid) {
      const wr = wrapper.getBoundingClientRect();
      const gr = grid.getBoundingClientRect();
      if (gr.width > 0 && gr.height > 0) {
        return { left: gr.left - wr.left, right: gr.right - wr.left, top: gr.top - wr.top, height: gr.height };
      }
    }
    const rects = svg.querySelectorAll('rect');
    const wr = wrapper.getBoundingClientRect();
    for (const rect of rects) {
      const rr = rect.getBoundingClientRect();
      if (rr.width > 50 && rr.height > 50) {
        return { left: rr.left - wr.left, right: rr.right - wr.left, top: rr.top - wr.top, height: rr.height };
      }
    }
    return null;
  }, []);

  const handleZoomMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || modalsOpenRef.current) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const plot = getPlotBounds();
    if (!plot) return;
    const wr = wrapper.getBoundingClientRect();
    const x = e.clientX - wr.left;
    if (x < plot.left || x > plot.right) return;

    isDraggingRef.current = true;
    zoomStartTsRef.current = null;
    zoomEndTsRef.current = null;

    const ds = { startX: x, wrLeft: wr.left, plotLeft: plot.left, plotRight: plot.right, plotTop: plot.top, plotHeight: plot.height };

    const onMove = (me: MouseEvent) => {
      const overlay = dragOverlayRef.current;
      if (!overlay) return;
      const currentX = Math.max(ds.plotLeft, Math.min(ds.plotRight, me.clientX - ds.wrLeft));
      const left = Math.min(ds.startX, currentX);
      const width = Math.abs(currentX - ds.startX);
      overlay.style.display = 'block';
      overlay.style.left = `${left}px`;
      overlay.style.top = `${ds.plotTop}px`;
      overlay.style.width = `${width}px`;
      overlay.style.height = `${ds.plotHeight}px`;
    };

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragOverlayRef.current) dragOverlayRef.current.style.display = 'none';
      isDraggingRef.current = false;
      dragCleanupRef.current = null;
    };

    const onUp = (me: MouseEvent) => {
      cleanup();

      let leftTs: number | null = null;
      let rightTs: number | null = null;
      const startTs = zoomStartTsRef.current;
      const endTs = zoomEndTsRef.current;
      if (startTs != null && endTs != null) {
        leftTs = Math.min(startTs, endTs);
        rightTs = Math.max(startTs, endTs);
      } else {
        const endX = Math.max(ds.plotLeft, Math.min(ds.plotRight, me.clientX - ds.wrLeft));
        const leftPx = Math.min(ds.startX, endX);
        const rightPx = Math.max(ds.startX, endX);
        if (rightPx - leftPx < 5) return;
        const { min, max } = dataDomainRef.current;
        const plotWidth = ds.plotRight - ds.plotLeft;
        if (plotWidth > 0 && max > min) {
          leftTs = min + ((leftPx - ds.plotLeft) / plotWidth) * (max - min);
          rightTs = min + ((rightPx - ds.plotLeft) / plotWidth) * (max - min);
        }
      }

      if (leftTs != null && rightTs != null && rightTs - leftTs > 86400000) {
        didDragRef.current = true;
        setZoomLeft(leftTs);
        setZoomRight(rightTs);
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    dragCleanupRef.current = cleanup;
  }, [getPlotBounds]);

  if (measurements.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50 text-slate-400 text-sm italic">
        No measurement data available for this well.
      </div>
    );
  }

  const formatXAxis = (tickItem: number) => {
    const d = new Date(tickItem);
    return `${d.getMonth() + 1}/${d.getFullYear()}`;
  };

  const wellNameMap = new Map<string, string>();
  for (const w of selectedWells) {
    wellNameMap.set(w.id, w.name);
  }

  const yAxisLabel = `${dataType.name} (${dataType.unit})`;

  // --- Dot hit-testing ---
  // Clear positions for this render cycle; dot render functions repopulate it
  dotPositionsRef.current = [];

  const findNearestDot = (clientX: number, clientY: number): DotPosition | null => {
    const svg = wrapperRef.current?.querySelector('svg');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const svgX = clientX - rect.left;
    const svgY = clientY - rect.top;

    let nearest: DotPosition | null = null;
    let minDist = HIT_RADIUS;
    for (const dot of dotPositionsRef.current) {
      const dist = Math.sqrt((dot.cx - svgX) ** 2 + (dot.cy - svgY) ** 2);
      if (dist < minDist) {
        minDist = dist;
        nearest = dot;
      }
    }
    return nearest;
  };

  const handleWrapperClick = (e: React.MouseEvent) => {
    // Skip if just finished a drag-to-zoom gesture
    if (didDragRef.current) { didDragRef.current = false; return; }
    // Don't interfere with context menu backdrop or modal clicks
    if (contextMenu || editModal || deleteModal) return;
    const dot = findNearestDot(e.clientX, e.clientY);
    if (dot) {
      setSelectedPoint({ wellId: dot.wellId, date: dot.date, value: dot.value });
    } else {
      setSelectedPoint(null);
    }
  };

  const handleWrapperContextMenu = (e: React.MouseEvent) => {
    if (editModal || deleteModal) return;
    const dot = findNearestDot(e.clientX, e.clientY);
    if (dot) {
      e.preventDefault();
      setSelectedPoint({ wellId: dot.wellId, date: dot.date, value: dot.value });
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
  };

  const handleWrapperMouseMove = (e: React.MouseEvent) => {
    if (editModal || deleteModal || contextMenu) return;
    const dot = findNearestDot(e.clientX, e.clientY);
    if (wrapperRef.current) {
      wrapperRef.current.style.cursor = dot ? 'pointer' : '';
    }
  };

  const handleSaveEdit = () => {
    if (!selectedPoint || !onEditMeasurement) return;
    const val = parseFloat(editValue);
    if (isNaN(val)) return;
    onEditMeasurement(selectedPoint.wellId, selectedPoint.date, val);
    setEditModal(false);
    setSelectedPoint(null);
  };

  const handleConfirmDelete = () => {
    if (!selectedPoint || !onDeleteMeasurement) return;
    onDeleteMeasurement(selectedPoint.wellId, selectedPoint.date);
    setDeleteModal(false);
    setSelectedPoint(null);
  };

  return (
    <div
      ref={wrapperRef}
      className="w-full h-full relative outline-none"
      onMouseDownCapture={handleZoomMouseDown}
      onClick={handleWrapperClick}
      onContextMenu={handleWrapperContextMenu}
      onMouseMove={handleWrapperMouseMove}
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
        <LineChart
          key={usePCHIP ? 'pchip' : 'linear'}
          data={finalChartData}
          margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
          onMouseDown={(e: any) => {
            if (e?.activeLabel != null) {
              zoomStartTsRef.current = e.activeLabel as number;
              zoomEndTsRef.current = e.activeLabel as number;
            }
          }}
          onMouseMove={(e: any) => {
            if (isDraggingRef.current && e?.activeLabel != null) {
              zoomEndTsRef.current = e.activeLabel as number;
            }
          }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#94a3b8" />
          <XAxis
            dataKey="date"
            type="number"
            domain={zoomLeft != null && zoomRight != null
              ? [zoomLeft, zoomRight]
              : trendWindowStart !== undefined
                ? (() => { const range = Date.now() - trendWindowStart; const pad = range * 0.02; return [trendWindowStart - pad, Date.now() + pad]; })()
                : rasterTimeRange
                  ? (() => { const range = rasterTimeRange[1] - rasterTimeRange[0]; const pad = range * 0.02; return [rasterTimeRange[0] - pad, rasterTimeRange[1] + pad]; })()
                  : finalChartData.length > 0
                    ? (() => { const range = (finalChartData[finalChartData.length - 1].date as number) - (finalChartData[0].date as number); const pad = range * 0.02; return [finalChartData[0].date as number - pad, finalChartData[finalChartData.length - 1].date as number + pad]; })()
                    : ['auto', 'auto']}
            allowDataOverflow={zoomLeft != null}
            tickFormatter={formatXAxis}
            stroke="#475569"
            fontSize={11}
            tick={{ fill: '#334155' }}
          />
          <YAxis
            domain={yDomain as any}
            stroke="#475569"
            fontSize={11}
            tick={{ fill: '#334155' }}
            tickFormatter={(val) => val.toLocaleString()}
            label={{ value: yAxisLabel, angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: '#64748b', fontSize: 11 } }}
          />
          <Tooltip
            content={({ label, payload }) => {
              if (!payload || payload.length === 0 || label == null) return null;
              const valEntries = (payload as any[]).filter(p => p.dataKey?.startsWith('val_'));
              const smoothEntries = (payload as any[]).filter(p => p.dataKey?.startsWith('smooth_') && p.value != null);
              if (valEntries.length === 0 && smoothEntries.length === 0) return null;
              return (
                <div className="bg-white rounded-lg shadow-md px-2.5 py-1.5 text-xs border border-slate-200">
                  <div className="text-slate-500">{new Date(label as number).toLocaleDateString()}</div>
                  {valEntries.map((entry: any) => {
                    const wellId = entry.dataKey.replace('val_', '');
                    return (
                      <div key={entry.dataKey} className="flex items-center gap-1.5 text-slate-700">
                        <span className="w-1.5 h-1.5 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: entry.color }} />
                        <span>{entry.value?.toFixed(2)}</span>
                        {selectedWells.length > 1 && (
                          <span className="text-slate-400">{wellNameMap.get(wellId)}</span>
                        )}
                      </div>
                    );
                  })}
                  {smoothEntries.map((entry: any) => (
                    <div key={entry.dataKey} className="flex items-center gap-1.5 text-slate-500">
                      <span className="w-1.5 h-1.5 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: entry.color }} />
                      <span>{entry.value?.toFixed(2)}</span>
                      <span className="text-slate-400">{entry.name}</span>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          {(selectedWells.length > 1 || (showSmooth && smoothData)) && (
            <Legend
              wrapperStyle={{ pointerEvents: 'none' }}
              formatter={(value: string) => {
                if (value.startsWith('val_')) {
                  const wellId = value.replace('val_', '');
                  return wellNameMap.get(wellId) || wellId;
                }
                // Moving average labels are set via name prop
                return value;
              }}
            />
          )}
          {wellIds.map((wellId, i) => {
            const color = SERIES_COLORS[i % SERIES_COLORS.length];
            const isMulti = selectedWells.length > 1;
            const maActive = showSmooth && !!smoothData;
            const animate = !isMulti && zoomLeft == null;
            return (
              <React.Fragment key={wellId}>
                {/* Interpolated curve */}
                <Line
                  type="linear"
                  dataKey={`val_${wellId}`}
                  stroke={color}
                  strokeWidth={maActive ? 1 : 2}
                  dot={false}
                  connectNulls
                  isAnimationActive={animate}
                  animationDuration={400}
                  activeDot={{ r: maActive ? 4 : 6, strokeWidth: 0, fill: color }}
                  name={`val_${wellId}`}
                />
                {/* Actual measurement dots */}
                <Line
                  type="linear"
                  dataKey={`dot_${wellId}`}
                  stroke="transparent"
                  connectNulls={false}
                  isAnimationActive={animate}
                  animationDuration={400}
                  legendType="none"
                  dot={(props: any) => {
                    const { cx, cy, payload } = props;
                    if (payload[`dot_${wellId}`] === undefined) return <React.Fragment key={`empty-${wellId}-${payload.date}`} />;

                    // Record pixel position for hit-testing
                    dotPositionsRef.current.push({ cx, cy, wellId, date: payload.date, value: payload[`dot_${wellId}`] });

                    const isSelected = selectedPoint?.wellId === wellId && selectedPoint?.date === payload.date;
                    const dotR = maActive ? (isMulti ? 1.5 : 2) : (isMulti ? 2.5 : 3);
                    return (
                      <g key={`${wellId}-${payload.date}`}>
                        {isSelected && (
                          <circle cx={cx} cy={cy} r={7} fill="none" stroke="#facc15" strokeWidth={2.5} />
                        )}
                        <circle
                          cx={cx} cy={cy}
                          r={dotR}
                          fill={color}
                          stroke="transparent"
                          strokeWidth={0}
                        />
                      </g>
                    );
                  }}
                  name={`dot_${wellId}`}
                />
              </React.Fragment>
            );
          })}
          {showGSE && dataType.code === 'wte' && selectedWells.map((well) => {
            if (well.gse == null || isNaN(well.gse)) return null;
            return (
              <ReferenceLine
                key={`gse_${well.id}`}
                y={well.gse}
                stroke={GSE_COLOR}
                strokeDasharray="6 3"
                strokeWidth={1.5}
                label={{
                  value: selectedWells.length > 1 ? `GSE ${well.name}` : 'GSE',
                  position: 'right',
                  fill: GSE_COLOR,
                  fontSize: 11,
                }}
              />
            );
          })}
          {showSmooth && smoothData && wellIds.map((wellId) => {
            if (!smoothData.has(wellId)) return null;
            const key = `smooth_${wellId}`;
            const label = `${smoothMonths}-mo MAvg`;
            return (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={SMOOTH_COLOR}
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                connectNulls
                isAnimationActive={false}
                legendType="plainline"
                name={wellIds.length > 1 ? `${label} (${wellNameMap.get(wellId)})` : label}
              />
            );
          })}
          {referenceDate != null && (
            <ReferenceLine x={referenceDate} stroke="#ef4444" strokeDasharray="4 3" strokeWidth={1.5} />
          )}
          {dateFilter && (
            <ReferenceArea
              x1={new Date(dateFilter.minYear, 0, 1).getTime()}
              x2={new Date(dateFilter.maxYear, 11, 31).getTime()}
              fillOpacity={0.15}
              strokeOpacity={0.3}
              ifOverflow="extendDomain"
              {...{ fill: '#9ca3af', stroke: '#9ca3af' } as any}
            />
          )}
          {showTrendLine && trendData && wellIds.map((wellId) => {
            const line = trendData.get(wellId);
            if (!line) return null;
            const thresholds = lengthUnit === 'm' ? { extreme: 0.6, moderate: 0.15 } : { extreme: 2.0, moderate: 0.5 };
            const slope = line.slopePerYear;
            let color: string;
            if (slope < -thresholds.extreme) color = '#DC2626';
            else if (slope < -thresholds.moderate) color = '#FB923C';
            else if (slope <= thresholds.moderate) color = '#CA8A04';
            else if (slope <= thresholds.extreme) color = '#38BDF8';
            else color = '#2563EB';
            return (
              <Line
                key={`trend_${wellId}`}
                type="linear"
                dataKey={`trend_${wellId}`}
                stroke={color}
                strokeWidth={3}
                strokeDasharray="8 4"
                dot={false}
                connectNulls
                isAnimationActive={false}
                legendType="none"
                name={`trend_${wellId}`}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>

      {/* Drag-to-zoom overlay (positioned via direct DOM manipulation for zero re-render lag) */}
      <div
        ref={dragOverlayRef}
        className="absolute pointer-events-none bg-blue-500/15 border border-blue-400/30 rounded-sm"
        style={{ display: 'none' }}
      />

      {/* Reset Zoom button */}
      {zoomLeft != null && (
        <button
          className="absolute top-2 right-2 z-10 px-2 py-1 text-[11px] bg-white border border-slate-300 rounded shadow-sm hover:bg-slate-50 text-slate-600 transition-colors"
          onClick={(e) => { e.stopPropagation(); setZoomLeft(null); setZoomRight(null); }}
        >
          Reset Zoom
        </button>
      )}

      {/* Context Menu */}
      {contextMenu && selectedPoint && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => { e.stopPropagation(); setContextMenu(null); setSelectedPoint(null); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu(null); setSelectedPoint(null); }}
          />
          <div
            className="fixed z-50 bg-white rounded-lg shadow-lg border border-slate-200 py-1 min-w-[120px]"
            style={{
              top: Math.min(contextMenu.y, window.innerHeight - 100),
              left: Math.min(contextMenu.x, window.innerWidth - 140),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-blue-50 hover:text-blue-700 transition-colors"
              onClick={() => {
                setEditValue(selectedPoint.value.toString());
                setEditModal(true);
                setContextMenu(null);
              }}
            >
              Edit
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
              onClick={() => {
                setDeleteModal(true);
                setContextMenu(null);
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}

      {/* Edit Modal */}
      {editModal && selectedPoint && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={(e) => { e.stopPropagation(); setEditModal(false); }}
        >
          <div className="bg-white rounded-lg shadow-xl p-4 w-64" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Date</span>
                <span className="text-xs text-slate-700">{new Date(selectedPoint.date).toLocaleDateString()}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-slate-500">{dataType.name}</span>
                <input
                  type="number"
                  step="any"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-32 border border-slate-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-transparent"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit();
                  }}
                />
              </div>
            </div>
            <div className="flex justify-end space-x-2 mt-3">
              <button
                className="px-3 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded transition-colors"
                onClick={() => setEditModal(false)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
                disabled={isNaN(parseFloat(editValue))}
                onClick={handleSaveEdit}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteModal && selectedPoint && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={(e) => { e.stopPropagation(); setDeleteModal(false); }}
        >
          <div className="bg-white rounded-lg shadow-xl p-4 w-64" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs text-slate-600 mb-3">
              Delete measurement on <span className="font-medium">{new Date(selectedPoint.date).toLocaleDateString()}</span>?
            </p>
            <div className="flex justify-end space-x-2">
              <button
                className="px-3 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded transition-colors"
                onClick={() => setDeleteModal(false)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
                onClick={handleConfirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TimeSeriesChart;
