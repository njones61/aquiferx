/**
 * Water Quality Portal (WQP) API integration.
 * Docs: https://www.waterqualitydata.us/webservices_documentation/
 *
 * WQP aggregates USGS NWIS, EPA STORET/WQX, USDA STEWARDS, and 400+
 * other agencies. No API key required, CORS enabled, no per-IP rate
 * limits published. Date format in queries is MM-DD-YYYY; CSV
 * responses use YYYY-MM-DD.
 *
 * Counts come back as response headers (`Total-Result-Count`,
 * `Total-Site-Count`, etc.) — we use HEAD requests to preview download
 * size without pulling the body.
 */

import { ParameterCatalog } from '../types';
import { parseCSV } from './importUtils';
import { fetchWithTimeout } from './http';

const WQP_ORIGIN = 'https://www.waterqualitydata.us/data';

/** All WQP requests go through the Vite-side proxy at /api/wqp-proxy.
 *  WQP doesn't send Access-Control-Expose-Headers, so the count
 *  headers (Total-Result-Count, Total-Site-Count) are hidden from
 *  browser JS when fetched directly. The proxy re-emits them with the
 *  correct expose header. */
function viaProxy(wqpUrl: string): string {
  return `/api/wqp-proxy?url=${encodeURIComponent(wqpUrl)}`;
}

// ============================================================================
// Types
// ============================================================================

export interface WqpQueryParams {
  /** [minLng, minLat, maxLng, maxLat] in WGS84. */
  bBox: [number, number, number, number];
  /** WQP `characteristicName` values. Each call should pass the
   *  full set of names the user picked; WQP joins them with `;`. */
  characteristicNames?: string[];
  /** Inclusive lower bound, ISO `YYYY-MM-DD`. */
  startDateLo?: string;
  /** Inclusive upper bound, ISO `YYYY-MM-DD`. */
  startDateHi?: string;
  /** `NWIS` for USGS-only, `STORET` for EPA-only, etc. Omit for all. */
  providers?: string;
  /** Defaults to `Well`. */
  siteType?: string;
}

export interface WqpStation {
  /** `MonitoringLocationIdentifier`, e.g. `USGS-06137570`. */
  siteId: string;
  /** `MonitoringLocationName`. */
  siteName: string;
  lat: number;
  lng: number;
  /** `MonitoringLocationTypeName`, e.g. `Well`. */
  siteType: string;
  /** `OrganizationFormalName`. */
  organization: string;
}

export interface WqpResult {
  /** `MonitoringLocationIdentifier`. */
  siteId: string;
  /** ISO `YYYY-MM-DD` from `ActivityStartDate`. */
  date: string;
  /** WQP `CharacteristicName` (e.g. `Nitrate`). Map to a catalog code
   *  via `buildCharacteristicMap`. */
  characteristicName: string;
  value: number;
  /** `ResultMeasure/MeasureUnitCode`, e.g. `mg/l`, `ug/l`. */
  unit: string;
  /** `ResultSampleFractionText`, e.g. `Filtered`, `Unfiltered`, or `''`. */
  sampleFraction: string;
  /** `OrganizationFormalName`. */
  organization: string;
}

export interface WqpCounts {
  resultCount: number;
  siteCount: number;
}

export interface WqpDataQualityReport {
  totalRaw: number;
  kept: number;
  droppedNonNumeric: number;
  droppedFractionMismatch: number;
  droppedDuplicates: number;
  details: string[];
}

/** Catalog → WQP mapping: characteristicName (lowercased) →
 *  `{ code, preferredFraction }`. Only includes catalog entries that
 *  actually carry a `wqp` block. */
export type CharacteristicMap = Map<string, { code: string; preferredFraction: string | null }>;

// ============================================================================
// URL building & HTTP
// ============================================================================

/** Convert ISO `YYYY-MM-DD` to WQP's required `MM-DD-YYYY`. */
function isoToWqpDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Invalid ISO date: ${iso}`);
  return `${m[2]}-${m[3]}-${m[1]}`;
}

function buildQueryString(params: WqpQueryParams, extra: Record<string, string>): string {
  const parts: string[] = [];
  parts.push(`bBox=${params.bBox.join(',')}`);
  parts.push(`siteType=${encodeURIComponent(params.siteType || 'Well')}`);
  if (params.characteristicNames && params.characteristicNames.length > 0) {
    parts.push(`characteristicName=${params.characteristicNames.map(encodeURIComponent).join(';')}`);
  }
  if (params.startDateLo) parts.push(`startDateLo=${isoToWqpDate(params.startDateLo)}`);
  if (params.startDateHi) parts.push(`startDateHi=${isoToWqpDate(params.startDateHi)}`);
  if (params.providers) parts.push(`providers=${encodeURIComponent(params.providers)}`);
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${encodeURIComponent(v)}`);
  return parts.join('&');
}

// Requests go through the Vite WQP proxy, which enforces its own upstream
// timeout — this browser-side timeout is a backstop so a stalled proxy
// response can never hang the import flow. Large CSV bodies can take a
// while, hence the generous limit.
const WQP_TIMEOUT_MS = 180000;

async function fetchWithRetry(url: string, init?: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetchWithTimeout(url, init ?? {}, WQP_TIMEOUT_MS);
    if (res.ok) return res;
    if (res.status >= 500 || res.status === 429) {
      const wait = Math.pow(2, attempt) * 1500 + Math.random() * 800;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  throw new Error('WQP request failed after retries — check your connection or narrow the query');
}

// ============================================================================
// Counts (HEAD requests, headers only)
// ============================================================================

/** Estimate download size before the user commits. WQP populates
 *  count headers (`Total-Result-Count`, `Total-Site-Count`) on every
 *  response — including the Result endpoint — so we issue GETs and
 *  abort the body stream as soon as headers arrive. HEAD would be
 *  cheaper but WQP returns 403 for HEAD when an Origin header is
 *  present (i.e. any browser request). */
async function getCountHeader(url: string, header: string): Promise<number> {
  // Append &headersOnly=1 so the proxy skips the body download.
  const u = `${url}${url.includes('?') ? '&' : '?'}headersOnly=1`;
  const res = await fetchWithRetry(u);
  return parseInt(res.headers.get(header) || '0', 10) || 0;
}

export async function fetchWqpCounts(params: WqpQueryParams): Promise<WqpCounts> {
  const qs = buildQueryString(params, { mimeType: 'csv', zip: 'no' });
  const [resultCount, siteCount] = await Promise.all([
    getCountHeader(viaProxy(`${WQP_ORIGIN}/Result/search?${qs}`), 'Total-Result-Count'),
    getCountHeader(viaProxy(`${WQP_ORIGIN}/Station/search?${qs}`), 'Total-Site-Count'),
  ]);
  return { resultCount, siteCount };
}

// ============================================================================
// Stations
// ============================================================================

export async function fetchWqpStations(params: WqpQueryParams): Promise<WqpStation[]> {
  const qs = buildQueryString(params, { mimeType: 'csv', zip: 'no' });
  const res = await fetchWithRetry(viaProxy(`${WQP_ORIGIN}/Station/search?${qs}`));
  const text = await res.text();
  if (!text.trim()) return [];

  const { headers, rows } = parseCSV(text);
  if (!headers.length) return [];

  // Cache header positions (CSV has 30+ columns; row-by-row indexOf is wasteful)
  const idx = (name: string) => headers.indexOf(name);
  const iSiteId = idx('MonitoringLocationIdentifier');
  const iName = idx('MonitoringLocationName');
  const iLat = idx('LatitudeMeasure');
  const iLng = idx('LongitudeMeasure');
  const iType = idx('MonitoringLocationTypeName');
  const iOrg = idx('OrganizationFormalName');

  const stations: WqpStation[] = [];
  for (const row of rows) {
    const siteId = iSiteId >= 0 ? row[headers[iSiteId]] : '';
    const lat = iLat >= 0 ? parseFloat(row[headers[iLat]]) : NaN;
    const lng = iLng >= 0 ? parseFloat(row[headers[iLng]]) : NaN;
    if (!siteId || isNaN(lat) || isNaN(lng)) continue;
    stations.push({
      siteId,
      siteName: iName >= 0 ? row[headers[iName]] || '' : '',
      lat,
      lng,
      siteType: iType >= 0 ? row[headers[iType]] || '' : '',
      organization: iOrg >= 0 ? row[headers[iOrg]] || '' : '',
    });
  }
  return stations;
}

// ============================================================================
// Results
// ============================================================================

export async function fetchWqpResults(params: WqpQueryParams): Promise<WqpResult[]> {
  const qs = buildQueryString(params, { mimeType: 'csv', zip: 'no' });
  const res = await fetchWithRetry(viaProxy(`${WQP_ORIGIN}/Result/search?${qs}`));
  const text = await res.text();
  if (!text.trim()) return [];

  const { headers, rows } = parseCSV(text);
  if (!headers.length) return [];

  const iSite = headers.indexOf('MonitoringLocationIdentifier');
  const iDate = headers.indexOf('ActivityStartDate');
  const iChar = headers.indexOf('CharacteristicName');
  const iValue = headers.indexOf('ResultMeasureValue');
  const iUnit = headers.indexOf('ResultMeasure/MeasureUnitCode');
  const iFrac = headers.indexOf('ResultSampleFractionText');
  const iOrg = headers.indexOf('OrganizationFormalName');

  const results: WqpResult[] = [];
  for (const row of rows) {
    const siteId = iSite >= 0 ? row[headers[iSite]] : '';
    const date = iDate >= 0 ? row[headers[iDate]] : '';
    const charName = iChar >= 0 ? row[headers[iChar]] : '';
    const rawVal = iValue >= 0 ? row[headers[iValue]] : '';
    if (!siteId || !date || !charName || rawVal === undefined || rawVal === '') continue;
    const value = parseFloat(rawVal);
    if (isNaN(value)) continue; // censored / non-numeric values like "<0.05" — drop
    results.push({
      siteId,
      date,
      characteristicName: charName,
      value,
      unit: iUnit >= 0 ? row[headers[iUnit]] || '' : '',
      sampleFraction: iFrac >= 0 ? row[headers[iFrac]] || '' : '',
      organization: iOrg >= 0 ? row[headers[iOrg]] || '' : '',
    });
  }
  return results;
}

// ============================================================================
// Catalog mapping & dedup
// ============================================================================

/** Build a lookup from `CharacteristicName` (case-insensitive) to the
 *  catalog code + preferred sample fraction. Catalog entries without a
 *  `wqp` block are skipped. */
export function buildCharacteristicMap(catalog: ParameterCatalog): CharacteristicMap {
  const map: CharacteristicMap = new Map();
  for (const [code, param] of Object.entries(catalog.parameters)) {
    const cn = param.wqp?.characteristicName;
    if (!cn) continue;
    map.set(cn.toLowerCase(), { code, preferredFraction: param.wqp.sampleFraction });
  }
  return map;
}

/** Convenience: list every catalog code that's downloadable from WQP
 *  (i.e. has a `wqp.characteristicName`). Used by the parameter picker
 *  in 4b to know which catalog rows to expose. */
export function listWqpDownloadableCodes(catalog: ParameterCatalog): string[] {
  return Object.entries(catalog.parameters)
    .filter(([, p]) => !!p.wqp?.characteristicName)
    .map(([code]) => code);
}

/** Per-WQP-row deduplication. A single sampling event can produce
 *  multiple rows for the same site+date+characteristic (different labs,
 *  filtered vs. unfiltered, lab vs. field). Strategy:
 *    1. Filter by the catalog's `wqp.sampleFraction` when set
 *       (e.g. Nitrate prefers `Filtered`). If a row's fraction doesn't
 *       match, drop it. Catalog entries with `sampleFraction: null`
 *       (pH, temperature) accept any row.
 *    2. Of what remains, take the first row per (siteId, date,
 *       characteristic) — deterministic, no ordering assumption beyond
 *       what WQP returned. */
export function dedupWqpResults(
  results: WqpResult[],
  charMap: CharacteristicMap
): { kept: WqpResult[]; report: WqpDataQualityReport } {
  const report: WqpDataQualityReport = {
    totalRaw: results.length,
    kept: 0,
    droppedNonNumeric: 0,
    droppedFractionMismatch: 0,
    droppedDuplicates: 0,
    details: [],
  };

  const kept: WqpResult[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    const entry = charMap.get(r.characteristicName.toLowerCase());
    // No catalog entry → caller shouldn't have queried for this; drop it
    // and report so the user can see the mismatch.
    if (!entry) {
      report.droppedFractionMismatch++;
      addDetail(report.details, `No catalog entry for "${r.characteristicName}"`);
      continue;
    }

    // Step 1: fraction filter (only when catalog specifies a preference)
    if (entry.preferredFraction) {
      const want = entry.preferredFraction.toLowerCase();
      const got = (r.sampleFraction || '').toLowerCase();
      if (got !== want) {
        report.droppedFractionMismatch++;
        continue;
      }
    }

    // Step 2: take-first dedup
    const key = `${r.siteId}|${r.date}|${entry.code}`;
    if (seen.has(key)) {
      report.droppedDuplicates++;
      continue;
    }
    seen.add(key);
    kept.push(r);
  }

  report.kept = kept.length;
  return { kept, report };
}

function addDetail(list: string[], detail: string) {
  if (list.length < 20) list.push(detail);
  else if (list.length === 20) list.push('... and more (truncated)');
}
