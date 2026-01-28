
/**
 * Attempt cubic spline interpolation for smoother curves.
 * Falls back gracefully for edge cases.
 */
export function interpolatePCHIP(x: number[], y: number[], targetX: number[]): number[] {
  const n = x.length;
  if (n < 2) return targetX.map(() => (n === 1 ? y[0] : 0));

  // For 2 points, just do linear
  if (n === 2) {
    const slope = (y[1] - y[0]) / (x[1] - x[0]);
    return targetX.map(tx => {
      if (tx <= x[0]) return y[0];
      if (tx >= x[1]) return y[1];
      return y[0] + slope * (tx - x[0]);
    });
  }

  // Use natural cubic spline for 3+ points (smoother than PCHIP)
  // This allows overshooting but produces nicer curves

  // 1. Calculate intervals and slopes
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

  // 2. Build tridiagonal system for natural cubic spline
  // Second derivatives at each point
  const a = new Array(n).fill(0);
  const b = new Array(n).fill(0);
  const c = new Array(n).fill(0);
  const d = new Array(n).fill(0);

  // Natural spline: second derivative = 0 at endpoints
  b[0] = 1;
  b[n - 1] = 1;

  for (let i = 1; i < n - 1; i++) {
    a[i] = h[i - 1];
    b[i] = 2 * (h[i - 1] + h[i]);
    c[i] = h[i];
    d[i] = 6 * (delta[i] - delta[i - 1]);
  }

  // Solve tridiagonal system using Thomas algorithm
  const m = new Array(n).fill(0); // second derivatives

  // Forward elimination
  for (let i = 1; i < n; i++) {
    if (b[i - 1] === 0) continue;
    const w = a[i] / b[i - 1];
    b[i] -= w * c[i - 1];
    d[i] -= w * d[i - 1];
  }

  // Back substitution
  if (b[n - 1] !== 0) {
    m[n - 1] = d[n - 1] / b[n - 1];
  }
  for (let i = n - 2; i >= 0; i--) {
    if (b[i] !== 0) {
      m[i] = (d[i] - c[i] * m[i + 1]) / b[i];
    }
  }

  // 3. Interpolate using cubic spline formula
  return targetX.map(tx => {
    // Clamp to range
    if (tx <= x[0]) return y[0];
    if (tx >= x[n - 1]) return y[n - 1];

    // Find interval
    let i = 0;
    while (i < n - 2 && x[i + 1] < tx) i++;

    // Guard against zero interval
    if (h[i] === 0) return y[i];

    // Cubic spline interpolation formula
    const t = tx - x[i];
    const hi = h[i];

    const a_coef = (m[i + 1] - m[i]) / (6 * hi);
    const b_coef = m[i] / 2;
    const c_coef = delta[i] - hi * (2 * m[i] + m[i + 1]) / 6;
    const d_coef = y[i];

    const result = a_coef * t * t * t + b_coef * t * t + c_coef * t + d_coef;

    return isFinite(result) ? result : y[i];
  });
}
