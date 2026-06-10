import { Measurement } from '../types';

// Linear-regression trend classification shared by the map legends and
// the Analyze Trends feature.

export const TREND_THRESHOLDS_FT = { extreme: 2.0, moderate: 0.5 };
export const TREND_THRESHOLDS_M = { extreme: 0.6, moderate: 0.15 };
export const AQUIFER_TREND_THRESHOLDS_FT = { extreme: 1.0, moderate: 0.25 };
export const AQUIFER_TREND_THRESHOLDS_M = { extreme: 0.3, moderate: 0.075 };

export type TrendThresholds = { extreme: number; moderate: number };

export const TREND_CATEGORIES: { label: string; color: string; test: (s: number, t: TrendThresholds) => boolean }[] = [
  { label: 'Extreme Decline', color: '#DC2626', test: (s, t) => s < -t.extreme },
  { label: 'Decline', color: '#FB923C', test: (s, t) => s < -t.moderate },
  { label: 'Static', color: '#FACC15', test: (s, t) => s <= t.moderate },
  { label: 'Increase', color: '#38BDF8', test: (s, t) => s <= t.extreme },
  { label: 'Extreme Increase', color: '#2563EB', test: () => true },
];

export const INSUFFICIENT_COLOR = '#1E293B';
export const MS_PER_YEAR = 365.25 * 86400000;

export function computeSlope(meas: Measurement[]): number | null {
  if (meas.length < 2) return null;
  let n = 0, sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const m of meas) {
    const x = new Date(m.date).getTime() / MS_PER_YEAR;
    const y = m.value;
    n++; sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

export function classifySlope(slope: number | null, thresholds: TrendThresholds): string {
  if (slope === null) return INSUFFICIENT_COLOR;
  for (const cat of TREND_CATEGORIES) {
    if (cat.test(slope, thresholds)) return cat.color;
  }
  return INSUFFICIENT_COLOR;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
