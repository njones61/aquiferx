import { haversineDistance } from '../utils/geo';
import type { VariogramModel, KrigingRangeMode } from '../types';

// Spatial covariance function — supports multiple variogram models
// C(h) at h=0+: sill - nugget (off-diagonal); diagonal set separately to sill
function covarianceFunction(
  dist: number, sill: number, range: number, nugget: number,
  model: VariogramModel = 'gaussian'
): number {
  const spatialVar = sill - nugget;
  if (dist <= 0) return spatialVar;
  const ratio = dist / range;

  switch (model) {
    case 'exponential':
      return spatialVar * Math.exp(-ratio);
    case 'spherical':
      if (dist >= range) return 0;
      return spatialVar * (1 - 1.5 * ratio + 0.5 * ratio * ratio * ratio);
    case 'gaussian':
    default:
      return spatialVar * Math.exp(-(ratio * ratio));
  }
}

// Build distance matrix between points using Haversine (returns meters)
function buildDistanceMatrix(lats: number[], lngs: number[]): number[][] {
  const n = lats.length;
  const dists: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineDistance(lats[i], lngs[i], lats[j], lngs[j]);
      dists[i][j] = d;
      dists[j][i] = d;
    }
  }
  return dists;
}

// Build (N+1)x(N+1) ordinary kriging matrix using covariance formulation
function buildKrigingMatrix(
  dists: number[][], sill: number, range: number, nugget: number,
  model: VariogramModel = 'gaussian'
): number[][] {
  const n = dists.length;
  const size = n + 1;
  const K: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));

  for (let i = 0; i < n; i++) {
    K[i][i] = sill; // diagonal: total variance (spatial + nugget)
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        K[i][j] = covarianceFunction(dists[i][j], sill, range, nugget, model);
      }
    }
    K[i][n] = 1;
    K[n][i] = 1;
  }
  K[n][n] = 0;

  return K;
}

// LU decomposition with partial pivoting — O(n³) done once
// Returns { LU, perm } where LU stores L (below diagonal) and U (on/above diagonal)
function luDecompose(A: number[][]): { LU: Float64Array[]; perm: Int32Array } {
  const n = A.length;
  const LU: Float64Array[] = Array.from({ length: n }, (_, i) => Float64Array.from(A[i]));
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    let maxVal = Math.abs(LU[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(LU[row][col]);
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }
    if (maxRow !== col) {
      const tmp = LU[col]; LU[col] = LU[maxRow]; LU[maxRow] = tmp;
      const tp = perm[col]; perm[col] = perm[maxRow]; perm[maxRow] = tp;
    }

    const pivot = LU[col][col];
    if (Math.abs(pivot) < 1e-12) continue;

    for (let row = col + 1; row < n; row++) {
      const factor = LU[row][col] / pivot;
      LU[row][col] = factor; // store L multiplier in-place
      for (let j = col + 1; j < n; j++) {
        LU[row][j] -= factor * LU[col][j];
      }
    }
  }

  return { LU, perm };
}

// Solve using pre-computed LU factorization — O(n²) per right-hand side
function luSolve(LU: Float64Array[], perm: Int32Array, b: number[]): number[] {
  const n = LU.length;

  // Apply permutation: y = P * b
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = b[perm[i]];

  // Forward substitution: L * z = y
  for (let i = 1; i < n; i++) {
    let sum = y[i];
    const row = LU[i];
    for (let j = 0; j < i; j++) sum -= row[j] * y[j];
    y[i] = sum;
  }

  // Back substitution: U * x = z
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    const row = LU[i];
    for (let j = i + 1; j < n; j++) sum -= row[j] * x[j];
    const diag = row[i];
    x[i] = Math.abs(diag) < 1e-12 ? 0 : sum / diag;
  }

  return x;
}

// Deduplicate wells within a minimum distance (meters), averaging co-located values
function deduplicateWells(
  lats: number[], lngs: number[], values: number[], minDist: number
): { lats: number[]; lngs: number[]; values: number[] } {
  const n = lats.length;
  const used = new Array(n).fill(false);
  const outLats: number[] = [];
  const outLngs: number[] = [];
  const outValues: number[] = [];

  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    // Find all wells within minDist of well i
    let sumLat = lats[i], sumLng = lngs[i], sumVal = values[i], count = 1;
    used[i] = true;
    for (let j = i + 1; j < n; j++) {
      if (used[j]) continue;
      const d = haversineDistance(lats[i], lngs[i], lats[j], lngs[j]);
      if (d < minDist) {
        sumLat += lats[j];
        sumLng += lngs[j];
        sumVal += values[j];
        count++;
        used[j] = true;
      }
    }
    outLats.push(sumLat / count);
    outLngs.push(sumLng / count);
    outValues.push(sumVal / count);
  }

  if (outLats.length < n) {
    console.log(`[Kriging] Deduplicated ${n} wells → ${outLats.length} (merged co-located within ${minDist}m)`);
  }

  return { lats: outLats, lngs: outLngs, values: outValues };
}

// Estimate variogram parameters heuristically from well data
export function estimateVariogramParams(
  wellLats: number[], wellLngs: number[], wellValues: number[],
  options?: {
    nuggetEnabled?: boolean;
    rangeMode?: KrigingRangeMode;
    rangeValue?: number | null;
  }
): { sill: number; range: number; nugget: number } {
  const n = wellValues.length;

  // Variance (sill)
  let mean = 0;
  for (const v of wellValues) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of wellValues) variance += (v - mean) ** 2;
  variance /= n;

  // Range: 1/3 of the spatial diagonal (in meters)
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (let i = 0; i < n; i++) {
    if (wellLats[i] < minLat) minLat = wellLats[i];
    if (wellLats[i] > maxLat) maxLat = wellLats[i];
    if (wellLngs[i] < minLng) minLng = wellLngs[i];
    if (wellLngs[i] > maxLng) maxLng = wellLngs[i];
  }
  const diagonal = haversineDistance(minLat, minLng, maxLat, maxLng);

  // Determine range based on mode
  let range: number;
  const rangeMode = options?.rangeMode ?? 'auto';
  const rangeValue = options?.rangeValue;
  if (rangeMode === 'custom' && rangeValue != null && rangeValue > 0) {
    range = rangeValue;
  } else if (rangeMode === 'percentage' && rangeValue != null && rangeValue > 0) {
    range = (rangeValue / 100) * diagonal;
  } else {
    range = diagonal / 3;
  }

  // Nugget
  const nuggetEnabled = options?.nuggetEnabled ?? true;
  const nugget = nuggetEnabled ? variance * 0.05 : 0.001;

  console.log(`[Kriging] Variogram: sill=${variance.toFixed(2)}, range=${range.toFixed(0)}m, nugget=${nugget.toFixed(4)}, mean=${mean.toFixed(2)}, n=${n}`);

  // Math.max(NaN, x) is NaN — a single bad value would silently turn the
  // entire raster into nulls, so fail loudly instead
  if (!Number.isFinite(variance) || !Number.isFinite(range)) {
    throw new Error('Variogram estimation produced non-finite parameters — check well values for NaN/Infinity');
  }

  return {
    sill: Math.max(variance, 0.01),
    range: Math.max(range, 100),
    nugget: Math.max(nugget, 0.001),
  };
}

// Main export: interpolate well values to a grid using ordinary kriging (covariance formulation)
export function krigGrid(
  wellLats: number[], wellLngs: number[], wellValues: number[],
  gridLats: number[], gridLngs: number[], mask: (0 | 1)[],
  variogramParams?: { sill: number; range: number; nugget: number },
  model: VariogramModel = 'gaussian'
): (number | null)[] {
  if (wellLats.length === 0) return gridLats.map(() => null);

  // Single well: return constant value for all cells
  if (wellLats.length === 1) {
    return mask.map(m => m === 1 ? wellValues[0] : null);
  }

  // Deduplicate co-located wells (within 10m) to prevent singular matrix
  const deduped = deduplicateWells(wellLats, wellLngs, wellValues, 10);
  const wLats = deduped.lats;
  const wLngs = deduped.lngs;
  const wValues = deduped.values;
  const n = wLats.length;

  if (n === 1) {
    return mask.map(m => m === 1 ? wValues[0] : null);
  }

  // Use provided variogram params or estimate from current data
  const { sill, range, nugget } = variogramParams || estimateVariogramParams(wLats, wLngs, wValues);

  // Build distance matrix between wells
  const wellDists = buildDistanceMatrix(wLats, wLngs);

  // Build the kriging matrix and LU-decompose once (O(n³))
  const K = buildKrigingMatrix(wellDists, sill, range, nugget, model);
  const { LU, perm } = luDecompose(K);

  // For each grid cell, solve for weights via O(n²) LU back-substitution
  const result: (number | null)[] = new Array(gridLats.length);
  const minVal = Math.min(...wValues);
  const maxVal = Math.max(...wValues);
  let gridMin = Infinity, gridMax = -Infinity;
  let outOfRangeCount = 0;
  let nanCount = 0;

  for (let g = 0; g < gridLats.length; g++) {
    if (mask[g] === 0) {
      result[g] = null;
      continue;
    }

    // Build right-hand side: spatial covariance from grid cell to each well + Lagrange
    const rhs = new Array(n + 1);
    for (let i = 0; i < n; i++) {
      const d = haversineDistance(gridLats[g], gridLngs[g], wLats[i], wLngs[i]);
      rhs[i] = covarianceFunction(d, sill, range, nugget, model);
    }
    rhs[n] = 1;

    // Solve using pre-computed LU factorization
    const weights = luSolve(LU, perm, rhs);

    // Interpolated value = weighted sum of well values
    let val = 0;
    for (let i = 0; i < n; i++) {
      val += weights[i] * wValues[i];
    }

    if (!isFinite(val)) {
      result[g] = null;
      nanCount++;
    } else {
      if (val < minVal || val > maxVal) outOfRangeCount++;
      if (val < gridMin) gridMin = val;
      if (val > gridMax) gridMax = val;
      result[g] = val;
    }
  }

  if (nanCount > 0) {
    console.warn(`[Kriging] ${nanCount} grid cells produced NaN/Infinity — check variogram parameters or data`);
  }

  console.log(`[Kriging] Output range: [${gridMin.toFixed(1)}, ${gridMax.toFixed(1)}], well range: [${minVal.toFixed(1)}, ${maxVal.toFixed(1)}], outside: ${outOfRangeCount}`);

  return result;
}
