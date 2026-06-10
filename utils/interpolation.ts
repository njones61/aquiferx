/**
 * Piecewise linear interpolation. Clamps to boundary values outside the data range.
 */
export function interpolateLinear(x: number[], y: number[], targetX: number[]): number[] {
  const n = x.length;
  if (n < 2) return targetX.map(() => (n === 1 ? y[0] : NaN)); // empty input has no value to extend — NaN, not a fabricated 0

  return targetX.map(tx => {
    if (tx <= x[0]) return y[0];
    if (tx >= x[n - 1]) return y[n - 1];

    // Binary search for interval
    let lo = 0;
    let hi = n - 1;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (x[mid] <= tx) lo = mid;
      else hi = mid;
    }

    const dx = x[hi] - x[lo];
    if (dx === 0) return y[lo];
    const t = (tx - x[lo]) / dx;
    return y[lo] + t * (y[hi] - y[lo]);
  });
}

/**
 * PCHIP (Piecewise Cubic Hermite Interpolating Polynomial) interpolation.
 * Matches the scipy.interpolate.PchipInterpolator algorithm used by PANDAS.
 *
 * Key properties:
 * - Shape-preserving: won't overshoot monotonic data
 * - Monotonicity-preserving: maintains monotonicity in each interval
 * - Uses Fritsch-Carlson method for derivative estimation
 */
export function interpolatePCHIP(x: number[], y: number[], targetX: number[]): number[] {
  const n = x.length;
  if (n < 2) return targetX.map(() => (n === 1 ? y[0] : NaN)); // empty input has no value to extend — NaN, not a fabricated 0

  // For 2 points, just do linear
  if (n === 2) {
    const slope = (y[1] - y[0]) / (x[1] - x[0]);
    return targetX.map(tx => {
      if (tx <= x[0]) return y[0];
      if (tx >= x[1]) return y[1];
      return y[0] + slope * (tx - x[0]);
    });
  }

  // 1. Calculate intervals (h) and secant slopes (delta)
  const h = new Array(n - 1);
  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i];
    if (h[i] === 0) {
      delta[i] = 0;
    } else {
      delta[i] = (y[i + 1] - y[i]) / h[i];
    }
  }

  // 2. Compute derivatives at each point using PCHIP method (Fritsch-Carlson)
  const d = new Array(n).fill(0);

  // Interior points: use weighted harmonic mean of adjacent slopes
  for (let i = 1; i < n - 1; i++) {
    const d0 = delta[i - 1];
    const d1 = delta[i];

    // If slopes have different signs or either is zero, derivative is zero
    if (d0 * d1 <= 0) {
      d[i] = 0;
    } else {
      // Weighted harmonic mean (PCHIP formula from scipy)
      const h0 = h[i - 1];
      const h1 = h[i];
      const w1 = 2 * h1 + h0;
      const w2 = h1 + 2 * h0;
      d[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
    }
  }

  // Endpoints: use one-sided three-point difference formula
  // Left endpoint
  d[0] = pchipEndSlope(h[0], h[1], delta[0], delta[1]);
  // Right endpoint
  d[n - 1] = pchipEndSlope(h[n - 2], h[n - 3], delta[n - 2], delta[n - 3]);

  // 3. Interpolate using Hermite cubic polynomials
  return targetX.map(tx => {
    // Clamp to range
    if (tx <= x[0]) return y[0];
    if (tx >= x[n - 1]) return y[n - 1];

    // Find interval using binary search for efficiency
    let lo = 0;
    let hi = n - 1;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (x[mid] <= tx) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const i = lo;

    // Guard against zero interval
    if (h[i] === 0) return y[i];

    // Hermite basis functions
    const t = (tx - x[i]) / h[i];  // Normalized parameter [0, 1]
    const t2 = t * t;
    const t3 = t2 * t;

    // Hermite basis polynomials
    const h00 = 2 * t3 - 3 * t2 + 1;      // value at start
    const h10 = t3 - 2 * t2 + t;           // derivative at start
    const h01 = -2 * t3 + 3 * t2;          // value at end
    const h11 = t3 - t2;                   // derivative at end

    // Interpolated value using Hermite formula
    const result = h00 * y[i] + h10 * h[i] * d[i] + h01 * y[i + 1] + h11 * h[i] * d[i + 1];

    return isFinite(result) ? result : y[i];
  });
}

/**
 * Nadaraya-Watson kernel smoothing with PCHIP interpolation for output.
 * Step 1: Gaussian kernel regression at each raw data point (statistically meaningful).
 * Step 2: PCHIP interpolation of the smoothed anchors onto the output timestamps.
 *
 * @param xValues - sorted timestamps of raw measurements
 * @param yValues - values at each measurement timestamp
 * @param outputTs - timestamps at which to produce smoothed output
 * @param smoothMonths - bandwidth in months (~95% of Gaussian weight falls within this window)
 */
export function kernelSmooth(
  xValues: number[],
  yValues: number[],
  outputTs: number[],
  smoothMonths: number
): number[] {
  const MS_PER_MONTH = 30.4375 * 24 * 60 * 60 * 1000;
  const sigma = (smoothMonths * MS_PER_MONTH) / 4;

  if (xValues.length < 2) {
    return outputTs.map(() => (xValues.length === 1 ? yValues[0] : 0));
  }

  // Step 1: Nadaraya-Watson kernel regression at each raw measurement timestamp
  // Use sliding window: beyond 4σ the Gaussian weight is < 0.0003, so skip those points.
  const cutoff = 4 * sigma;
  const smoothedAtData: number[] = new Array(xValues.length);
  for (let j = 0; j < xValues.length; j++) {
    const t = xValues[j];
    let sumW = 0, sumWY = 0;
    // Scan left from j
    for (let i = j; i >= 0; i--) {
      const dt = t - xValues[i];
      if (dt > cutoff) break;
      const d = dt / sigma;
      const w = Math.exp(-0.5 * d * d);
      sumW += w;
      sumWY += w * yValues[i];
    }
    // Scan right from j+1
    for (let i = j + 1; i < xValues.length; i++) {
      const dt = xValues[i] - t;
      if (dt > cutoff) break;
      const d = dt / sigma;
      const w = Math.exp(-0.5 * d * d);
      sumW += w;
      sumWY += w * yValues[i];
    }
    smoothedAtData[j] = sumWY / sumW;
  }

  // Step 2: PCHIP interpolation of smoothed anchor values onto output grid
  return interpolatePCHIP(xValues, smoothedAtData, outputTs);
}

/**
 * Smooth the combined (PCHIP + model) series from ModelTimeSeries rows.
 * Reusable for spatial analysis integration.
 *
 * @param rows - pre-sorted rows with date (ISO string) and combined value
 * @param smoothMonths - bandwidth in months for kernelSmooth
 * @returns parallel arrays of timestamps and smoothed values
 */
export function smoothModelCombined(
  rows: { date: string; combined: number }[],
  smoothMonths: number
): { dates: number[]; values: number[] } {
  if (rows.length < 2) {
    const dates = rows.map(r => new Date(r.date).getTime());
    const values = rows.map(r => r.combined);
    return { dates, values };
  }
  const dates = rows.map(r => new Date(r.date).getTime());
  const values = rows.map(r => r.combined);
  const smoothed = kernelSmooth(dates, values, dates, smoothMonths);
  return { dates, values: smoothed };
}

/**
 * Compute the one-sided derivative at an endpoint for PCHIP.
 * Uses the "not-a-knot" style endpoint condition from scipy.
 */
function pchipEndSlope(h0: number, h1: number, d0: number, d1: number): number {
  // Handle edge cases
  if (h0 === 0) return d1;
  if (h1 === 0) return d0;

  // Three-point difference formula
  const slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);

  // Ensure monotonicity preservation
  if (Math.sign(slope) !== Math.sign(d0)) {
    return 0;
  }
  if (Math.sign(d0) !== Math.sign(d1) && Math.abs(slope) > 3 * Math.abs(d0)) {
    return 3 * d0;
  }

  return slope;
}
