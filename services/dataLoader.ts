import shp from 'shpjs';
import polylabel from 'polylabel';
import { Region, Aquifer, Well, Measurement, RegionMeta, RasterAnalysisMeta, ImputationModelMeta, DataType } from '../types';
import { freshFetch } from './importUtils';
import { loadCatalog, computeEffectiveDataTypes } from './catalog';

interface DataFolder {
  name: string;
  path: string;
}

// Calculate bounds from GeoJSON geometry (iterative to avoid stack overflow)
function calculateBounds(geojson: any): [number, number, number, number] {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;

  // Collect all geometries
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

  // Process coordinates iteratively using a stack
  for (const geometry of geometries) {
    if (!geometry.coordinates) continue;

    const stack: any[] = [geometry.coordinates];
    while (stack.length > 0) {
      const coords = stack.pop();
      if (!Array.isArray(coords)) continue;

      // Check if this is a [lng, lat] pair
      if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
        const [lng, lat] = coords;
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
      } else {
        // It's a nested array, add children to stack
        for (const child of coords) {
          stack.push(child);
        }
      }
    }
  }

  return [minLat, minLng, maxLat, maxLng];
}

// Compute optimal label point using pole-of-inaccessibility algorithm.
// Returns [lat, lng]. Picks the largest polygon from a FeatureCollection.
function computeLabelPoint(geojson: any, bounds: [number, number, number, number]): [number, number] {
  // Extract all polygon rings, pick the one with the largest area
  const polygons: number[][][] = [];
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
    if (geom.type === 'Polygon' && geom.coordinates?.length > 0) {
      polygons.push(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (poly?.length > 0) polygons.push(poly);
      }
    }
  }

  if (polygons.length === 0) {
    // Fallback to bounds center
    return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  }

  // Pick the polygon with the largest outer ring (by area approximation)
  let bestPoly = polygons[0];
  let bestArea = 0;
  for (const poly of polygons) {
    const ring = poly[0];
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    area = Math.abs(area);
    if (area > bestArea) {
      bestArea = area;
      bestPoly = poly;
    }
  }

  const result = polylabel(bestPoly, 0.001);
  return [result[1], result[0]]; // [lat, lng]
}

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
          i++; // skip escaped quote
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

// Parse CSV text into rows
export function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];

  // Detect delimiter (comma or tab)
  const firstLine = lines[0];
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const headers = splitCSVLine(lines[0], delimiter);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i], delimiter);
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx]?.trim() || '';
    });
    rows.push(row);
  }

  return rows;
}

// Load shapefile from URL - shpjs handles fetching all components (.shp, .dbf, .prj, .cpg)
async function loadShapefile(shpPath: string): Promise<any> {
  // shpjs accepts a URL string and automatically fetches .shp, .dbf, .prj, .cpg files
  return shp(shpPath);
}

// Load GeoJSON file
async function loadGeoJSON(path: string): Promise<any> {
  const response = await fetch(path);
  return response.json();
}

// Load region manifest via API
async function loadRegionManifest(): Promise<RegionMeta[]> {
  try {
    const response = await freshFetch('/api/regions');
    if (response.ok) {
      const raw = await response.json();
      // Migrate old shape (dataTypes) → new shape (customDataTypes) in memory
      // so consumers never see the legacy field. The disk files are handled
      // separately by the migration step.
      return (raw as any[]).map((m: any): RegionMeta => ({
        id: m.id,
        name: m.name,
        lengthUnit: m.lengthUnit || 'ft',
        singleUnit: !!m.singleUnit,
        customDataTypes: Array.isArray(m.customDataTypes)
          ? m.customDataTypes
          : Array.isArray(m.dataTypes)
            ? m.dataTypes.filter((dt: DataType) => dt.code !== 'wte')
            : [],
        dataFiles: Array.isArray(m.dataFiles) ? m.dataFiles : [],
      }));
    }
  } catch (e) {
    console.warn('Could not load regions from API:', e);
  }
  return [];
}


// Load aquifers for a region from aquifers.geojson
// GeoJSON should have standardized properties: aquifer_id, aquifer_name
export async function loadAquifers(regionId: string, regionPath: string, wells: Well[]): Promise<Aquifer[]> {
  const aquifers: Aquifer[] = [];

  // Get unique aquifers from well data (fallback)
  const wellAquifers = new Map<string, string>();
  for (const well of wells) {
    if (well.aquiferId && !wellAquifers.has(well.aquiferId)) {
      wellAquifers.set(well.aquiferId, well.aquiferName);
    }
  }

  try {
    const response = await freshFetch(`${regionPath}/aquifers.geojson`);
    if (response.ok) {
      const geojson = await response.json();
      const featureCollection = geojson.type === 'FeatureCollection'
        ? geojson
        : { type: 'FeatureCollection', features: [geojson] };

      // Group features by aquifer_id
      const aquiferMap = new Map<string, { features: any[]; name: string }>();
      for (const feature of featureCollection.features) {
        const props = feature.properties || {};
        const id = String(props.aquifer_id || 'unknown');
        const name = props.aquifer_name || `Aquifer ${id}`;

        if (!aquiferMap.has(id)) {
          aquiferMap.set(id, { features: [], name });
        }
        aquiferMap.get(id)!.features.push(feature);
      }

      // Create aquifer entries
      for (const [id, data] of aquiferMap) {
        const aquiferGeojson = { type: 'FeatureCollection', features: data.features };
        const bounds = calculateBounds(aquiferGeojson);

        // Check for stored label_point in geojson properties, otherwise compute
        let labelPoint: [number, number] | null = null;
        for (const f of data.features) {
          const lp = f.properties?.label_point;
          if (Array.isArray(lp) && lp.length === 2) {
            labelPoint = [lp[0], lp[1]]; // [lat, lng]
            break;
          }
        }
        if (!labelPoint) {
          labelPoint = computeLabelPoint(aquiferGeojson, bounds);
          // Store back into the first feature for future use
          if (data.features.length > 0) {
            if (!data.features[0].properties) data.features[0].properties = {};
            data.features[0].properties.label_point = labelPoint;
          }
        }

        aquifers.push({
          id,
          name: data.name,
          regionId,
          geojson: aquiferGeojson,
          bounds,
          labelPoint
        });
      }
    }

    // If no geometry loaded, create aquifers from well data
    if (aquifers.length === 0 && wellAquifers.size > 0) {
      for (const [id, name] of wellAquifers) {
        const aquiferWells = wells.filter(w => w.aquiferId === id);
        if (aquiferWells.length > 0) {
          const lats = aquiferWells.map(w => w.lat);
          const lngs = aquiferWells.map(w => w.lng);
          const bounds: [number, number, number, number] = [
            Math.min(...lats) - 0.1,
            Math.min(...lngs) - 0.1,
            Math.max(...lats) + 0.1,
            Math.max(...lngs) + 0.1
          ];

          aquifers.push({
            id,
            name,
            regionId,
            geojson: { type: 'FeatureCollection', features: [] },
            bounds,
            labelPoint: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
          });
        }
      }
    }
  } catch (e) {
    console.warn(`Error loading aquifers for ${regionId}:`, e);
  }

  return aquifers;
}

// Load wells from CSV
export async function loadWells(regionPath: string, regionId: string): Promise<Well[]> {
  const wells: Well[] = [];

  try {
    const response = await freshFetch(`${regionPath}/wells.csv`);
    if (!response.ok) return wells;

    const text = await response.text();
    const rows = parseCSV(text);

    for (const row of rows) {
      // Standard column names: well_id, long, lat, aquifer_id
      const wellId = row['well_id'] || '';
      const wellName = row['well_name'] || wellId;
      const lat = parseFloat(row['lat'] || '0');
      const lng = parseFloat(row['long'] || '0');
      const gse = parseFloat(row['gse'] || '0');
      const aquiferId = row['aquifer_id'] || '';
      const aquiferName = row['aquifer_name'] || '';

      if (wellId && !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        wells.push({
          id: wellId,
          name: wellName,
          lat,
          lng,
          gse,
          aquiferId,
          aquiferName,
          regionId
        });
      }
    }
  } catch (e) {
    console.warn(`Error loading wells for ${regionId}:`, e);
  }

  return wells;
}

// Load measurements from data_{code}.csv files for each data type
export async function loadMeasurements(regionPath: string, regionId: string, dataTypes: { code: string; name: string; unit: string }[]): Promise<Measurement[]> {
  const measurements: Measurement[] = [];

  for (const dt of dataTypes) {
    try {
      const response = await freshFetch(`${regionPath}/data_${dt.code}.csv`);
      if (!response.ok) continue;

      const text = await response.text();
      const rows = parseCSV(text);

      for (const row of rows) {
        const wellId = row['well_id'] || '';
        const wellName = row['well_name'] || '';
        const date = row['date'] || '';
        // A blank value cell is a missing measurement, not a measurement of 0
        const rawValue = (row['value'] || '').trim();
        const value = rawValue ? parseFloat(rawValue) : NaN;
        const aquiferId = row['aquifer_id'] || '';

        if (wellId && date && !isNaN(value)) {
          measurements.push({
            wellId,
            wellName,
            date,
            value,
            dataType: dt.code,
            aquiferId,
            regionId
          });
        }
      }
    } catch (e) {
      console.warn(`Error loading ${dt.code} measurements for ${regionId}:`, e);
    }
  }

  return measurements;
}

// Load all data
// Each region folder should contain: region.json, region.geojson, aquifers.geojson, wells.csv, data_*.csv
export async function loadAllData(): Promise<{
  regions: Region[];
  aquifers: Aquifer[];
  wells: Well[];
  measurements: Measurement[];
  storageMeta: RasterAnalysisMeta[];
  modelMeta: ImputationModelMeta[];
}> {
  const regionMetas = await loadRegionManifest();

  // Load the catalog so we can compute each region's effective type list
  let catalog = null;
  try {
    catalog = await loadCatalog();
  } catch (e) {
    console.warn('Could not load parameter catalog:', e);
  }

  const regions: Region[] = [];
  const allAquifers: Aquifer[] = [];
  const allWells: Well[] = [];
  const allMeasurements: Measurement[] = [];
  const allStorageMeta: RasterAnalysisMeta[] = [];
  const allModelMeta: ImputationModelMeta[] = [];

  for (const meta of regionMetas) {
    const folderPath = `/data/${meta.id}`;
    const effectiveDataTypes = computeEffectiveDataTypes(meta, catalog);

    // Load region boundary from region.geojson
    try {
      const response = await freshFetch(`${folderPath}/region.geojson`);
      if (response.ok) {
        const geojson = await response.json();
        const bounds = calculateBounds(geojson);
        regions.push({
          id: meta.id,
          name: meta.name,
          lengthUnit: meta.lengthUnit || 'ft',
          singleUnit: meta.singleUnit || false,
          customDataTypes: meta.customDataTypes || [],
          effectiveDataTypes,
          geojson: geojson.type === 'FeatureCollection' ? geojson : { type: 'FeatureCollection', features: [geojson] },
          bounds
        });
      }
    } catch (e) {
      console.warn(`Error loading region ${meta.name}:`, e);
    }

    // Load wells
    const wells = await loadWells(folderPath, meta.id);
    for (const w of wells) allWells.push(w);

    // Load aquifers
    const aquifers = await loadAquifers(meta.id, folderPath, wells);
    for (const a of aquifers) allAquifers.push(a);

    // Load measurements from all effective data type CSVs
    const measurements = await loadMeasurements(folderPath, meta.id, effectiveDataTypes);
    for (const m of measurements) allMeasurements.push(m);

    // Load storage analysis metadata
    try {
      const storageRes = await freshFetch(`/api/list-rasters?region=${encodeURIComponent(meta.id)}`);
      if (storageRes.ok) {
        const items: RasterAnalysisMeta[] = await storageRes.json();
        for (const item of items) allStorageMeta.push(item);
      }
    } catch (e) {
      console.warn(`Error loading storage metadata for ${meta.id}:`, e);
    }

    // Load imputation model metadata
    try {
      const modelRes = await freshFetch(`/api/list-models?region=${encodeURIComponent(meta.id)}`);
      if (modelRes.ok) {
        const items: ImputationModelMeta[] = await modelRes.json();
        for (const item of items) allModelMeta.push(item);
      }
    } catch (e) {
      console.warn(`Error loading model metadata for ${meta.id}:`, e);
    }
  }

  return {
    regions,
    aquifers: allAquifers,
    wells: allWells,
    measurements: allMeasurements,
    storageMeta: allStorageMeta,
    modelMeta: allModelMeta,
  };
}
