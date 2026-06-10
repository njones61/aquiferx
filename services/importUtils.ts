import shp from 'shpjs';
import JSZip from 'jszip';
import { reprojectGeoJSON, reprojectFromWKT } from './reprojection';

/** Fetch with cache-busting to avoid stale browser-cached data after writes.
 *  Also detects Vite SPA fallback (returns index.html for missing files) and treats as 404. */
export async function freshFetch(url: string): Promise<Response> {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`);
  const ct = res.headers.get('content-type') || '';
  if (res.ok && ct.includes('text/html') && !url.endsWith('.html')) {
    return new Response(null, { status: 404, statusText: 'Not Found' });
  }
  return res;
}

export interface ColumnMapping {
  [targetColumn: string]: string;
}

export interface UploadedFile {
  name: string;
  data: any;
  columns: string[];
  mapping: ColumnMapping;
  type: 'geojson' | 'csv';
}

export const DATE_FORMATS = [
  { label: 'YYYY-MM-DD (2024-01-15)', value: 'iso' },
  { label: 'MM/DD/YYYY (01/15/2024)', value: 'us' },
  { label: 'DD/MM/YYYY (15/01/2024)', value: 'eu' },
  { label: 'M/D/YYYY (1/15/2024)', value: 'us-short' },
  { label: 'D/M/YYYY (15/1/2024)', value: 'eu-short' },
];

// Split a CSV line respecting quoted fields
export function splitCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

// Parse CSV text into { headers, rows }
export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length < 1) return { headers: [], rows: [] };

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = splitCSVLine(lines[0], delimiter);

  const rows = lines.slice(1).map(line => {
    const values = splitCSVLine(line, delimiter);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i]?.trim() || ''; });
    return row;
  });

  return { headers, rows };
}

// Parse date based on format
export function parseDate(dateStr: string, format: string): string {
  if (!dateStr) return '';

  let parts: string[];
  let year: string, month: string, day: string;

  try {
    switch (format) {
      case 'iso':
        parts = dateStr.split('-');
        if (parts.length === 3) {
          // Zero-pad so lexicographic comparisons (cutoffs, sorts, dedup
          // keys) work — "2024-1-5" would sort/compare incorrectly
          return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
        }
        break;
      case 'us':
      case 'us-short':
        parts = dateStr.split('/');
        if (parts.length === 3) {
          month = parts[0].padStart(2, '0');
          day = parts[1].padStart(2, '0');
          year = parts[2].length === 2
            ? (parseInt(parts[2], 10) >= 50 ? '19' : '20') + parts[2]
            : parts[2];
          return `${year}-${month}-${day}`;
        }
        break;
      case 'eu':
      case 'eu-short':
        parts = dateStr.split('/');
        if (parts.length === 3) {
          day = parts[0].padStart(2, '0');
          month = parts[1].padStart(2, '0');
          year = parts[2].length === 2
            ? (parseInt(parts[2], 10) >= 50 ? '19' : '20') + parts[2]
            : parts[2];
          return `${year}-${month}-${day}`;
        }
        break;
    }
  } catch {
    // Fall through
  }

  return dateStr;
}

// Detect date format from sample values
export function detectDateFormat(rows: Record<string, string>[], dateCol: string): string {
  const samples: string[] = [];
  for (const row of rows) {
    const val = row[dateCol]?.trim();
    if (val && samples.length < 20) samples.push(val);
  }
  if (samples.length === 0) return 'iso';

  if (samples.every(s => /^\d{4}-\d{1,2}-\d{1,2}$/.test(s))) return 'iso';

  const slashSamples = samples.filter(s => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s));
  if (slashSamples.length > 0) {
    let hasFirstOver12 = false;
    let hasSecondOver12 = false;
    let hasShortParts = false;
    for (const s of slashSamples) {
      const parts = s.split('/');
      const first = parseInt(parts[0], 10);
      const second = parseInt(parts[1], 10);
      if (first > 12) hasFirstOver12 = true;
      if (second > 12) hasSecondOver12 = true;
      if (parts[0].length === 1 || parts[1].length === 1) hasShortParts = true;
    }
    if (hasFirstOver12) return hasShortParts ? 'eu-short' : 'eu';
    if (hasSecondOver12) return hasShortParts ? 'us-short' : 'us';
    return hasShortParts ? 'us-short' : 'us';
  }

  return 'iso';
}

// Generate folder name from region name
export function getFolderName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Check if coordinates fall within US bounding boxes
export function isInUS(lat: number, lng: number): boolean {
  if (lat >= 24.4 && lat <= 49.4 && lng >= -125.0 && lng <= -66.9) return true;
  if (lat >= 51.0 && lat <= 71.5 && lng >= -180.0 && lng <= -129.0) return true;
  if (lat >= 18.9 && lat <= 22.3 && lng >= -160.3 && lng <= -154.8) return true;
  if (lat >= 17.6 && lat <= 18.6 && lng >= -67.3 && lng <= -64.5) return true;
  if (lat >= 13.2 && lat <= 13.7 && lng >= 144.6 && lng <= 145.0) return true;
  return false;
}

// Auto-map columns based on common names
export function autoMapColumns(columns: string[], fileType: string): ColumnMapping {
  const mapping: ColumnMapping = {};
  const lowerColumns = columns.map(c => c.toLowerCase());

  if (fileType === 'aquifer') {
    const idIdx = lowerColumns.findIndex(c =>
      c.includes('aquifer') && c.includes('id') || c === 'aquifer_id' || c === 'id'
    );
    const nameIdx = lowerColumns.findIndex(c =>
      (c.includes('aquifer') && c.includes('name')) || c === 'aquifer_name' || c === 'name' || c === 'full_name'
    );
    if (idIdx >= 0) mapping['aquifer_id'] = columns[idIdx];
    if (nameIdx >= 0) mapping['aquifer_name'] = columns[nameIdx];
  } else if (fileType === 'wells') {
    const wellIdIdx = lowerColumns.findIndex(c => c.includes('well') && c.includes('id') || c === 'well_id');
    const wellNameIdx = lowerColumns.findIndex(c => (c.includes('well') && c.includes('name')) || c === 'well_name' || c === 'name');
    const latIdx = lowerColumns.findIndex(c => c === 'lat' || c.includes('latitude') || c === 'lat_dec' || c === 'northing' || c === 'y');
    const longIdx = lowerColumns.findIndex(c => c === 'long' || c === 'lng' || c.includes('longitude') || c === 'long_dec' || c === 'easting' || c === 'x');
    const gseIdx = lowerColumns.findIndex(c => c === 'gse' || c === 'ground_surface_elevation' || c === 'elevation' || c === 'surface_elevation');
    const aqIdIdx = lowerColumns.findIndex(c => c.includes('aquifer') && c.includes('id') || c === 'aquifer_id');

    if (wellIdIdx >= 0) mapping['well_id'] = columns[wellIdIdx];
    if (wellNameIdx >= 0) mapping['well_name'] = columns[wellNameIdx];
    if (latIdx >= 0) mapping['lat'] = columns[latIdx];
    if (longIdx >= 0) mapping['long'] = columns[longIdx];
    if (gseIdx >= 0) mapping['gse'] = columns[gseIdx];
    if (aqIdIdx >= 0) mapping['aquifer_id'] = columns[aqIdIdx];
  } else if (fileType === 'measurements') {
    // Only auto-map structural columns. Data columns (including WTE's
    // "value" column) are handled by the detection panel.
    const wellIdIdx = lowerColumns.findIndex(c => c.includes('well') && c.includes('id') || c === 'well_id');
    const wellNameIdx = lowerColumns.findIndex(c => (c.includes('well') && c.includes('name')) || c === 'well_name' || c === 'name' || c === 'station' || c === 'station_name');
    const dateIdx = lowerColumns.findIndex(c => c === 'date' || c.includes('date'));
    const latIdx = lowerColumns.findIndex(c => c === 'lat' || c.includes('latitude') || c === 'lat_dec' || c === 'northing' || c === 'y');
    const longIdx = lowerColumns.findIndex(c => c === 'long' || c === 'lng' || c.includes('longitude') || c === 'long_dec' || c === 'lon' || c === 'easting' || c === 'x');
    const aqIdIdx = lowerColumns.findIndex(c => c.includes('aquifer') && c.includes('id') || c === 'aquifer_id');

    if (wellIdIdx >= 0) mapping['well_id'] = columns[wellIdIdx];
    if (wellNameIdx >= 0) mapping['well_name'] = columns[wellNameIdx];
    if (dateIdx >= 0) mapping['date'] = columns[dateIdx];
    if (latIdx >= 0) mapping['lat'] = columns[latIdx];
    if (longIdx >= 0) mapping['long'] = columns[longIdx];
    if (aqIdIdx >= 0) mapping['aquifer_id'] = columns[aqIdIdx];
  }

  return mapping;
}

// Process uploaded file (GeoJSON, shapefile zip, or CSV)
// Returns { UploadedFile } with automatic CRS reprojection for spatial files
export async function processUploadedFile(
  file: File,
  fileType: string
): Promise<UploadedFile & { reprojected?: boolean; fromCrs?: string }> {
  const isZip = file.name.endsWith('.zip');
  const isGeoJSON = file.name.endsWith('.geojson') || file.name.endsWith('.json');
  const isCSV = file.name.endsWith('.csv') || file.name.endsWith('.txt');

  if (isZip) {
    const buffer = await file.arrayBuffer();
    let geojson = await shp(buffer);

    // Try to extract .prj file for reprojection
    let reprojected = false;
    let fromCrs = 'WGS84';
    try {
      const zip = await JSZip.loadAsync(buffer);
      let prjContent = '';
      zip.forEach((path, entry) => {
        if (path.endsWith('.prj') && !entry.dir) {
          // We'll read the first .prj file found
          prjContent = path;
        }
      });
      if (prjContent) {
        const prjFile = zip.file(prjContent);
        if (prjFile) {
          const wkt = await prjFile.async('text');
          const result = reprojectFromWKT(geojson, wkt);
          geojson = result.geojson;
          reprojected = result.reprojected;
          fromCrs = result.fromCrs;
        }
      }
    } catch {
      // Reprojection not critical, continue with original
    }

    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    const columns = features.length > 0 ? Object.keys(features[0].properties || {}) : [];
    return {
      name: file.name,
      data: geojson,
      columns,
      mapping: autoMapColumns(columns, fileType),
      type: 'geojson',
      reprojected,
      fromCrs,
    };
  } else if (isGeoJSON) {
    const text = await file.text();
    let geojson = JSON.parse(text);

    // Check for CRS property and reproject if needed
    const { geojson: reprojGj, reprojected, fromCrs } = reprojectGeoJSON(geojson);
    geojson = reprojGj;

    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    const columns = features.length > 0 ? Object.keys(features[0].properties || {}) : [];
    return {
      name: file.name,
      data: geojson,
      columns,
      mapping: autoMapColumns(columns, fileType),
      type: 'geojson',
      reprojected,
      fromCrs,
    };
  } else if (isCSV) {
    const text = await file.text();
    const { headers, rows } = parseCSV(text);
    return {
      name: file.name,
      data: rows,
      columns: headers,
      mapping: autoMapColumns(headers, fileType),
      type: 'csv'
    };
  }

  throw new Error(`Unsupported file type: ${file.name}`);
}

// Save files via API
export async function saveFiles(files: { path: string; content: string }[]): Promise<void> {
  const res = await fetch('/api/save-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files })
  });
  if (!res.ok) throw new Error(await res.text());
}

// Delete a single file via API
export async function deleteFile(filePath: string): Promise<void> {
  const res = await fetch('/api/delete-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath })
  });
  if (!res.ok) throw new Error(await res.text());
}

// Point-in-polygon using ray casting
export function pointInPolygon(point: [number, number], polygon: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Assign a well to an aquifer by testing point-in-polygon against all aquifer features
export function assignWellToAquifer(
  lat: number,
  lng: number,
  aquifersGeojson: any
): string | null {
  const features = aquifersGeojson?.type === 'FeatureCollection'
    ? aquifersGeojson.features
    : [aquifersGeojson];

  for (const feature of features) {
    if (!feature?.geometry) continue;
    const geom = feature.geometry;
    const aquiferId = String(feature.properties?.aquifer_id || '');

    const polygons: number[][][] = [];
    if (geom.type === 'Polygon') {
      polygons.push(geom.coordinates[0]);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        polygons.push(poly[0]);
      }
    }

    for (const ring of polygons) {
      if (pointInPolygon([lng, lat], ring)) {
        return aquiferId;
      }
    }
  }
  return null;
}
