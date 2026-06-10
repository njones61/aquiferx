/**
 * Pure measurement-import logic shared by MeasurementImporter's save path.
 * Everything here is data-in/data-out — fetching existing CSVs and React
 * state stay in the component. Keeping these out of the component makes
 * the save pipeline's contracts explicit (the divergent inline copies of
 * this logic were where the importer's bugs lived).
 */
import { parseDate } from './importUtils';

// Type alias (not interface) so it picks up the implicit index signature
// and stays assignable to the CSV writer's Record<string, string>
export type MeasurementRow = {
  well_id: string;
  date: string;
  value: string;
  aquifer_id: string;
};

export type DuplicateStrategy = 'keep-all' | 'average' | 'maximum';

/** Columns every data_{code}.csv is written with. */
export const MEASUREMENT_CSV_HEADERS = ['well_id', 'date', 'value', 'aquifer_id'];

/**
 * Convert a depth-below-surface reading to a water table elevation.
 * Returns the original string when there is no usable GSE or the value
 * does not parse — callers decide whether such rows are kept.
 */
export function depthToWte(rawValue: string, gse: number): string {
  const raw = parseFloat(rawValue);
  if (isNaN(raw) || gse <= 0) return rawValue;
  return String(Math.round((gse - Math.abs(raw)) * 100) / 100);
}

/**
 * Build normalized measurement rows for one data type from source CSV rows.
 * Rows without a resolvable well, date, or value are dropped.
 */
export function buildMeasurementRows(
  sourceRows: Record<string, string>[],
  opts: {
    valueCol: string;
    dateCol: string;
    dateFormat: string;
    convertDepthToWte: boolean;
    rowToWellId: (row: Record<string, string>) => string;
    resolveAquifer: (row: Record<string, string>) => string;
    gseOf: (wellId: string) => number;
  }
): MeasurementRow[] {
  const out: MeasurementRow[] = [];
  for (const r of sourceRows) {
    const wid = opts.rowToWellId(r);
    if (!wid || !r[opts.dateCol] || !r[opts.valueCol]) continue;
    const value = opts.convertDepthToWte
      ? depthToWte(r[opts.valueCol], opts.gseOf(wid))
      : r[opts.valueCol];
    out.push({
      well_id: wid,
      date: parseDate(r[opts.dateCol], opts.dateFormat),
      value,
      aquifer_id: opts.resolveAquifer(r),
    });
  }
  return out;
}

/**
 * Collapse in-batch duplicates (same well_id + date) according to the
 * user-selected strategy. Returns the surviving rows and how many were
 * collapsed (for the import summary).
 */
export function dedupMeasurements(
  rows: MeasurementRow[],
  strategy: DuplicateStrategy
): { rows: MeasurementRow[]; collapsed: number } {
  if (strategy === 'keep-all') return { rows, collapsed: 0 };

  const groups = new Map<string, MeasurementRow[]>();
  for (const r of rows) {
    const key = `${r.well_id}|${r.date}`;
    const arr = groups.get(key);
    if (arr) arr.push(r); else groups.set(key, [r]);
  }

  let collapsed = 0;
  const result: MeasurementRow[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) { result.push(group[0]); continue; }
    collapsed += group.length - 1;
    const nums = group.map(r => parseFloat(r.value)).filter(v => !isNaN(v));
    let finalVal: string;
    if (nums.length === 0) {
      finalVal = group[0].value;
    } else if (strategy === 'average') {
      finalVal = String(Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000);
    } else {
      // maximum
      finalVal = String(Math.max(...nums));
    }
    result.push({ ...group[0], value: finalVal });
  }
  return { rows: result, collapsed };
}

/**
 * Append merge: keep every existing row, add only new rows whose
 * well_id|date key isn't already present. (Keying on aquifer_id too would
 * re-append the same measurement whenever a re-import resolves the
 * aquifer differently.)
 */
export function mergeAppend(
  existingRows: Record<string, string>[],
  newRows: MeasurementRow[]
): MeasurementRow[] {
  const existingKeys = new Set(existingRows.map(r => `${r.well_id}|${r.date}`));
  const toAdd = newRows.filter(r => !existingKeys.has(`${r.well_id}|${r.date}`));
  return [
    ...existingRows.map(r => ({
      well_id: r.well_id,
      date: r.date,
      value: r.value,
      aquifer_id: r.aquifer_id || '',
    })),
    ...toAdd,
  ];
}

/**
 * Full-refresh merge: update existing rows in place where the new data has
 * the same well_id|date, keep the rest, and append new rows that don't
 * exist yet (backfills).
 */
export function mergeFullRefresh(
  existingRows: Record<string, string>[],
  newRows: MeasurementRow[]
): MeasurementRow[] {
  const newLookup = new Map<string, { value: string; aquifer_id: string }>();
  for (const r of newRows) {
    newLookup.set(`${r.well_id}|${r.date}`, { value: r.value, aquifer_id: r.aquifer_id });
  }

  const usedKeys = new Set<string>();
  const merged: MeasurementRow[] = existingRows.map(r => {
    const key = `${r.well_id}|${r.date}`;
    const update = newLookup.get(key);
    if (update) {
      usedKeys.add(key);
      return { well_id: r.well_id, date: r.date, value: update.value, aquifer_id: r.aquifer_id || update.aquifer_id };
    }
    return { well_id: r.well_id, date: r.date, value: r.value, aquifer_id: r.aquifer_id || '' };
  });

  for (const r of newRows) {
    if (!usedKeys.has(`${r.well_id}|${r.date}`)) merged.push(r);
  }
  return merged;
}
