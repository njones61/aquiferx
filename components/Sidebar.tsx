
import React from 'react';
import { Region, Aquifer } from '../types';
import { MapPin, Droplets, List, Box } from 'lucide-react';

interface SidebarProps {
  regions: Region[];
  selectedRegion: Region | null;
  setSelectedRegion: (r: Region | null) => void;
  aquifers: Aquifer[];
  selectedAquifer: Aquifer | null;
  setSelectedAquifer: (a: Aquifer | null) => void;
  openDataManager: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  regions,
  selectedRegion,
  setSelectedRegion,
  aquifers,
  selectedAquifer,
  setSelectedAquifer,
}) => {
  return (
    <aside className="w-80 bg-white border-r border-slate-200 flex flex-col shadow-xl z-20">
      <div className="p-6 border-b border-slate-100 flex items-center space-x-3 bg-gradient-to-br from-blue-600 to-indigo-700">
        <Droplets className="text-white" size={28} />
        <div>
          <h1 className="text-lg font-bold text-white tracking-tight leading-none">AquiferX</h1>
          <p className="text-blue-100 text-[10px] font-medium uppercase mt-1">Groundwater Intelligence</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Regions List */}
        <section>
          <div className="flex items-center space-x-2 mb-3 text-slate-400">
            <MapPin size={16} />
            <h2 className="text-xs font-bold uppercase tracking-widest">Regions</h2>
          </div>
          <div className="space-y-1">
            {regions.map(r => (
              <button
                key={r.id}
                onClick={() => setSelectedRegion(selectedRegion?.id === r.id ? null : r)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center justify-between group ${
                  selectedRegion?.id === r.id 
                    ? 'bg-blue-600 text-white shadow-md' 
                    : 'text-slate-600 hover:bg-slate-50 hover:text-blue-600'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <Box size={14} className={selectedRegion?.id === r.id ? 'text-blue-100' : 'text-slate-300'} />
                  <span className="font-medium">{r.name}</span>
                </div>
                {selectedRegion?.id === r.id && (
                  <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                )}
              </button>
            ))}
            {regions.length === 0 && (
              <p className="text-xs text-slate-400 italic px-3">No regions loaded.</p>
            )}
          </div>
        </section>

        {/* Aquifers List (Populated only if region selected) */}
        {selectedRegion && (
          <section className="animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex items-center space-x-2 mb-3 text-slate-400">
              <Droplets size={16} />
              <h2 className="text-xs font-bold uppercase tracking-widest">Aquifers</h2>
            </div>
            <div className="space-y-1">
              {aquifers.map(a => (
                <button
                  key={a.id}
                  onClick={() => setSelectedAquifer(selectedAquifer?.id === a.id ? null : a)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center group ${
                    selectedAquifer?.id === a.id 
                      ? 'bg-indigo-500 text-white shadow-md' 
                      : 'text-slate-600 hover:bg-slate-50 hover:text-indigo-500'
                  }`}
                >
                  <List size={14} className={`mr-3 ${selectedAquifer?.id === a.id ? 'text-indigo-100' : 'text-slate-300'}`} />
                  <span className="font-medium">{a.name}</span>
                </button>
              ))}
              {aquifers.length === 0 && (
                <p className="text-xs text-slate-400 italic px-3">No aquifers in this region.</p>
              )}
            </div>
          </section>
        )}
      </div>

      <div className="p-4 bg-slate-50 border-t border-slate-100">
        <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm text-center">
          <p className="text-[10px] text-slate-400 uppercase font-bold mb-1">Status</p>
          <div className="flex items-center justify-center space-x-2">
            <span className="flex h-2 w-2 rounded-full bg-green-500"></span>
            <span className="text-xs font-medium text-slate-600">Sync Active</span>
          </div>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
