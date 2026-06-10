import React, { useState, useEffect, useMemo } from 'react';
import { X, CheckCircle2, Loader2, AlertTriangle, Download, Upload, RefreshCw } from 'lucide-react';
import { processUploadedFile, UploadedFile, saveFiles, deleteFile, isInUS, assignWellToAquifer, parseCSV, toCsv, WELLS_CSV_HEADERS, freshFetch } from '../../services/importUtils';
import { fetchUSGSWells, getUSGSApiKey, setUSGSApiKey } from '../../services/usgsApi';
import { fetchGseBatch } from '../../services/gseLookup';
import { compareNames } from '../../utils/strings';
import { SampleCoord } from '../../services/reprojection';
import { useCrsPicker } from '../../hooks/useCrsPicker';
import CrsPickerPanel from './CrsPickerPanel';
import ColumnMapperModal from './ColumnMapperModal';
import ConfirmDialog from './ConfirmDialog';

interface WellImporterProps {
  regionId: string;
  regionName: string;
  lengthUnit: 'ft' | 'm';
  singleUnit: boolean;
  regionBounds: [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]
  aquiferCount: number;
  existingWellCount: number;
  onComplete: () => void;
  onClose: () => void;
}

type ImportMode = 'append' | 'replace';
type DataSource = 'upload' | 'usgs';
type AquiferAssignment = 'single' | 'csv-field' | 'by-location';

const WellImporter: React.FC<WellImporterProps> = ({
  regionId, regionName, lengthUnit, singleUnit, regionBounds, aquiferCount, existingWellCount, onComplete, onClose
}) => {
  const [dataSource, setDataSource] = useState<DataSource>('upload');
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [showMapper, setShowMapper] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>(existingWellCount > 0 ? 'append' : 'replace');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);

  // Aquifer assignment
  const [aquiferAssignment, setAquiferAssignment] = useState<AquiferAssignment>(
    singleUnit ? 'single' : 'csv-field'
  );
  const [selectedAquiferId, setSelectedAquiferId] = useState('');
  const [aquiferList, setAquiferList] = useState<{ id: string; name: string }[]>([]);
  const [aquifersGeojson, setAquifersGeojson] = useState<any>(null);

  // GSE interpolation
  const [gseValues, setGseValues] = useState<Map<string, number>>(new Map());
  const [gseInterpolated, setGseInterpolated] = useState(false);
  const [gseProgress, setGseProgress] = useState({ current: 0, total: 0 });
  const [gseSource, setGseSource] = useState('');
  const [gseIsRunning, setGseIsRunning] = useState(false);

  // USGS download
  const [usgsWells, setUsgsWells] = useState<any[] | null>(null);
  const [usgsProgress, setUsgsProgress] = useState({ count: 0, done: false });
  const [usgsIsLoading, setUsgsIsLoading] = useState(false);

  // USGS scope
  const [usgsScope, setUsgsScope] = useState<'region' | 'aquifer'>('region');
  const [usgsScopeAquiferId, setUsgsScopeAquiferId] = useState('');
  const [apiKey, setApiKey] = useState(getUSGSApiKey());

  // Per-aquifer well counts for scope-aware import mode
  const [wellCountsByAquifer, setWellCountsByAquifer] = useState<Record<string, number>>({});

  // USGS well refresh
  const [existingUsgsIds, setExistingUsgsIds] = useState<Set<string>>(new Set());
  const [hasExistingUsgsWells, setHasExistingUsgsWells] = useState(false);
  const [refreshSummary, setRefreshSummary] = useState<{ newCount: number; existingCount: number } | null>(null);
  const [usgsRefreshLoading, setUsgsRefreshLoading] = useState(false);

  // Check if region overlaps US for USGS option
  const regionOverlapsUS = isInUS(
    (regionBounds[0] + regionBounds[2]) / 2,
    (regionBounds[1] + regionBounds[3]) / 2
  );

  // Sample coordinates for CRS picker preview / auto-detect. Pull up to 5
  // parseable (x, y) pairs from the mapped lat/long columns.
  const crsSamples = useMemo<SampleCoord[]>(() => {
    if (!file) return [];
    const latCol = file.mapping['lat'];
    const longCol = file.mapping['long'];
    if (!latCol || !longCol) return [];
    const out: SampleCoord[] = [];
    for (const r of file.data as Record<string, string>[]) {
      const x = parseFloat(r[longCol]);
      const y = parseFloat(r[latCol]);
      if (!isNaN(x) && !isNaN(y)) out.push({ x, y });
      if (out.length >= 5) break;
    }
    return out;
  }, [file?.mapping, file?.data]);

  const crs = useCrsPicker({ regionBounds, samples: crsSamples });
  const { parseRowCoords } = crs;

  // Load existing USGS well IDs for refresh feature
  useEffect(() => {
    (async () => {
      try {
        const res = await freshFetch(`/data/${regionId}/wells.csv`);
        if (res.ok) {
          const text = await res.text();
          const { rows } = parseCSV(text);
          const usgsIds = new Set<string>();
          for (const r of rows) {
            const id = r.well_id;
            if (!id) continue;
            if (id.startsWith('USGS-')) {
              usgsIds.add(id);
            } else if (/^\d{8,15}$/.test(id)) {
              // Bare numeric USGS site IDs — store with prefix so refresh dedup works
              usgsIds.add(`USGS-${id}`);
            }
          }
          setExistingUsgsIds(usgsIds);
          setHasExistingUsgsWells(usgsIds.size > 0);
          // Build per-aquifer well counts
          const counts: Record<string, number> = {};
          for (const r of rows) {
            if (r.aquifer_id) counts[r.aquifer_id] = (counts[r.aquifer_id] || 0) + 1;
          }
          setWellCountsByAquifer(counts);
        }
      } catch {}
    })();
  }, [regionId]);

  // Load aquifer list for assignment
  useEffect(() => {
    if (singleUnit) return;
    (async () => {
      try {
        const res = await freshFetch(`/data/${regionId}/aquifers.geojson`);
        if (res.ok) {
          const gj = await res.json();
          setAquifersGeojson(gj);
          const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
          const list = features.map((f: any) => ({
            id: String(f.properties?.aquifer_id || ''),
            name: f.properties?.aquifer_name || ''
          }));
          list.sort((a: { id: string; name: string }, b: { id: string; name: string }) =>
            compareNames(a.name || a.id, b.name || b.id));
          setAquiferList(list);
          if (list.length === 1) {
            setAquiferAssignment('single');
            setSelectedAquiferId(list[0].id);
          }
        }
      } catch {}
    })();
  }, [regionId, singleUnit]);

  // Effective well count based on scope (for import mode visibility)
  const effectiveExistingCount = dataSource === 'usgs' && usgsScope === 'aquifer' && usgsScopeAquiferId
    ? (wellCountsByAquifer[usgsScopeAquiferId] || 0)
    : existingWellCount;

  const fieldDefs = [
    { key: 'well_id', label: 'Well ID', required: true },
    { key: 'well_name', label: 'Well Name', required: false },
    { key: 'lat', label: 'Latitude', required: true },
    { key: 'long', label: 'Longitude', required: true },
    { key: 'gse', label: 'Ground Surface Elevation', required: false },
    ...(!singleUnit && aquiferAssignment === 'csv-field'
      ? [{ key: 'aquifer_id', label: 'Aquifer ID', required: false }] : []),
  ];

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const uploaded = await processUploadedFile(f, 'wells');
      setFile(uploaded);
      setShowMapper(true);
      setGseValues(new Map());
      setGseInterpolated(false);
      setUsgsWells(null);
    } catch (err) {
      setError(`Failed to process: ${err}`);
    }
  };

  const updateMapping = (key: string, value: string) => {
    if (!file) return;
    setFile({ ...file, mapping: { ...file.mapping, [key]: value } });
  };

  // Compute bounding box from aquifer geojson features
  const computeGeojsonBounds = (geojson: any, aquiferId?: string): [number, number, number, number] | null => {
    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    const targets = aquiferId
      ? features.filter((f: any) => String(f.properties?.aquifer_id) === aquiferId)
      : features;
    if (targets.length === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    const walk = (coords: any) => {
      if (typeof coords[0] === 'number') {
        minLng = Math.min(minLng, coords[0]); maxLng = Math.max(maxLng, coords[0]);
        minLat = Math.min(minLat, coords[1]); maxLat = Math.max(maxLat, coords[1]);
      } else {
        for (const c of coords) walk(c);
      }
    };
    for (const f of targets) walk(f.geometry.coordinates);
    return [minLat, minLng, maxLat, maxLng];
  };

  // USGS well download
  const handleUSGSDownload = async () => {
    setUsgsIsLoading(true);
    setError('');
    setUsgsProgress({ count: 0, done: false });
    try {
      // Compute bbox based on scope
      let bounds: [number, number, number, number] | null = null;
      if (aquifersGeojson) {
        bounds = usgsScope === 'aquifer'
          ? computeGeojsonBounds(aquifersGeojson, usgsScopeAquiferId)
          : computeGeojsonBounds(aquifersGeojson);
      }
      if (!bounds) bounds = regionBounds;

      // Convert bounds to USGS bbox format: [minLng, minLat, maxLng, maxLat]
      const bbox: [number, number, number, number] = [
        bounds[1], bounds[0], bounds[3], bounds[2]
      ];
      const wells = await fetchUSGSWells(bbox, (count) => {
        setUsgsProgress({ count, done: false });
      });

      // Filter to aquifer boundaries and capture aquifer_id via point-in-polygon
      let wellsWithAquifer: { well: typeof wells[0]; aquiferId: string }[];
      if (aquifersGeojson) {
        wellsWithAquifer = [];
        if (usgsScope === 'aquifer') {
          // Only match to the selected aquifer
          const features = aquifersGeojson.type === 'FeatureCollection' ? aquifersGeojson.features : [aquifersGeojson];
          const targetFeature = features.find((f: any) => String(f.properties?.aquifer_id) === usgsScopeAquiferId);
          if (targetFeature) {
            const scopedGj = { type: 'FeatureCollection', features: [targetFeature] };
            for (const w of wells) {
              const aqId = assignWellToAquifer(w.lat, w.lng, scopedGj);
              if (aqId !== null) wellsWithAquifer.push({ well: w, aquiferId: aqId });
            }
          }
        } else {
          for (const w of wells) {
            const aqId = assignWellToAquifer(w.lat, w.lng, aquifersGeojson);
            if (aqId !== null) wellsWithAquifer.push({ well: w, aquiferId: aqId });
          }
        }
      } else {
        wellsWithAquifer = wells.map(w => ({ well: w, aquiferId: singleUnit ? '0' : '' }));
      }

      setUsgsWells(wellsWithAquifer.map(x => x.well));
      setUsgsProgress({ count: wellsWithAquifer.length, done: true });

      // Convert to UploadedFile format for the save flow
      const rows = wellsWithAquifer.map(({ well: w, aquiferId }) => ({
        well_id: w.siteId,
        well_name: w.siteName,
        lat: String(w.lat),
        long: String(w.lng),
        gse: w.gse ? String(lengthUnit === 'ft' ? Math.round(w.gse * 3.28084 * 100) / 100 : Math.round(w.gse * 100) / 100) : '',
        aquifer_id: aquiferId,
      }));
      const columns = ['well_id', 'well_name', 'lat', 'long', 'gse', 'aquifer_id'];
      setFile({
        name: 'USGS Wells',
        data: rows,
        columns,
        mapping: { well_id: 'well_id', well_name: 'well_name', lat: 'lat', long: 'long', gse: 'gse', aquifer_id: 'aquifer_id' },
        type: 'csv'
      });
    } catch (err) {
      setError(`USGS download failed: ${err}`);
    }
    setUsgsIsLoading(false);
  };

  // USGS well refresh — diff against existing wells, show only new ones
  const handleUSGSRefresh = async () => {
    setUsgsRefreshLoading(true);
    setError('');
    setRefreshSummary(null);
    try {
      // Compute bbox based on scope
      let bounds: [number, number, number, number] | null = null;
      if (aquifersGeojson) {
        bounds = usgsScope === 'aquifer'
          ? computeGeojsonBounds(aquifersGeojson, usgsScopeAquiferId)
          : computeGeojsonBounds(aquifersGeojson);
      }
      if (!bounds) bounds = regionBounds;

      const bbox: [number, number, number, number] = [
        bounds[1], bounds[0], bounds[3], bounds[2]
      ];
      const wells = await fetchUSGSWells(bbox, (count) => {
        setUsgsProgress({ count, done: false });
      });

      // Filter to aquifer boundaries and capture aquifer_id
      let wellsWithAquifer: { well: typeof wells[0]; aquiferId: string }[];
      if (aquifersGeojson) {
        wellsWithAquifer = [];
        if (usgsScope === 'aquifer') {
          const features = aquifersGeojson.type === 'FeatureCollection' ? aquifersGeojson.features : [aquifersGeojson];
          const targetFeature = features.find((f: any) => String(f.properties?.aquifer_id) === usgsScopeAquiferId);
          if (targetFeature) {
            const scopedGj = { type: 'FeatureCollection', features: [targetFeature] };
            for (const w of wells) {
              const aqId = assignWellToAquifer(w.lat, w.lng, scopedGj);
              if (aqId !== null) wellsWithAquifer.push({ well: w, aquiferId: aqId });
            }
          }
        } else {
          for (const w of wells) {
            const aqId = assignWellToAquifer(w.lat, w.lng, aquifersGeojson);
            if (aqId !== null) wellsWithAquifer.push({ well: w, aquiferId: aqId });
          }
        }
      } else {
        wellsWithAquifer = wells.map(w => ({ well: w, aquiferId: singleUnit ? '0' : '' }));
      }

      // Diff against existing USGS wells
      const newWells = wellsWithAquifer.filter(x => !existingUsgsIds.has(x.well.siteId));
      const existingCount = wellsWithAquifer.length - newWells.length;

      setRefreshSummary({ newCount: newWells.length, existingCount });
      setUsgsProgress({ count: wellsWithAquifer.length, done: true });

      if (newWells.length > 0) {
        // Populate file with only new wells, force append
        const rows = newWells.map(({ well: w, aquiferId }) => ({
          well_id: w.siteId,
          well_name: w.siteName,
          lat: String(w.lat),
          long: String(w.lng),
          gse: w.gse ? String(lengthUnit === 'ft' ? Math.round(w.gse * 3.28084 * 100) / 100 : Math.round(w.gse * 100) / 100) : '',
          aquifer_id: aquiferId,
        }));
        const columns = ['well_id', 'well_name', 'lat', 'long', 'gse', 'aquifer_id'];
        setFile({
          name: 'USGS Wells (New)',
          data: rows,
          columns,
          mapping: { well_id: 'well_id', well_name: 'well_name', lat: 'lat', long: 'long', gse: 'gse', aquifer_id: 'aquifer_id' },
          type: 'csv'
        });
        setImportMode('append');
      } else {
        setFile(null);
      }
    } catch (err) {
      setError(`USGS refresh failed: ${err}`);
    }
    setUsgsRefreshLoading(false);
  };

  const needsGseInterpolation = file !== null && !file.mapping['gse'] && dataSource === 'upload';

  const interpolateGSE = async () => {
    if (!file) return;
    setGseIsRunning(true);
    setGseValues(new Map());

    const wellIdCol = file.mapping['well_id'];
    const latCol = file.mapping['lat'];
    const longCol = file.mapping['long'];
    // Reproject via the selected CRS so elevation queries land at real
    // lat/lng, not raw easting/northing values.
    const wells = (file.data as Record<string, string>[])
      .map(w => {
        const { lat, lng } = parseRowCoords(w[latCol], w[longCol]);
        return { id: w[wellIdCol], lat, lng };
      })
      .filter((w): w is { id: string; lat: number; lng: number } =>
        !!w.id && w.lat !== undefined && w.lng !== undefined
      );

    setGseProgress({ current: 0, total: wells.length });
    const allInUS = wells.every(w => isInUS(w.lat, w.lng));
    setGseSource(allInUS ? 'USGS 3DEP (~10m resolution)' : 'Open-Meteo Copernicus DEM (~90m resolution)');

    try {
      const { values } = await fetchGseBatch(wells, {
        lengthUnit,
        onProgress: (current, total) => setGseProgress({ current, total }),
      });
      setGseValues(values);
      setGseInterpolated(true);
    } catch (err) {
      setError(`GSE interpolation failed: ${err}`);
    } finally {
      setGseIsRunning(false);
    }
  };

  const resolveAquiferId = (row: Record<string, string>): string => {
    if (singleUnit) return '0';
    switch (aquiferAssignment) {
      case 'single':
        return selectedAquiferId;
      case 'csv-field': {
        const col = file?.mapping['aquifer_id'];
        return col ? row[col] || '' : '';
      }
      case 'by-location': {
        const latCol = file?.mapping['lat'] || '';
        const longCol = file?.mapping['long'] || '';
        const { lat, lng } = parseRowCoords(row[latCol], row[longCol]);
        if (lat !== undefined && lng !== undefined && aquifersGeojson) {
          return assignWellToAquifer(lat, lng, aquifersGeojson) || '';
        }
        return '';
      }
      default: return '';
    }
  };

  const doSave = async () => {
    if (!file) return;
    setIsSaving(true);
    setError('');
    try {
      const rows = file.data as Record<string, string>[];
      const wellIdCol = file.mapping['well_id'];
      const wellNameCol = file.mapping['well_name'];
      const latCol = file.mapping['lat'];
      const longCol = file.mapping['long'];
      const gseCol = file.mapping['gse'];

      // Reproject lat/long through the selected CRS so the CSV always
      // stores WGS84 values, even when the user's source data was in a
      // projected coordinate system (e.g. JAD2001 Jamaica Metric Grid).
      const aquiferNameById = new Map<string, string>(aquiferList.map(a => [a.id, String(a.name || '')]));
      const processedWells = rows.map(w => {
        const { lat, lng } = parseRowCoords(w[latCol], w[longCol]);
        const aquiferId = resolveAquiferId(w);
        return {
          well_id: w[wellIdCol] || '',
          well_name: wellNameCol ? w[wellNameCol] || '' : '',
          lat: lat !== undefined ? String(lat) : '',
          long: lng !== undefined ? String(lng) : '',
          gse: gseCol ? w[gseCol] || '' : (gseValues.get(w[wellIdCol])?.toString() ?? ''),
          aquifer_id: aquiferId,
          aquifer_name: aquiferNameById.get(aquiferId) || '',
        };
      }).filter(w => w.well_id && w.lat && w.long);

      const isAquiferScoped = dataSource === 'usgs' && usgsScope === 'aquifer' && usgsScopeAquiferId;

      if (isAquiferScoped) {
        // Aquifer-scoped: always merge with other aquifers' wells
        let existingRows: Record<string, string>[] = [];
        try {
          const res = await freshFetch(`/data/${regionId}/wells.csv`);
          if (res.ok) {
            existingRows = parseCSV((await res.text())).rows;
          }
        } catch {}

        let keptExisting: Record<string, string>[];
        if (importMode === 'replace') {
          // Remove wells from selected aquifer, keep everything else
          keptExisting = existingRows.filter(r => r.aquifer_id !== usgsScopeAquiferId);
        } else {
          // Append: keep all existing, skip duplicates
          keptExisting = existingRows;
        }

        const existingIds = new Set(keptExisting.map(r => r.well_id));
        const toAdd = processedWells.filter(w => !existingIds.has(w.well_id));

        const csv = toCsv(WELLS_CSV_HEADERS, [...keptExisting, ...toAdd]);
        await saveFiles([{ path: `${regionId}/wells.csv`, content: csv }]);
      } else if (importMode === 'append' && existingWellCount > 0) {
        // Load existing wells, skip duplicates
        let existingRows: Record<string, string>[] = [];
        try {
          const res = await freshFetch(`/data/${regionId}/wells.csv`);
          if (res.ok) {
            existingRows = parseCSV((await res.text())).rows;
          }
        } catch {}

        const existingIds = new Set(existingRows.map(r => r.well_id));
        const toAdd = processedWells.filter(w => !existingIds.has(w.well_id));

        // Merge: keep existing + add new
        const csv = toCsv(WELLS_CSV_HEADERS, [...existingRows, ...toAdd]);
        await saveFiles([{ path: `${regionId}/wells.csv`, content: csv }]);
      } else {
        // Region-wide replace: delete measurements then write
        if (importMode === 'replace' && existingWellCount > 0) {
          try {
            const regionsRes = await fetch('/api/regions');
            if (regionsRes.ok) {
              const all: any[] = await regionsRes.json();
              const me = all.find((r: any) => r.id === regionId);
              const dataFiles: string[] = Array.isArray(me?.dataFiles) ? me.dataFiles : [];
              for (const f of dataFiles) {
                try { await deleteFile(`${regionId}/${f}`); } catch {}
              }
            }
          } catch {}
        }

        const csv = toCsv(WELLS_CSV_HEADERS, processedWells);
        await saveFiles([{ path: `${regionId}/wells.csv`, content: csv }]);
      }
      onComplete();
    } catch (err) {
      setError(`Failed to save: ${err}`);
    }
    setIsSaving(false);
  };

  const handleSave = () => {
    if (importMode === 'replace' && effectiveExistingCount > 0) {
      setShowReplaceConfirm(true);
    } else {
      doSave();
    }
  };

  const isReady = file && file.mapping['well_id'] && file.mapping['lat'] && file.mapping['long'] &&
    (!needsGseInterpolation || gseInterpolated) &&
    (singleUnit || aquiferAssignment !== 'single' || selectedAquiferId);

  return (
    <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Add Wells</h2>
            <p className="text-sm text-slate-500">{regionName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        {/* Data source selector */}
        {regionOverlapsUS && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Data Source</label>
            <div className="flex gap-2">
              <button
                onClick={() => { setDataSource('upload'); setFile(null); setUsgsWells(null); }}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  dataSource === 'upload' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                <Upload size={14} /> Upload CSV
              </button>
              <button
                onClick={() => { setDataSource('usgs'); setFile(null); }}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  dataSource === 'usgs' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                <Download size={14} /> USGS Download
              </button>
            </div>
          </div>
        )}

        {/* Import mode */}
        {effectiveExistingCount > 0 && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Import Mode</label>
            <div className="flex gap-2">
              <button
                onClick={() => setImportMode('append')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  importMode === 'append' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Append
              </button>
              <button
                onClick={() => setImportMode('replace')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  importMode === 'replace' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {usgsScope === 'aquifer' && usgsScopeAquiferId ? 'Replace Aquifer' : 'Replace All'}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {importMode === 'append'
                ? 'New wells will be added. Duplicates (by ID) are skipped.'
                : usgsScope === 'aquifer' && usgsScopeAquiferId
                  ? 'Existing wells in this aquifer will be replaced. Other aquifers are not affected.'
                  : 'All existing wells and measurements will be deleted first.'}
            </p>
            {importMode === 'replace' && !(usgsScope === 'aquifer' && usgsScopeAquiferId) && (
              <div className="flex items-start gap-2 mt-2 p-2 bg-red-50 border border-red-200 rounded-lg">
                <AlertTriangle size={14} className="text-red-500 mt-0.5 shrink-0" />
                <p className="text-xs text-red-700">This will also delete all measurement data for this region.</p>
              </div>
            )}
          </div>
        )}

        {/* Aquifer assignment (not for singleUnit) */}
        {!singleUnit && aquiferList.length > 0 && dataSource === 'upload' && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Aquifer Assignment</label>
            <div className="space-y-2">
              {aquiferList.length === 1 ? (
                <div className="text-sm text-slate-600 p-2 bg-slate-50 rounded-lg">
                  All wells assigned to: <span className="font-medium">{aquiferList[0].name || aquiferList[0].id}</span>
                </div>
              ) : (
                <>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="aq-assign" checked={aquiferAssignment === 'csv-field'}
                      onChange={() => setAquiferAssignment('csv-field')} className="text-blue-600" />
                    <span className="text-sm text-slate-700">Use aquifer_id column from CSV</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="aq-assign" checked={aquiferAssignment === 'single'}
                      onChange={() => setAquiferAssignment('single')} className="text-blue-600" />
                    <span className="text-sm text-slate-700">Assign all to one aquifer</span>
                  </label>
                  {aquiferAssignment === 'single' && (
                    <select value={selectedAquiferId} onChange={e => setSelectedAquiferId(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm ml-6">
                      <option value="">-- Select Aquifer --</option>
                      {aquiferList.map(a => (
                        <option key={a.id} value={a.id}>{a.name || a.id}</option>
                      ))}
                    </select>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="aq-assign" checked={aquiferAssignment === 'by-location'}
                      onChange={() => setAquiferAssignment('by-location')} className="text-blue-600" />
                    <span className="text-sm text-slate-700">Assign by well location (point-in-polygon)</span>
                  </label>
                </>
              )}
            </div>
          </div>
        )}

        {/* Upload flow */}
        {dataSource === 'upload' && (
          <>
            <p className="text-sm text-slate-500 mb-4">Upload a CSV file with well locations.</p>
            <label className="block mb-4">
              <input type="file" accept=".csv,.txt" onChange={handleUpload}
                className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
            </label>
          </>
        )}

        {/* USGS download flow */}
        {dataSource === 'usgs' && !file && (
          <div className="mb-4">
            <p className="text-sm text-slate-500 mb-3">
              Download groundwater monitoring wells from USGS within this region's bounding box.
            </p>
            {/* Scope selector — only when multiple aquifers */}
            {aquiferList.length > 1 && (
              <div className="mb-3">
                <label className="block text-sm font-medium text-slate-700 mb-2">Download Scope</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="usgs-scope" checked={usgsScope === 'region'}
                      onChange={() => { setUsgsScope('region'); setUsgsScopeAquiferId(''); }}
                      className="text-blue-600" />
                    <span className="text-sm text-slate-700">Entire Region</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="usgs-scope" checked={usgsScope === 'aquifer'}
                      onChange={() => setUsgsScope('aquifer')}
                      className="text-blue-600" />
                    <span className="text-sm text-slate-700">Selected Aquifer</span>
                  </label>
                  {usgsScope === 'aquifer' && (
                    <select value={usgsScopeAquiferId} onChange={e => setUsgsScopeAquiferId(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm ml-6">
                      <option value="">-- Select Aquifer --</option>
                      {aquiferList.map(a => (
                        <option key={a.id} value={a.id}>{a.name || a.id}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}
            {/* API key */}
            <div className="mb-3">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                API Key {!apiKey && <span className="text-amber-600 font-normal">(required for bulk downloads)</span>}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  onBlur={() => setUSGSApiKey(apiKey)}
                  placeholder="Paste your api.data.gov key"
                  className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-mono"
                />
              </div>
              {!apiKey && (
                <p className="text-xs text-slate-400 mt-1">
                  Without a key: 30 req/hour. With a key: 1,000 req/hour.{' '}
                  <a href="https://api.waterdata.usgs.gov/signup/" target="_blank" rel="noopener noreferrer"
                    className="text-blue-600 underline hover:text-blue-700">Get a free key</a>
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleUSGSDownload}
                disabled={usgsIsLoading || usgsRefreshLoading || (usgsScope === 'aquifer' && !usgsScopeAquiferId)}
                className={`${hasExistingUsgsWells ? 'flex-1' : 'w-full'} px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2`}
              >
                {usgsIsLoading ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Downloading... ({usgsProgress.count} found)
                  </>
                ) : (
                  <>
                    <Download size={14} /> Download All
                  </>
                )}
              </button>
              {hasExistingUsgsWells && (
                <button
                  onClick={handleUSGSRefresh}
                  disabled={usgsIsLoading || usgsRefreshLoading || (usgsScope === 'aquifer' && !usgsScopeAquiferId)}
                  className="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {usgsRefreshLoading ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Checking... ({usgsProgress.count} found)
                    </>
                  ) : (
                    <>
                      <RefreshCw size={14} /> Refresh
                    </>
                  )}
                </button>
              )}
            </div>
            {refreshSummary && (
              <div className={`mt-3 p-3 rounded-lg text-sm ${refreshSummary.newCount > 0 ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-slate-50 border border-slate-200 text-slate-700'}`}>
                {refreshSummary.newCount > 0
                  ? `Found ${refreshSummary.newCount} new well(s) (${refreshSummary.existingCount} already existed)`
                  : `Your wells are up to date (${refreshSummary.existingCount} wells checked)`}
              </div>
            )}
          </div>
        )}

        {/* File / USGS result display */}
        {file && (
          <div className="mb-4">
            <div className="flex items-center gap-2 text-sm text-green-700 mb-2">
              <CheckCircle2 size={16} />
              {dataSource === 'usgs'
                ? `${(file.data as any[]).length} USGS wells loaded`
                : `${file.name} (${(file.data as any[]).length} rows)`}
            </div>
            {dataSource === 'upload' && (
              <button onClick={() => setShowMapper(true)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                Edit Column Mapping
              </button>
            )}
          </div>
        )}

        {/* Coordinate reference system — upload flow with mapped lat/long */}
        {file && dataSource === 'upload' && file.mapping['lat'] && file.mapping['long'] && (
          <div className="mb-4 p-4 bg-sky-50 border border-sky-200 rounded-lg">
            <CrsPickerPanel crs={crs} />
          </div>
        )}

        {/* GSE interpolation */}
        {needsGseInterpolation && file && (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg mb-4">
            <p className="text-sm text-amber-800 mb-3">
              No GSE column mapped. Ground Surface Elevation will be estimated from a DEM.
            </p>
            {gseSource && <p className="text-xs text-slate-600 mb-2">Source: {gseSource}</p>}
            {!gseIsRunning && !gseInterpolated && (
              <button onClick={interpolateGSE} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                Start GSE Interpolation
              </button>
            )}
            {gseIsRunning && (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Loader2 size={14} className="animate-spin" />
                Fetching: {gseProgress.current} / {gseProgress.total}
              </div>
            )}
            {gseInterpolated && (
              <div className="flex items-center gap-2 text-sm text-green-700">
                <CheckCircle2 size={16} /> GSE interpolated for {gseValues.size} wells
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={!isReady || isSaving}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving && <Loader2 size={14} className="animate-spin" />}
            {isSaving ? 'Saving...' : 'Save Wells'}
          </button>
        </div>
      </div>

      {showMapper && file && (
        <ColumnMapperModal
          file={file}
          fieldDefinitions={fieldDefs}
          onUpdateMapping={updateMapping}
          onClose={() => setShowMapper(false)}
          title="Map Well Columns"
        />
      )}

      {showReplaceConfirm && (
        <ConfirmDialog
          title={usgsScope === 'aquifer' && usgsScopeAquiferId ? 'Replace Aquifer Wells?' : 'Replace All Wells?'}
          message={usgsScope === 'aquifer' && usgsScopeAquiferId
            ? `This will replace ${effectiveExistingCount} well(s) in the selected aquifer. Wells in other aquifers are not affected.`
            : `This will delete all ${existingWellCount} existing well(s) and all measurement data. This cannot be undone.`}
          confirmLabel={usgsScope === 'aquifer' && usgsScopeAquiferId ? 'Replace Aquifer' : 'Replace All'}
          variant="danger"
          onConfirm={() => { setShowReplaceConfirm(false); doSave(); }}
          onCancel={() => setShowReplaceConfirm(false)}
        />
      )}
    </div>
  );
};

export default WellImporter;
