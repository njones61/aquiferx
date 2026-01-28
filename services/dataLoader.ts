import shp from 'shpjs';
import { Region, Aquifer, Well, Measurement } from '../types';

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

// Parse CSV text into rows
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];

  // Detect delimiter (comma or tab)
  const firstLine = lines[0];
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const headers = lines[0].split(delimiter).map(h => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter);
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

// Load all regions from data folders
export async function loadRegions(): Promise<Region[]> {
  const regions: Region[] = [];
  const folders: DataFolder[] = [
    { name: 'Oregon - Klamath Basin', path: '/data/oregon' },
    { name: 'Utah', path: '/data/utah' }
  ];

  for (const folder of folders) {
    try {
      const regionPath = `${folder.path}/region`;
      const regionFilename = folder.path.split('/').pop();

      // Try .geojson first (preferred)
      try {
        const response = await fetch(`${regionPath}/${regionFilename}.geojson`);
        if (response.ok) {
          const geojson = await response.json();
          const bounds = calculateBounds(geojson);
          regions.push({
            id: regionFilename || folder.name,
            name: folder.name,
            geojson: geojson.type === 'FeatureCollection' ? geojson : { type: 'FeatureCollection', features: [geojson] },
            bounds
          });
          continue;
        }
      } catch (e) {
        // GeoJSON not found, try shapefile
      }

      // Fallback to .shp
      try {
        const shpPath = `${regionPath}/${regionFilename}.shp`;
        const response = await fetch(shpPath);
        if (response.ok) {
          const geojson = await loadShapefile(shpPath);
          const bounds = calculateBounds(geojson);
          regions.push({
            id: regionFilename || folder.name,
            name: folder.name,
            geojson: geojson.type === 'FeatureCollection' ? geojson : { type: 'FeatureCollection', features: [geojson] },
            bounds
          });
        }
      } catch (e) {
        console.warn(`Could not load region for ${folder.name}`, e);
      }
    } catch (e) {
      console.warn(`Error loading region ${folder.name}:`, e);
    }
  }

  return regions;
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
    const response = await fetch(`${regionPath}/aquifers.geojson`);
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

        aquifers.push({
          id,
          name: data.name,
          regionId,
          geojson: aquiferGeojson,
          bounds
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
            bounds
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
    const response = await fetch(`${regionPath}/wells.csv`);
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

// Load water level measurements from CSV
export async function loadMeasurements(regionPath: string, regionId: string): Promise<Measurement[]> {
  const measurements: Measurement[] = [];

  try {
    const response = await fetch(`${regionPath}/water_levels.csv`);
    if (!response.ok) return measurements;

    const text = await response.text();
    const rows = parseCSV(text);

    for (const row of rows) {
      // Standard column names: well_id, date, wte, aquifer_id
      const wellId = row['well_id'] || '';
      const wellName = row['well_name'] || '';
      const date = row['date'] || '';
      const wte = parseFloat(row['wte'] || '0');
      const aquiferId = row['aquifer_id'] || '';

      if (wellId && date && !isNaN(wte)) {
        measurements.push({
          wellId,
          wellName,
          date,
          wte,
          aquiferId
        });
      }
    }
  } catch (e) {
    console.warn(`Error loading measurements for ${regionId}:`, e);
  }

  return measurements;
}

// Load region manifest
async function loadRegionManifest(): Promise<{ id: string; path: string; name: string }[]> {
  try {
    const response = await fetch('/data/regions.json');
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {
    console.warn('Could not load regions.json manifest:', e);
  }
  return [];
}

// Load all data
// Each region folder should contain: region.geojson, aquifers.geojson, wells.csv, water_levels.csv
export async function loadAllData(): Promise<{
  regions: Region[];
  aquifers: Aquifer[];
  wells: Well[];
  measurements: Measurement[];
}> {
  const regionFolders = await loadRegionManifest();

  const regions: Region[] = [];
  const allAquifers: Aquifer[] = [];
  const allWells: Well[] = [];
  const allMeasurements: Measurement[] = [];

  for (const folder of regionFolders) {
    // Load region boundary from region.geojson
    try {
      const response = await fetch(`${folder.path}/region.geojson`);
      if (response.ok) {
        const geojson = await response.json();
        const bounds = calculateBounds(geojson);
        regions.push({
          id: folder.id,
          name: folder.name,
          geojson: geojson.type === 'FeatureCollection' ? geojson : { type: 'FeatureCollection', features: [geojson] },
          bounds
        });
      }
    } catch (e) {
      console.warn(`Error loading region ${folder.name}:`, e);
    }

    // Load wells
    const wells = await loadWells(folder.path, folder.id);
    for (const w of wells) allWells.push(w);

    // Load aquifers
    const aquifers = await loadAquifers(folder.id, folder.path, wells);
    for (const a of aquifers) allAquifers.push(a);

    // Load measurements
    const measurements = await loadMeasurements(folder.path, folder.id);
    for (const m of measurements) allMeasurements.push(m);
  }

  return {
    regions,
    aquifers: allAquifers,
    wells: allWells,
    measurements: allMeasurements
  };
}
