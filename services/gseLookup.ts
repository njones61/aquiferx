import { isInUS } from './importUtils';
import { fetchWithTimeout } from './http';

export interface GseFetchInput {
  id: string;
  lat: number;
  lng: number;
}

export interface GseFetchOptions {
  lengthUnit: 'ft' | 'm';
  onProgress?: (completed: number, total: number) => void;
}

export interface GseFetchResult {
  values: Map<string, number>;
  source: string;
}

// Batched elevation fetch. Picks USGS 3DEP for US-only batches, Open-Meteo
// Copernicus DEM otherwise. Returns a map keyed by input id.
export async function fetchGseBatch(wells: GseFetchInput[], opts: GseFetchOptions): Promise<GseFetchResult> {
  const values = new Map<string, number>();
  if (wells.length === 0) return { values, source: '' };

  const allInUS = wells.every(w => isInUS(w.lat, w.lng));
  const factor = opts.lengthUnit === 'ft' ? 3.28084 : 1;

  if (allInUS) {
    let completed = 0;
    const queue = [...wells];
    const worker = async () => {
      while (queue.length > 0) {
        const well = queue.shift()!;
        try {
          const url = `https://epqs.nationalmap.gov/v1/json?x=${well.lng}&y=${well.lat}&units=Meters&wkid=4326`;
          const res = await fetchWithTimeout(url, {}, 10000);
          if (res.ok) {
            const data = await res.json();
            const m = parseFloat(data.value);
            if (!isNaN(m) && m > -100) {
              values.set(well.id, Math.round(m * factor * 100) / 100);
            }
          }
        } catch {
          // swallow — leaving the well without an elevation is acceptable
        }
        completed++;
        opts.onProgress?.(completed, wells.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, wells.length) }, () => worker()));
    return { values, source: 'USGS 3DEP (~10m resolution)' };
  }

  // Open-Meteo batched: 100 per request
  let completed = 0;
  for (let i = 0; i < wells.length; i += 100) {
    const batch = wells.slice(i, i + 100);
    try {
      const lats = batch.map(w => w.lat).join(',');
      const lngs = batch.map(w => w.lng).join(',');
      const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`, {}, 15000);
      if (res.ok) {
        const data = await res.json();
        batch.forEach((well, idx) => {
          const m = data.elevation?.[idx];
          if (m !== undefined && !isNaN(m) && m > -1000) {
            values.set(well.id, Math.round(m * factor * 100) / 100);
          }
        });
      }
    } catch {}
    completed += batch.length;
    opts.onProgress?.(completed, wells.length);
  }
  return { values, source: 'Open-Meteo Copernicus DEM (~90m resolution)' };
}
