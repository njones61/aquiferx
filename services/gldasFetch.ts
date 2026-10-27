import * as zarr from 'zarrita';
import { interpolatePCHIP } from '../utils/interpolation';

// Monthly soil moisture from NOAA CPC v2 (0.5 degree, 1948 on), published as a
// zarr store by scripts/soil_moisture_store.py. The names below still say GLDAS
// because the imputation pipeline and its saved models do; the record itself
// is CPC's, as it was when this read a THREDDS server.
//
// A /local-zarr/ URL only exists on the dev server, so a production build that
// still carries one would fail every read; fall back to the published store.
const PUBLISHED_URL = 'https://cdn.apps.geoglows.org/aqx/cpc-soil-moisture-0.5-v1.zarr';
const configuredUrl = (import.meta.env.VITE_SOIL_MOISTURE_URL || '').trim();
const SOIL_MOISTURE_URL = (
  !configuredUrl || (import.meta.env.PROD && configuredUrl.startsWith('/local-zarr/'))
    ? PUBLISHED_URL
    : configuredUrl
).replace(/\/+$/, '');

// The time coordinate counts days from this date (see the script's attributes)
const TIME_EPOCH_MS = Date.UTC(1948, 0, 1);
const DAY_MS = 86400000;

export interface GldasFeatures {
  dates: string[];    // ISO date strings, monthly
  soilw: number[];
  soilw_yr01: number[];
  soilw_yr03: number[];
  soilw_yr05: number[];
  soilw_yr10: number[];
}

// In-memory cache: all wells in same aquifer share the same GLDAS data.
// Keyed by "{regionId}:{aquiferId}" — aquifer ids alone collide across
// regions (single-unit regions all use aquifer_id=0).
const gldasCache = new Map<string, { features: GldasFeatures; range: { min: string; max: string } }>();

// Chunks that are entirely ocean were never written. The CDN answers those
// with 403 rather than 404, so both read as "missing", which zarrita fills
// with NaN.
const storeGet = async (key: string): Promise<Uint8Array | undefined> => {
  const res = await fetch(`${SOIL_MOISTURE_URL}${key}`, { signal: AbortSignal.timeout(30000) });
  if (res.status === 404 || res.status === 403) return undefined;
  if (!res.ok) throw new Error(`Soil moisture store returned ${res.status} for ${key}`);
  return new Uint8Array(await res.arrayBuffer());
};

interface SoilMoistureGrid {
  soilw: zarr.Array<'float32', any>;
  dates: string[];
  lats: Float32Array;
  lons: Float32Array;
}

let gridPromise: Promise<SoilMoistureGrid> | null = null;

/** Open the store once per session; a failed open is retried on the next call. */
function openGrid(): Promise<SoilMoistureGrid> {
  if (!gridPromise) {
    gridPromise = (async () => {
      const root = zarr.root({ get: storeGet });
      const [soilw, time, lat, lon] = await Promise.all([
        zarr.open.v3(root.resolve('soilw'), { kind: 'array' }),
        zarr.open.v3(root.resolve('time'), { kind: 'array' }),
        zarr.open.v3(root.resolve('lat'), { kind: 'array' }),
        zarr.open.v3(root.resolve('lon'), { kind: 'array' }),
      ]).catch(err => {
        // zarrita reports a store it cannot find as "Node not found"
        throw new Error(`Soil moisture store unavailable at ${SOIL_MOISTURE_URL} (${err.message})`);
      });
      const [t, la, lo] = await Promise.all([zarr.get(time), zarr.get(lat), zarr.get(lon)]);
      const dates = Array.from(t.data as Int32Array, days =>
        new Date(TIME_EPOCH_MS + days * DAY_MS).toISOString().slice(0, 10));
      return {
        soilw: soilw as zarr.Array<'float32', any>,
        dates,
        lats: la.data as Float32Array,
        lons: lo.data as Float32Array,
      };
    })();
    gridPromise.catch(() => { gridPromise = null; });
  }
  return gridPromise;
}

/** First and last month in the soil moisture record. */
export async function fetchGldasDateRange(): Promise<{ min: string; max: string }> {
  const { dates } = await openGrid();
  return { min: dates[0], max: dates[dates.length - 1] };
}

const nearestIndex = (coords: Float32Array, value: number): number => {
  const step = coords[1] - coords[0];
  return Math.min(coords.length - 1, Math.max(0, Math.round((value - coords[0]) / step)));
};

/**
 * The whole record at the cell nearest (lat, lng). A centroid on a coast or a
 * small island can land on a cell CPC leaves empty as ocean, so the search
 * widens one ring at a time, up to three cells (about 150 km), and takes the
 * closest cell that has data.
 */
async function readCellSeries(lat: number, lng: number): Promise<{ values: Float32Array; lat: number; lng: number }> {
  const { soilw, lats, lons } = await openGrid();
  const i0 = nearestIndex(lats, lat);
  const j0 = nearestIndex(lons, lng);
  for (let ring = 0; ring <= 3; ring++) {
    const candidates: [number, number][] = [];
    for (let di = -ring; di <= ring; di++) {
      for (let dj = -ring; dj <= ring; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
        const i = i0 + di;
        const j = (j0 + dj + lons.length) % lons.length;
        if (i >= 0 && i < lats.length) candidates.push([i, j]);
      }
    }
    candidates.sort(([ia, ja], [ib, jb]) =>
      Math.hypot(lats[ia] - lat, lons[ja] - lng) - Math.hypot(lats[ib] - lat, lons[jb] - lng));
    for (const [i, j] of candidates) {
      const cell = await zarr.get(soilw, [null, i, j]);
      const values = cell.data as Float32Array;
      if (values.some(v => !isNaN(v))) return { values, lat: lats[i], lng: lons[j] };
    }
  }
  throw new Error(`No soil moisture data within 150 km of the aquifer center (${lat.toFixed(3)}, ${lng.toFixed(3)})`);
}

/**
 * Compute centroid of aquifer polygon(s) by averaging all vertices
 */
export function computeAquiferCentroid(geojson: any): [number, number] {
  let sumLat = 0, sumLng = 0, count = 0;

  const geometries: any[] = [];
  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features) {
      if (f.geometry) geometries.push(f.geometry);
    }
  } else if (geojson.type === 'Feature') {
    if (geojson.geometry) geometries.push(geojson.geometry);
  } else if (geojson.coordinates) {
    geometries.push(geojson);
  }

  for (const geom of geometries) {
    if (!geom.coordinates) continue;
    const stack: any[] = [geom.coordinates];
    while (stack.length > 0) {
      const coords = stack.pop();
      if (!Array.isArray(coords)) continue;
      if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
        sumLng += coords[0];
        sumLat += coords[1];
        count++;
      } else {
        for (const child of coords) stack.push(child);
      }
    }
  }

  if (count === 0) return [0, 0];
  return [sumLat / count, sumLng / count];
}

/**
 * Generate monthly date strings from start to end (inclusive)
 */
function generateMonthlyDates(startDate: string, endDate: string): string[] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  // An Invalid Date makes `d > end` always false — without this guard the
  // loop below would never terminate
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error(`Invalid date range: "${startDate}" – "${endDate}"`);
  }
  const dates: string[] = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  const MAX_MONTHS = 10000; // backstop: ~833 years
  for (let i = 0; i < MAX_MONTHS; i++) {
    const d = new Date(Date.UTC(year, month, 1));
    if (d > end) break;
    dates.push(d.toISOString().slice(0, 10));
    month++;
    if (month > 11) { month = 0; year++; }
  }
  return dates;
}

/**
 * Compute rolling mean of array with given window size.
 * Returns NaN for positions with insufficient data.
 */
function rollingMean(values: number[], window: number): number[] {
  const result: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (i < window - 1) {
      result[i] = NaN;
    } else {
      let sum = 0;
      for (let j = i - window + 1; j <= i; j++) {
        sum += values[j];
      }
      result[i] = sum / window;
    }
  }
  return result;
}

/**
 * Fetch GLDAS soil moisture features for an aquifer
 */
export async function fetchGldasFeatures(
  cacheKey: string,
  aquiferGeojson: any,
  startDate: string,
  endDate: string,
): Promise<GldasFeatures> {
  // Check cache — only use if it covers the requested date range
  const cached = gldasCache.get(cacheKey);
  if (cached && cached.range.min <= startDate && cached.range.max >= endDate) {
    return cached.features;
  }

  const [lat, lng] = computeAquiferCentroid(aquiferGeojson);
  const { dates } = await openGrid();
  const cell = await readCellSeries(lat, lng);

  // Months CPC has no value for are skipped here and filled by PCHIP below,
  // as the "none" rows of the THREDDS CSV were
  const sortedDates: string[] = [];
  const sortedValues: number[] = [];
  for (let k = 0; k < dates.length; k++) {
    if (dates[k] < startDate || dates[k] > endDate) continue;
    const v = cell.values[k];
    if (isNaN(v)) continue;
    sortedDates.push(dates[k]);
    sortedValues.push(v);
  }
  if (sortedDates.length === 0) throw new Error(`No soil moisture data between ${startDate} and ${endDate}`);

  // PCHIP interpolate any internal gaps, then resample to monthly
  const monthlyDates = generateMonthlyDates(sortedDates[0], sortedDates[sortedDates.length - 1]);
  const sortedTimestamps = sortedDates.map(d => new Date(d).getTime());
  const monthlyTimestamps = monthlyDates.map(d => new Date(d).getTime());
  const monthlySoilw = interpolatePCHIP(sortedTimestamps, sortedValues, monthlyTimestamps);

  // Compute rolling means
  const yr01 = rollingMean(monthlySoilw, 12);
  const yr03 = rollingMean(monthlySoilw, 36);
  const yr05 = rollingMean(monthlySoilw, 60);
  const yr10 = rollingMean(monthlySoilw, 120);

  // Trim leading rows where 10-year rolling mean is NaN (~1948-1957)
  let trimStart = 0;
  for (let i = 0; i < yr10.length; i++) {
    if (!isNaN(yr10[i])) {
      trimStart = i;
      break;
    }
  }

  const features: GldasFeatures = {
    dates: monthlyDates.slice(trimStart),
    soilw: monthlySoilw.slice(trimStart),
    soilw_yr01: yr01.slice(trimStart),
    soilw_yr03: yr03.slice(trimStart),
    soilw_yr05: yr05.slice(trimStart),
    soilw_yr10: yr10.slice(trimStart),
  };

  gldasCache.set(cacheKey, {
    features,
    range: { min: features.dates[0], max: features.dates[features.dates.length - 1] },
  });

  return features;
}

export function clearGldasCache() {
  gldasCache.clear();
}
