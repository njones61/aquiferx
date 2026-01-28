
import React, { useState, useCallback } from 'react';
import { X, Upload, FileText, CheckCircle2, AlertCircle, ChevronRight, ChevronLeft, Download, MapPin, Droplets, Layers } from 'lucide-react';
import { Region, Aquifer, Well, Measurement } from '../types';
import shp from 'shpjs';
import JSZip from 'jszip';

interface DataManagerProps {
  onClose: () => void;
  onUpdateRegions: (r: Region[]) => void;
  onUpdateAquifers: (a: Aquifer[]) => void;
  onUpdateWells: (w: Well[]) => void;
  onUpdateMeasurements: (m: Measurement[]) => void;
  existingRegions: string[]; // List of existing region folder names
}

interface ColumnMapping {
  [targetColumn: string]: string; // targetColumn -> sourceColumn
}

interface UploadedFile {
  name: string;
  data: any; // Parsed data (GeoJSON or CSV rows)
  columns: string[]; // Available columns
  mapping: ColumnMapping;
  type: 'geojson' | 'csv';
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  droppedMeasurements: number;
}

const DATE_FORMATS = [
  { label: 'YYYY-MM-DD (2024-01-15)', value: 'iso' },
  { label: 'MM/DD/YYYY (01/15/2024)', value: 'us' },
  { label: 'DD/MM/YYYY (15/01/2024)', value: 'eu' },
  { label: 'M/D/YYYY (1/15/2024)', value: 'us-short' },
  { label: 'D/M/YYYY (15/1/2024)', value: 'eu-short' },
];

const DataManager: React.FC<DataManagerProps> = ({
  onClose,
  onUpdateRegions,
  onUpdateAquifers,
  onUpdateWells,
  onUpdateMeasurements,
  existingRegions = []
}) => {
  const [step, setStep] = useState(1);
  const [regionName, setRegionName] = useState('');
  const [regionNameError, setRegionNameError] = useState('');

  const [regionFile, setRegionFile] = useState<UploadedFile | null>(null);
  const [aquiferFile, setAquiferFile] = useState<UploadedFile | null>(null);
  const [wellsFile, setWellsFile] = useState<UploadedFile | null>(null);
  const [waterLevelsFile, setWaterLevelsFile] = useState<UploadedFile | null>(null);

  const [dateFormat, setDateFormat] = useState('iso');
  const [showColumnMapper, setShowColumnMapper] = useState(false);
  const [currentMappingFile, setCurrentMappingFile] = useState<'region' | 'aquifer' | 'wells' | 'waterLevels' | null>(null);

  const [logs, setLogs] = useState<{msg: string, type: 'info'|'success'|'error'|'warning'}[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const addLog = (msg: string, type: 'info'|'success'|'error'|'warning' = 'info') => {
    setLogs(prev => [...prev, { msg, type }]);
  };

  // Generate folder name from region name
  const getFolderName = (name: string) => {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  };

  // Validate region name
  const validateRegionName = (name: string) => {
    if (!name.trim()) {
      setRegionNameError('Region name is required');
      return false;
    }
    const folderName = getFolderName(name);
    if (existingRegions.includes(folderName)) {
      setRegionNameError(`A region with folder name "${folderName}" already exists`);
      return false;
    }
    setRegionNameError('');
    return true;
  };

  // Parse CSV text into rows
  const parseCSV = (text: string): { headers: string[]; rows: Record<string, string>[] } => {
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length < 1) return { headers: [], rows: [] };

    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    const headers = lines[0].split(delimiter).map(h => h.trim());

    const rows = lines.slice(1).map(line => {
      const values = line.split(delimiter);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = values[i]?.trim() || ''; });
      return row;
    });

    return { headers, rows };
  };

  // Parse date based on format
  const parseDate = (dateStr: string, format: string): string => {
    if (!dateStr) return '';

    let parts: string[];
    let year: string, month: string, day: string;

    try {
      switch (format) {
        case 'iso':
          // YYYY-MM-DD
          parts = dateStr.split('-');
          if (parts.length === 3) {
            return dateStr; // Already in ISO format
          }
          break;
        case 'us':
        case 'us-short':
          // MM/DD/YYYY or M/D/YYYY
          parts = dateStr.split('/');
          if (parts.length === 3) {
            month = parts[0].padStart(2, '0');
            day = parts[1].padStart(2, '0');
            year = parts[2].length === 2 ? '20' + parts[2] : parts[2];
            return `${year}-${month}-${day}`;
          }
          break;
        case 'eu':
        case 'eu-short':
          // DD/MM/YYYY or D/M/YYYY
          parts = dateStr.split('/');
          if (parts.length === 3) {
            day = parts[0].padStart(2, '0');
            month = parts[1].padStart(2, '0');
            year = parts[2].length === 2 ? '20' + parts[2] : parts[2];
            return `${year}-${month}-${day}`;
          }
          break;
      }
    } catch (e) {
      // Fall through to return original
    }

    return dateStr; // Return original if parsing fails
  };

  // Handle file upload
  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    fileType: 'region' | 'aquifer' | 'wells' | 'waterLevels'
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    addLog(`Processing ${file.name}...`, 'info');
    setIsProcessing(true);

    try {
      const isZip = file.name.endsWith('.zip');
      const isGeoJSON = file.name.endsWith('.geojson') || file.name.endsWith('.json');
      const isCSV = file.name.endsWith('.csv') || file.name.endsWith('.txt');

      let uploadedFile: UploadedFile;

      if (isZip) {
        // Shapefile in zip - convert to GeoJSON
        const buffer = await file.arrayBuffer();
        const geojson = await shp(buffer);
        const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
        const columns = features.length > 0 ? Object.keys(features[0].properties || {}) : [];

        uploadedFile = {
          name: file.name,
          data: geojson,
          columns,
          mapping: {},
          type: 'geojson'
        };
        addLog(`Converted shapefile to GeoJSON with ${features.length} features`, 'success');
      } else if (isGeoJSON) {
        const text = await file.text();
        const geojson = JSON.parse(text);
        const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
        const columns = features.length > 0 ? Object.keys(features[0].properties || {}) : [];

        uploadedFile = {
          name: file.name,
          data: geojson,
          columns,
          mapping: {},
          type: 'geojson'
        };
        addLog(`Loaded GeoJSON with ${features.length} features`, 'success');
      } else if (isCSV) {
        const text = await file.text();
        const { headers, rows } = parseCSV(text);

        uploadedFile = {
          name: file.name,
          data: rows,
          columns: headers,
          mapping: {},
          type: 'csv'
        };
        addLog(`Loaded CSV with ${rows.length} rows and ${headers.length} columns`, 'success');
      } else {
        addLog(`Unsupported file type: ${file.name}`, 'error');
        setIsProcessing(false);
        return;
      }

      // Auto-map columns if possible
      uploadedFile.mapping = autoMapColumns(uploadedFile.columns, fileType);

      // Set the file
      switch (fileType) {
        case 'region':
          setRegionFile(uploadedFile);
          break;
        case 'aquifer':
          setAquiferFile(uploadedFile);
          break;
        case 'wells':
          setWellsFile(uploadedFile);
          break;
        case 'waterLevels':
          setWaterLevelsFile(uploadedFile);
          break;
      }

      // Show column mapper (skip for region files - no mapping needed)
      if (fileType !== 'region') {
        setCurrentMappingFile(fileType);
        setShowColumnMapper(true);
      }
    } catch (err) {
      addLog(`Failed to process file: ${err}`, 'error');
    }

    setIsProcessing(false);
  };

  // Auto-map columns based on common names
  const autoMapColumns = (columns: string[], fileType: string): ColumnMapping => {
    const mapping: ColumnMapping = {};
    const lowerColumns = columns.map(c => c.toLowerCase());

    if (fileType === 'region') {
      // No mapping needed - region name is entered manually
    } else if (fileType === 'aquifer') {
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
      const latIdx = lowerColumns.findIndex(c => c === 'lat' || c.includes('latitude') || c === 'lat_dec');
      const longIdx = lowerColumns.findIndex(c => c === 'long' || c === 'lng' || c.includes('longitude') || c === 'long_dec');
      const aqIdIdx = lowerColumns.findIndex(c => c.includes('aquifer') && c.includes('id') || c === 'aquifer_id');

      if (wellIdIdx >= 0) mapping['well_id'] = columns[wellIdIdx];
      if (latIdx >= 0) mapping['lat'] = columns[latIdx];
      if (longIdx >= 0) mapping['long'] = columns[longIdx];
      if (aqIdIdx >= 0) mapping['aquifer_id'] = columns[aqIdIdx];
    } else if (fileType === 'waterLevels') {
      const wellIdIdx = lowerColumns.findIndex(c => c.includes('well') && c.includes('id') || c === 'well_id');
      const dateIdx = lowerColumns.findIndex(c => c === 'date' || c.includes('date'));
      const wteIdx = lowerColumns.findIndex(c => c === 'wte' || c.includes('elevation') || c.includes('level'));
      const aqIdIdx = lowerColumns.findIndex(c => c.includes('aquifer') && c.includes('id') || c === 'aquifer_id');

      if (wellIdIdx >= 0) mapping['well_id'] = columns[wellIdIdx];
      if (dateIdx >= 0) mapping['date'] = columns[dateIdx];
      if (wteIdx >= 0) mapping['wte'] = columns[wteIdx];
      if (aqIdIdx >= 0) mapping['aquifer_id'] = columns[aqIdIdx];
    }

    return mapping;
  };

  // Get required columns for each file type
  const getRequiredColumns = (fileType: string): { key: string; label: string; required: boolean }[] => {
    switch (fileType) {
      case 'region':
        return []; // Region name is entered manually in Step 1
      case 'aquifer':
        return [
          { key: 'aquifer_id', label: 'Aquifer ID', required: true },
          { key: 'aquifer_name', label: 'Aquifer Name', required: true }
        ];
      case 'wells':
        return [
          { key: 'well_id', label: 'Well ID', required: true },
          { key: 'lat', label: 'Latitude', required: true },
          { key: 'long', label: 'Longitude', required: true },
          { key: 'aquifer_id', label: 'Aquifer ID', required: false }
        ];
      case 'waterLevels':
        return [
          { key: 'well_id', label: 'Well ID', required: true },
          { key: 'date', label: 'Date', required: true },
          { key: 'wte', label: 'Water Table Elevation', required: true },
          { key: 'aquifer_id', label: 'Aquifer ID', required: false }
        ];
      default:
        return [];
    }
  };

  // Update mapping for current file
  const updateMapping = (targetColumn: string, sourceColumn: string) => {
    const updateFile = (file: UploadedFile | null): UploadedFile | null => {
      if (!file) return null;
      return { ...file, mapping: { ...file.mapping, [targetColumn]: sourceColumn } };
    };

    switch (currentMappingFile) {
      case 'region':
        setRegionFile(updateFile(regionFile));
        break;
      case 'aquifer':
        setAquiferFile(updateFile(aquiferFile));
        break;
      case 'wells':
        setWellsFile(updateFile(wellsFile));
        break;
      case 'waterLevels':
        setWaterLevelsFile(updateFile(waterLevelsFile));
        break;
    }
  };

  // Get current file being mapped
  const getCurrentFile = (): UploadedFile | null => {
    switch (currentMappingFile) {
      case 'region': return regionFile;
      case 'aquifer': return aquiferFile;
      case 'wells': return wellsFile;
      case 'waterLevels': return waterLevelsFile;
      default: return null;
    }
  };

  // Validate all data
  const validateData = (): ValidationResult => {
    const errors: string[] = [];
    const warnings: string[] = [];
    let droppedMeasurements = 0;

    // Check required files
    if (!regionFile) errors.push('Region file is required');
    if (!aquiferFile) errors.push('Aquifer file is required');
    if (!wellsFile) errors.push('Wells file is required');
    if (!waterLevelsFile) errors.push('Water levels file is required');

    if (errors.length > 0) {
      return { isValid: false, errors, warnings, droppedMeasurements };
    }

    // Check required mappings
    const checkMapping = (file: UploadedFile, fileType: string) => {
      const required = getRequiredColumns(fileType).filter(c => c.required);
      for (const col of required) {
        if (!file.mapping[col.key]) {
          errors.push(`${fileType}: Missing mapping for ${col.label}`);
        }
      }
    };

    // Region has no required mappings - name comes from Step 1
    checkMapping(aquiferFile!, 'aquifer');
    checkMapping(wellsFile!, 'wells');
    checkMapping(waterLevelsFile!, 'waterLevels');

    if (errors.length > 0) {
      return { isValid: false, errors, warnings, droppedMeasurements };
    }

    // Get aquifer IDs from aquifer file
    const aquiferIds = new Set<string>();
    const aquiferFeatures = aquiferFile!.data.type === 'FeatureCollection'
      ? aquiferFile!.data.features
      : [aquiferFile!.data];
    for (const feature of aquiferFeatures) {
      const id = feature.properties?.[aquiferFile!.mapping['aquifer_id']];
      if (id) aquiferIds.add(String(id));
    }

    // Get well IDs and check aquifer references
    const wellIds = new Set<string>();
    const wellsData = wellsFile!.data as Record<string, string>[];
    const wellIdCol = wellsFile!.mapping['well_id'];
    const wellAqIdCol = wellsFile!.mapping['aquifer_id'];

    for (const well of wellsData) {
      const wellId = well[wellIdCol];
      if (wellId) wellIds.add(wellId);

      if (wellAqIdCol && well[wellAqIdCol]) {
        const aqId = well[wellAqIdCol];
        if (!aquiferIds.has(aqId)) {
          errors.push(`Well ${wellId} references non-existent aquifer ${aqId}`);
        }
      }
    }

    if (!wellAqIdCol) {
      warnings.push('Wells file has no aquifer_id column. Point-in-polygon assignment will be attempted.');
    }

    // Check water levels reference valid wells
    const waterLevelsData = waterLevelsFile!.data as Record<string, string>[];
    const wlWellIdCol = waterLevelsFile!.mapping['well_id'];
    const validMeasurements: Record<string, string>[] = [];

    for (const measurement of waterLevelsData) {
      const wellId = measurement[wlWellIdCol];
      if (wellIds.has(wellId)) {
        validMeasurements.push(measurement);
      } else {
        droppedMeasurements++;
      }
    }

    if (droppedMeasurements > 0) {
      warnings.push(`${droppedMeasurements} measurements reference non-existent wells and will be dropped`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      droppedMeasurements
    };
  };

  // Process and generate output files
  const processData = async () => {
    setIsProcessing(true);
    addLog('Validating data...', 'info');

    const result = validateData();
    setValidation(result);

    if (!result.isValid) {
      for (const err of result.errors) {
        addLog(err, 'error');
      }
      setIsProcessing(false);
      return;
    }

    for (const warn of result.warnings) {
      addLog(warn, 'warning');
    }

    addLog('Processing files...', 'info');

    try {
      // Process region GeoJSON
      const regionFeatures = regionFile!.data.type === 'FeatureCollection'
        ? regionFile!.data.features
        : [regionFile!.data];

      const processedRegion = {
        type: 'FeatureCollection',
        features: regionFeatures.map((f: any) => ({
          type: 'Feature',
          properties: {
            region_id: getFolderName(regionName),
            region_name: regionName
          },
          geometry: f.geometry
        }))
      };

      // Process aquifers GeoJSON
      const aquiferFeatures = aquiferFile!.data.type === 'FeatureCollection'
        ? aquiferFile!.data.features
        : [aquiferFile!.data];

      const processedAquifers = {
        type: 'FeatureCollection',
        features: aquiferFeatures.map((f: any) => ({
          type: 'Feature',
          properties: {
            aquifer_id: String(f.properties?.[aquiferFile!.mapping['aquifer_id']] || ''),
            aquifer_name: f.properties?.[aquiferFile!.mapping['aquifer_name']] || ''
          },
          geometry: f.geometry
        }))
      };

      // Process wells CSV
      const wellsData = wellsFile!.data as Record<string, string>[];
      const wellIdCol = wellsFile!.mapping['well_id'];
      const latCol = wellsFile!.mapping['lat'];
      const longCol = wellsFile!.mapping['long'];
      const wellAqIdCol = wellsFile!.mapping['aquifer_id'];

      const processedWells = wellsData.map(w => ({
        well_id: w[wellIdCol] || '',
        lat: w[latCol] || '',
        long: w[longCol] || '',
        aquifer_id: wellAqIdCol ? w[wellAqIdCol] || '' : ''
      })).filter(w => w.well_id && w.lat && w.long);

      // Process water levels CSV
      const waterLevelsData = waterLevelsFile!.data as Record<string, string>[];
      const wlWellIdCol = waterLevelsFile!.mapping['well_id'];
      const dateCol = waterLevelsFile!.mapping['date'];
      const wteCol = waterLevelsFile!.mapping['wte'];
      const wlAqIdCol = waterLevelsFile!.mapping['aquifer_id'];

      const wellIdSet = new Set(processedWells.map(w => w.well_id));
      const processedWaterLevels = waterLevelsData
        .filter(m => wellIdSet.has(m[wlWellIdCol]))
        .map(m => ({
          well_id: m[wlWellIdCol] || '',
          date: parseDate(m[dateCol] || '', dateFormat),
          wte: m[wteCol] || '',
          aquifer_id: wlAqIdCol ? m[wlAqIdCol] || '' : ''
        }));

      // Generate CSV strings
      const wellsCsv = 'well_id,lat,long,aquifer_id\n' +
        processedWells.map(w => `${w.well_id},${w.lat},${w.long},${w.aquifer_id}`).join('\n');

      const waterLevelsCsv = 'well_id,date,wte,aquifer_id\n' +
        processedWaterLevels.map(m => `${m.well_id},${m.date},${m.wte},${m.aquifer_id}`).join('\n');

      addLog(`Processed ${processedWells.length} wells`, 'success');
      addLog(`Processed ${processedWaterLevels.length} measurements`, 'success');

      // Create downloadable files
      const folderName = getFolderName(regionName);

      // Fetch current regions.json and add new region
      let regionsManifest: { id: string; path: string; name: string }[] = [];
      try {
        const response = await fetch('/data/regions.json');
        if (response.ok) {
          regionsManifest = await response.json();
        }
      } catch (e) {
        // Start with empty array if manifest doesn't exist
      }

      // Add new region if not already present
      if (!regionsManifest.find(r => r.id === folderName)) {
        regionsManifest.push({
          id: folderName,
          path: `/data/${folderName}`,
          name: regionName
        });
      }

      // Create zip file with all data
      const zip = new JSZip();
      const regionFolder = zip.folder(folderName);
      regionFolder?.file('region.geojson', JSON.stringify(processedRegion, null, 2));
      regionFolder?.file('aquifers.geojson', JSON.stringify(processedAquifers, null, 2));
      regionFolder?.file('wells.csv', wellsCsv);
      regionFolder?.file('water_levels.csv', waterLevelsCsv);
      zip.file('regions.json', JSON.stringify(regionsManifest, null, 2));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      setZipFile({ name: `${folderName}.zip`, blob: zipBlob });

      addLog(`Zip file ready: ${folderName}.zip`, 'success');
      addLog(`Extract to public/data/ and refresh the app`, 'info');

      setStep(6);

    } catch (err) {
      addLog(`Processing failed: ${err}`, 'error');
    }

    setIsProcessing(false);
  };

  const [zipFile, setZipFile] = useState<{ name: string; blob: Blob } | null>(null);

  const downloadZip = () => {
    if (!zipFile) return;
    const url = URL.createObjectURL(zipFile.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = zipFile.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Column Mapper Modal
  const renderColumnMapper = () => {
    const file = getCurrentFile();
    if (!file || !currentMappingFile) return null;

    const requiredColumns = getRequiredColumns(currentMappingFile);
    const fileTypeLabels: Record<string, string> = {
      region: 'Region',
      aquifer: 'Aquifers',
      wells: 'Wells',
      waterLevels: 'Water Levels'
    };

    return (
      <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-slate-900/60">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6">
          <h3 className="text-lg font-bold text-slate-800 mb-4">
            Map Columns - {fileTypeLabels[currentMappingFile]}
          </h3>
          <p className="text-sm text-slate-500 mb-4">
            Map your file columns to the required fields. File: {file.name}
          </p>

          <div className="space-y-3 mb-6">
            {requiredColumns.map(col => (
              <div key={col.key} className="flex items-center space-x-3">
                <label className="w-40 text-sm font-medium text-slate-700">
                  {col.label}
                  {col.required && <span className="text-red-500 ml-1">*</span>}
                </label>
                <select
                  value={file.mapping[col.key] || ''}
                  onChange={(e) => updateMapping(col.key, e.target.value)}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">-- Select Column --</option>
                  {file.columns.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            ))}

            {currentMappingFile === 'waterLevels' && (
              <div className="flex items-center space-x-3 pt-2 border-t">
                <label className="w-40 text-sm font-medium text-slate-700">
                  Date Format
                </label>
                <select
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value)}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {DATE_FORMATS.map(f => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setShowColumnMapper(false)}
              className="px-4 py-2 bg-slate-800 text-white rounded-lg font-medium text-sm hover:bg-slate-700"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  };

  // File upload card component
  const FileUploadCard = ({
    title,
    icon: Icon,
    fileType,
    file,
    accept,
    color
  }: {
    title: string;
    icon: any;
    fileType: 'region' | 'aquifer' | 'wells' | 'waterLevels';
    file: UploadedFile | null;
    accept: string;
    color: string;
  }) => (
    <div className={`border rounded-xl p-4 ${file ? 'border-green-300 bg-green-50' : 'border-slate-200 bg-slate-50/50'}`}>
      <div className="flex items-center space-x-3 mb-3">
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon size={20} />
        </div>
        <div>
          <h3 className="font-semibold text-slate-700">{title}</h3>
          {file && <p className="text-xs text-green-600">{file.name}</p>}
        </div>
        {file && (
          <CheckCircle2 className="ml-auto text-green-500" size={20} />
        )}
      </div>
      <label className="block w-full">
        <input
          type="file"
          accept={accept}
          onChange={(e) => handleFileUpload(e, fileType)}
          className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
        />
      </label>
      {file && fileType !== 'region' && (
        <button
          onClick={() => {
            setCurrentMappingFile(fileType);
            setShowColumnMapper(true);
          }}
          className="mt-2 text-xs text-blue-600 hover:text-blue-800 font-medium"
        >
          Edit Column Mapping
        </button>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh] overflow-hidden">
        <header className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-800">Import New Region</h2>
            <p className="text-xs text-slate-500 font-medium">Step {step} of 6</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
            <X size={20} />
          </button>
        </header>

        <div className="p-6 overflow-y-auto flex-1">
          {/* Step 1: Region Name */}
          {step === 1 && (
            <div>
              <h3 className="text-lg font-semibold text-slate-800 mb-4">Enter Region Name</h3>
              <input
                type="text"
                value={regionName}
                onChange={(e) => {
                  setRegionName(e.target.value);
                  validateRegionName(e.target.value);
                }}
                placeholder="e.g., California Central Valley"
                className="w-full px-4 py-3 border border-slate-300 rounded-lg text-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              {regionNameError && (
                <p className="mt-2 text-sm text-red-600">{regionNameError}</p>
              )}
              {regionName && !regionNameError && (
                <p className="mt-2 text-sm text-slate-500">
                  Folder name: <span className="font-mono text-slate-700">{getFolderName(regionName)}</span>
                </p>
              )}
            </div>
          )}

          {/* Step 2: Upload Region File */}
          {step === 2 && (
            <div>
              <h3 className="text-lg font-semibold text-slate-800 mb-4">Upload Region Boundary</h3>
              <p className="text-sm text-slate-500 mb-4">
                Upload a GeoJSON file or a zipped Shapefile (.shp.zip) containing the region boundary.
              </p>
              <FileUploadCard
                title="Region Boundary"
                icon={MapPin}
                fileType="region"
                file={regionFile}
                accept=".geojson,.json,.zip"
                color="bg-blue-100 text-blue-600"
              />
            </div>
          )}

          {/* Step 3: Upload Aquifers File */}
          {step === 3 && (
            <div>
              <h3 className="text-lg font-semibold text-slate-800 mb-4">Upload Aquifers</h3>
              <p className="text-sm text-slate-500 mb-4">
                Upload a GeoJSON file or a zipped Shapefile containing aquifer boundaries.
              </p>
              <FileUploadCard
                title="Aquifer Boundaries"
                icon={Layers}
                fileType="aquifer"
                file={aquiferFile}
                accept=".geojson,.json,.zip"
                color="bg-indigo-100 text-indigo-600"
              />
            </div>
          )}

          {/* Step 4: Upload Wells File */}
          {step === 4 && (
            <div>
              <h3 className="text-lg font-semibold text-slate-800 mb-4">Upload Wells</h3>
              <p className="text-sm text-slate-500 mb-4">
                Upload a CSV file containing well locations. Required: well_id, latitude, longitude.
              </p>
              <FileUploadCard
                title="Wells"
                icon={FileText}
                fileType="wells"
                file={wellsFile}
                accept=".csv,.txt"
                color="bg-green-100 text-green-600"
              />
            </div>
          )}

          {/* Step 5: Upload Water Levels File */}
          {step === 5 && (
            <div>
              <h3 className="text-lg font-semibold text-slate-800 mb-4">Upload Water Levels</h3>
              <p className="text-sm text-slate-500 mb-4">
                Upload a CSV file containing water level measurements. Required: well_id, date, wte.
              </p>
              <FileUploadCard
                title="Water Levels"
                icon={Droplets}
                fileType="waterLevels"
                file={waterLevelsFile}
                accept=".csv,.txt"
                color="bg-cyan-100 text-cyan-600"
              />
            </div>
          )}

          {/* Step 6: Download Files */}
          {step === 6 && (
            <div>
              <h3 className="text-lg font-semibold text-slate-800 mb-4">Download & Install</h3>

              {zipFile && (
                <div className="flex flex-col items-center justify-center p-8 bg-slate-50 rounded-xl border-2 border-dashed border-slate-300 mb-4">
                  <div className="p-4 bg-blue-100 rounded-full mb-4">
                    <Download size={32} className="text-blue-600" />
                  </div>
                  <p className="text-lg font-semibold text-slate-700 mb-2">{zipFile.name}</p>
                  <p className="text-sm text-slate-500 mb-4">Contains region data and updated manifest</p>
                  <button
                    onClick={downloadZip}
                    className="flex items-center space-x-2 px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
                  >
                    <Download size={20} />
                    <span>Download Zip</span>
                  </button>
                </div>
              )}

              <div className="p-4 bg-slate-100 rounded-lg mb-4">
                <p className="text-sm font-medium text-slate-700 mb-2">Zip contents:</p>
                <ul className="text-sm text-slate-600 font-mono space-y-1">
                  <li>{getFolderName(regionName)}/region.geojson</li>
                  <li>{getFolderName(regionName)}/aquifers.geojson</li>
                  <li>{getFolderName(regionName)}/wells.csv</li>
                  <li>{getFolderName(regionName)}/water_levels.csv</li>
                  <li>regions.json</li>
                </ul>
              </div>

              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm text-amber-800">
                  <strong>Instructions:</strong> Extract the zip into <span className="font-mono">public/data/</span> and refresh the app.
                </p>
              </div>
            </div>
          )}

          {/* Activity Logs */}
          {logs.length > 0 && (
            <div className="mt-6 bg-slate-900 rounded-xl p-4 font-mono text-sm max-h-40 overflow-y-auto">
              {logs.map((log, i) => (
                <div key={i} className={`flex items-start space-x-2 mb-1 ${
                  log.type === 'success' ? 'text-green-400' :
                  log.type === 'error' ? 'text-red-400' :
                  log.type === 'warning' ? 'text-yellow-400' : 'text-blue-300'
                }`}>
                  {log.type === 'success' ? <CheckCircle2 size={12} className="mt-1" /> :
                   log.type === 'error' ? <AlertCircle size={12} className="mt-1" /> :
                   <AlertCircle size={12} className="mt-1" />}
                  <span>{log.msg}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
          <button
            onClick={() => step > 1 && setStep(step - 1)}
            disabled={step === 1 || step === 6}
            className="flex items-center space-x-2 text-slate-600 hover:text-slate-800 text-sm font-semibold px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
            <span>Back</span>
          </button>

          {step < 5 && (
            <button
              onClick={() => {
                if (step === 1 && !validateRegionName(regionName)) return;
                setStep(step + 1);
              }}
              disabled={
                (step === 1 && !regionName) ||
                (step === 2 && !regionFile) ||
                (step === 3 && !aquiferFile) ||
                (step === 4 && !wellsFile)
              }
              className="flex items-center space-x-2 px-6 py-2 bg-slate-800 text-white rounded-lg font-bold text-sm hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>Next</span>
              <ChevronRight size={16} />
            </button>
          )}

          {step === 5 && (
            <button
              onClick={processData}
              disabled={!waterLevelsFile || isProcessing}
              className="flex items-center space-x-2 px-6 py-2 bg-green-600 text-white rounded-lg font-bold text-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>{isProcessing ? 'Processing...' : 'Process & Generate Files'}</span>
            </button>
          )}

          {step === 6 && (
            <button
              onClick={onClose}
              className="px-6 py-2 bg-slate-800 text-white rounded-lg font-bold text-sm hover:bg-slate-700"
            >
              Done
            </button>
          )}
        </footer>
      </div>

      {showColumnMapper && renderColumnMapper()}
    </div>
  );
};

export default DataManager;
