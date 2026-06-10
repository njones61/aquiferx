import { DataType, CatalogParameter, ParameterCatalog } from '../types';

// -------- Normalization helpers --------

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Strip parenthesized unit hints like "Nitrate (mg/L)" → "nitrate" + unit "mg/L"
export function parseColumnHeader(header: string): { base: string; unit: string | null } {
  const m = header.match(/^(.*?)\s*[\(\[]\s*([^\)\]]+)\s*[\)\]]\s*$/);
  if (m) return { base: m[1].trim(), unit: m[2].trim() };
  return { base: header.trim(), unit: null };
}

// -------- Haversine distance (meters) --------

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// -------- aqx- ID generation --------

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
}

function fmtCoord(n: number): string {
  return Math.abs(n).toFixed(2);
}

export function generateAqxId(name: string | null | undefined, lat: number, lng: number, taken: Set<string>): string {
  const latTag = `${fmtCoord(lat)}${lat >= 0 ? 'N' : 'S'}`;
  const lngTag = `${fmtCoord(lng)}${lng >= 0 ? 'E' : 'W'}`;
  const base = name && name.trim() ? `aqx-${slugify(name)}-${latTag}${lngTag}` : `aqx-${latTag}${lngTag}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}-${i}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}

// -------- Well matching pipeline --------

export interface ExistingWell {
  well_id: string;
  well_name: string;
  lat: number;
  lng: number;
  aquifer_id: string;
  gse: number;
}

export interface SourceWellRow {
  sourceIndex: number;
  wellId?: string;
  wellName?: string;
  lat?: number;
  lng?: number;
}

export type MatchKind = 'id' | 'name' | 'proximity' | 'new' | 'unmatched';

export interface MatchResult {
  sourceRow: SourceWellRow;
  kind: MatchKind;
  existingWell?: ExistingWell;
  distanceMeters?: number;
  resolvedWellId: string | null; // null when unmatched
  rejected?: boolean;
}

export interface MatchOptions {
  proximityMeters: number;
}

export interface MatchSummary {
  byId: number;
  byName: number;
  byProximity: number;
  newWells: number;
  unmatched: number;
  total: number;
}

export function matchWells(rows: SourceWellRow[], existing: ExistingWell[], opts: MatchOptions): MatchResult[] {
  const byId = new Map<string, ExistingWell>();
  const byNormName = new Map<string, ExistingWell>();
  for (const w of existing) {
    if (w.well_id) byId.set(w.well_id, w);
    if (w.well_name) byNormName.set(normalizeName(w.well_name), w);
  }
  const results: MatchResult[] = [];
  for (const row of rows) {
    // 1. Exact ID match
    if (row.wellId && byId.has(row.wellId)) {
      const ex = byId.get(row.wellId)!;
      results.push({ sourceRow: row, kind: 'id', existingWell: ex, resolvedWellId: ex.well_id });
      continue;
    }
    // 2. Exact name match
    if (row.wellName) {
      const ex = byNormName.get(normalizeName(row.wellName));
      if (ex) {
        results.push({ sourceRow: row, kind: 'name', existingWell: ex, resolvedWellId: ex.well_id });
        continue;
      }
    }
    // 3. Proximity match
    if (row.lat !== undefined && row.lng !== undefined && !isNaN(row.lat) && !isNaN(row.lng)) {
      // Cheap bounding-box prefilter before the trig-heavy haversine —
      // a full scan per row froze the import preview on large CSVs
      const latDelta = opts.proximityMeters / 111_320;
      const lngDelta = latDelta / Math.max(0.1, Math.cos(row.lat * Math.PI / 180));
      let nearest: { well: ExistingWell; dist: number } | null = null;
      for (const w of existing) {
        if (isNaN(w.lat) || isNaN(w.lng)) continue;
        if (Math.abs(w.lat - row.lat) > latDelta || Math.abs(w.lng - row.lng) > lngDelta) continue;
        const d = haversineMeters(row.lat, row.lng, w.lat, w.lng);
        if (d <= opts.proximityMeters && (!nearest || d < nearest.dist)) {
          nearest = { well: w, dist: d };
        }
      }
      if (nearest) {
        results.push({
          sourceRow: row,
          kind: 'proximity',
          existingWell: nearest.well,
          distanceMeters: nearest.dist,
          resolvedWellId: nearest.well.well_id,
        });
        continue;
      }
      // 4. New well (has lat/lng but no match)
      results.push({ sourceRow: row, kind: 'new', resolvedWellId: null });
      continue;
    }
    // 5. Unmatched (no lat/lng and no id/name match)
    results.push({ sourceRow: row, kind: 'unmatched', resolvedWellId: null });
  }
  return results;
}

export function summarizeMatches(results: MatchResult[]): MatchSummary {
  const s: MatchSummary = { byId: 0, byName: 0, byProximity: 0, newWells: 0, unmatched: 0, total: results.length };
  for (const r of results) {
    if (r.rejected) { s.unmatched++; continue; }
    switch (r.kind) {
      case 'id': s.byId++; break;
      case 'name': s.byName++; break;
      case 'proximity': s.byProximity++; break;
      case 'new': s.newWells++; break;
      case 'unmatched': s.unmatched++; break;
    }
  }
  return s;
}

// -------- Column → data type suggestion --------

export type SuggestionSource = 'catalog' | 'existingCustom' | 'otherRegionCustom' | 'custom';

export interface ColumnSuggestion {
  column: string;
  code: string;
  name: string;
  unit: string;
  /** Unit string parsed from the CSV header like "(mg/L)", or null when the
   *  header carried no unit hint. Used by the importer to warn on unit
   *  mismatches against catalog entries. */
  headerUnit: string | null;
  source: SuggestionSource;
  include: boolean;
}

// Reserved column keys that shouldn't be suggested as data types
const RESERVED_LOWER = new Set([
  'well_id', 'wellid', 'well id', 'site', 'site_id', 'siteid',
  'well_name', 'wellname', 'well name', 'name',
  'date', 'datetime', 'timestamp', 'time',
  'lat', 'latitude', 'lat_dec',
  'long', 'lng', 'longitude', 'long_dec', 'lon',
  'aquifer_id', 'aquifer', 'aquifer_name',
  'gse', 'ground_surface_elevation', 'surface_elevation',
]);

// WTE aliases — column headers that should auto-match to the built-in
// Water Table Elevation type. WTE isn't in the catalog (it's the implicit
// default) so it needs its own match set.
const WTE_ALIASES = new Set([
  'value', 'wte', 'water table elevation', 'water_table_elevation',
  'water level', 'water_level', 'elevation', 'level',
  'measurement', 'reading', 'head', 'water head',
]);

function isReservedColumn(col: string): boolean {
  return RESERVED_LOWER.has(col.toLowerCase().trim());
}

function buildCatalogIndex(catalog: ParameterCatalog): Map<string, { code: string; param: CatalogParameter }> {
  const index = new Map<string, { code: string; param: CatalogParameter }>();
  for (const [code, param] of Object.entries(catalog.parameters)) {
    const entry = { code, param };
    const keys = new Set<string>();
    keys.add(normalizeName(code));
    keys.add(normalizeName(param.name));
    if (param.wqp?.characteristicName) keys.add(normalizeName(param.wqp.characteristicName));
    // Auto-computed acronym: "Fecal Coliform" → "fc", "Total Dissolved Solids" → "tds"
    const acronym = computeAcronym(param.name);
    if (acronym) keys.add(acronym);
    for (const k of keys) {
      if (k && !index.has(k)) index.set(k, entry);
    }
  }
  return index;
}

function slugCode(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'custom';
}

// Chemical formulas and symbols that can't be derived algorithmically from
// catalog names. Acronyms (FC, TDS, DO) are computed automatically; spelling
// variants (Sulphate) are caught by Levenshtein distance. This table is
// only for formula→code mappings.
const CHEMICAL_ALIASES: Record<string, string> = {
  no3: 'nitrate', no2: 'nitrite',
  nh3: 'ammonia', nh4: 'ammonia',
  po4: 'phosphorus',
  so4: 'sulfate',
  hco3: 'bicarbonate', co3: 'carbonate',
  ca: 'calcium', mg: 'magnesium', na: 'sodium', k: 'potassium',
  fe: 'iron', mn: 'manganese', cl: 'chloride',
  as: 'arsenic', pb: 'lead', cu: 'copper', zn: 'zinc',
  cr: 'chromium', se: 'selenium', b: 'boron', si: 'silica', f: 'fluoride',
  ecoli: 'e_coli', 'e coli': 'e_coli',
};

// Compute the acronym of a multi-word name: "Fecal Coliform" → "fc",
// "Total Dissolved Solids" → "tds". Single-word names return the first
// 3 chars as a pseudo-acronym ("Nitrate" → "nit").
function computeAcronym(name: string): string {
  const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length <= 1) return '';
  return words.map(w => w[0]).join('');
}

// Levenshtein edit distance — O(mn) DP, fine for short strings
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

export function suggestDataTypesFromColumns(
  columns: string[],
  catalog: ParameterCatalog | null,
  regionCustomDataTypes: DataType[],
  otherRegionCustomDataTypes: DataType[]
): ColumnSuggestion[] {
  const catalogIdx = catalog ? buildCatalogIndex(catalog) : new Map();
  const regionCustomByName = new Map<string, DataType>();
  for (const dt of regionCustomDataTypes) {
    regionCustomByName.set(normalizeName(dt.name), dt);
    regionCustomByName.set(normalizeName(dt.code), dt);
  }
  const otherByName = new Map<string, DataType>();
  for (const dt of otherRegionCustomDataTypes) {
    if (!otherByName.has(normalizeName(dt.name))) otherByName.set(normalizeName(dt.name), dt);
    if (!otherByName.has(normalizeName(dt.code))) otherByName.set(normalizeName(dt.code), dt);
  }

  const suggestions: ColumnSuggestion[] = [];
  for (const col of columns) {
    if (isReservedColumn(col)) continue;
    const { base, unit } = parseColumnHeader(col);
    const norm = normalizeName(base);
    if (!norm) continue;

    // 0. WTE — the built-in Water Table Elevation type isn't in the catalog
    //    but matches common column names like "value", "wte", "water_level".
    if (WTE_ALIASES.has(norm)) {
      suggestions.push({
        column: col,
        code: 'wte',
        name: 'Water Table Elevation',
        unit: '', // unit comes from the region's lengthUnit at save time
        headerUnit: unit,
        source: 'catalog',
        include: true,
      });
      continue;
    }

    // 1. Catalog — authoritative for standard parameters
    // Match tiers: exact → chemical formula alias → Levenshtein → substring
    const chemAlias = CHEMICAL_ALIASES[norm];
    const catHit = catalogIdx.get(norm)
      || (chemAlias && catalog ? { code: chemAlias, param: catalog.parameters[chemAlias] } : null)
      || findLevenshteinCatalogMatch(norm, catalogIdx)
      || findSubstringCatalogMatch(norm, catalogIdx);
    if (catHit && catHit.param) {
      suggestions.push({
        column: col,
        code: catHit.code,
        name: catHit.param.name,
        unit: catHit.param.unit, // catalog unit wins for catalog targets
        headerUnit: unit,
        source: 'catalog',
        include: true,
      });
      continue;
    }

    // 2. Region's existing custom types (non-catalog, defined in customDataTypes)
    const customHit = regionCustomByName.get(norm);
    if (customHit) {
      suggestions.push({
        column: col,
        code: customHit.code,
        name: customHit.name,
        unit: customHit.unit,
        headerUnit: unit,
        source: 'existingCustom',
        include: true,
      });
      continue;
    }

    // 3. Other regions' custom types (seed for importing to this region)
    const otherHit = otherByName.get(norm);
    if (otherHit) {
      suggestions.push({
        column: col,
        code: otherHit.code,
        name: otherHit.name,
        unit: unit || otherHit.unit,
        headerUnit: unit,
        source: 'otherRegionCustom',
        include: true,
      });
      continue;
    }

    // 4. Custom fallback — unmatched, default off
    suggestions.push({
      column: col,
      code: slugCode(base),
      name: base,
      unit: unit || '',
      headerUnit: unit,
      source: 'custom',
      include: false,
    });
  }
  return suggestions;
}

// Levenshtein fuzzy match: catches spelling variants (Sulphate→Sulfate,
// Flouride→Fluoride) without hardcoded lists. Only fires for inputs ≥ 4 chars
// and accepts distance ≤ 2 to avoid false positives on short strings.
function findLevenshteinCatalogMatch(norm: string, index: Map<string, { code: string; param: CatalogParameter }>) {
  if (norm.length < 4) return null;
  const maxDist = 2;
  let best: { entry: { code: string; param: CatalogParameter }; dist: number } | null = null;
  for (const [key, entry] of index) {
    if (key.length < 4) continue;
    if (Math.abs(key.length - norm.length) > maxDist) continue;
    const d = levenshtein(norm, key);
    if (d <= maxDist && (!best || d < best.dist)) {
      best = { entry, dist: d };
    }
  }
  return best?.entry || null;
}

function findSubstringCatalogMatch(norm: string, index: Map<string, { code: string; param: CatalogParameter }>) {
  for (const [key, entry] of index) {
    if (key.length < 3) continue;
    if (norm.includes(key) || key.includes(norm)) return entry;
  }
  return null;
}
