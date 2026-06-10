import { kdTree } from 'kd-tree-javascript';
import { haversineDistance } from '../utils/geo';
import type { IdwNodalFunction, IdwNeighborMode } from '../types';

interface ProjectedPoint {
  x: number; // meters east of centroid
  y: number; // meters north of centroid
  idx: number;
}

// Convert lat/lng to approximate meters relative to centroid (equirectangular projection)
function projectPoints(
  lats: number[], lngs: number[]
): { xs: number[]; ys: number[]; centLat: number; centLng: number } {
  const n = lats.length;
  let centLat = 0, centLng = 0;
  for (let i = 0; i < n; i++) { centLat += lats[i]; centLng += lngs[i]; }
  centLat /= n; centLng /= n;

  const R = 6371000;
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(centLat * toRad);

  const xs = new Array<number>(n);
  const ys = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (lngs[i] - centLng) * toRad * R * cosLat;
    ys[i] = (lats[i] - centLat) * toRad * R;
  }
  return { xs, ys, centLat, centLng };
}

function projectSingle(
  lat: number, lng: number, centLat: number, centLng: number
): { x: number; y: number } {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(centLat * toRad);
  return {
    x: (lng - centLng) * toRad * R * cosLat,
    y: (lat - centLat) * toRad * R,
  };
}

// Solve small linear system via Gaussian elimination (for nodal function fitting)
function solveSmall(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return null; // singular
    if (maxRow !== col) [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / pivot;
      for (let j = col; j <= n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i][n];
    for (let j = i + 1; j < n; j++) sum -= aug[i][j] * x[j];
    x[i] = sum / aug[i][i];
  }
  return x;
}

// Fit gradient plane: Q_i(x,y) = f_i + fx*(x-xi) + fy*(y-yi)
// Returns [fx, fy] or null if singular
function fitGradientPlane(
  cx: number, cy: number, cv: number,
  nx: number[], ny: number[], nv: number[], nw: number[]
): [number, number] | null {
  let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
  for (let j = 0; j < nx.length; j++) {
    const dx = nx[j] - cx;
    const dy = ny[j] - cy;
    const df = nv[j] - cv;
    const w = nw[j];
    a00 += w * dx * dx;
    a01 += w * dx * dy;
    a11 += w * dy * dy;
    b0 += w * dx * df;
    b1 += w * dy * df;
  }

  const result = solveSmall([[a00, a01], [a01, a11]], [b0, b1]);
  return result ? [result[0], result[1]] : null;
}

// Fit quadratic: Q_k(x,y) = f_k + a2*dx + a3*dy + a4*dx^2 + a5*dx*dy + a6*dy^2
// Returns [a2, a3, a4, a5, a6] or null if singular
function fitQuadratic(
  cx: number, cy: number, cv: number,
  nx: number[], ny: number[], nv: number[], nw: number[]
): [number, number, number, number, number] | null {
  if (nx.length < 5) return null;

  const m = 5;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);

  for (let j = 0; j < nx.length; j++) {
    const dx = nx[j] - cx;
    const dy = ny[j] - cy;
    const df = nv[j] - cv;
    const w = nw[j];
    const phi = [dx, dy, dx * dx, dx * dy, dy * dy];

    for (let p = 0; p < m; p++) {
      for (let q = 0; q < m; q++) {
        A[p][q] += w * phi[p] * phi[q];
      }
      b[p] += w * phi[p] * df;
    }
  }

  const result = solveSmall(A, b);
  return result ? [result[0], result[1], result[2], result[3], result[4]] : null;
}

// Async: the cell loop periodically awaits onChunk (UI repaint +
// cancellation check) when provided, since large grids would otherwise
// block the main thread for seconds.
export async function idwGrid(
  wellLats: number[], wellLngs: number[], wellValues: number[],
  gridLats: number[], gridLngs: number[], mask: (0 | 1)[],
  options: {
    exponent?: number;
    nodalFunction?: IdwNodalFunction;
    neighborMode?: IdwNeighborMode;
    neighborCount?: number;
  } = {},
  onChunk?: () => Promise<void>
): Promise<(number | null)[]> {
  const nWells = wellLats.length;
  if (nWells === 0) return gridLats.map(() => null);
  if (nWells === 1) return mask.map(m => m === 1 ? wellValues[0] : null);

  const exponent = options.exponent ?? 2;
  const nodalFn = options.nodalFunction ?? 'classic';
  const neighborMode = options.neighborMode ?? 'all';
  const neighborCount = options.neighborCount ?? 24;

  // Project all scatter points (wells) to meters
  const { xs: wellXs, ys: wellYs, centLat, centLng } = projectPoints(wellLats, wellLngs);

  // Build kd-tree from scatter points
  const treePoints: ProjectedPoint[] = wellXs.map((x, i) => ({ x, y: wellYs[i], idx: i }));
  const distFn = (a: ProjectedPoint, b: ProjectedPoint) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const tree = new kdTree<ProjectedPoint>(treePoints, distFn, ['x', 'y']);

  // Pre-compute nodal function coefficients at each scatter point.
  // Fitted using the scatter point's nearest neighbors with modified Shepard weights.
  const nodalCoeffs: (number[] | null)[] = new Array(nWells).fill(null);

  if (nodalFn !== 'classic') {
    const fitK = Math.min(nWells - 1, Math.max(nodalFn === 'quadratic' ? 8 : 5, neighborCount));
    for (let i = 0; i < nWells; i++) {
      const query = { x: wellXs[i], y: wellYs[i], idx: i };
      const nearest = tree.nearest(query, fitK + 1); // includes self

      // Collect neighbors (excluding self) and track max distance (Rw)
      const neighX: number[] = [], neighY: number[] = [], neighV: number[] = [];
      const neighDist: number[] = [];
      let Rw = 0;
      for (const [pt, dist] of nearest) {
        if (pt.idx === i) continue;
        neighX.push(wellXs[pt.idx]);
        neighY.push(wellYs[pt.idx]);
        neighV.push(wellValues[pt.idx]);
        neighDist.push(dist);
        if (dist > Rw) Rw = dist;
      }

      // Fitting weights: ((Rw - d) / (Rw * d))^p, normalized to sum to 1
      const neighW: number[] = neighDist.map(d => {
        if (d < 1e-10) return 1e10;
        if (d >= Rw) return 0;
        return Math.pow((Rw - d) / (Rw * d), exponent);
      });
      let sumFitW = 0;
      for (const w of neighW) sumFitW += w;
      if (sumFitW > 0) for (let j = 0; j < neighW.length; j++) neighW[j] /= sumFitW;

      if (nodalFn === 'quadratic') {
        const qCoeffs = fitQuadratic(wellXs[i], wellYs[i], wellValues[i], neighX, neighY, neighV, neighW);
        if (qCoeffs) {
          nodalCoeffs[i] = qCoeffs;
        } else {
          // Fall back to gradient if quadratic is singular
          const gCoeffs = fitGradientPlane(wellXs[i], wellYs[i], wellValues[i], neighX, neighY, neighV, neighW);
          nodalCoeffs[i] = gCoeffs ? [...gCoeffs, 0, 0, 0] : null;
        }
      } else {
        const gCoeffs = fitGradientPlane(wellXs[i], wellYs[i], wellValues[i], neighX, neighY, neighV, neighW);
        nodalCoeffs[i] = gCoeffs;
      }
    }
  }

  // Evaluate nodal function Q_i at an interpolation point (px, py)
  function evalNodal(i: number, px: number, py: number): number {
    const fi = wellValues[i];
    const coeffs = nodalCoeffs[i];
    if (!coeffs) return fi; // classic fallback

    const dx = px - wellXs[i];
    const dy = py - wellYs[i];

    if (coeffs.length === 2) {
      return fi + coeffs[0] * dx + coeffs[1] * dy;
    }
    return fi + coeffs[0] * dx + coeffs[1] * dy
      + coeffs[2] * dx * dx + coeffs[3] * dx * dy + coeffs[4] * dy * dy;
  }

  // Interpolate each grid cell (interpolation point)
  const result: (number | null)[] = new Array(gridLats.length);
  let gridMin = Infinity, gridMax = -Infinity;

  let processed = 0;
  for (let g = 0; g < gridLats.length; g++) {
    if (mask[g] === 0) {
      result[g] = null;
      continue;
    }
    if (onChunk && ++processed % 5000 === 0) await onChunk();

    const { x: gx, y: gy } = projectSingle(gridLats[g], gridLngs[g], centLat, centLng);

    // Find active scatter points for this interpolation point
    let activeIndices: number[];
    let activeDists: number[];

    if (neighborMode === 'nearest') {
      const k = Math.min(nWells, neighborCount);
      const nearest = tree.nearest({ x: gx, y: gy, idx: -1 }, k);
      activeIndices = nearest.map(([pt]) => pt.idx);
      activeDists = nearest.map(([, d]) => d);
    } else {
      activeIndices = [];
      activeDists = [];
      for (let i = 0; i < nWells; i++) {
        const dx = gx - wellXs[i];
        const dy = gy - wellYs[i];
        activeIndices.push(i);
        activeDists.push(Math.sqrt(dx * dx + dy * dy));
      }
    }

    // Coincident point: if interpolation point is at a scatter point, use f_i directly
    let coincident = -1;
    for (let k = 0; k < activeDists.length; k++) {
      if (activeDists[k] < 1e-10) { coincident = activeIndices[k]; break; }
    }
    if (coincident >= 0) {
      result[g] = wellValues[coincident];
      if (wellValues[coincident] < gridMin) gridMin = wellValues[coincident];
      if (wellValues[coincident] > gridMax) gridMax = wellValues[coincident];
      continue;
    }

    // R = distance from this interpolation point to the most distant scatter point
    // in the active set. Recalculated for every interpolation point.
    let R = 0;
    for (const d of activeDists) if (d > R) R = d;
    if (R < 1e-10) R = 1;

    // Weights: ((R - h_i) / (R * h_i))^p, normalized to sum to 1.
    // Same formula for all nodal function modes.
    // Scatter points at h_i >= R get zero weight.
    let sumW = 0;
    let sumWQ = 0;
    for (let k = 0; k < activeIndices.length; k++) {
      const h = activeDists[k];
      if (h >= R) continue;
      const w = Math.pow((R - h) / (R * h), exponent);
      const q = evalNodal(activeIndices[k], gx, gy);
      sumW += w;
      sumWQ += w * q;
    }

    const val = sumW > 0 ? sumWQ / sumW : null;
    if (val !== null && isFinite(val)) {
      result[g] = val;
      if (val < gridMin) gridMin = val;
      if (val > gridMax) gridMax = val;
    } else {
      result[g] = null;
    }
  }

  const minVal = Math.min(...wellValues);
  const maxVal = Math.max(...wellValues);
  console.log(`[IDW] Output range: [${gridMin.toFixed(1)}, ${gridMax.toFixed(1)}], well range: [${minVal.toFixed(1)}, ${maxVal.toFixed(1)}]`);

  return result;
}
