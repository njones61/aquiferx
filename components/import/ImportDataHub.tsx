import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, MapPin, Layers, Navigation, BarChart3, Plus, Settings } from 'lucide-react';
import { RegionMeta, DataType, ParameterCatalog } from '../../types';
import { listRegions, readJson, readText } from '../../services/dataStore';
import { loadCatalog, computeEffectiveDataTypes } from '../../services/catalog';
import RegionImporter from './RegionImporter';
import AquiferImporter from './AquiferImporter';
import WellImporter from './WellImporter';
import MeasurementImporter from './MeasurementImporter';
import DataTypeEditor from './DataTypeEditor';

interface ImportDataHubProps {
  onClose: () => void;
  onDataChanged: () => void;
  initialRegionId?: string | null;
}

interface RegionInfo extends RegionMeta {
  aquiferCount: number;
  wellCount: number;
  measurementCounts: Record<string, number>;
  effectiveDataTypes: DataType[];
  bounds: [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]
}

async function fetchRegionList(catalog: ParameterCatalog | null): Promise<RegionInfo[]> {
  // Imports only ever write to My Data, so the hub lists only those regions
  const rawMetas: any[] = (await listRegions()).filter(r => r.source === 'mine');
  // Normalize legacy dataTypes → customDataTypes in memory
  const metas: RegionMeta[] = rawMetas.map(m => ({
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

  const infos: RegionInfo[] = [];
  for (const meta of metas) {
    const effectiveDataTypes = computeEffectiveDataTypes(meta, catalog);
    const info: RegionInfo = {
      ...meta,
      aquiferCount: 0,
      wellCount: 0,
      measurementCounts: {},
      effectiveDataTypes,
      bounds: [0, 0, 0, 0]
    };

    // Load region bounds from geojson
    try {
      const gj = await readJson(`${meta.id}/region.geojson`);
      if (gj) {
        const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        const visitCoords = (arr: any) => {
          if (typeof arr[0] === 'number') {
            const [lng, lat] = arr;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
          } else {
            for (const child of arr) visitCoords(child);
          }
        };
        for (const f of features) {
          const coords = f.geometry?.coordinates;
          if (!coords) continue;
          visitCoords(coords);
        }
        info.bounds = [minLat, minLng, maxLat, maxLng];
      }
    } catch {}

    // Count aquifers
    try {
      const gj = await readJson(`${meta.id}/aquifers.geojson`);
      if (gj) {
        const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
        const ids = new Set(features.map((f: any) => String(f.properties?.aquifer_id || '')));
        info.aquiferCount = ids.size;
      }
    } catch {}

    // Count wells
    try {
      const text = await readText(`${meta.id}/wells.csv`);
      if (text !== null) {
        info.wellCount = Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
      }
    } catch {}

    // Count measurements per data type — iterate scanned data files so the
    // counts reflect disk state, not a stale metadata list.
    for (const f of meta.dataFiles || []) {
      const m = /^data_(.+)\.csv$/.exec(f);
      if (!m) continue;
      const code = m[1];
      try {
        const text = await readText(`${meta.id}/${f}`);
        if (text !== null) {
          info.measurementCounts[code] = Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
        }
      } catch {}
    }

    infos.push(info);
  }
  return infos;
}

interface DataCardProps {
  icon: React.ReactNode;
  tint: string;
  title: string;
  count: number;
  /** Why the card can't be used yet; empty when it can. */
  blocked: string;
  detail?: React.ReactNode;
  children: React.ReactNode;
}

const DataCard: React.FC<DataCardProps> = ({ icon, tint, title, count, blocked, detail, children }) => (
  <div className="border rounded-xl p-4 flex flex-col">
    <div className={`flex items-center gap-2 mb-2 ${blocked ? 'opacity-50' : ''}`}>
      <div className={`p-1.5 rounded-lg ${tint}`}>{icon}</div>
      <h4 className="font-semibold text-slate-700 text-sm">{title}</h4>
    </div>
    <p className={`text-2xl font-bold text-slate-800 mb-2 ${blocked ? 'opacity-50' : ''}`}>{count}</p>
    {!blocked && detail}
    <div className="mt-auto">
      {blocked ? <p className="text-xs text-slate-500 leading-snug">{blocked}</p> : children}
    </div>
  </div>
);

const ImportDataHub: React.FC<ImportDataHubProps> = ({ onClose, onDataChanged, initialRegionId }) => {
  const [regionList, setRegionList] = useState<RegionInfo[]>([]);
  const [catalog, setCatalog] = useState<ParameterCatalog | null>(null);
  const [activeRegionId, setActiveRegionId] = useState<string | null>(initialRegionId || null);
  const [activeWizard, setActiveWizard] = useState<'region' | 'aquifer' | 'well' | 'measurement' | 'datatypes' | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadRegions = async () => {
    setIsLoading(true);
    try {
      let cat = catalog;
      if (!cat) {
        try {
          cat = await loadCatalog();
          setCatalog(cat);
        } catch {}
      }
      const list = await fetchRegionList(cat);
      setRegionList(list);
    } catch (err) {
      console.warn('Failed to load region list:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadRegions(); }, []);

  const activeRegion = useMemo(() =>
    regionList.find(r => r.id === activeRegionId) || null,
  [regionList, activeRegionId]);

  const handleSubWizardComplete = () => {
    setActiveWizard(null);
    loadRegions();
    onDataChanged();
  };

  // A card that can't be used yet is dimmed, with the reason under it
  const noRegion = !activeRegion;
  const isSingleUnit = activeRegion?.singleUnit || false;
  const noAquifers = (activeRegion?.aquiferCount || 0) === 0;
  const PICK_REGION = 'Choose a region above.';
  const NEED_AQUIFERS = 'Add aquifers first, or make this a single-unit region (region menu → Edit).';

  const aquifersBlocked = noRegion ? PICK_REGION : isSingleUnit
    ? 'This is a single-unit region, so it has no aquifers. To add them, turn off single-unit (region menu → Edit).'
    : '';
  const wellsBlocked = noRegion ? PICK_REGION : (!isSingleUnit && noAquifers) ? NEED_AQUIFERS : '';
  // Measurements don't need wells: a CSV with locations can create them.
  // A multi-unit region still needs aquifers to assign them to.
  const measurementsBlocked = wellsBlocked;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[90vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <header className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-800">Add Data</h2>
            <p className="text-xs text-slate-500 font-medium">Add regions, aquifers, wells and measurements to My Data</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
              <X size={20} />
            </button>
          </div>
        </header>

        <div className="p-6 overflow-y-auto flex-1">
          {/* Region selector */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <MapPin size={14} /> Regions
              </h3>
              <button
                onClick={() => setActiveWizard('region')}
                className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-md text-xs font-medium hover:bg-blue-100 transition-colors"
              >
                <Plus size={14} /> Add Region
              </button>
            </div>

            {isLoading ? (
              <p className="text-sm text-slate-400 italic">Loading regions...</p>
            ) : regionList.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No regions yet. Add one to get started.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {regionList.map(r => (
                  <button
                    key={r.id}
                    onClick={() => setActiveRegionId(activeRegionId === r.id ? null : r.id)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      activeRegionId === r.id
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-blue-300 hover:bg-blue-50'
                    }`}
                  >
                    {r.name}
                    {r.singleUnit && <span className="ml-1 text-xs opacity-70">(single)</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Data cards */}
          <div className="grid grid-cols-3 gap-4">
            <DataCard
              icon={<Layers size={16} />} tint="bg-indigo-100 text-indigo-600" title="Aquifers"
              count={activeRegion?.aquiferCount || 0} blocked={aquifersBlocked}
            >
              <button
                onClick={() => setActiveWizard('aquifer')}
                className="w-full flex items-center gap-1 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-md text-xs font-medium hover:bg-indigo-100 transition-colors justify-center"
              >
                <Plus size={14} /> Add Aquifers
              </button>
            </DataCard>

            <DataCard
              icon={<Navigation size={16} />} tint="bg-green-100 text-green-600" title="Wells"
              count={activeRegion?.wellCount || 0} blocked={wellsBlocked}
            >
              <button
                onClick={() => setActiveWizard('well')}
                className="flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-700 rounded-md text-xs font-medium hover:bg-green-100 transition-colors w-full justify-center"
              >
                <Plus size={14} /> Add Wells
              </button>
            </DataCard>

            <DataCard
              icon={<BarChart3 size={16} />} tint="bg-cyan-100 text-cyan-600" title="Measurements"
              count={Object.values(activeRegion?.measurementCounts || {}).reduce((a: number, b: number) => a + b, 0)}
              blocked={measurementsBlocked}
              detail={activeRegion && activeRegion.effectiveDataTypes.length > 0 && (
                <ul className="text-xs text-slate-500 mb-2 space-y-0.5">
                  {activeRegion.effectiveDataTypes.map(dt => (
                    <li key={dt.code} className="flex justify-between gap-2">
                      <span className="truncate">{dt.name}</span>
                      <span className="tabular-nums">{activeRegion.measurementCounts[dt.code] || 0}</span>
                    </li>
                  ))}
                </ul>
              )}
            >
              <div className="flex gap-2">
                <button
                  onClick={() => setActiveWizard('measurement')}
                  className="flex-1 flex items-center gap-1 px-3 py-1.5 bg-cyan-50 text-cyan-700 rounded-md text-xs font-medium hover:bg-cyan-100 transition-colors justify-center"
                >
                  <Plus size={14} /> Add Measurements
                </button>
                <button
                  onClick={() => setActiveWizard('datatypes')}
                  className="p-1.5 bg-slate-100 text-slate-500 rounded-md hover:bg-slate-200 hover:text-slate-700 transition-colors"
                  title="Rename or delete this region's custom data types"
                >
                  <Settings size={14} />
                </button>
              </div>
            </DataCard>
          </div>
        </div>

        <footer className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-slate-800 text-slate-50 rounded-lg font-bold text-sm hover:bg-slate-700"
          >
            Done
          </button>
        </footer>
      </div>

      {/* Sub-wizards */}
      {activeWizard === 'region' && (
        <RegionImporter
          existingRegionIds={regionList.map(r => r.id)}
          onComplete={(id) => { setActiveRegionId(id); handleSubWizardComplete(); }}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'aquifer' && activeRegion && (
        <AquiferImporter
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          existingAquiferCount={activeRegion.aquiferCount}
          onComplete={handleSubWizardComplete}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'well' && activeRegion && (
        <WellImporter
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          lengthUnit={activeRegion.lengthUnit}
          singleUnit={activeRegion.singleUnit}
          regionBounds={activeRegion.bounds}
          aquiferCount={activeRegion.aquiferCount}
          existingWellCount={activeRegion.wellCount}
          onComplete={handleSubWizardComplete}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'measurement' && activeRegion && (
        <MeasurementImporter
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          lengthUnit={activeRegion.lengthUnit}
          singleUnit={activeRegion.singleUnit}
          dataTypes={activeRegion.effectiveDataTypes}
          customDataTypes={activeRegion.customDataTypes}
          regionBounds={activeRegion.bounds}
          existingWellCount={activeRegion.wellCount}
          onComplete={handleSubWizardComplete}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'datatypes' && activeRegion && (
        <DataTypeEditor
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          lengthUnit={activeRegion.lengthUnit}
          customDataTypes={activeRegion.customDataTypes}
          singleUnit={activeRegion.singleUnit}
          onUpdate={() => { loadRegions(); onDataChanged(); }}
          onClose={() => setActiveWizard(null)}
        />
      )}
    </div>
  );
};

export default ImportDataHub;
