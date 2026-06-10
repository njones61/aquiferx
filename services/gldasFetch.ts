import { interpolatePCHIP } from '../utils/interpolation';

const GLDAS_WMS_URL = 'https://apps.geoglows.org/thredds/wms/geoglows_data/soilw.mon.mean.v2.nc';

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

/**
 * Fetch GLDAS date range via GetCapabilities XML.
 * The time dimension is a mix of comma-separated dates and start/end/period ranges.
 * Matches notebook's get_time_bounds: split by comma, take first and last entries,
 * then split the last entry by "/" to get the actual end date.
 */
export async function fetchGldasDateRange(): Promise<{ min: string; max: string }> {
  const capUrl = `${GLDAS_WMS_URL}?service=WMS&version=1.3.0&request=GetCapabilities`;
  const proxyUrl = `/api/gldas-proxy?url=${encodeURIComponent(capUrl)}`;

  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GLDAS GetCapabilities failed: ${res.status}`);

  const xml = await res.text();

  // Parse time dimension from XML
  const timeMatch = xml.match(/<Dimension[^>]*name="time"[^>]*>([\s\S]*?)<\/Dimension>/i)
    || xml.match(/<Extent[^>]*name="time"[^>]*>([\s\S]*?)<\/Extent>/i);
  if (!timeMatch) throw new Error('Could not parse GLDAS time dimension from GetCapabilities');

  const content = timeMatch[1].trim();
  // Split by comma first (entries are either individual dates or start/end/period ranges)
  const entries = content.split(',').map(s => s.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('Empty GLDAS time dimension');

  // First entry: may be a date or a range — take the first date part
  const minStr = entries[0].split('/')[0].trim().slice(0, 10);

  // Last entry: may be a "start/end/period" range — take the end (index 1) if available
  const lastParts = entries[entries.length - 1].split('/');
  const maxStr = (lastParts.length >= 2 ? lastParts[1] : lastParts[0]).trim().slice(0, 10);

  return { min: minStr, max: maxStr };
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

  // Build WMS GetTimeseries request — match notebook's get_thredds_value format
  const delta = 0.125; // half of GLDAS 0.25° grid cell
  const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;

  const timeseriesUrl = `${GLDAS_WMS_URL}?service=WMS&version=1.3.0&request=GetTimeseries` +
    `&CRS=CRS:84&QUERY_LAYERS=soilw` +
    `&X=0&Y=0&I=0&J=0` +
    `&BBOX=${bbox}` +
    `&LAYER=soilw` +
    `&WIDTH=1&HEIGHT=1` +
    `&INFO_FORMAT=text/csv` +
    `&STYLES=raster/default` +
    `&TIME=${startDate}T00:00:00.000Z/${endDate}T00:00:00.000Z`;

  const proxyUrl = `/api/gldas-proxy?url=${encodeURIComponent(timeseriesUrl)}`;
  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GLDAS GetTimeseries failed: ${res.status}`);

  const csvText = await res.text();
  if (!csvText.trim()) throw new Error('GLDAS returned empty response');

  // Parse CSV — notebook skips first 2 lines (comment lines starting with #),
  // then header: "Time (UTC),Model-Calculated Monthly Mean Soil Moisture (mm)"
  // then data: "1974-01-01T00:00:00.000Z,567.956"
  const lines = csvText.trim().split('\n');
  const rawDates: string[] = [];
  const rawValues: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip comment lines (# ...) and header lines
    if (!line || line.startsWith('#') || line.startsWith('Time')) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const dateStr = parts[0].trim().slice(0, 10);
    const valStr = parts[parts.length - 1].trim();
    // Handle "none" values like the notebook does
    if (valStr === 'none' || valStr === '') continue;
    const value = parseFloat(valStr);
    if (dateStr && !isNaN(new Date(dateStr).getTime()) && !isNaN(value)) {
      rawDates.push(dateStr);
      rawValues.push(value);
    }
  }

  if (rawDates.length === 0) throw new Error('No valid GLDAS data parsed from response');

  // Sort by date
  const indices = rawDates.map((_, i) => i).sort((a, b) => rawDates[a].localeCompare(rawDates[b]));
  const sortedDates = indices.map(i => rawDates[i]);
  const sortedValues = indices.map(i => rawValues[i]);

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
