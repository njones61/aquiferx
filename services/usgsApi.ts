/**
 * USGS Water Data API integration for wells and measurements.
 * Docs: https://api.waterdata.usgs.gov/ogcapi/v0/
 *
 * Rate limits (via api.data.gov):
 *   Without API key: 30 requests/hour, 50/day
 *   With API key:    1,000 requests/hour
 * Get a free key at: https://api.waterdata.usgs.gov/signup/
 */

import { fetchWithTimeout, isAbortError } from './http';

export interface USGSWell {
  siteId: string;
  siteName: string;
  lat: number;
  lng: number;
  gse: number;
}

export interface USGSMeasurement {
  siteId: string;
  date: string;
  value: number;
}

export interface USGSDataQualityReport {
  totalRaw: number;
  kept: number;
  fixed: { count: number; details: string[] };
  dropped: { count: number; details: string[] };
}

const BASE_URL = 'https://api.waterdata.usgs.gov/ogcapi/v0';
const LOCALSTORAGE_KEY = 'usgs_api_key';

/** Get stored USGS API key from localStorage */
export function getUSGSApiKey(): string {
  try { return localStorage.getItem(LOCALSTORAGE_KEY) || ''; } catch { return ''; }
}

/** Save USGS API key to localStorage */
export function setUSGSApiKey(key: string): void {
  try {
    if (key.trim()) {
      localStorage.setItem(LOCALSTORAGE_KEY, key.trim());
    } else {
      localStorage.removeItem(LOCALSTORAGE_KEY);
    }
  } catch {}
}

/** Append API key to URL if available */
function withApiKey(url: string): string {
  const key = getUSGSApiKey();
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(key)}`;
}

const REQUEST_TIMEOUT_MS = 30000;

async function fetchRetrying(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  const fullUrl = withApiKey(url);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(fullUrl, init, REQUEST_TIMEOUT_MS);
    } catch (err) {
      // Timeout or transient network failure — retry like a 5xx
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      if (isAbortError(err)) {
        throw new Error(`USGS request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${maxRetries} attempts)`);
      }
      throw err;
    }
    if (res.ok) return res;
    if (res.status === 429) {
      const wait = Math.pow(2, attempt) * 2000 + Math.random() * 1000;
      console.warn(`429 rate limited (attempt ${attempt + 1}/${maxRetries}), waiting ${Math.round(wait / 1000)}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (res.status >= 500) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  throw new Error('Max retries exceeded — you may be rate-limited. Get a free API key at https://api.waterdata.usgs.gov/signup/');
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<Response> {
  return fetchRetrying(url, {}, maxRetries);
}

/** POST with CQL2 JSON body + retry logic */
async function postCQL2WithRetry(url: string, body: object, maxRetries = 3): Promise<Response> {
  return fetchRetrying(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/query-cql-json' },
    body: JSON.stringify(body),
  }, maxRetries);
}

/**
 * Fetch groundwater monitoring wells within a bounding box.
 */
export async function fetchUSGSWells(
  bbox: [number, number, number, number], // [minLng, minLat, maxLng, maxLat]
  onProgress?: (count: number) => void
): Promise<USGSWell[]> {
  const wells: USGSWell[] = [];
  const bboxStr = bbox.join(',');
  let offset = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const url = `${BASE_URL}/collections/monitoring-locations/items?bbox=${bboxStr}&site_type_code=GW&limit=${limit}&offset=${offset}&f=json`;
    const res = await fetchWithRetry(url);
    const data = await res.json();

    const features = data.features || [];
    for (const f of features) {
      const props = f.properties || {};
      const coords = f.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;

      // USGS OGC API property names (with fallbacks for older schemas)
      const altFt = parseFloat(String(props.altitude ?? props.altitude_of_gage_or_measuring_point ?? 0)) || 0;
      wells.push({
        siteId: props.id || props.monitoring_location_identifier || '',
        siteName: props.monitoring_location_name || '',
        lat: coords[1],
        lng: coords[0],
        gse: altFt ? altFt * 0.3048 : 0, // USGS altitude is in feet; convert to meters
      });
    }

    onProgress?.(wells.length);

    if (features.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
      // Termination guard: if the server ever ignores/caps `offset` and keeps
      // returning full pages, this loop would spin forever
      if (offset > 1_000_000) {
        throw new Error(`USGS well pagination exceeded ${offset} records — aborting (server may be ignoring offset)`);
      }
    }
  }

  return wells;
}

/**
 * Validate and clean USGS measurement data.
 * Fixes obvious date issues, drops unfixable records, and reports what happened.
 */
export function validateUSGSMeasurements(
  raw: USGSMeasurement[]
): { measurements: USGSMeasurement[]; report: USGSDataQualityReport } {
  const report: USGSDataQualityReport = {
    totalRaw: raw.length,
    kept: 0,
    fixed: { count: 0, details: [] },
    dropped: { count: 0, details: [] },
  };

  const seen = new Set<string>();
  const kept: USGSMeasurement[] = [];

  for (const m of raw) {
    const { date, fixDetail, dropReason } = validateDate(m.date, m.siteId);

    if (dropReason) {
      report.dropped.count++;
      addDetail(report.dropped.details, dropReason);
      continue;
    }

    // Validate value — drop clearly nonsensical values
    if (m.value < -10000 || m.value > 100000) {
      report.dropped.count++;
      addDetail(report.dropped.details, `Extreme value (${m.value}) for ${m.siteId} on ${date}`);
      continue;
    }

    // Deduplicate: same site + date → keep first
    const key = `${m.siteId}|${date}`;
    if (seen.has(key)) {
      report.dropped.count++;
      addDetail(report.dropped.details, `Duplicate entry for ${m.siteId} on ${date}`);
      continue;
    }
    seen.add(key);

    if (fixDetail) {
      report.fixed.count++;
      addDetail(report.fixed.details, fixDetail);
    }

    kept.push({ ...m, date });
  }

  report.kept = kept.length;

  // Summarize duplicate detail if many
  const dupCount = report.dropped.details.filter(d => d.startsWith('Duplicate')).length;
  if (dupCount > 3) {
    report.dropped.details = [
      ...report.dropped.details.filter(d => !d.startsWith('Duplicate')),
      `Duplicate entries removed: ${dupCount} total`
    ];
  }

  return { measurements: kept, report };
}

function validateDate(raw: string, siteId: string): { date: string; fixDetail?: string; dropReason?: string } {
  if (!raw || !raw.trim()) {
    return { date: '', dropReason: `Missing date for ${siteId}` };
  }

  const trimmed = raw.trim();

  // Already valid: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { date: trimmed };
    }
    // Month/day out of range
    if (m < 1 || m > 12) {
      return { date: '', dropReason: `Invalid month (${m}) in date "${trimmed}" for ${siteId}` };
    }
    if (d < 1 || d > 31) {
      return { date: '', dropReason: `Invalid day (${d}) in date "${trimmed}" for ${siteId}` };
    }
  }

  // Missing day: YYYY-MM → assume first of month
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    const [y, m] = trimmed.split('-').map(Number);
    if (y > 1800 && y < 2100 && m >= 1 && m <= 12) {
      const fixed = `${trimmed}-01`;
      return { date: fixed, fixDetail: `Missing day in "${trimmed}" for ${siteId} → set to ${fixed}` };
    }
    return { date: '', dropReason: `Invalid partial date "${trimmed}" for ${siteId}` };
  }

  // Missing month and day: YYYY → assume Jan 1
  if (/^\d{4}$/.test(trimmed)) {
    const y = parseInt(trimmed, 10);
    if (y > 1800 && y < 2100) {
      const fixed = `${trimmed}-01-01`;
      return { date: fixed, fixDetail: `Year-only date "${trimmed}" for ${siteId} → set to ${fixed}` };
    }
    return { date: '', dropReason: `Invalid year-only date "${trimmed}" for ${siteId}` };
  }

  // YYYY-M-D or YYYY-M-DD or YYYY-MM-D → zero-pad
  const dashMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dashMatch) {
    const [, ys, ms, ds] = dashMatch;
    const y = parseInt(ys, 10), m = parseInt(ms, 10), d = parseInt(ds, 10);
    if (y > 1800 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const fixed = `${ys}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (fixed !== trimmed) {
        return { date: fixed, fixDetail: `Zero-padded date "${trimmed}" for ${siteId} → ${fixed}` };
      }
      return { date: fixed };
    }
    return { date: '', dropReason: `Invalid date "${trimmed}" for ${siteId}` };
  }

  // Slash formats: MM/DD/YYYY or M/D/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, ms, ds, ys] = slashMatch;
    const y = parseInt(ys, 10), m = parseInt(ms, 10), d = parseInt(ds, 10);
    if (y > 1800 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const fixed = `${ys}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return { date: fixed, fixDetail: `Converted date format "${trimmed}" for ${siteId} → ${fixed}` };
    }
  }

  // Unrecognizable
  return { date: '', dropReason: `Unrecognized date format "${trimmed}" for ${siteId}` };
}

/** Keep detail lists from growing unbounded — cap at 20 unique entries */
function addDetail(list: string[], detail: string) {
  if (list.length < 20) {
    list.push(detail);
  } else if (list.length === 20) {
    list.push('... and more (truncated)');
  }
}

/**
 * Fetch water level measurements for given well site IDs.
 * Uses parameter_code=72019 (depth to water level below land surface).
 */
export interface USGSDataSpan {
  minDate: string;     // YYYY-MM-DD
  maxDate: string;     // YYYY-MM-DD
  totalRecords: number;
  wellCount: number;   // distinct site IDs
}

export function computeDataSpan(measurements: { siteId: string; date: string }[]): USGSDataSpan {
  if (measurements.length === 0) {
    return { minDate: '', maxDate: '', totalRecords: 0, wellCount: 0 };
  }
  const dates = measurements.map(m => m.date).sort();
  const wells = new Set(measurements.map(m => m.siteId));
  return {
    minDate: dates[0],
    maxDate: dates[dates.length - 1],
    totalRecords: measurements.length,
    wellCount: wells.size,
  };
}

export function filterByDateRange(
  measurements: USGSMeasurement[],
  startDate: string | null,
  endDate: string | null
): USGSMeasurement[] {
  return measurements.filter(m => {
    if (startDate && m.date < startDate) return false;
    if (endDate && m.date > endDate) return false;
    return true;
  });
}

/**
 * Fetch water level measurements using batched CQL2 POST queries.
 * Batches site IDs into groups to minimize request count.
 * e.g. 7,664 wells at 1,000/batch → 8 requests instead of 7,664.
 */
export async function fetchUSGSMeasurements(
  wellSiteIds: string[],
  onProgress?: (completed: number, total: number) => void,
  onBatchError?: (message: string) => void
): Promise<USGSMeasurement[]> {
  if (wellSiteIds.length === 0) return [];

  const allMeasurements: USGSMeasurement[] = [];
  const PAGE_LIMIT = 10000; // max records per response page

  // Start with large batches; shrink if the server rejects them
  let batchSize = 1000;

  let i = 0;
  while (i < wellSiteIds.length) {
    const batch = wellSiteIds.slice(i, i + batchSize);
    const cqlFilter = {
      op: 'and' as const,
      args: [
        { op: 'in' as const, args: [{ property: 'monitoring_location_id' }, batch] },
        { op: '=' as const, args: [{ property: 'parameter_code' }, '72019'] },
      ],
    };

    // Paginate through results for this batch. Pages accumulate locally so
    // a batch-size retry can discard them — merging eagerly would duplicate
    // already-fetched pages when the whole batch is re-requested.
    const batchMeasurements: USGSMeasurement[] = [];
    let offset = 0;
    let hasMore = true;
    let batchFailed = false;

    while (hasMore) {
      try {
        const url = `${BASE_URL}/collections/field-measurements/items?limit=${PAGE_LIMIT}&offset=${offset}&f=json`;
        const res = await postCQL2WithRetry(url, cqlFilter);
        const data = await res.json();
        const features = data.features || [];

        for (const f of features) {
          const props = f.properties || {};
          const siteId = props.monitoring_location_id || props.id || '';
          const rawTime = props.time || props.activity_start_date || '';
          const date = rawTime.includes('T') ? rawTime.split('T')[0] : rawTime;
          const value = parseFloat(String(props.value ?? props.result_measure_value ?? ''));

          if (siteId && date && !isNaN(value)) {
            batchMeasurements.push({ siteId, date, value });
          }
        }

        hasMore = features.length >= PAGE_LIMIT;
        offset += PAGE_LIMIT;
        if (offset > 5_000_000) {
          console.warn('USGS measurement pagination exceeded 5M records for one batch — stopping this batch');
          hasMore = false;
        }
      } catch (err: any) {
        // If batch too large (400/413), halve the batch size and retry the
        // whole batch (anchored so a "400" inside an error body can't
        // trigger a spurious size reduction)
        if (batchSize > 50 && /^HTTP 4(00|13):/.test(String(err?.message || ''))) {
          batchSize = Math.max(50, Math.floor(batchSize / 2));
          console.warn(`Batch too large, reducing to ${batchSize} sites per request`);
          batchFailed = true;
          hasMore = false;
        } else {
          // Terminal failure for this batch: keep whatever pages succeeded,
          // tell the caller, and move on rather than dying silently
          const msg = `Measurement download incomplete for sites ${i + 1}–${i + batch.length}: ${err?.message || err}`;
          console.warn(msg);
          onBatchError?.(msg);
          hasMore = false;
        }
      }
    }

    // Only advance if batch succeeded; otherwise retry with smaller batch
    if (!batchFailed) {
      for (const m of batchMeasurements) allMeasurements.push(m);
      i += batch.length;
      onProgress?.(Math.min(i, wellSiteIds.length), wellSiteIds.length);
    }
  }

  return allMeasurements;
}
