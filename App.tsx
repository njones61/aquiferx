
import React, { useState, useMemo, useEffect } from 'react';
import { Layers, Map as MapIcon, Database, ChevronRight, Activity, Upload, Loader2 } from 'lucide-react';
import { Region, Aquifer, Well, Measurement } from './types';
import { loadAllData } from './services/dataLoader';
import MapView from './components/MapView';
import Sidebar from './components/Sidebar';
import TimeSeriesChart from './components/TimeSeriesChart';
import DataManager from './components/DataManager';

const App: React.FC = () => {
  const [regions, setRegions] = useState<Region[]>([]);
  const [aquifers, setAquifers] = useState<Aquifer[]>([]);
  const [wells, setWells] = useState<Well[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null);
  const [selectedAquifer, setSelectedAquifer] = useState<Aquifer | null>(null);
  const [selectedWell, setSelectedWell] = useState<Well | null>(null);
  const [isDataManagerOpen, setIsDataManagerOpen] = useState(false);

  // Load data on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        setLoadError(null);
        const data = await loadAllData();
        setRegions(data.regions);
        setAquifers(data.aquifers);
        setWells(data.wells);
        setMeasurements(data.measurements);
        console.log(`Loaded: ${data.regions.length} regions, ${data.aquifers.length} aquifers, ${data.wells.length} wells, ${data.measurements.length} measurements`);
      } catch (e) {
        console.error('Failed to load data:', e);
        setLoadError(e instanceof Error ? e.message : 'Failed to load data');
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  // Filtered views
  const filteredAquifers = useMemo(() => 
    selectedRegion ? aquifers.filter(a => a.regionId === selectedRegion.id) : [],
  [selectedRegion, aquifers]);

  const filteredWells = useMemo(() =>
    selectedAquifer ? wells.filter(w => w.aquiferId === selectedAquifer.id && w.regionId === selectedAquifer.regionId) : [],
  [selectedAquifer, wells]);

  const selectedWellMeasurements = useMemo(() => 
    selectedWell ? measurements.filter(m => m.wellId === selectedWell.id) : [],
  [selectedWell, measurements]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-4" />
          <p className="text-slate-600 font-medium">Loading groundwater data...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (loadError) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center max-w-md">
          <div className="text-red-500 text-6xl mb-4">!</div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">Failed to Load Data</h2>
          <p className="text-slate-600 mb-4">{loadError}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 font-sans">
      {/* Sidebar */}
      <Sidebar 
        regions={regions}
        selectedRegion={selectedRegion}
        setSelectedRegion={(r) => {
          setSelectedRegion(r);
          setSelectedAquifer(null);
          setSelectedWell(null);
        }}
        aquifers={filteredAquifers}
        selectedAquifer={selectedAquifer}
        setSelectedAquifer={(a) => {
          setSelectedAquifer(a);
          setSelectedWell(null);
        }}
        openDataManager={() => setIsDataManagerOpen(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Top Navigation / Breadcrumbs */}
        <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shadow-sm z-10">
          <div className="flex items-center space-x-2 text-sm text-slate-600">
            <MapIcon size={16} />
            <button
              onClick={() => {
                setSelectedRegion(null);
                setSelectedAquifer(null);
                setSelectedWell(null);
              }}
              className="font-semibold text-slate-800 hover:text-blue-600 transition-colors"
            >
              Groundwater Explorer
            </button>
            {selectedRegion && (
              <>
                <ChevronRight size={14} className="text-slate-400" />
                <button
                  onClick={() => {
                    setSelectedAquifer(null);
                    setSelectedWell(null);
                  }}
                  className="hover:text-blue-600 transition-colors"
                >
                  {selectedRegion.name}
                </button>
              </>
            )}
            {selectedAquifer && (
              <>
                <ChevronRight size={14} className="text-slate-400" />
                <button
                  onClick={() => setSelectedWell(null)}
                  className="hover:text-blue-600 transition-colors"
                >
                  {selectedAquifer.name}
                </button>
              </>
            )}
            {selectedWell && (
              <>
                <ChevronRight size={14} className="text-slate-400" />
                <span className="font-medium text-blue-600">{selectedWell.name}</span>
              </>
            )}
          </div>
          <button 
            onClick={() => setIsDataManagerOpen(true)}
            className="flex items-center space-x-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-md text-sm font-medium hover:bg-blue-100 transition-colors"
          >
            <Database size={16} />
            <span>Manage Data</span>
          </button>
        </header>

        {/* Map and Chart Split View */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 relative">
            <MapView
              regions={regions}
              aquifers={filteredAquifers}
              wells={filteredWells}
              measurements={measurements}
              selectedRegion={selectedRegion}
              selectedAquifer={selectedAquifer}
              onRegionClick={(r) => {
                setSelectedRegion(r);
                setSelectedAquifer(null);
                setSelectedWell(null);
              }}
              onAquiferClick={setSelectedAquifer}
              onWellClick={setSelectedWell}
            />
          </div>

          {/* Time Series Section */}
          <div className={`transition-all duration-300 ease-in-out border-t border-slate-200 bg-white ${selectedWell ? 'h-1/3' : 'h-0 overflow-hidden'}`}>
            {selectedWell && (
              <div className="p-4 h-full flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2">
                    <Activity size={18} className="text-blue-500" />
                    <h3 className="font-bold text-slate-800">Water Table Elevation: {selectedWell.name}</h3>
                  </div>
                  <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
                    Units: Feet (WTE)
                  </div>
                </div>
                <div className="flex-1 min-h-0">
                  <TimeSeriesChart 
                    measurements={selectedWellMeasurements}
                    wellName={selectedWell.name}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Data Management Overlay */}
      {isDataManagerOpen && (
        <DataManager
          onClose={() => setIsDataManagerOpen(false)}
          onUpdateRegions={setRegions}
          onUpdateAquifers={setAquifers}
          onUpdateWells={setWells}
          onUpdateMeasurements={setMeasurements}
          existingRegions={regions.map(r => r.id)}
        />
      )}
    </div>
  );
};

export default App;
