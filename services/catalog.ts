import { ParameterCatalog, CatalogParameter, DataType, RegionMeta } from '../types';

let cachedCatalog: ParameterCatalog | null = null;

export async function loadCatalog(): Promise<ParameterCatalog> {
  if (cachedCatalog) return cachedCatalog;
  // Ships with the app beside the sample regions, so it follows the deploy path
  const res = await fetch(`${import.meta.env.BASE_URL}data/catalog_wq.json`);
  if (!res.ok) throw new Error(`Failed to load catalog_wq.json: ${res.status}`);
  cachedCatalog = (await res.json()) as ParameterCatalog;
  return cachedCatalog;
}

/** Compute the effective data type list for a region: WTE + catalog entries
 *  with data on disk + custom types with data on disk. Pass the raw catalog
 *  and the region's server-reported `dataFiles` list. */
export function computeEffectiveDataTypes(
  meta: RegionMeta,
  catalog: ParameterCatalog | null
): DataType[] {
  const wte: DataType = {
    code: 'wte',
    name: 'Water Table Elevation',
    unit: meta.lengthUnit || 'ft',
  };
  const files = new Set(meta.dataFiles || []);
  const dataCodes = new Set<string>();
  for (const f of files) {
    const m = /^data_(.+)\.csv$/.exec(f);
    if (m) dataCodes.add(m[1]);
  }
  const result: DataType[] = [wte];
  // Catalog types with data
  if (catalog) {
    for (const [code, param] of Object.entries(catalog.parameters)) {
      if (code === 'wte') continue;
      if (dataCodes.has(code)) {
        result.push({ code, name: param.name, unit: param.unit });
      }
    }
  }
  // Custom types with data — those whose code isn't in the catalog
  const catalogCodes = new Set(Object.keys(catalog?.parameters || {}));
  for (const dt of meta.customDataTypes || []) {
    if (catalogCodes.has(dt.code)) continue;
    if (dataCodes.has(dt.code)) result.push(dt);
  }
  return result;
}

export function groupCatalog(catalog: ParameterCatalog): Record<string, Array<{ code: string; param: CatalogParameter }>> {
  const groups: Record<string, Array<{ code: string; param: CatalogParameter }>> = {};
  for (const [code, param] of Object.entries(catalog.parameters)) {
    (groups[param.group] ||= []).push({ code, param });
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => a.param.name.localeCompare(b.param.name));
  }
  return groups;
}
