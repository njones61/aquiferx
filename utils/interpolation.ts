
/**
 * Simple Monotonic Cubic Spline (PCHIP-like) for time-series.
 * Given points (x, y), it calculates interpolated values.
 */
export function interpolatePCHIP(x: number[], y: number[], targetX: number[]): number[] {
  const n = x.length;
  if (n < 2) return targetX.map(() => (n === 1 ? y[0] : 0));

  // 1. Calculate intervals
  const h = new Array(n - 1);
  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i];
    // Guard against division by zero (duplicate x values)
    if (h[i] === 0) {
      delta[i] = 0;
    } else {
      delta[i] = (y[i + 1] - y[i]) / h[i];
    }
  }

  // 2. Calculate slopes (m)
  const m = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      const denom = w1 / delta[i - 1] + w2 / delta[i];
      // Guard against division issues
      if (!isFinite(denom) || denom === 0) {
        m[i] = 0;
      } else {
        m[i] = (w1 + w2) / denom;
      }
    }
  }
  // Boundary conditions (one-sided)
  m[0] = isFinite(delta[0]) ? delta[0] : 0;
  m[n - 1] = isFinite(delta[n - 2]) ? delta[n - 2] : 0;

  // 3. Interpolate
  return targetX.map(tx => {
    if (tx <= x[0]) return y[0];
    if (tx >= x[n - 1]) return y[n - 1];

    // Find interval
    let i = 0;
    while (i < n - 2 && x[i + 1] < tx) i++;

    // Guard against zero interval
    if (h[i] === 0) return y[i];

    const t = (tx - x[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;

    // Hermite basis functions
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    const result = h00 * y[i] + h10 * h[i] * m[i] + h01 * y[i + 1] + h11 * h[i] * m[i + 1];

    // Return original y value if interpolation failed
    return isFinite(result) ? result : y[i];
  });
}
