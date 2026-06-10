import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, CheckCircle2, Loader2, AlertTriangle, Download, Upload, Calendar, MapPin, Wand2, BookOpen, FlaskConical } from 'lucide-react';
import { processUploadedFile, UploadedFile, saveFiles, parseDate, detectDateFormat, parseCSV, toCsv, WELLS_CSV_HEADERS, isInUS, freshFetch, assignWellToAquifer, DATE_FORMATS } from '../../services/importUtils';
import { fetchUSGSMeasurements, validateUSGSMeasurements, USGSDataQualityReport, USGSMeasurement, USGSDataSpan, computeDataSpan, filterByDateRange, getUSGSApiKey, setUSGSApiKey } from '../../services/usgsApi';
import { loadCatalog } from '../../services/catalog';
import { compareNames } from '../../utils/strings';
import CatalogBrowser from '../CatalogBrowser';
import WqpParameterPicker from '../WqpParameterPicker';
import {
  matchWells,
  summarizeMatches,
  generateAqxId,
  suggestDataTypesFromColumns,
  ExistingWell,
  MatchResult,
  MatchSummary,
} from '../../services/wellMatching';
import { fetchGseBatch } from '../../services/gseLookup';
import { SampleCoord } from '../../services/reprojection';
import { useCrsPicker } from '../../hooks/useCrsPicker';
import CrsPickerPanel from './CrsPickerPanel';
import ColumnMapperModal from './ColumnMapperModal';
import ConfirmDialog from './ConfirmDialog';
import { DataType, ParameterCatalog, RegionMeta } from '../../types';
import {
  fetchWqpCounts,
  fetchWqpStations,
  fetchWqpResults,
  dedupWqpResults,
  buildCharacteristicMap,
  WqpQueryParams,
  WqpCounts,
  WqpDataQualityReport,
} from '../../services/wqpApi';

interface MeasurementImporterProps {
  regionId: string;
  regionName: string;
  lengthUnit: 'ft' | 'm';
  singleUnit: boolean;
  /** Effective set of data types for this region (WTE + catalog types with
   *  data + customs with data). Drives the type picker UI. */
  dataTypes: DataType[];
  /** The region's custom (non-catalog) types from region.json. Used when
   *  persisting new non-catalog additions to disk. */
  customDataTypes: DataType[];
  regionBounds: [number, number, number, number];
  existingWellCount: number;
  onComplete: () => void;
  onClose: () => void;
}

type ImportMode = 'append' | 'replace';
type DataSource = 'upload' | 'usgs' | 'wqp';
type USGSMode = 'fresh' | 'quick-refresh' | 'full-refresh';
type AquiferAssignment = 'from-wells' | 'single' | 'csv-field';
type WqpProvider = 'all' | 'NWIS';

const MeasurementImporter: React.FC<MeasurementImporterProps> = ({
  regionId, regionName, lengthUnit, singleUnit, dataTypes, customDataTypes, regionBounds, existingWellCount, onComplete, onClose
}) => {
  const [dataSource, setDataSource] = useState<DataSource>('upload');
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [showMapper, setShowMapper] = useState(false);
  const [dateFormat, setDateFormat] = useState('iso');
  const [importMode, setImportMode] = useState<ImportMode>('append');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);

  // Multi-type selection
  const [selectedTypes, setSelectedTypes] = useState<string[]>([dataTypes[0]?.code || 'wte']);
  const [isMultiType, setIsMultiType] = useState(false);
  const [typeColumnMapping, setTypeColumnMapping] = useState<Record<string, string>>({});

  // WTE depth-below-GSE option
  const [wteIsDepth, setWteIsDepth] = useState(false);
  const [wellGseMap, setWellGseMap] = useState<Record<string, number>>({});

  // Aquifer assignment
  const [aquiferAssignment, setAquiferAssignment] = useState<AquiferAssignment>('from-wells');
  const [selectedAquiferId, setSelectedAquiferId] = useState('');
  const [aquiferList, setAquiferList] = useState<{ id: string; name: string }[]>([]);
  const [wellAquiferMap, setWellAquiferMap] = useState<Record<string, string>>({});

  // USGS scope
  const [usgsScope, setUsgsScope] = useState<'region' | 'aquifer'>('region');
  const [usgsScopeAquiferId, setUsgsScopeAquiferId] = useState('');
  const [apiKey, setApiKey] = useState(getUSGSApiKey());

  // USGS download
  const [usgsMode, setUsgsMode] = useState<USGSMode>('quick-refresh');
  const [usgsIsLoading, setUsgsIsLoading] = useState(false);
  const [usgsProgress, setUsgsProgress] = useState({ completed: 0, total: 0, done: false });
  const [qualityReport, setQualityReport] = useState<USGSDataQualityReport | null>(null);
  const [dataSpan, setDataSpan] = useState<USGSDataSpan | null>(null);
  const [trimStartDate, setTrimStartDate] = useState('');
  const [trimEndDate, setTrimEndDate] = useState('');
  const [isTrimmed, setIsTrimmed] = useState(false);
  const [quickRefreshCutoff, setQuickRefreshCutoff] = useState('');
  const [rawUSGSMeasurements, setRawUSGSMeasurements] = useState<USGSMeasurement[]>([]);

  // Phase 3: smart well discovery + column detection
  // Toggle: does the CSV include per-row well locations (name / lat / lng)?
  // Default ON when the region has no wells (bootstrap case), off otherwise.
  const [hasWellColumns, setHasWellColumns] = useState(existingWellCount === 0);
  // CRS picker (managed via useCrsPicker; see below where the hook is called)
  const [existingWellsFull, setExistingWellsFull] = useState<ExistingWell[]>([]);
  const [aquifersGeojson, setAquifersGeojson] = useState<any>(null);
  const [catalog, setCatalog] = useState<ParameterCatalog | null>(null);
  const [otherRegionTypes, setOtherRegionTypes] = useState<DataType[]>([]);
  const [matchResults, setMatchResults] = useState<MatchResult[] | null>(null);
  const [matchSummary, setMatchSummary] = useState<MatchSummary | null>(null);
  const [proximityMeters, setProximityMeters] = useState(100);
  const [isMatching, setIsMatching] = useState(false);
  const [newWellsGseProgress, setNewWellsGseProgress] = useState({ done: 0, total: 0 });
  const [showCatalogBrowser, setShowCatalogBrowser] = useState(false);

  // Phase 4: WQP download state
  const todayIso = new Date().toISOString().slice(0, 10);
  const tenYearsAgoIso = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [wqpSelectedCodes, setWqpSelectedCodes] = useState<string[]>([]);
  const [wqpStartDate, setWqpStartDate] = useState<string>(tenYearsAgoIso);
  const [wqpEndDate, setWqpEndDate] = useState<string>(todayIso);
  const [wqpProvider, setWqpProvider] = useState<WqpProvider>('all');
  const [wqpCounts, setWqpCounts] = useState<WqpCounts | null>(null);
  const [wqpIsCounting, setWqpIsCounting] = useState(false);
  const [wqpIsDownloading, setWqpIsDownloading] = useState(false);
  const [wqpQualityReport, setWqpQualityReport] = useState<WqpDataQualityReport | null>(null);
  const [showWqpPicker, setShowWqpPicker] = useState(false);
  const [wqpScope, setWqpScope] = useState<'region' | 'aquifer'>('region');
  const [wqpScopeAquiferId, setWqpScopeAquiferId] = useState('');

  // Duplicate handling strategy when multiple rows share the same well+date
  type DuplicateStrategy = 'average' | 'maximum' | 'keep-all';
  const [duplicateStrategy, setDuplicateStrategy] = useState<DuplicateStrategy>('average');

  // Post-save summary
  interface ImportSummary {
    wellsAdded: number;
    wellsMatchedById: number;
    wellsMatchedByName: number;
    wellsMatchedByProximity: number;
    measurementsByType: Record<string, number>;
    typeNames: Record<string, string>;
    skippedRows: number;
    duplicatesCollapsed: number;
    duplicateStrategyUsed: DuplicateStrategy;
  }
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  const regionOverlapsUS = isInUS(
    (regionBounds[0] + regionBounds[2]) / 2,
    (regionBounds[1] + regionBounds[3]) / 2
  );

  // Load aquifer list and well->aquifer mapping
  useEffect(() => {
    (async () => {
      // Load aquifers geojson (kept for point-in-polygon assignment of new wells,
      // even for single-unit regions we may still have it for display)
      try {
        const res = await freshFetch(`/data/${regionId}/aquifers.geojson`);
        if (res.ok) {
          const gj = await res.json();
          setAquifersGeojson(gj);
          if (!singleUnit) {
            const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
            const list = features.map((f: any) => ({
              id: String(f.properties?.aquifer_id || ''),
              name: f.properties?.aquifer_name || ''
            }));
            list.sort((a: { id: string; name: string }, b: { id: string; name: string }) =>
              compareNames(a.name || a.id, b.name || b.id));
            setAquiferList(list);
          }
        }
      } catch {}

      // Load wells for aquifer lookup, GSE, and full well records for matching
      try {
        const res = await freshFetch(`/data/${regionId}/wells.csv`);
        if (res.ok) {
          const text = await res.text();
          const { rows } = parseCSV(text);
          const aqMap: Record<string, string> = {};
          const gseMap: Record<string, number> = {};
          const fullWells: ExistingWell[] = [];
          for (const r of rows) {
            if (r.well_id) {
              aqMap[r.well_id] = r.aquifer_id || '0';
              const gse = parseFloat(r.gse);
              if (!isNaN(gse)) gseMap[r.well_id] = gse;
              fullWells.push({
                well_id: r.well_id,
                well_name: r.well_name || '',
                lat: parseFloat(r.lat),
                lng: parseFloat(r.long),
                aquifer_id: r.aquifer_id || '0',
                gse: isNaN(gse) ? 0 : gse,
              });
            }
          }
          setWellAquiferMap(aqMap);
          setWellGseMap(gseMap);
          setExistingWellsFull(fullWells);
        }
      } catch {}

      // Load catalog + cross-region data types for column detection
      try {
        const cat = await loadCatalog();
        setCatalog(cat);
      } catch {}
      try {
        const res = await fetch('/api/regions');
        if (res.ok) {
          const all: any[] = await res.json();
          const types: DataType[] = [];
          const seen = new Set<string>();
          for (const r of all) {
            if (r.id === regionId) continue;
            const others: DataType[] = Array.isArray(r.customDataTypes)
              ? r.customDataTypes
              : Array.isArray(r.dataTypes)
                ? r.dataTypes
                : [];
            for (const dt of others) {
              if (!seen.has(dt.code)) { seen.add(dt.code); types.push(dt); }
            }
          }
          setOtherRegionTypes(types);
        }
      } catch {}
    })();
  }, [regionId, singleUnit]);

  // Check if any selected types already have data
  const [existingCounts, setExistingCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    (async () => {
      const counts: Record<string, number> = {};
      for (const dt of dataTypes) {
        try {
          const res = await freshFetch(`/data/${regionId}/data_${dt.code}.csv`);
          if (res.ok) {
            const text = await res.text();
            counts[dt.code] = Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
          }
        } catch {}
      }
      setExistingCounts(counts);
    })();
  }, [regionId, dataTypes]);

  const hasExistingData = selectedTypes.some(code => (existingCounts[code] || 0) > 0);

  // Well ID is required for the legacy strict-matching case. When the
  // toggle "file includes well locations" is on, we run the smart-matching
  // pipeline and at least one of {well_id, well_name, lat+long} suffices.
  const wellIdRequired = dataSource !== 'upload' || (existingWellCount > 0 && !hasWellColumns);
  const smartFields = dataSource === 'upload' && hasWellColumns
    ? [
        { key: 'well_name', label: 'Well Name', required: false },
        { key: 'lat', label: 'Latitude', required: false },
        { key: 'long', label: 'Longitude', required: false },
      ]
    : [];
  // Structural fields only — no Value field. Data columns (including WTE)
  // are handled by the detection panel below the file chooser.
  const fieldDefs = [
    { key: 'well_id', label: 'Well ID', required: wellIdRequired },
    ...smartFields,
    { key: 'date', label: 'Date', required: true },
    ...(!singleUnit && aquiferAssignment === 'csv-field'
      ? [{ key: 'aquifer_id', label: 'Aquifer ID', required: false }] : []),
  ];

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const uploaded = await processUploadedFile(f, 'measurements');
      setFile(uploaded);
      setMatchResults(null);
      setMatchSummary(null);

      if (uploaded.mapping['date'] && Array.isArray(uploaded.data)) {
        const detected = detectDateFormat(uploaded.data as Record<string, string>[], uploaded.mapping['date']);
        setDateFormat(detected);
      }

      // Don't auto-open the modal — structural fields render inline now
    } catch (err) {
      setError(`Failed to process: ${err}`);
    }
  };

  // --- Per-column mapping editor (Phase 3.5d) ------------------------
  // Each CSV column that isn't a well_id/date/lat/etc. gets a mapping row
  // with an explicit Target. Users can override the auto-match to handle
  // typos and variant spellings, or opt out of columns entirely.

  type MappingTarget =
    | { kind: 'catalog'; code: string }
    | { kind: 'existingCustom'; code: string }
    | { kind: 'new'; code: string; name: string; unit: string };

  interface ColumnMapping {
    column: string;
    headerUnit: string | null;
    include: boolean;
    target: MappingTarget;
  }

  const [columnMappings, setColumnMappings] = useState<ColumnMapping[]>([]);

  const catalogCodes = useMemo(
    () => new Set(Object.keys(catalog?.parameters || {})),
    [catalog]
  );

  // Derive initial mappings from auto-match when the file or catalog changes
  useEffect(() => {
    if (!file) { setColumnMappings([]); return; }
    // USGS/WQP preset their own columnMappings when building the file —
    // clearing here would wipe them (the WQP presets are set in the same
    // commit as the file, so this effect runs right after)
    if (dataSource !== 'upload') return;
    // Exclude columns the user has already mapped in the column mapper
    // (well_id / well_name / lat / long / date / value / aquifer_id). They
    // aren't measurement data and shouldn't be offered as type candidates.
    const mappedCols = new Set(Object.values(file.mapping).filter((v): v is string => !!v));
    const candidateColumns = file.columns.filter(c => !mappedCols.has(c));
    const suggestions = suggestDataTypesFromColumns(candidateColumns, catalog, customDataTypes, otherRegionTypes);
    const initial: ColumnMapping[] = suggestions.map(s => {
      let target: MappingTarget;
      if (s.source === 'catalog') {
        target = { kind: 'catalog', code: s.code };
      } else if (s.source === 'existingCustom') {
        target = { kind: 'existingCustom', code: s.code };
      } else {
        // otherRegionCustom or custom: treat as a new custom, carry prefilled values
        target = { kind: 'new', code: s.code, name: s.name, unit: s.unit };
      }
      return {
        column: s.column,
        headerUnit: s.headerUnit,
        include: s.include,
        target,
      };
    });
    setColumnMappings(initial);
  }, [file?.columns, file?.mapping, catalog, customDataTypes, otherRegionTypes, dataSource]);

  const setMappingInclude = (column: string, include: boolean) => {
    setColumnMappings(prev => prev.map(m => m.column === column ? { ...m, include } : m));
  };

  // Handle Target dropdown change. The value encodes kind + code:
  //   "catalog:nitrate", "existingCustom:bod5", "new"
  const setMappingTarget = (column: string, value: string) => {
    setColumnMappings(prev => prev.map(m => {
      if (m.column !== column) return m;
      if (value.startsWith('catalog:')) {
        return { ...m, target: { kind: 'catalog', code: value.slice('catalog:'.length) } };
      }
      if (value.startsWith('existingCustom:')) {
        return { ...m, target: { kind: 'existingCustom', code: value.slice('existingCustom:'.length) } };
      }
      if (value === 'new') {
        // Seed from the column header if we don't already have new-custom values
        if (m.target.kind === 'new') return m;
        const slug = m.column.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'custom';
        return {
          ...m,
          target: { kind: 'new', code: slug, name: m.column, unit: m.headerUnit || '' },
        };
      }
      return m;
    }));
  };

  const updateNewCustom = (column: string, field: 'code' | 'name' | 'unit', value: string) => {
    setColumnMappings(prev => prev.map(m => {
      if (m.column !== column || m.target.kind !== 'new') return m;
      return { ...m, target: { ...m.target, [field]: value } };
    }));
  };

  const setAllMappingsInclude = (filter: 'all' | 'catalogOnly' | 'none') => {
    setColumnMappings(prev => prev.map(m => {
      if (filter === 'none') return { ...m, include: false };
      if (filter === 'all') return { ...m, include: true };
      // catalogOnly
      return { ...m, include: m.target.kind === 'catalog' };
    }));
  };

  // Resolve the effective DataType for a mapping — the thing that drives
  // the resulting data_{code}.csv file.
  const mappingResolvedType = (m: ColumnMapping): DataType | null => {
    if (m.target.kind === 'catalog') {
      if (m.target.code === 'wte') {
        return { code: 'wte', name: 'Water Table Elevation', unit: lengthUnit };
      }
      const param = catalog?.parameters[m.target.code];
      if (!param) return null;
      return { code: m.target.code, name: param.name, unit: param.unit };
    }
    if (m.target.kind === 'existingCustom') {
      const dt = customDataTypes.find(d => d.code === m.target.code);
      if (!dt) return null;
      return dt;
    }
    // new
    return { code: m.target.code, name: m.target.name, unit: m.target.unit };
  };

  const includedMappings = useMemo(
    () => columnMappings.filter(m => m.include),
    [columnMappings]
  );

  // Custom types that will be newly added to the region's customDataTypes
  // (distinct codes from rows whose target is 'new' and whose code isn't
  // already a custom or a catalog entry).
  const newCustomTypesToAdd = useMemo(() => {
    const existing = new Set(customDataTypes.map(d => d.code));
    const seen = new Set<string>();
    const result: DataType[] = [];
    for (const m of includedMappings) {
      if (m.target.kind !== 'new') continue;
      if (!m.target.code) continue;
      if (existing.has(m.target.code)) continue;
      if (catalogCodes.has(m.target.code)) continue; // collision prevented by UI validation
      if (seen.has(m.target.code)) continue;
      seen.add(m.target.code);
      result.push({ code: m.target.code, name: m.target.name || m.target.code, unit: m.target.unit });
    }
    return result;
  }, [includedMappings, customDataTypes, catalogCodes]);

  // Keep typeColumnMapping + selectedTypes in sync with the included mappings
  // so doSave's existing multi-type path can consume them directly.
  useEffect(() => {
    if (includedMappings.length === 0) return;
    const newMapping: Record<string, string> = { ...typeColumnMapping };
    const codes: string[] = [];
    for (const m of includedMappings) {
      const type = mappingResolvedType(m);
      if (!type || !type.code) continue;
      newMapping[type.code] = m.column;
      if (!codes.includes(type.code)) codes.push(type.code);
    }
    if (codes.length === 0) return;
    setTypeColumnMapping(newMapping);
    setSelectedTypes(codes);
    // Auto-enable multi-type when we have 2+ included mappings so doSave
    // iterates them as separate data files. Single-column imports can use
    // either path since the multi-type loop handles length=1 the same way.
    if (codes.length > 1 && !isMultiType) setIsMultiType(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includedMappings]);

  // Validation: a new-custom row is invalid when its code collides with
  // the catalog. UI blocks save when any row has this error.
  const mappingErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const m of columnMappings) {
      if (!m.include || m.target.kind !== 'new') continue;
      if (!m.target.code) { errs[m.column] = 'Code required'; continue; }
      if (!/^[a-z0-9_]{1,20}$/.test(m.target.code)) {
        errs[m.column] = 'Code must be lowercase alphanumeric + underscore, max 20 chars';
        continue;
      }
      if (catalogCodes.has(m.target.code)) {
        errs[m.column] = `"${m.target.code}" is a catalog code — pick the catalog entry instead`;
        continue;
      }
    }
    return errs;
  }, [columnMappings, catalogCodes]);

  const hasMappingErrors = Object.keys(mappingErrors).length > 0;

  const updateMapping = (key: string, value: string) => {
    if (!file) return;
    setFile({ ...file, mapping: { ...file.mapping, [key]: value } });
  };

  // Build an UploadedFile from validated USGS measurements.
  // USGS 72019 is depth to water below land surface (negative = artesian,
  // water above surface), so WTE = GSE − depth. Wells without a usable GSE
  // are filtered out at download time; the guard here is a backstop so a
  // raw depth can never be written into an elevation series.
  const buildUSGSFile = (measurements: USGSMeasurement[], label: string) => {
    const rows: { well_id: string; date: string; value: string; aquifer_id: string }[] = [];
    for (const m of measurements) {
      const gse = wellGseMap[m.siteId] || 0;
      if (gse <= 0) continue;
      rows.push({
        well_id: m.siteId,
        date: m.date,
        value: String(Math.round((gse - m.value) * 100) / 100),
        aquifer_id: singleUnit ? '0' : (wellAquiferMap[m.siteId] || '')
      });
    }
    setFile({
      name: label,
      data: rows,
      columns: ['well_id', 'date', 'value', 'aquifer_id'],
      mapping: { well_id: 'well_id', date: 'date', value: 'value', aquifer_id: 'aquifer_id' },
      type: 'csv'
    });
    // Keep typeColumnMapping in sync so isReady's per-type check passes —
    // the columnMappings sync effect doesn't run for USGS downloads
    setTypeColumnMapping(prev => ({ ...prev, wte: 'value' }));
    const span = computeDataSpan(measurements);
    setDataSpan(span);
    setTrimStartDate(span.minDate);
    setTrimEndDate(span.maxDate);
    setIsTrimmed(false);
  };

  // USGS measurement download — shared across all three modes
  const handleUSGSDownload = async () => {
    setUsgsIsLoading(true);
    setError('');
    setFile(null);
    setDataSpan(null);
    setIsTrimmed(false);
    setQuickRefreshCutoff('');
    setUsgsProgress({ completed: 0, total: 0, done: false });
    try {
      // Get well IDs from wells.csv
      const wellRes = await freshFetch(`/data/${regionId}/wells.csv`);
      if (!wellRes.ok) throw new Error('No wells found. Import wells first.');
      const wellText = await wellRes.text();
      const { rows: wellRows } = parseCSV(wellText);
      const wellIds = wellRows
        .filter(r => usgsScope === 'aquifer' ? r.aquifer_id === usgsScopeAquiferId : true)
        .map(r => r.well_id).filter(Boolean);

      if (wellIds.length === 0) throw new Error('No well IDs found in wells.csv');

      // Filter to USGS site IDs: accept "USGS-" prefixed or bare numeric (8-15 digit) IDs
      // Build mapping from API-format siteId → wells.csv well_id
      const apiToWellId: Record<string, string> = {};
      for (const id of wellIds) {
        // Monitoring-location IDs are "{AGENCY}-{site number}". The USGS
        // API hosts cooperating agencies' wells too (e.g. AZ014-… from the
        // Arizona DWR network) and serves their field measurements from
        // the same collection — matching only "USGS-" silently skipped
        // them. App-generated ids (lowercase "aqx-…") don't match.
        if (/^[A-Z][A-Z0-9]{1,9}-\d{8,15}$/.test(id)) {
          apiToWellId[id] = id;
        } else if (/^\d{8,15}$/.test(id)) {
          apiToWellId[`USGS-${id}`] = id;
        }
      }
      const usgsSiteIds = Object.keys(apiToWellId);
      if (usgsSiteIds.length === 0) throw new Error('No USGS site IDs found. Wells must have an "{AGENCY}-" prefix (e.g. USGS-) or be 8-15 digit numeric IDs.');

      setUsgsProgress({ completed: 0, total: usgsSiteIds.length, done: false });

      const batchErrors: string[] = [];
      const rawMeasurements = await fetchUSGSMeasurements(usgsSiteIds, (completed, total) => {
        setUsgsProgress({ completed, total, done: false });
      }, msg => batchErrors.push(msg));

      // Remap siteIds back to wells.csv well_id format
      for (const m of rawMeasurements) {
        m.siteId = apiToWellId[m.siteId] || m.siteId;
      }

      // Validate and clean data
      const { measurements: validated, report } = validateUSGSMeasurements(rawMeasurements);

      // Drop records whose well has no usable GSE — depth-to-water can't be
      // converted to an elevation without it, and storing the raw depth
      // would silently mix units within one series
      const measurements = validated.filter(m => (wellGseMap[m.siteId] || 0) > 0);
      const noGseCount = validated.length - measurements.length;
      if (noGseCount > 0) {
        report.dropped.count += noGseCount;
        report.dropped.details.push(`${noGseCount} record(s) from wells without a ground surface elevation (cannot convert depth to WTE)`);
      }

      // Surface batches that failed to download — previously these were
      // dropped with only a console.warn while the UI reported success
      if (batchErrors.length > 0) {
        report.dropped.count += batchErrors.length;
        report.dropped.details.push(...batchErrors);
      }

      setQualityReport(report);
      setRawUSGSMeasurements(measurements);

      // Mode-specific post-processing
      let filtered = measurements;

      if (usgsMode === 'quick-refresh') {
        // Find max existing date for USGS wells
        try {
          const dataRes = await freshFetch(`/data/${regionId}/data_wte.csv`);
          if (dataRes.ok) {
            const dataText = await dataRes.text();
            const { rows: dataRows } = parseCSV(dataText);
            const usgsDateSet = new Set(Object.values(apiToWellId));
            const usgsRows = dataRows.filter(r => usgsDateSet.has(r.well_id));
            if (usgsRows.length > 0) {
              const dates = usgsRows.map(r => r.date).filter(Boolean).sort();
              const cutoff = dates[dates.length - 1];
              setQuickRefreshCutoff(cutoff);
              filtered = measurements.filter(m => m.date > cutoff);
            }
          }
        } catch {}
      }
      // full-refresh: no filtering — all records go to merge at save time
      // fresh: no filtering

      const label = !hasExistingData || usgsMode === 'fresh' ? 'USGS Measurements' : `USGS ${usgsMode === 'quick-refresh' ? 'Quick' : 'Full'} Refresh`;
      buildUSGSFile(filtered, label);
      setSelectedTypes(['wte']);
      setIsMultiType(false);
      setUsgsProgress({ completed: usgsSiteIds.length, total: usgsSiteIds.length, done: true });
    } catch (err) {
      setError(`USGS download failed: ${err}`);
    }
    setUsgsIsLoading(false);
  };

  // Apply date range trim to USGS data
  const handleTrim = () => {
    if (rawUSGSMeasurements.length === 0) return;
    let filtered = rawUSGSMeasurements;

    // Re-apply mode filter first (quick-refresh cutoff)
    if (usgsMode === 'quick-refresh' && quickRefreshCutoff) {
      filtered = filtered.filter(m => m.date > quickRefreshCutoff);
    }

    // Then apply date range
    filtered = filterByDateRange(filtered, trimStartDate || null, trimEndDate || null);

    buildUSGSFile(filtered, 'USGS Measurements (Trimmed)');
    setIsTrimmed(true);
  };

  // ---- WQP download (Phase 4c) ----

  // Compute a bbox for the aquifer scope. Tighter than regionBounds
  // when the region's geojson contains lots of empty polygon space.
  // Returns [minLng, minLat, maxLng, maxLat] (WQP order).
  const wqpScopeBBox = useMemo<[number, number, number, number] | null>(() => {
    const features = aquifersGeojson?.type === 'FeatureCollection'
      ? aquifersGeojson.features
      : aquifersGeojson ? [aquifersGeojson] : [];
    const wantId = wqpScope === 'aquifer' ? wqpScopeAquiferId : null;
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    let any = false;
    const visit = (coords: any) => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
        const [lng, lat] = coords;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        any = true;
      } else for (const c of coords) visit(c);
    };
    for (const f of features) {
      if (wantId && String(f.properties?.aquifer_id || '') !== wantId) continue;
      visit(f.geometry?.coordinates);
    }
    if (!any) {
      // No aquifer geometry — fall back to region bounds
      return [regionBounds[1], regionBounds[0], regionBounds[3], regionBounds[2]];
    }
    return [minLng, minLat, maxLng, maxLat];
  }, [aquifersGeojson, wqpScope, wqpScopeAquiferId, regionBounds]);

  // Build the WqpQueryParams shared across count and download. WQP uses
  // [west, south, east, north]; we use the scoped aquifer bbox.
  const wqpQueryParams = useMemo<WqpQueryParams | null>(() => {
    if (!catalog || wqpSelectedCodes.length === 0 || !wqpScopeBBox) return null;
    if (wqpScope === 'aquifer' && !wqpScopeAquiferId) return null;
    const characteristicNames: string[] = [];
    for (const code of wqpSelectedCodes) {
      const cn = catalog.parameters[code]?.wqp?.characteristicName;
      if (cn) characteristicNames.push(cn);
    }
    if (characteristicNames.length === 0) return null;
    return {
      bBox: wqpScopeBBox,
      characteristicNames,
      startDateLo: wqpStartDate || undefined,
      startDateHi: wqpEndDate || undefined,
      providers: wqpProvider === 'NWIS' ? 'NWIS' : undefined,
    };
  }, [catalog, wqpSelectedCodes, wqpStartDate, wqpEndDate, wqpProvider, wqpScopeBBox, wqpScope, wqpScopeAquiferId]);

  const handleWqpEstimate = async () => {
    if (!wqpQueryParams) return;
    setError('');
    setWqpIsCounting(true);
    setWqpCounts(null);
    try {
      const counts = await fetchWqpCounts(wqpQueryParams);
      setWqpCounts(counts);
    } catch (err) {
      setError(`WQP count failed: ${err}`);
    }
    setWqpIsCounting(false);
  };

  // Pivot deduped WQP results into a wide CSV-shaped table with one
  // value column per catalog code. Each (siteId, date) becomes one row.
  // Pre-builds columnMappings so the existing save path can iterate
  // selectedTypes via typeColumnMapping without the user touching the
  // mapping editor.
  const buildWqpFile = (
    deduped: { siteId: string; date: string; characteristicName: string; value: number }[],
    stationMap: Map<string, { lat: number; lng: number; name: string }>,
    selectedCodes: string[]
  ) => {
    if (!catalog) return;
    // characteristicName → catalog code (only for parameters the user picked,
    // since dedup may have rejected others)
    const charToCode = new Map<string, string>();
    for (const code of selectedCodes) {
      const cn = catalog.parameters[code]?.wqp?.characteristicName;
      if (cn) charToCode.set(cn.toLowerCase(), code);
    }

    // Group by (siteId, date)
    const grouped = new Map<string, Record<string, string>>();
    for (const r of deduped) {
      const code = charToCode.get(r.characteristicName.toLowerCase());
      if (!code) continue;
      const station = stationMap.get(r.siteId);
      const key = `${r.siteId}|${r.date}`;
      let row = grouped.get(key);
      if (!row) {
        row = {
          well_id: r.siteId,
          well_name: station?.name || '',
          lat: station ? String(station.lat) : '',
          long: station ? String(station.lng) : '',
          date: r.date,
        };
        grouped.set(key, row);
      }
      row[code] = String(r.value);
    }

    const rows = Array.from(grouped.values());
    const columns = ['well_id', 'well_name', 'lat', 'long', 'date', ...selectedCodes];

    setFile({
      name: 'WQP Download',
      data: rows,
      columns,
      mapping: {
        well_id: 'well_id',
        well_name: 'well_name',
        lat: 'lat',
        long: 'long',
        date: 'date',
      },
      type: 'csv',
    });

    // Pre-populate columnMappings — one per catalog code, all included,
    // each pointing at the matching catalog target. Skips the mapping
    // editor since these aren't user-supplied columns.
    const presetMappings: ColumnMapping[] = selectedCodes.map(code => ({
      column: code,
      headerUnit: catalog.parameters[code]?.unit || null,
      include: true,
      target: { kind: 'catalog', code },
    }));
    setColumnMappings(presetMappings);

    // WQP rows always carry lat/lng → enable the well-matching panel
    setHasWellColumns(true);

    // Date span for the trim widget
    const dates = rows.map(r => r.date).filter(Boolean).sort();
    if (dates.length > 0) {
      const wellCount = new Set(rows.map(r => r.well_id)).size;
      setDataSpan({
        minDate: dates[0],
        maxDate: dates[dates.length - 1],
        totalRecords: deduped.length,
        wellCount,
      });
      setTrimStartDate(dates[0]);
      setTrimEndDate(dates[dates.length - 1]);
    }
    setIsTrimmed(false);
  };

  const handleWqpDownload = async () => {
    if (!wqpQueryParams || !catalog) return;
    setError('');
    setFile(null);
    setWqpIsDownloading(true);
    setWqpQualityReport(null);
    setMatchResults(null);
    setMatchSummary(null);
    setDataSpan(null);
    try {
      // Size check before committing: a broad query can return hundreds
      // of MB of CSV that must then be parsed on the main thread. Counts
      // come from headers only, so this pre-flight is cheap.
      const WQP_MAX_RESULTS = 250_000;
      try {
        const counts = await fetchWqpCounts(wqpQueryParams);
        setWqpCounts(counts);
        if (counts.resultCount > WQP_MAX_RESULTS) {
          setError(
            `This query matches ${counts.resultCount.toLocaleString()} results — too large to download at once. ` +
            `Narrow the date range, parameter list, or scope (try "Selected Aquifer").`
          );
          setWqpIsDownloading(false);
          return;
        }
      } catch { /* counts are advisory — proceed if they fail */ }

      const [stations, results] = await Promise.all([
        fetchWqpStations(wqpQueryParams),
        fetchWqpResults(wqpQueryParams),
      ]);

      // Polygon clip — WQP queries by bounding box, but the user
      // expects results inside the actual aquifer polygons. Drop
      // stations outside the chosen polygon(s); cascade the drop to
      // their results.
      const stationMap = new Map<string, { lat: number; lng: number; name: string }>();
      let droppedStations = 0;
      for (const s of stations) {
        if (aquifersGeojson) {
          const aq = assignWellToAquifer(s.lat, s.lng, aquifersGeojson);
          if (!aq) { droppedStations++; continue; }
          if (wqpScope === 'aquifer' && aq !== wqpScopeAquiferId) { droppedStations++; continue; }
        }
        stationMap.set(s.siteId, { lat: s.lat, lng: s.lng, name: s.siteName });
      }
      const inScopeResults = results.filter(r => stationMap.has(r.siteId));

      const charMap = buildCharacteristicMap(catalog);
      const { kept, report } = dedupWqpResults(inScopeResults, charMap);
      // Annotate the report so the cleanup panel shows polygon-clip stats too
      if (droppedStations > 0) {
        report.details.unshift(`${droppedStations} station${droppedStations === 1 ? '' : 's'} dropped — outside aquifer polygon${wqpScope === 'aquifer' ? '' : 's'}`);
      }
      setWqpQualityReport(report);

      buildWqpFile(kept, stationMap, wqpSelectedCodes);
    } catch (err) {
      setError(`WQP download failed: ${err}`);
    }
    setWqpIsDownloading(false);
  };

  // Sample coordinates for the CRS picker — memoized by mapping + data
  // reference so the hook's preview only refreshes when the CSV changes.
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

  const crs = useCrsPicker({
    regionBounds,
    samples: crsSamples,
    onCrsChange: () => { setMatchResults(null); setMatchSummary(null); },
  });
  const { parseRowCoords } = crs;

  // Auto-run CRS detection once per loaded CSV when the default WGS84 preview
  // lands outside the region — saves a click for projected-coordinate CSVs.
  // Keyed on the samples reference so changing files re-arms, and user picks
  // aren't overridden (preview.ok becomes true, or samples don't change).
  const autoDetectedSamplesRef = useRef<unknown>(null);
  useEffect(() => {
    if (crsSamples.length === 0 || !crs.crsPreview) return;
    if (crs.crsPreview.ok || crs.isAutoDetecting) return;
    if (autoDetectedSamplesRef.current === crsSamples) return;
    autoDetectedSamplesRef.current = crsSamples;
    crs.handleAutoDetectCrs();
  }, [crsSamples, crs.crsPreview, crs.isAutoDetecting, crs.handleAutoDetectCrs]);

  // Identity key for a well. ID wins (authoritative even at shared coords);
  // otherwise coords collapse spelling variants of the same physical well;
  // name is the last-resort key for rows without coords. Must be used
  // consistently across buildSourceWells and the handleImport lookups.
  const wellIdentityKey = (wellId: string, wellName: string, lat: number | undefined, lng: number | undefined): string => {
    if (wellId) return `id:${wellId}`;
    if (lat !== undefined && lng !== undefined) return `@${lat.toFixed(5)}|${lng.toFixed(5)}`;
    if (wellName) return `name:${wellName}`;
    return '';
  };

  // Build SourceWellRow[] by deduplicating the CSV on well identity.
  // One match decision per unique well, not per measurement row.
  const buildSourceWells = () => {
    if (!file) return [];
    const rows = file.data as Record<string, string>[];
    const wellIdCol = file.mapping['well_id'];
    const wellNameCol = file.mapping['well_name'];
    const latCol = file.mapping['lat'];
    const longCol = file.mapping['long'];
    const seen = new Map<string, { sourceIndex: number; wellId?: string; wellName?: string; lat?: number; lng?: number }>();
    rows.forEach((r, i) => {
      const wellId = wellIdCol ? (r[wellIdCol] || '').trim() : '';
      const wellName = wellNameCol ? (r[wellNameCol] || '').trim() : '';
      const latRaw = latCol ? r[latCol] : '';
      const lngRaw = longCol ? r[longCol] : '';
      const { lat, lng } = parseRowCoords(latRaw, lngRaw);
      const key = wellIdentityKey(wellId, wellName, lat, lng);
      if (!key || seen.has(key)) return;
      seen.set(key, {
        sourceIndex: i,
        wellId: wellId || undefined,
        wellName: wellName || undefined,
        lat,
        lng,
      });
    });
    return Array.from(seen.values());
  };

  const runWellMatching = () => {
    if (!file) return;
    setIsMatching(true);
    try {
      const sources = buildSourceWells();
      const results = matchWells(sources, existingWellsFull, { proximityMeters });
      setMatchResults(results);
      setMatchSummary(summarizeMatches(results));
    } finally {
      setIsMatching(false);
    }
  };

  // Reset match results whenever the identity columns change so stale
  // matches from a previous mapping aren't reused.
  const identitySignature = `${file?.mapping['well_id'] || ''}|${file?.mapping['well_name'] || ''}|${file?.mapping['lat'] || ''}|${file?.mapping['long'] || ''}`;
  useEffect(() => {
    setMatchResults(null);
    setMatchSummary(null);
  }, [identitySignature]);

  // Auto-run matching once the user has mapped at least one smart column
  // and confirmed the file. Without this, the save flow would silently
  // drop every row because it depends on the match results to resolve
  // row identities (well_id / name / coords → existing or new well).
  useEffect(() => {
    if (!file || !hasWellColumns || showMapper) return;
    if (isMatching || matchResults) return;
    // At least one identity column must be mapped
    const hasSmart = !!(file.mapping['lat'] || file.mapping['long'] || file.mapping['well_name']);
    if (!hasSmart) return;
    runWellMatching();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, hasWellColumns, showMapper, matchResults, isMatching, existingWellsFull.length]);

  // Toggle rejection of a single proximity match (user wants it treated as new)
  const toggleRejectMatch = (sourceIndex: number) => {
    if (!matchResults) return;
    const updated = matchResults.map(r => {
      if (r.sourceRow.sourceIndex !== sourceIndex) return r;
      const rejected = !r.rejected;
      return {
        ...r,
        rejected,
        // When rejected a proximity match becomes a "new" well if it has coords
        kind: rejected ? ('new' as const) : r.kind,
        resolvedWellId: rejected ? null : (r.existingWell?.well_id ?? null),
      };
    });
    setMatchResults(updated);
    setMatchSummary(summarizeMatches(updated));
  };

  const resolveAquiferId = (row: Record<string, string>): string => {
    if (singleUnit) return '0';
    switch (aquiferAssignment) {
      case 'from-wells': {
        const wellId = row[file?.mapping['well_id'] || 'well_id'];
        return wellAquiferMap[wellId] || '';
      }
      case 'single':
        return selectedAquiferId;
      case 'csv-field': {
        const col = file?.mapping['aquifer_id'];
        return col ? row[col] || '' : '';
      }
      default: return '';
    }
  };

  const doSave = async () => {
    if (!file) return;
    setIsSaving(true);
    setError('');
    try {
      const allRows = file.data as Record<string, string>[];
      const wellIdCol = file.mapping['well_id'];
      const wellNameCol = file.mapping['well_name'];
      const latCol = file.mapping['lat'];
      const longCol = file.mapping['long'];
      const dateCol = file.mapping['date'];

      // --- Well resolution: build a per-row wellId that accounts for match
      // results (existing wells) and new wells created during import ----
      const filesToSave: { path: string; content: string }[] = [];
      const rowIdentityKey = (r: Record<string, string>): string => {
        const id = wellIdCol ? (r[wellIdCol] || '').trim() : '';
        const name = wellNameCol ? (r[wellNameCol] || '').trim() : '';
        // Coord-based key uses the reprojected WGS84 values so it lines up
        // with whatever buildSourceWells / matchResults stored.
        const { lat, lng } = parseRowCoords(
          latCol ? r[latCol] : undefined,
          longCol ? r[longCol] : undefined
        );
        return wellIdentityKey(id, name, lat, lng);
      };

      // Compose identityKey → final wellId (and track aquifer lookup)
      const identityToWellId = new Map<string, string>();
      const newWellRecords: ExistingWell[] = [];
      const takenIds = new Set<string>(existingWellsFull.map(w => w.well_id));

      if (matchResults && matchResults.length > 0) {
        // For rows with existing matches, use the existing well_id
        for (const r of matchResults) {
          const srcKey = wellIdentityKey(r.sourceRow.wellId || '', r.sourceRow.wellName || '', r.sourceRow.lat, r.sourceRow.lng);
          if (!srcKey) continue;
          if (r.resolvedWellId && !r.rejected) {
            identityToWellId.set(srcKey, r.resolvedWellId);
          }
        }

        // Collect new wells (kind='new' or rejected proximity) and
        // create aqx- records for them
        const newRows = matchResults.filter(r => (r.kind === 'new' || r.rejected) && r.sourceRow.lat !== undefined && r.sourceRow.lng !== undefined);
        if (newRows.length > 0) {
          const gseInput = newRows.map((r, i) => ({
            id: `__new_${i}`,
            lat: r.sourceRow.lat!,
            lng: r.sourceRow.lng!,
          }));
          setNewWellsGseProgress({ done: 0, total: newRows.length });
          const gse = await fetchGseBatch(gseInput, {
            lengthUnit,
            onProgress: (done, total) => setNewWellsGseProgress({ done, total }),
          });

          newRows.forEach((r, i) => {
            const srcKey = wellIdentityKey(r.sourceRow.wellId || '', r.sourceRow.wellName || '', r.sourceRow.lat, r.sourceRow.lng);
            const aqx = generateAqxId(r.sourceRow.wellName || null, r.sourceRow.lat!, r.sourceRow.lng!, takenIds);
            takenIds.add(aqx);
            const aquiferId = singleUnit
              ? '0'
              : (aquifersGeojson ? (assignWellToAquifer(r.sourceRow.lat!, r.sourceRow.lng!, aquifersGeojson) || '') : '');
            const elev = gse.values.get(`__new_${i}`) ?? 0;
            const rec: ExistingWell = {
              well_id: aqx,
              well_name: r.sourceRow.wellName || aqx,
              lat: r.sourceRow.lat!,
              lng: r.sourceRow.lng!,
              aquifer_id: aquiferId,
              gse: elev,
            };
            newWellRecords.push(rec);
            identityToWellId.set(srcKey, aqx);
          });
        }
      }

      // Fallback for rows not touched by matching: trust the CSV well_id
      // (original behavior). This covers the happy path where wells already
      // exist and the user didn't run matching.
      const knownWellIds = new Set([
        ...Object.keys(wellAquiferMap),
        ...newWellRecords.map(w => w.well_id),
      ]);

      // If matching ran, expand the known set with the resolved IDs so rows pass the filter
      for (const wid of identityToWellId.values()) knownWellIds.add(wid);

      // Per-row resolver: take original well_id, fall back to identity lookup
      const rowToWellId = (r: Record<string, string>): string => {
        const rawId = wellIdCol ? (r[wellIdCol] || '').trim() : '';
        if (rawId && knownWellIds.has(rawId)) return rawId;
        const key = rowIdentityKey(r);
        return identityToWellId.get(key) || rawId;
      };

      // Filter out measurements whose wells can't be resolved to a real well
      const rows = knownWellIds.size > 0
        ? allRows.filter(r => {
            const wid = rowToWellId(r);
            return wid && knownWellIds.has(wid);
          })
        : allRows;

      // --- Build extended aquifer lookup including new wells
      const effectiveWellAquiferMap: Record<string, string> = { ...wellAquiferMap };
      for (const w of newWellRecords) effectiveWellAquiferMap[w.well_id] = w.aquifer_id || '0';

      // Override resolveAquiferId's 'from-wells' path via a closure replacement
      const resolveAquifer = (row: Record<string, string>): string => {
        if (singleUnit) return '0';
        switch (aquiferAssignment) {
          case 'from-wells': {
            const wid = rowToWellId(row);
            return effectiveWellAquiferMap[wid] || '';
          }
          case 'single':
            return selectedAquiferId;
          case 'csv-field': {
            const col = file.mapping['aquifer_id'];
            return col ? row[col] || '' : '';
          }
          default: return '';
        }
      };

      // Effective GSE lookup used by depth→elevation conversion (new wells
      // included)
      const effectiveGseMap: Record<string, number> = { ...wellGseMap };
      for (const w of newWellRecords) if (w.gse) effectiveGseMap[w.well_id] = w.gse;

      // Deduplicate within a batch by well_id+date. Strategy is user-selected.
      type MeasRow = { well_id: string; date: string; value: string; aquifer_id: string };
      let totalDupsCollapsed = 0;
      const dedup = (rows: MeasRow[]): MeasRow[] => {
        if (duplicateStrategy === 'keep-all') return rows;
        // Group by key
        const groups = new Map<string, MeasRow[]>();
        for (const r of rows) {
          const key = `${r.well_id}|${r.date}`;
          const arr = groups.get(key);
          if (arr) arr.push(r); else groups.set(key, [r]);
        }
        const result: MeasRow[] = [];
        for (const [, group] of groups) {
          if (group.length === 1) { result.push(group[0]); continue; }
          totalDupsCollapsed += group.length - 1;
          const nums = group.map(r => parseFloat(r.value)).filter(v => !isNaN(v));
          let finalVal: string;
          if (nums.length === 0) {
            finalVal = group[0].value;
          } else if (duplicateStrategy === 'average') {
            finalVal = String(Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000);
          } else {
            // maximum
            finalVal = String(Math.max(...nums));
          }
          result.push({ ...group[0], value: finalVal });
        }
        return result;
      };

      // Collect summary counts as we write each data file
      const summaryByType: Record<string, number> = {};
      const typeNames: Record<string, string> = {};

      if (isMultiType && selectedTypes.length > 1) {
        for (const typeCode of selectedTypes) {
          const valueCol = typeColumnMapping[typeCode] ?? file.mapping['value'];
          if (!valueCol) continue;

          const isWteDepth = typeCode === 'wte' && wteIsDepth;

          let processed = dedup(rows
            .filter(r => rowToWellId(r) && r[dateCol] && r[valueCol])
            .map(r => {
              const wid = rowToWellId(r);
              let val = r[valueCol];
              if (isWteDepth) {
                const gse = effectiveGseMap[wid] || 0;
                const raw = parseFloat(val);
                if (!isNaN(raw) && gse > 0) {
                  val = String(Math.round((gse - Math.abs(raw)) * 100) / 100);
                }
              }
              return {
                well_id: wid,
                date: parseDate(r[dateCol], dateFormat),
                value: val,
                aquifer_id: resolveAquifer(r),
              };
            }));

          // Skip writing anything for this type if the CSV contributed no
          // rows — don't leave behind empty header-only files or phantom
          // type declarations.
          if (processed.length === 0) continue;

          // Capture the number of new rows for this type before merge so the
          // summary can show what the user's CSV contributed
          summaryByType[typeCode] = processed.length;
          const effectiveType = dataTypes.find(d => d.code === typeCode);
          typeNames[typeCode] = effectiveType?.name || typeCode;

          if (importMode === 'append') {
            processed = await mergeWithExisting(typeCode, processed);
          }

          const csv = toCsv(['well_id', 'date', 'value', 'aquifer_id'], processed);
          filesToSave.push({ path: `${regionId}/data_${typeCode}.csv`, content: csv });
        }
      } else {
        // Single type. Resolve the value column the same way as the
        // multi-type path — file.mapping['value'] only exists for USGS
        // downloads, so single-column uploads/WQP must use
        // typeColumnMapping or every row silently filters out.
        const typeCode = selectedTypes[0] || 'wte';
        const valueCol = typeColumnMapping[typeCode] ?? file.mapping['value'];
        const isWteDepth = typeCode === 'wte' && wteIsDepth;

        let processed = dedup(rows
          .filter(r => rowToWellId(r) && r[dateCol] && r[valueCol])
          .map(r => {
            const wid = rowToWellId(r);
            let val = r[valueCol];
            if (isWteDepth) {
              const gse = effectiveGseMap[wid] || 0;
              const raw = parseFloat(val);
              if (!isNaN(raw) && gse > 0) {
                val = String(Math.round((gse - Math.abs(raw)) * 100) / 100);
              }
            }
            return {
              well_id: wid,
              date: parseDate(r[dateCol], dateFormat),
              value: val,
              aquifer_id: resolveAquifer(r),
            };
          }));

        // Skip empty imports so we don't create header-only phantom files
        if (processed.length === 0) {
          // Intentionally fall through to the error check below.
        } else {
          // Capture the new-row count for this type before merge
          summaryByType[typeCode] = processed.length;
          const effectiveType = dataTypes.find(d => d.code === typeCode);
          typeNames[typeCode] = effectiveType?.name || typeCode;

          // Merge/overwrite logic depends on source and mode
          if (dataSource === 'usgs') {
            if (usgsMode === 'fresh' && importMode === 'replace') {
              // Overwrite — no merge needed
            } else if (usgsMode === 'full-refresh') {
              processed = await mergeWithExistingFullRefresh(typeCode, processed);
            } else {
              processed = await mergeWithExisting(typeCode, processed);
            }
          } else if (importMode === 'append') {
            processed = await mergeWithExisting(typeCode, processed);
          }

          const csv = toCsv(['well_id', 'date', 'value', 'aquifer_id'], processed);
          filesToSave.push({ path: `${regionId}/data_${typeCode}.csv`, content: csv });
        }
      }

      // If every row was filtered out, bail out with a clear error instead
      // of writing bogus wells.csv / region.json updates and an empty summary
      const hasDataFiles = filesToSave.some(f => /\/data_.+\.csv$/.test(f.path));
      if (!hasDataFiles) {
        setError(
          `No measurements were imported. All ${allRows.length} rows were skipped because they could not be resolved to a well. Check your column mapping and that the "Match wells" step found matches.`
        );
        setIsSaving(false);
        return;
      }

      // --- Persist new wells (if any) by appending to wells.csv ---
      if (newWellRecords.length > 0) {
        let existingRows: Record<string, string>[] = [];
        try {
          const res = await freshFetch(`/data/${regionId}/wells.csv`);
          if (res.ok) existingRows = parseCSV(await res.text()).rows;
        } catch {}
        const aquiferNameById = new Map<string, string>(aquiferList.map(a => [a.id, a.name]));
        const newRows = newWellRecords.map(w => ({
          well_id: w.well_id,
          well_name: w.well_name || '',
          lat: String(w.lat),
          long: String(w.lng),
          gse: String(w.gse ?? ''),
          aquifer_id: w.aquifer_id,
          aquifer_name: aquiferNameById.get(w.aquifer_id) || '',
        }));
        filesToSave.push({
          path: `${regionId}/wells.csv`,
          content: toCsv(WELLS_CSV_HEADERS, [...existingRows, ...newRows]),
        });
      }

      // --- Persist new custom data types (if any) by updating region.json.
      // Catalog-backed types don't need to be recorded — they become
      // effective automatically when their CSV file exists.
      if (newCustomTypesToAdd.length > 0) {
        const updatedCustom = [...customDataTypes, ...newCustomTypesToAdd];
        const meta: RegionMeta = { id: regionId, name: regionName, lengthUnit, singleUnit, customDataTypes: updatedCustom };
        filesToSave.push({ path: `${regionId}/region.json`, content: JSON.stringify(meta, null, 2) });
      }

      await saveFiles(filesToSave);

      // Build the post-save summary panel
      const summary: ImportSummary = {
        wellsAdded: newWellRecords.length,
        wellsMatchedById: matchSummary?.byId || 0,
        wellsMatchedByName: matchSummary?.byName || 0,
        wellsMatchedByProximity: matchSummary?.byProximity || 0,
        measurementsByType: summaryByType,
        typeNames,
        skippedRows: Math.max(0, allRows.length - rows.length),
        duplicatesCollapsed: totalDupsCollapsed,
        duplicateStrategyUsed: duplicateStrategy,
      };
      setImportSummary(summary);
    } catch (err) {
      setError(`Failed to save: ${err}`);
    }
    setIsSaving(false);
  };

  const mergeWithExisting = async (
    typeCode: string,
    newRows: { well_id: string; date: string; value: string; aquifer_id: string }[]
  ) => {
    try {
      const res = await freshFetch(`/data/${regionId}/data_${typeCode}.csv`);
      if (res.ok) {
        const text = await res.text();
        const { rows: existingRows } = parseCSV(text);
        // Key on well_id|date only (matching the in-batch dedup and
        // full-refresh merge): including aquifer_id re-appends the same
        // measurement whenever a re-import resolves the aquifer differently
        // (e.g. existing rows have a blank aquifer_id)
        const existingKeys = new Set(
          existingRows.map(r => `${r.well_id}|${r.date}`)
        );
        const toAdd = newRows.filter(r => !existingKeys.has(`${r.well_id}|${r.date}`));

        return [
          ...existingRows.map(r => ({
            well_id: r.well_id,
            date: r.date,
            value: r.value,
            aquifer_id: r.aquifer_id || ''
          })),
          ...toAdd
        ];
      }
    } catch {}
    return newRows;
  };

  const mergeWithExistingFullRefresh = async (
    typeCode: string,
    newRows: { well_id: string; date: string; value: string; aquifer_id: string }[]
  ) => {
    try {
      const res = await freshFetch(`/data/${regionId}/data_${typeCode}.csv`);
      if (res.ok) {
        const text = await res.text();
        const { rows: existingRows } = parseCSV(text);

        // Build lookup from new data for fast matching
        const newLookup = new Map<string, { value: string; aquifer_id: string }>();
        for (const r of newRows) {
          newLookup.set(`${r.well_id}|${r.date}`, { value: r.value, aquifer_id: r.aquifer_id });
        }

        // Update existing rows if matching key found in new data
        const usedKeys = new Set<string>();
        const merged = existingRows.map(r => {
          const key = `${r.well_id}|${r.date}`;
          const update = newLookup.get(key);
          if (update) {
            usedKeys.add(key);
            return { well_id: r.well_id, date: r.date, value: update.value, aquifer_id: r.aquifer_id || update.aquifer_id };
          }
          return { well_id: r.well_id, date: r.date, value: r.value, aquifer_id: r.aquifer_id || '' };
        });

        // Append new rows not already in existing data (backfills)
        for (const r of newRows) {
          const key = `${r.well_id}|${r.date}`;
          if (!usedKeys.has(key)) {
            merged.push(r);
          }
        }

        return merged;
      }
    } catch {}
    return newRows;
  };

  const handleSave = () => {
    if (importMode === 'replace' && hasExistingData) {
      setShowReplaceConfirm(true);
    } else {
      doSave();
    }
  };

  const toggleType = (code: string) => {
    setSelectedTypes(prev =>
      prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]
    );
  };

  // Compute unmatched well info — only surfaces warnings for IDs that
  // weren't handled by the smart-matching pipeline.
  const unmatchedInfo = useMemo(() => {
    if (!file) return null;
    const rows = file.data as Record<string, string>[];
    const wellIdCol = file.mapping['well_id'];
    if (!wellIdCol || rows.length === 0) return null;

    const knownWellIds = new Set(Object.keys(wellAquiferMap));
    if (knownWellIds.size === 0) return null;

    // If matching ran, consider wells resolved via match results (existing + new) as "known"
    const resolvedFromMatch = new Set<string>();
    if (matchResults) {
      for (const r of matchResults) {
        if (r.rejected) continue;
        if (r.resolvedWellId) resolvedFromMatch.add(r.resolvedWellId);
        if (r.sourceRow.wellId) resolvedFromMatch.add(r.sourceRow.wellId); // source id covered
      }
    }

    const unmatchedWellIds = new Set<string>();
    let unmatchedCount = 0;
    let matchedCount = 0;

    for (const row of rows) {
      const wellId = row[wellIdCol];
      if (!wellId) continue;
      if (knownWellIds.has(wellId) || resolvedFromMatch.has(wellId)) {
        matchedCount++;
      } else {
        unmatchedWellIds.add(wellId);
        unmatchedCount++;
      }
    }

    if (unmatchedCount === 0) return null;

    return {
      unmatchedWellIds: Array.from(unmatchedWellIds),
      unmatchedCount,
      matchedCount,
    };
  }, [file, wellAquiferMap, matchResults]);

  const hasSmartColumns = !!(file && (file.mapping['lat'] || file.mapping['long'] || file.mapping['well_name']));

  // Pre-save duplicate detection: scan the loaded CSV for rows that share
  // the same well identity + date. Shown as an info banner with the strategy
  // dropdown so the user picks their handling before Save.
  const duplicateInfo = useMemo(() => {
    if (!file || dataSource !== 'upload') return null;
    const rows = file.data as Record<string, string>[];
    const dateCol = file.mapping['date'];
    const wellIdCol = file.mapping['well_id'];
    const wellNameCol = file.mapping['well_name'];
    if (!dateCol) return null;
    // Use the same identity key as doSave so the counts match reality
    const counts = new Map<string, number>();
    for (const r of rows) {
      const wid = wellIdCol ? (r[wellIdCol] || '').trim() : '';
      const wname = wellNameCol ? (r[wellNameCol] || '').trim() : '';
      const identity = wid || wname || '';
      if (!identity) continue;
      const date = r[dateCol] || '';
      if (!date) continue;
      const key = `${identity}|${date}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let duplicateGroups = 0;
    let extraRows = 0;
    for (const c of counts.values()) {
      if (c > 1) {
        duplicateGroups++;
        extraRows += c - 1;
      }
    }
    if (duplicateGroups === 0) return null;
    return { duplicateGroups, extraRows };
  }, [file, dataSource]);
  const hasMatchResults = !!matchResults && matchResults.length > 0;
  const isBootstrap = existingWellCount === 0;

  // Row identity: legacy flow needs a well_id column; smart flow accepts
  // any of well_id / well_name / (lat + long).
  const hasRowIdentity = !!file && (
    !!file.mapping['well_id'] ||
    (hasWellColumns && (!!file.mapping['well_name'] || (!!file.mapping['lat'] && !!file.mapping['long'])))
  );

  const isReady = file && file.mapping['date'] &&
    (hasRowIdentity || hasMatchResults || isBootstrap) &&
    selectedTypes.length > 0 &&
    selectedTypes.every(code => typeColumnMapping[code]) &&
    (singleUnit || aquiferAssignment !== 'single' || selectedAquiferId) &&
    (!unmatchedInfo || unmatchedInfo.matchedCount > 0 || hasMatchResults) &&
    !hasMappingErrors;

  // Post-save summary panel — rendered instead of the form once the save
  // succeeds. User dismisses with "Done" which fires onComplete to refresh
  // App state and close the importer.
  if (importSummary) {
    const totalMeas = Object.keys(importSummary.measurementsByType).reduce<number>((a, k) => a + importSummary.measurementsByType[k], 0);
    const totalMatched = importSummary.wellsMatchedById + importSummary.wellsMatchedByName + importSummary.wellsMatchedByProximity;
    return (
      <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40" onClick={onComplete}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle2 size={20} className="text-green-600" />
            <h2 className="text-lg font-bold text-slate-800">Import complete</h2>
          </div>
          <p className="text-sm text-slate-500 mb-4">{regionName}</p>

          {/* Wells summary */}
          {(importSummary.wellsAdded > 0 || totalMatched > 0) && (
            <div className="mb-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <p className="text-sm font-medium text-slate-700 mb-2">Wells</p>
              {importSummary.wellsAdded > 0 && (
                <p className="text-xs text-slate-600">
                  <span className="font-semibold text-green-700">{importSummary.wellsAdded}</span> new well{importSummary.wellsAdded !== 1 ? 's' : ''} created
                </p>
              )}
              {totalMatched > 0 && (
                <p className="text-xs text-slate-600">
                  <span className="font-semibold">{totalMatched}</span> matched to existing wells
                  {' '}(<span className="text-slate-500">
                    {importSummary.wellsMatchedById > 0 && `${importSummary.wellsMatchedById} by ID`}
                    {importSummary.wellsMatchedById > 0 && importSummary.wellsMatchedByName > 0 && ', '}
                    {importSummary.wellsMatchedByName > 0 && `${importSummary.wellsMatchedByName} by name`}
                    {(importSummary.wellsMatchedById + importSummary.wellsMatchedByName) > 0 && importSummary.wellsMatchedByProximity > 0 && ', '}
                    {importSummary.wellsMatchedByProximity > 0 && `${importSummary.wellsMatchedByProximity} by proximity`}
                  </span>)
                </p>
              )}
            </div>
          )}

          {/* Measurements summary */}
          <div className="mb-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-sm font-medium text-slate-700 mb-2">
              Measurements <span className="text-slate-400 font-normal">({totalMeas.toLocaleString()} total)</span>
            </p>
            {Object.keys(importSummary.measurementsByType).length === 0 ? (
              <p className="text-xs text-slate-500 italic">No measurements imported.</p>
            ) : (
              <ul className="space-y-1">
                {Object.entries(importSummary.measurementsByType).map(([code, count]) => (
                  <li key={code} className="text-xs text-slate-600 flex items-center justify-between">
                    <span>{importSummary.typeNames[code] || code} <span className="text-slate-400 font-mono">({code})</span></span>
                    <span className="font-semibold text-slate-700">{count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {importSummary.duplicatesCollapsed > 0 && (
            <p className="text-xs text-slate-600 mb-2">
              {importSummary.duplicatesCollapsed.toLocaleString()} duplicate{importSummary.duplicatesCollapsed !== 1 ? 's' : ''} collapsed
              ({importSummary.duplicateStrategyUsed === 'average' ? 'averaged' : importSummary.duplicateStrategyUsed === 'maximum' ? 'kept maximum' : 'kept all'})
            </p>
          )}

          {importSummary.skippedRows > 0 && (
            <p className="text-xs text-amber-700 mb-4">
              <AlertTriangle size={12} className="inline mr-1" />
              {importSummary.skippedRows.toLocaleString()} row{importSummary.skippedRows !== 1 ? 's' : ''} skipped (unmatched or missing identity)
            </p>
          )}

          <div className="flex justify-end">
            <button onClick={onComplete} className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700">
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Add Measurements</h2>
            <p className="text-sm text-slate-500">{regionName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        {/* Data source */}
        {regionOverlapsUS && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Data Source</label>
            <div className="flex gap-2">
              <button
                onClick={() => { setDataSource('upload'); setFile(null); }}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  dataSource === 'upload' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                <Upload size={14} /> Upload CSV
              </button>
              {existingWellCount > 0 && (
                <button
                  onClick={() => { setDataSource('usgs'); setFile(null); }}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    dataSource === 'usgs' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                  }`}
                  title="Download USGS water levels for wells already in this region"
                >
                  <Download size={14} /> USGS Levels
                </button>
              )}
              <button
                onClick={() => { setDataSource('wqp'); setFile(null); }}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  dataSource === 'wqp' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
                title="Download water quality data from the Water Quality Portal (WQP) — discovers wells inside the region bounding box"
              >
                <FlaskConical size={14} /> Water Quality (WQP)
              </button>
            </div>
          </div>
        )}


        {/* Import mode — show for upload and USGS when existing data */}
        {hasExistingData && (dataSource === 'upload' || dataSource === 'usgs' || dataSource === 'wqp') && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Import Mode</label>
            <div className="flex gap-2">
              <button
                onClick={() => { setImportMode('append'); if (dataSource === 'usgs') setUsgsMode('quick-refresh'); }}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  importMode === 'append' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Append
              </button>
              <button
                onClick={() => { setImportMode('replace'); if (dataSource === 'usgs') setUsgsMode('fresh'); }}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  importMode === 'replace' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Replace
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {importMode === 'append'
                ? 'New measurements will be added. Duplicates (by well_id + date) are skipped.'
                : `Replaces data for selected type(s): ${selectedTypes.join(', ')}`}
            </p>
          </div>
        )}

        {/* Aquifer assignment */}
        {!singleUnit && aquiferList.length > 0 && dataSource === 'upload' && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Aquifer Assignment</label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="meas-aq" checked={aquiferAssignment === 'from-wells'}
                  onChange={() => setAquiferAssignment('from-wells')} className="text-blue-600" />
                <span className="text-sm text-slate-700">Look up from wells (by well_id)</span>
              </label>
              {aquiferList.length > 1 && (
                <>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="meas-aq" checked={aquiferAssignment === 'single'}
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
                    <input type="radio" name="meas-aq" checked={aquiferAssignment === 'csv-field'}
                      onChange={() => setAquiferAssignment('csv-field')} className="text-blue-600" />
                    <span className="text-sm text-slate-700">Use aquifer_id column from CSV</span>
                  </label>
                </>
              )}
            </div>
          </div>
        )}

        {/* Upload flow */}
        {dataSource === 'upload' && (
          <>
            <p className="text-sm text-slate-500 mb-3">Upload a CSV file with measurement data.</p>

            {/* Well location toggle — gates the smart well matching pipeline */}
            <label className="flex items-start gap-2 mb-3 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={hasWellColumns}
                onChange={e => { setHasWellColumns(e.target.checked); setMatchResults(null); setMatchSummary(null); }}
                className="mt-0.5 text-blue-600 rounded"
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-slate-700">Measurements file includes well locations</span>
                <p className="text-xs text-slate-500 mt-0.5">
                  Turn on if your CSV has per-row well names or latitude/longitude columns. The importer will match rows to existing wells (by ID, name, or proximity) and can create new wells for unmatched coordinates. Leave off for simple well_id + date + value files.
                </p>
              </div>
            </label>

            <label className="block mb-4">
              <input type="file" accept=".csv,.txt" onChange={handleUpload}
                className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
            </label>
          </>
        )}

        {/* USGS mode selector */}
        {dataSource === 'usgs' && !file && (
          <div className="mb-4">
            <p className="text-sm text-slate-500 mb-3">
              Download water level measurements from USGS for wells with USGS site IDs. Depth values will be converted to water table elevation using GSE.
            </p>
            {/* Scope selector — only when multiple aquifers */}
            {aquiferList.length > 1 && (
              <div className="mb-3">
                <label className="block text-sm font-medium text-slate-700 mb-2">Download Scope</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="usgs-meas-scope" checked={usgsScope === 'region'}
                      onChange={() => { setUsgsScope('region'); setUsgsScopeAquiferId(''); }}
                      className="text-blue-600" />
                    <span className="text-sm text-slate-700">All wells in region</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="usgs-meas-scope" checked={usgsScope === 'aquifer'}
                      onChange={() => setUsgsScope('aquifer')}
                      className="text-blue-600" />
                    <span className="text-sm text-slate-700">Wells in selected aquifer</span>
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
            {hasExistingData && importMode === 'append' && (
              <>
              <label className="block text-sm font-medium text-slate-700 mb-2">Refresh Mode</label>
              <div className="space-y-2 mb-4">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="usgs-mode" checked={usgsMode === 'quick-refresh'}
                    onChange={() => setUsgsMode('quick-refresh')} className="text-blue-600 mt-0.5" />
                  <div>
                    <span className="text-sm text-slate-700 font-medium">Quick Refresh</span>
                    <p className="text-xs text-slate-500">Fetch all, keep only records newer than latest existing date.</p>
                  </div>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="usgs-mode" checked={usgsMode === 'full-refresh'}
                    onChange={() => setUsgsMode('full-refresh')} className="text-blue-600 mt-0.5" />
                  <div>
                    <span className="text-sm text-slate-700 font-medium">Full Refresh</span>
                    <p className="text-xs text-slate-500">Fetch all, merge/deduplicate with existing data. Catches backfills.</p>
                  </div>
                </label>
              </div>
              </>
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
            <button
              onClick={handleUSGSDownload}
              disabled={usgsIsLoading || (usgsScope === 'aquifer' && !usgsScopeAquiferId)}
              className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {usgsIsLoading ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Downloading... ({usgsProgress.completed}/{usgsProgress.total} wells)
                </>
              ) : (
                <>
                  <Download size={14} /> Download USGS Measurements
                </>
              )}
            </button>
          </div>
        )}

        {/* WQP download flow */}
        {dataSource === 'wqp' && !file && (
          <div className="mb-4">
            <p className="text-sm text-slate-500 mb-3">
              Download water quality data from the Water Quality Portal (USGS + EPA + 400+ agencies). Wells are discovered inside the region's bounding box; new wells are added during import.
            </p>

            {/* Parameter picker */}
            <div className="mb-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-slate-700">Parameters</label>
                <button
                  onClick={() => setShowWqpPicker(true)}
                  className="text-xs px-3 py-1 bg-white border border-slate-300 rounded hover:bg-slate-100 text-slate-700 font-medium"
                >
                  {wqpSelectedCodes.length > 0 ? 'Edit selection' : 'Pick parameters'}
                </button>
              </div>
              {wqpSelectedCodes.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No parameters selected.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {wqpSelectedCodes.map(code => {
                    const param = catalog?.parameters[code];
                    return (
                      <span key={code} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 text-xs rounded-full">
                        {param?.name || code}
                        <button
                          onClick={() => setWqpSelectedCodes(prev => prev.filter(c => c !== code))}
                          className="hover:text-blue-900"
                          title="Remove"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Scope */}
            {!singleUnit && aquiferList.length > 0 && (
              <div className="mb-3">
                <label className="block text-sm font-medium text-slate-700 mb-2">Scope</label>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="wqp-scope" checked={wqpScope === 'region'}
                      onChange={() => { setWqpScope('region'); setWqpScopeAquiferId(''); setWqpCounts(null); }}
                      className="text-blue-600" />
                    <span className="text-sm text-slate-700">All aquifers in region <span className="text-xs text-slate-400">(stations outside aquifer polygons are dropped)</span></span>
                  </label>
                  {aquiferList.length > 1 && (
                    <>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="wqp-scope" checked={wqpScope === 'aquifer'}
                          onChange={() => { setWqpScope('aquifer'); setWqpCounts(null); }}
                          className="text-blue-600" />
                        <span className="text-sm text-slate-700">Specific aquifer</span>
                      </label>
                      {wqpScope === 'aquifer' && (
                        <select value={wqpScopeAquiferId} onChange={e => { setWqpScopeAquiferId(e.target.value); setWqpCounts(null); }}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm ml-6">
                          <option value="">-- Select Aquifer --</option>
                          {aquiferList.map(a => (
                            <option key={a.id} value={a.id}>{a.name || a.id}</option>
                          ))}
                        </select>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Date range */}
            <div className="mb-3 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Start Date</label>
                <input type="date" value={wqpStartDate} onChange={e => { setWqpStartDate(e.target.value); setWqpCounts(null); }}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">End Date</label>
                <input type="date" value={wqpEndDate} onChange={e => { setWqpEndDate(e.target.value); setWqpCounts(null); }}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
            </div>

            {/* Provider toggle */}
            <div className="mb-3">
              <label className="block text-sm font-medium text-slate-700 mb-2">Sources</label>
              <div className="space-y-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="wqp-provider" checked={wqpProvider === 'all'}
                    onChange={() => { setWqpProvider('all'); setWqpCounts(null); }} className="text-blue-600" />
                  <span className="text-sm text-slate-700">All agencies <span className="text-xs text-slate-400">(USGS + EPA + state + tribal)</span></span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="wqp-provider" checked={wqpProvider === 'NWIS'}
                    onChange={() => { setWqpProvider('NWIS'); setWqpCounts(null); }} className="text-blue-600" />
                  <span className="text-sm text-slate-700">USGS only <span className="text-xs text-slate-400">(providers=NWIS)</span></span>
                </label>
              </div>
            </div>

            {/* Count preview + download */}
            <div className="mb-2 flex gap-2">
              <button
                onClick={handleWqpEstimate}
                disabled={wqpIsCounting || wqpIsDownloading || !wqpQueryParams}
                className="flex-1 px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {wqpIsCounting ? <Loader2 size={14} className="animate-spin" /> : <Calendar size={14} />}
                Estimate
              </button>
              <button
                onClick={handleWqpDownload}
                disabled={wqpIsDownloading || wqpIsCounting || !wqpQueryParams}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {wqpIsDownloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {wqpIsDownloading ? 'Downloading…' : 'Download'}
              </button>
            </div>

            {wqpCounts && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
                Estimated: <strong>{wqpCounts.resultCount.toLocaleString()}</strong> result{wqpCounts.resultCount === 1 ? '' : 's'} at <strong>{wqpCounts.siteCount.toLocaleString()}</strong> site{wqpCounts.siteCount === 1 ? '' : 's'} (bounding box).
                <p className="mt-1 text-blue-700">Stations outside the aquifer polygon{wqpScope === 'aquifer' ? '' : 's'} are dropped after download — actual count will be lower.</p>
                {wqpCounts.resultCount > 500_000 && (
                  <p className="mt-1 text-amber-700 font-medium">⚠ Large download — narrow the date range, fewer parameters, or smaller area before pulling.</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Inline structural column mapping — replaces the popup modal */}
        {file && dataSource === 'upload' && (
          <div className="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-sm font-medium text-slate-700 mb-3">Map Structural Columns</p>
            <div className="space-y-3">
              {fieldDefs.map(col => (
                <div key={col.key} className="flex items-center space-x-3">
                  <label className="w-32 text-sm font-medium text-slate-700 shrink-0">
                    {col.label}
                    {col.required && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  <select
                    value={file.mapping[col.key] || ''}
                    onChange={e => updateMapping(col.key, e.target.value)}
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">-- Select Column --</option>
                    {file.columns.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              ))}

              {/* Date format — only when a date column is mapped */}
              {file.mapping['date'] && (
                <div className="flex items-center space-x-3 pt-2 border-t border-slate-200">
                  <label className="w-32 text-sm font-medium text-slate-700 shrink-0">Date Format</label>
                  <select
                    value={dateFormat}
                    onChange={e => setDateFormat(e.target.value)}
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {DATE_FORMATS.map(f => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Smart well matching panel — only when lat/lng are mapped */}
        {file && (dataSource === 'upload' || dataSource === 'wqp') && hasSmartColumns && (
          <div className="mb-4 p-4 bg-sky-50 border border-sky-200 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <MapPin size={14} className="text-sky-600" />
              <span className="text-sm font-medium text-sky-800">Well matching</span>
            </div>
            <p className="text-xs text-sky-700 mb-3">
              Match source rows to existing wells by ID, name, or proximity. Unmatched rows with coordinates become new wells.
            </p>

            {/* Coordinate reference system picker */}
            <div className="mb-3 pb-3 border-b border-sky-200">
              <CrsPickerPanel crs={crs} />
            </div>

            <div className="flex items-center gap-2 mb-3">
              <label className="text-xs text-slate-600">Proximity threshold (m):</label>
              <input
                type="number"
                value={proximityMeters}
                min={1}
                max={5000}
                onChange={e => setProximityMeters(Math.max(1, parseInt(e.target.value || '100', 10)))}
                className="w-20 px-2 py-1 border border-sky-200 rounded text-xs"
              />
              <button
                onClick={runWellMatching}
                disabled={isMatching}
                className="ml-auto px-3 py-1.5 bg-sky-600 text-white rounded text-xs font-medium hover:bg-sky-700 disabled:opacity-50 flex items-center gap-1"
              >
                {isMatching && <Loader2 size={12} className="animate-spin" />}
                {matchResults ? 'Re-match' : 'Match wells'}
              </button>
            </div>
            {matchSummary && (
              <div className="space-y-2">
                <div className="grid grid-cols-5 gap-1 text-center text-xs">
                  <div className="p-1.5 bg-white rounded border border-slate-200"><div className="font-bold text-slate-800">{matchSummary.byId}</div><div className="text-[10px] text-slate-500">by ID</div></div>
                  <div className="p-1.5 bg-white rounded border border-slate-200"><div className="font-bold text-slate-800">{matchSummary.byName}</div><div className="text-[10px] text-slate-500">by name</div></div>
                  <div className="p-1.5 bg-white rounded border border-slate-200"><div className="font-bold text-slate-800">{matchSummary.byProximity}</div><div className="text-[10px] text-slate-500">by proximity</div></div>
                  <div className="p-1.5 bg-white rounded border border-slate-200"><div className="font-bold text-green-700">{matchSummary.newWells}</div><div className="text-[10px] text-slate-500">new</div></div>
                  <div className="p-1.5 bg-white rounded border border-slate-200"><div className={`font-bold ${matchSummary.unmatched > 0 ? 'text-red-600' : 'text-slate-400'}`}>{matchSummary.unmatched}</div><div className="text-[10px] text-slate-500">unmatched</div></div>
                </div>
                {matchResults && matchResults.some(r => r.kind === 'proximity' && !r.rejected) && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-sky-700 hover:text-sky-800">Review proximity matches ({matchResults.filter(r => r.kind === 'proximity' && !r.rejected).length})</summary>
                    <p className="mt-2 text-[11px] text-slate-500">
                      Each row below shows a {dataSource === 'wqp' ? 'WQP station' : 'source well from your CSV'} that was auto-matched to an existing well based on location. If a match looks wrong, click <span className="font-medium text-red-600">Reject</span> to create a new well instead.
                    </p>
                    <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                      {matchResults.filter(r => r.kind === 'proximity' && !r.rejected).map(r => (
                        <div key={r.sourceRow.sourceIndex} className="flex items-center gap-2 py-1 border-b border-sky-100 last:border-0">
                          <span className="flex-1 text-[11px] text-slate-700">
                            "{r.sourceRow.wellName || r.sourceRow.wellId || '(no name)'}" → <span className="font-medium">{r.existingWell?.well_name || r.existingWell?.well_id}</span>
                            <span className="text-slate-400"> · {Math.round(r.distanceMeters || 0)}m</span>
                          </span>
                          <button
                            onClick={() => toggleRejectMatch(r.sourceRow.sourceIndex)}
                            title="Reject this match — treat the CSV row as a new well instead"
                            className="px-2 py-0.5 text-[10px] text-red-600 border border-red-200 rounded hover:bg-red-50 hover:border-red-300 font-medium"
                          >
                            Reject
                          </button>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {newWellsGseProgress.total > 0 && newWellsGseProgress.done < newWellsGseProgress.total && (
                  <p className="text-xs text-sky-700 flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" />
                    Fetching elevation for new wells ({newWellsGseProgress.done}/{newWellsGseProgress.total})
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Detected data types panel — per-column mapping editor */}
        {file && dataSource === 'upload' && columnMappings.length > 0 && (
          <div className="mb-4 p-4 bg-indigo-50 border border-indigo-200 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Wand2 size={14} className="text-indigo-600" />
                <span className="text-sm font-medium text-indigo-800">Map data columns</span>
              </div>
              <button
                onClick={() => setShowCatalogBrowser(true)}
                className="inline-flex items-center gap-1 text-xs text-indigo-700 hover:text-indigo-900 font-medium"
              >
                <BookOpen size={12} /> View Catalog
              </button>
            </div>
            <p className="text-xs text-indigo-700 mb-3">
              Each column from your CSV that looks like measurement data is listed below. Pick a target for each — a catalog parameter, an existing custom type, or a new custom. Uncheck anything you don't want to import.
            </p>
            <div className="flex items-center gap-2 mb-3 text-xs">
              <span className="text-slate-500">Bulk:</span>
              <button onClick={() => setAllMappingsInclude('all')} className="px-2 py-0.5 bg-white border border-indigo-200 rounded hover:bg-indigo-100 text-indigo-700">Include all</button>
              <button onClick={() => setAllMappingsInclude('catalogOnly')} className="px-2 py-0.5 bg-white border border-indigo-200 rounded hover:bg-indigo-100 text-indigo-700">Only catalog matches</button>
              <button onClick={() => setAllMappingsInclude('none')} className="px-2 py-0.5 bg-white border border-indigo-200 rounded hover:bg-indigo-100 text-indigo-700">None</button>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {columnMappings.map(m => {
                const resolved = mappingResolvedType(m);
                const targetValue = m.target.kind === 'catalog'
                  ? `catalog:${m.target.code}`
                  : m.target.kind === 'existingCustom'
                    ? `existingCustom:${m.target.code}`
                    : 'new';
                const unitMismatch = m.target.kind === 'catalog' && m.headerUnit && resolved && m.headerUnit.toLowerCase() !== resolved.unit.toLowerCase();
                const err = mappingErrors[m.column];
                return (
                  <div key={m.column} className={`p-2 rounded border ${m.include ? 'border-indigo-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-70'}`}>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={m.include}
                        onChange={e => setMappingInclude(m.column, e.target.checked)}
                        className="text-indigo-600 rounded"
                      />
                      <span className="flex-1 text-xs font-mono text-slate-700 truncate" title={m.column}>{m.column}</span>
                      <select
                        value={targetValue}
                        onChange={e => setMappingTarget(m.column, e.target.value)}
                        className="text-xs px-2 py-1 border border-slate-300 rounded bg-white max-w-[180px]"
                      >
                        <optgroup label="Built-in">
                          <option value="catalog:wte">Water Table Elevation</option>
                        </optgroup>
                        <optgroup label="Catalog parameters">
                          {catalog && Object.keys(catalog.parameters)
                            .sort((a, b) => catalog.parameters[a].name.localeCompare(catalog.parameters[b].name))
                            .map(code => (
                              <option key={code} value={`catalog:${code}`}>{catalog.parameters[code].name}</option>
                            ))}
                        </optgroup>
                        {customDataTypes.length > 0 && (
                          <optgroup label="Region custom types">
                            {customDataTypes.map(dt => (
                              <option key={dt.code} value={`existingCustom:${dt.code}`}>{dt.name}</option>
                            ))}
                          </optgroup>
                        )}
                        <optgroup label="Other">
                          <option value="new">+ New custom type</option>
                        </optgroup>
                      </select>
                      {/* Unit display */}
                      {m.target.kind === 'catalog' && resolved && (
                        <span className="text-xs text-slate-500 min-w-[3rem] text-right">{resolved.unit || '—'}</span>
                      )}
                      {m.target.kind === 'existingCustom' && resolved && (
                        <span className="text-xs text-slate-500 min-w-[3rem] text-right">{resolved.unit || '—'}</span>
                      )}
                    </div>
                    {/* Warnings / errors / badges */}
                    {unitMismatch && (
                      <p className="mt-1 ml-6 text-[11px] text-amber-700">
                        header says <span className="font-mono">{m.headerUnit}</span>, catalog is <span className="font-mono">{resolved?.unit}</span> — verify your values before importing
                      </p>
                    )}
                    {m.target.kind === 'new' && (
                      <div className="mt-1 ml-6 space-y-1">
                        <div className="flex gap-2 items-center text-xs">
                          <label className="text-slate-500 w-10">Code</label>
                          <input
                            value={m.target.code}
                            onChange={e => updateNewCustom(m.column, 'code', e.target.value)}
                            className="flex-1 px-2 py-0.5 border border-slate-300 rounded font-mono"
                            placeholder="e.g. bod5"
                          />
                          <label className="text-slate-500 w-8">Name</label>
                          <input
                            value={m.target.name}
                            onChange={e => updateNewCustom(m.column, 'name', e.target.value)}
                            className="flex-1 px-2 py-0.5 border border-slate-300 rounded"
                            placeholder="e.g. BOD5"
                          />
                          <label className="text-slate-500 w-8">Unit</label>
                          <input
                            value={m.target.unit}
                            onChange={e => updateNewCustom(m.column, 'unit', e.target.value)}
                            className="w-16 px-2 py-0.5 border border-slate-300 rounded"
                            placeholder="mg/L"
                          />
                        </div>
                      </div>
                    )}
                    {err && <p className="mt-1 ml-6 text-[11px] text-red-600">{err}</p>}
                  </div>
                );
              })}
            </div>
            {newCustomTypesToAdd.length > 0 && (
              <p className="text-xs text-indigo-700 mt-2">
                {newCustomTypesToAdd.length} new custom type{newCustomTypesToAdd.length !== 1 ? 's' : ''} will be added to the region.
              </p>
            )}
            {selectedTypes.includes('wte') && (
              <label className="flex items-center gap-2 mt-3 pt-3 border-t border-indigo-200 cursor-pointer">
                <input type="checkbox" checked={wteIsDepth}
                  onChange={e => setWteIsDepth(e.target.checked)}
                  className="text-blue-600 rounded" />
                <span className="text-xs text-slate-600">WTE values are depth below ground surface (will convert to elevation using GSE)</span>
              </label>
            )}
          </div>
        )}

        {file && (
          <div className="mb-4">
            <div className="flex items-center gap-2 text-sm text-green-700 mb-2">
              <CheckCircle2 size={16} />
              {dataSource === 'usgs'
                ? `${(file.data as any[]).length} USGS measurements loaded`
                : dataSource === 'wqp'
                  ? `${(file.data as any[]).length} WQP rows ready (${wqpSelectedCodes.length} parameter${wqpSelectedCodes.length === 1 ? '' : 's'})`
                  : `${file.name} (${(file.data as any[]).length} rows)`}
            </div>
            {unmatchedInfo && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg mt-2">
                <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800">
                    {unmatchedInfo.unmatchedCount} measurement{unmatchedInfo.unmatchedCount !== 1 ? 's' : ''} from {unmatchedInfo.unmatchedWellIds.length} well{unmatchedInfo.unmatchedWellIds.length !== 1 ? 's' : ''} not found in wells.csv
                  </p>
                  <p className="text-xs text-amber-700 mt-1">
                    Unmatched well IDs: {unmatchedInfo.unmatchedWellIds.slice(0, 5).join(', ')}
                    {unmatchedInfo.unmatchedWellIds.length > 5 && ` and ${unmatchedInfo.unmatchedWellIds.length - 5} more`}
                  </p>
                  {unmatchedInfo.matchedCount > 0 ? (
                    <p className="text-xs text-green-700 mt-1">
                      {unmatchedInfo.matchedCount} matched measurement{unmatchedInfo.matchedCount !== 1 ? 's' : ''} will be imported.
                    </p>
                  ) : (
                    <p className="text-xs text-red-700 mt-1 font-medium">
                      No measurements match existing wells. Import cannot proceed.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Data Span Preview + Date Trimmer */}
        {dataSpan && (dataSource === 'usgs' || dataSource === 'wqp') && file && (
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <Calendar size={14} className="text-blue-600" />
              <span className="text-sm font-medium text-blue-800">Data Range</span>
            </div>
            <p className="text-sm text-slate-700 mb-1">
              {dataSpan.minDate} to {dataSpan.maxDate} — {dataSpan.totalRecords.toLocaleString()} measurements across {dataSpan.wellCount} wells
            </p>
            {dataSource === 'usgs' && usgsMode === 'quick-refresh' && quickRefreshCutoff && (
              <p className="text-xs text-amber-700 mb-2">Cutoff: showing only records after {quickRefreshCutoff}</p>
            )}
            {dataSource === 'usgs' && (
              <div className="flex items-end gap-2 mt-2">
                <div className="flex-1">
                  <label className="block text-xs text-slate-500 mb-1">Start Date</label>
                  <input type="date" value={trimStartDate} onChange={e => setTrimStartDate(e.target.value)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-slate-500 mb-1">End Date</label>
                  <input type="date" value={trimEndDate} onChange={e => setTrimEndDate(e.target.value)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                </div>
                <button onClick={handleTrim}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">
                  Trim
                </button>
              </div>
            )}
            {dataSource === 'usgs' && isTrimmed && (
              <p className="text-xs text-green-700 mt-2">Trimmed to {(file.data as any[]).length.toLocaleString()} measurements</p>
            )}
          </div>
        )}

        {/* WQP Data Quality Report */}
        {wqpQualityReport && dataSource === 'wqp' && (
          <div className="mb-4 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
            <div className="font-medium text-slate-700 mb-1">WQP cleanup</div>
            <div className="text-slate-600 space-y-0.5">
              <div>{wqpQualityReport.totalRaw.toLocaleString()} raw rows → {wqpQualityReport.kept.toLocaleString()} kept</div>
              {wqpQualityReport.droppedFractionMismatch > 0 && (
                <div>{wqpQualityReport.droppedFractionMismatch.toLocaleString()} dropped — sample fraction didn't match catalog preference</div>
              )}
              {wqpQualityReport.droppedDuplicates > 0 && (
                <div>{wqpQualityReport.droppedDuplicates.toLocaleString()} duplicates collapsed (same site + date + parameter)</div>
              )}
              {wqpQualityReport.details.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-slate-500">Details</summary>
                  <ul className="mt-1 ml-4 list-disc text-slate-500">
                    {wqpQualityReport.details.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                </details>
              )}
            </div>
          </div>
        )}

        {/* USGS Data Quality Report */}
        {qualityReport && dataSource === 'usgs' && (
          <div className="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm">
            <h4 className="font-semibold text-slate-700 mb-2">Data Quality Report</h4>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="text-center p-2 bg-white rounded border">
                <p className="text-lg font-bold text-slate-800">{qualityReport.totalRaw}</p>
                <p className="text-xs text-slate-500">Raw records</p>
              </div>
              <div className="text-center p-2 bg-white rounded border">
                <p className="text-lg font-bold text-green-600">{qualityReport.kept}</p>
                <p className="text-xs text-slate-500">Kept</p>
              </div>
              <div className="text-center p-2 bg-white rounded border">
                <p className={`text-lg font-bold ${qualityReport.dropped.count > 0 ? 'text-red-600' : 'text-slate-400'}`}>{qualityReport.dropped.count}</p>
                <p className="text-xs text-slate-500">Dropped</p>
              </div>
            </div>
            {qualityReport.fixed.count > 0 && (
              <div className="mb-2">
                <p className="text-xs font-medium text-amber-700 mb-1">
                  Fixed {qualityReport.fixed.count} record(s):
                </p>
                <ul className="text-xs text-slate-600 space-y-0.5 max-h-24 overflow-y-auto">
                  {qualityReport.fixed.details.map((d, i) => (
                    <li key={i} className="pl-2 border-l-2 border-amber-300">{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {qualityReport.dropped.count > 0 && (
              <div>
                <p className="text-xs font-medium text-red-700 mb-1">
                  Dropped {qualityReport.dropped.count} record(s):
                </p>
                <ul className="text-xs text-slate-600 space-y-0.5 max-h-24 overflow-y-auto">
                  {qualityReport.dropped.details.map((d, i) => (
                    <li key={i} className="pl-2 border-l-2 border-red-300">{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {qualityReport.fixed.count === 0 && qualityReport.dropped.count === 0 && (
              <p className="text-xs text-green-600">All records passed validation.</p>
            )}
          </div>
        )}

        {/* Duplicate handling — shown when the CSV has same-well same-date rows */}
        {file && dataSource === 'upload' && duplicateInfo && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-center justify-between">
              <p className="text-xs text-amber-800">
                <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
                <span className="font-medium">{duplicateInfo.duplicateGroups}</span> well{duplicateInfo.duplicateGroups !== 1 ? 's have' : ' has'} multiple
                samples on the same date (<span className="font-medium">{duplicateInfo.extraRows}</span> extra row{duplicateInfo.extraRows !== 1 ? 's' : ''}).
              </p>
              <select
                value={duplicateStrategy}
                onChange={e => setDuplicateStrategy(e.target.value as DuplicateStrategy)}
                className="ml-3 px-2 py-1 border border-amber-200 rounded text-xs bg-white"
              >
                <option value="average">Average duplicates</option>
                <option value="maximum">Keep maximum</option>
                <option value="keep-all">Keep all (no dedup)</option>
              </select>
            </div>
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
            {isSaving ? 'Saving...' : 'Save Measurements'}
          </button>
        </div>
      </div>

      {showMapper && file && (
        <ColumnMapperModal
          file={file}
          fieldDefinitions={fieldDefs}
          onUpdateMapping={updateMapping}
          onClose={() => setShowMapper(false)}
          dateFormat={dateFormat}
          onDateFormatChange={setDateFormat}
          title="Map Measurement Columns"
        />
      )}

      {showReplaceConfirm && (
        <ConfirmDialog
          title="Replace Measurements?"
          message={`This will replace all existing measurement data for: ${selectedTypes.join(', ')}. This cannot be undone.`}
          confirmLabel="Replace"
          variant="danger"
          onConfirm={() => { setShowReplaceConfirm(false); doSave(); }}
          onCancel={() => setShowReplaceConfirm(false)}
        />
      )}

      {showCatalogBrowser && <CatalogBrowser onClose={() => setShowCatalogBrowser(false)} />}

      {showWqpPicker && (
        <WqpParameterPicker
          initialSelected={wqpSelectedCodes}
          onApply={codes => { setWqpSelectedCodes(codes); setWqpCounts(null); setShowWqpPicker(false); }}
          onClose={() => setShowWqpPicker(false)}
        />
      )}
    </div>
  );
};

export default MeasurementImporter;
