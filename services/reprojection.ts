import proj4 from 'proj4';
import { fetchWithTimeout } from './http';

// Common EPSG definitions
const KNOWN_CRS: Record<string, string> = {
  'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  'EPSG:32601': '+proj=utm +zone=1 +datum=WGS84 +units=m +no_defs',
  // JAD2001 / Jamaica Metric Grid — LCC 1SP form from epsg.io
  'EPSG:3448': '+proj=lcc +lat_1=18 +lat_0=18 +lon_0=-77 +k_0=1 +x_0=750000 +y_0=650000 +ellps=WGS84 +units=m +no_defs',
};

// Dropdown options for the importer's CRS picker. Keep this short — common
// cases only, with a Custom proj4-string option for advanced users.
export interface CrsOption {
  code: string;        // identifier or "custom"
  label: string;
  proj4?: string;      // optional override proj4 string for custom entries
}

export const COMMON_CRS_OPTIONS: CrsOption[] = [
  { code: 'EPSG:4326', label: 'WGS84 — latitude / longitude (default)' },
  { code: 'EPSG:3857', label: 'EPSG:3857 — Web Mercator' },
  { code: 'EPSG:3448', label: 'EPSG:3448 — JAD2001 / Jamaica Metric Grid' },
];

/**
 * Reproject a single (x, y) point from the given CRS to WGS84 (lng, lat).
 * Accepts an EPSG code from KNOWN_CRS or a raw proj4 string.
 * Returns null if the input can't be parsed or the CRS is unknown.
 */
export function reprojectPoint(x: number, y: number, fromCrs: string): [number, number] | null {
  if (!fromCrs || isWGS84(fromCrs)) {
    return [x, y];
  }
  const projection = getProjection(fromCrs);
  if (!projection) return null;
  try {
    const [lng, lat] = proj4(projection, KNOWN_CRS['EPSG:4326'], [x, y]);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return [lng, lat];
  } catch {
    return null;
  }
}

// ===========================================================================
// EPSG registry: dynamic lookup via epsg.io + localStorage cache
// ===========================================================================

const EPSG_CACHE_PREFIX = 'epsg:def:';

interface EpsgDefinition {
  code: string;       // e.g. "EPSG:3448"
  name: string;       // e.g. "JAD2001 / Jamaica Metric Grid"
  proj4: string;      // proj4 string
}

/**
 * Normalize an EPSG code input to the canonical "EPSG:NNNN" format.
 * Accepts "3448", "epsg:3448", "EPSG:3448", with or without whitespace.
 */
export function normalizeEpsgCode(input: string): string | null {
  const m = input.trim().match(/^(?:epsg:?)?\s*(\d{2,6})$/i);
  if (!m) return null;
  return `EPSG:${m[1]}`;
}

function readEpsgCache(code: string): EpsgDefinition | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(EPSG_CACHE_PREFIX + code) : null;
    if (!raw) return null;
    return JSON.parse(raw) as EpsgDefinition;
  } catch {
    return null;
  }
}

function writeEpsgCache(def: EpsgDefinition): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(EPSG_CACHE_PREFIX + def.code, JSON.stringify(def));
    }
  } catch {
    // ignore storage errors (quota, private mode)
  }
}

/**
 * Fetch an EPSG definition from epsg.io (or cache). Registers the result
 * with proj4 so reprojectPoint() can use the code afterwards. Returns null
 * if the code can't be resolved (offline, unknown code, etc).
 */
export async function fetchEpsgDefinition(rawCode: string): Promise<EpsgDefinition | null> {
  const code = normalizeEpsgCode(rawCode);
  if (!code) return null;

  // In-memory shortcut: if proj4 already knows this code we can short-circuit
  if (KNOWN_CRS[code]) {
    return { code, name: code, proj4: KNOWN_CRS[code] };
  }

  const cached = readEpsgCache(code);
  if (cached) {
    KNOWN_CRS[code] = cached.proj4;
    try { proj4.defs(code, cached.proj4); } catch {}
    return cached;
  }

  const numeric = code.replace(/^EPSG:/, '');
  try {
    const [proj4Res, jsonRes] = await Promise.all([
      fetchWithTimeout(`https://epsg.io/${numeric}.proj4`, {}, 10000),
      fetchWithTimeout(`https://epsg.io/?format=json&q=${numeric}`, {}, 10000),
    ]);
    if (!proj4Res.ok) return null;
    const proj4Str = (await proj4Res.text()).trim();
    if (!proj4Str || !proj4Str.startsWith('+proj')) return null;
    let name = code;
    try {
      if (jsonRes.ok) {
        const json = await jsonRes.json();
        const first = Array.isArray(json?.results) && json.results[0];
        if (first?.name) name = first.name;
      }
    } catch {}
    const def: EpsgDefinition = { code, name, proj4: proj4Str };
    KNOWN_CRS[code] = proj4Str;
    try { proj4.defs(code, proj4Str); } catch {}
    writeEpsgCache(def);
    return def;
  } catch {
    return null;
  }
}

/**
 * Fetch a list of EPSG codes valid at the given WGS84 point, using epsg.io's
 * crs-lookup. Used by auto-detect to narrow the candidate list based on the
 * region's centroid.
 */
async function lookupEpsgCandidatesNear(lat: number, lng: number): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(`https://epsg.io/?format=json&q=${lat},${lng}`, {}, 10000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json?.results)) return [];
    return json.results
      .map((r: any) => r?.code ? `EPSG:${r.code}` : null)
      .filter((c: string | null): c is string => !!c)
      .slice(0, 8);
  } catch {
    return [];
  }
}

// ===========================================================================
// UTM helpers
// ===========================================================================

/**
 * Compute the EPSG code for the UTM zone that covers a given WGS84 point.
 * Returns an EPSG identifier like "EPSG:32617" (zone 17 N) or "EPSG:32717"
 * (zone 17 S). UTM defs are not pre-registered; the caller should use
 * fetchEpsgDefinition to resolve.
 */
export function computeUtmEpsg(lng: number, lat: number): string {
  const zone = Math.floor((lng + 180) / 6) + 1;
  const northern = lat >= 0;
  const base = northern ? 32600 : 32700;
  return `EPSG:${base + zone}`;
}

// ===========================================================================
// Auto-detect: pick a CRS by trying candidates against sample rows + region
// ===========================================================================

export interface SampleCoord { x: number; y: number; }
export interface RegionBox { minLat: number; minLng: number; maxLat: number; maxLng: number; }

export interface AutoDetectResult {
  crs: string;
  name: string;
  reprojectedSample: [number, number]; // [lng, lat] of the first sample after reprojection
  insideRegion: boolean;
  candidatesTried: string[];
}

function pointInsideBuffered(lng: number, lat: number, box: RegionBox, bufferFactor: number): boolean {
  const dLat = Math.max(0.1, (box.maxLat - box.minLat) * bufferFactor);
  const dLng = Math.max(0.1, (box.maxLng - box.minLng) * bufferFactor);
  return (
    lat >= box.minLat - dLat &&
    lat <= box.maxLat + dLat &&
    lng >= box.minLng - dLng &&
    lng <= box.maxLng + dLng
  );
}

/**
 * Try a series of CRS candidates against sample coordinates and pick the
 * first one whose reprojected output lands inside (a buffered) region box.
 *
 * Candidate order:
 *   1. WGS84 — trust the raw values if they're already in [-90,90]/[-180,180]
 *   2. UTM zone computed from the region centroid
 *   3. EPSG candidates returned by epsg.io for the region centroid (country
 *      grids, state plane, etc.)
 */
export async function autoDetectCrs(
  samples: SampleCoord[],
  region: RegionBox
): Promise<AutoDetectResult | null> {
  if (samples.length === 0) return null;
  const bufferFactor = 2; // generous buffer so near-border points still match
  const centerLat = (region.minLat + region.maxLat) / 2;
  const centerLng = (region.minLng + region.maxLng) / 2;
  const candidatesTried: string[] = [];

  const tryCandidate = async (crs: string, name: string): Promise<AutoDetectResult | null> => {
    candidatesTried.push(crs);
    // Ensure proj4 knows about this code (may fetch from epsg.io)
    if (crs !== 'EPSG:4326' && !KNOWN_CRS[crs]) {
      const def = await fetchEpsgDefinition(crs);
      if (!def) return null;
    }
    // Reproject every sample; accept if the majority land inside the region
    let insideCount = 0;
    let firstResult: [number, number] | null = null;
    for (const s of samples) {
      const out = reprojectPoint(s.x, s.y, crs);
      if (!out) continue;
      const [lng, lat] = out;
      if (!firstResult) firstResult = [lng, lat];
      if (pointInsideBuffered(lng, lat, region, bufferFactor)) insideCount++;
    }
    if (firstResult && insideCount >= Math.ceil(samples.length / 2)) {
      return { crs, name, reprojectedSample: firstResult, insideRegion: true, candidatesTried: [...candidatesTried] };
    }
    return null;
  };

  // 1. WGS84 — direct pass-through
  const wgsResult = await tryCandidate('EPSG:4326', 'WGS84 — latitude / longitude');
  if (wgsResult) return wgsResult;

  // 2. Curated list of common projected CRSes (JAD2001, Web Mercator, etc.)
  for (const opt of COMMON_CRS_OPTIONS) {
    if (candidatesTried.includes(opt.code)) continue;
    const result = await tryCandidate(opt.code, opt.label);
    if (result) return result;
  }

  // 3. UTM zone from region centroid
  const utm = computeUtmEpsg(centerLng, centerLat);
  if (!candidatesTried.includes(utm)) {
    const utmResult = await tryCandidate(utm, `${utm} — UTM zone (computed from region centroid)`);
    if (utmResult) return utmResult;
  }

  // 4. EPSG candidates valid at the region centroid (via epsg.io)
  const localCandidates = await lookupEpsgCandidatesNear(centerLat, centerLng);
  for (const code of localCandidates) {
    if (candidatesTried.includes(code)) continue;
    const def = await fetchEpsgDefinition(code);
    if (!def) continue;
    const result = await tryCandidate(code, def.name);
    if (result) return result;
  }

  return null;
}

const WGS84 = 'EPSG:4326';

function isWGS84(crsString: string): boolean {
  if (!crsString) return true;
  const lower = crsString.toLowerCase();
  return lower.includes('4326') || lower.includes('wgs84') || lower.includes('wgs 84');
}

function getProjection(crsIdentifier: string): string | null {
  if (KNOWN_CRS[crsIdentifier]) return KNOWN_CRS[crsIdentifier];
  // If it looks like a proj4 string, use it directly
  if (crsIdentifier.startsWith('+proj=')) return crsIdentifier;
  return null;
}

type Proj4Converter = proj4.Converter;

function transformCoords(coords: any, conv: Proj4Converter): any {
  if (!Array.isArray(coords)) return coords;
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const [x, y] = conv.forward([coords[0], coords[1]]);
    return coords.length > 2 ? [x, y, ...coords.slice(2)] : [x, y];
  }
  return coords.map((c: any) => transformCoords(c, conv));
}

function transformGeometry(geometry: any, conv: Proj4Converter): any {
  if (!geometry) return geometry;
  return {
    ...geometry,
    coordinates: transformCoords(geometry.coordinates, conv)
  };
}

/**
 * Detect CRS from GeoJSON `crs` property and reproject to WGS84 if needed.
 * Returns { geojson, reprojected, fromCrs }.
 */
export function reprojectGeoJSON(geojson: any): { geojson: any; reprojected: boolean; fromCrs: string } {
  const crsProperty = geojson.crs;
  let fromCrs = '';

  if (crsProperty) {
    if (crsProperty.type === 'name' && crsProperty.properties?.name) {
      fromCrs = crsProperty.properties.name;
    } else if (crsProperty.type === 'EPSG' && crsProperty.properties?.code) {
      fromCrs = `EPSG:${crsProperty.properties.code}`;
    }
  }

  if (!fromCrs || isWGS84(fromCrs)) {
    return { geojson, reprojected: false, fromCrs: fromCrs || 'WGS84' };
  }

  const projection = getProjection(fromCrs);
  if (!projection) {
    console.warn(`Unknown CRS: ${fromCrs}, assuming WGS84`);
    return { geojson, reprojected: false, fromCrs };
  }

  return reprojectWithProj(geojson, projection, fromCrs);
}

/**
 * Reproject GeoJSON using a WKT string (from .prj file).
 */
export function reprojectFromWKT(geojson: any, wkt: string): { geojson: any; reprojected: boolean; fromCrs: string } {
  if (!wkt || isWGS84(wkt)) {
    return { geojson, reprojected: false, fromCrs: 'WGS84' };
  }

  try {
    proj4.Proj(wkt); // validates the WKT — throws on parse failure
    return reprojectWithProj(geojson, wkt, 'Custom CRS');
  } catch (err) {
    console.warn('Failed to parse WKT, assuming WGS84:', err);
    return { geojson, reprojected: false, fromCrs: 'Unknown' };
  }
}

function reprojectWithProj(geojson: any, fromProj: string, fromCrs: string): { geojson: any; reprojected: boolean; fromCrs: string } {
  const result = { ...geojson };

  // Remove CRS property (WGS84 is assumed)
  delete result.crs;

  // Build the converter once — proj4(from, to, point) re-parses the CRS
  // definition on every call, which froze the tab for seconds on
  // detailed shapefiles (100k+ vertices)
  const conv = proj4(fromProj, KNOWN_CRS[WGS84]);

  if (result.type === 'FeatureCollection') {
    result.features = result.features.map((f: any) => ({
      ...f,
      geometry: transformGeometry(f.geometry, conv)
    }));
  } else if (result.type === 'Feature') {
    result.geometry = transformGeometry(result.geometry, conv);
  } else if (result.coordinates) {
    result.coordinates = transformCoords(result.coordinates, conv);
  }

  return { geojson: result, reprojected: true, fromCrs };
}
