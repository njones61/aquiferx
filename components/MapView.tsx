
import React, { useEffect, useRef, useMemo, useState } from 'react';
import L from 'leaflet';
import { Layers, ChevronRight } from 'lucide-react';
import { Region, Aquifer, Well, Measurement } from '../types';

const BASEMAPS = {
  'Topographic': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/67372ff42cd145319639a99152b15bc3/info/thumbnail/ago_downloaded.png'
  },
  'Imagery': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/10df2279f9684e4a9f6a7f08febac2a9/info/thumbnail/ago_downloaded.png'
  },
  'Streets': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/3b93337983e9436f8db950e38a8629af/info/thumbnail/ago_downloaded.png'
  },
  'Light Gray': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/8b3d38c0819547faa83f7b7aca80bd76/info/thumbnail/ago_downloaded.png'
  },
  'Dark Gray': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/358ec1e175ea41c3bf5c68f0da11ae2b/info/thumbnail/ago_downloaded.png'
  },
  'Terrain': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/c61ad8ab017d49e1a82f580ee1298571/info/thumbnail/ago_downloaded.png'
  }
};

interface MapViewProps {
  regions: Region[];
  aquifers: Aquifer[];
  wells: Well[];
  measurements: Measurement[];
  selectedRegion: Region | null;
  selectedAquifer: Aquifer | null;
  onRegionClick: (r: Region) => void;
  onAquiferClick: (a: Aquifer) => void;
  onWellClick: (w: Well) => void;
}

const MapView: React.FC<MapViewProps> = ({
  regions,
  aquifers,
  wells,
  measurements,
  selectedRegion,
  selectedAquifer,
  onRegionClick,
  onAquiferClick,
  onWellClick
}) => {
  // Count measurements per well
  const wellMeasurementCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of measurements) {
      counts.set(m.wellId, (counts.get(m.wellId) || 0) + 1);
    }
    return counts;
  }, [measurements]);
  const mapRef = useRef<L.Map | null>(null);
  const basemapLayerRef = useRef<L.TileLayer | null>(null);
  const regionLayerRef = useRef<L.FeatureGroup | null>(null);
  const aquiferLayerRef = useRef<L.FeatureGroup | null>(null);
  const wellLayerRef = useRef<L.FeatureGroup | null>(null);

  const [currentBasemap, setCurrentBasemap] = useState<keyof typeof BASEMAPS>('Topographic');
  const [isBasemapMenuOpen, setIsBasemapMenuOpen] = useState(false);

  useEffect(() => {
    if (!mapRef.current) {
      mapRef.current = L.map('map-container').setView([37.1, -113.5], 10);

      const basemap = BASEMAPS[currentBasemap];
      basemapLayerRef.current = L.tileLayer(basemap.url, {
        attribution: basemap.attribution
      }).addTo(mapRef.current);

      regionLayerRef.current = L.featureGroup().addTo(mapRef.current);
      aquiferLayerRef.current = L.featureGroup().addTo(mapRef.current);
      wellLayerRef.current = L.featureGroup().addTo(mapRef.current);
    }
  }, []);

  // Handle basemap changes
  const changeBasemap = (name: keyof typeof BASEMAPS) => {
    if (!mapRef.current) return;

    if (basemapLayerRef.current) {
      mapRef.current.removeLayer(basemapLayerRef.current);
    }

    const basemap = BASEMAPS[name];
    basemapLayerRef.current = L.tileLayer(basemap.url, {
      attribution: basemap.attribution
    }).addTo(mapRef.current);

    // Move basemap to back so other layers stay on top
    basemapLayerRef.current.bringToBack();

    setCurrentBasemap(name);
  };

  // Update Region Layer
  useEffect(() => {
    if (!regionLayerRef.current || !mapRef.current) return;
    regionLayerRef.current.clearLayers();

    regions.forEach(r => {
      const isSelected = selectedRegion?.id === r.id;
      const layer = L.geoJSON(r.geojson, {
        style: {
          color: isSelected ? '#2563eb' : '#94a3b8',
          weight: isSelected ? 3 : 1,
          fillOpacity: isSelected ? 0.05 : 0.1,
          fillColor: '#2563eb'
        }
      });
      layer.on('click', () => onRegionClick(r));
      regionLayerRef.current?.addLayer(layer);
    });

    if (!selectedRegion && regions.length > 0) {
      const bounds = regionLayerRef.current.getBounds();
      if (bounds.isValid()) mapRef.current.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [regions, selectedRegion]);

  // Update Aquifer Layer
  useEffect(() => {
    if (!aquiferLayerRef.current || !mapRef.current) return;
    aquiferLayerRef.current.clearLayers();

    if (selectedRegion) {
      aquifers.forEach(a => {
        const isSelected = selectedAquifer?.id === a.id;
        const layer = L.geoJSON(a.geojson, {
          style: {
            color: isSelected ? '#6366f1' : '#475569',
            weight: 2,
            fillOpacity: isSelected ? 0.3 : 0.15,
            fillColor: isSelected ? '#6366f1' : '#64748b'
          }
        });
        layer.on('click', () => onAquiferClick(a));
        aquiferLayerRef.current?.addLayer(layer);
      });

      if (!selectedAquifer && aquifers.length > 0) {
        const bounds = aquiferLayerRef.current.getBounds();
        if (bounds.isValid()) mapRef.current.flyToBounds(bounds, { padding: [40, 40], duration: 1.5 });
      } else if (!selectedAquifer) {
        // Fallback zoom to region
        const rBounds = L.latLngBounds([selectedRegion.bounds[0], selectedRegion.bounds[1]], [selectedRegion.bounds[2], selectedRegion.bounds[3]]);
        mapRef.current.flyToBounds(rBounds, { padding: [40, 40] });
      }
    }
  }, [aquifers, selectedRegion, selectedAquifer]);

  // Update Well Layer
  useEffect(() => {
    if (!wellLayerRef.current || !mapRef.current) return;
    wellLayerRef.current.clearLayers();

    if (selectedAquifer) {
      wells.forEach(w => {
        const measurementCount = wellMeasurementCounts.get(w.id) || 0;
        const hasEnoughData = measurementCount >= 2;
        const marker = L.circleMarker([w.lat, w.lng], {
          radius: 6,
          fillColor: hasEnoughData ? '#3b82f6' : '#ef4444', // blue if data, red if not
          color: '#ffffff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.8
        });
        marker.bindTooltip(`Well: ${w.name}<br/>ID: ${w.id}<br/>Measurements: ${measurementCount}`, { direction: 'top' });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          onWellClick(w);
        });
        wellLayerRef.current?.addLayer(marker);
      });

      if (wells.length > 0) {
        const bounds = wellLayerRef.current.getBounds();
        if (bounds.isValid()) mapRef.current.flyToBounds(bounds, { padding: [100, 100], duration: 1 });
      } else {
        // Zoom to aquifer bounds
        const aBounds = L.latLngBounds([selectedAquifer.bounds[0], selectedAquifer.bounds[1]], [selectedAquifer.bounds[2], selectedAquifer.bounds[3]]);
        mapRef.current.flyToBounds(aBounds, { padding: [40, 40] });
      }
    }
  }, [wells, selectedAquifer, wellMeasurementCounts]);

  return (
    <div className="relative w-full h-full">
      <div id="map-container" className="w-full h-full" />

      {/* Basemap Gallery */}
      <div className="absolute top-3 right-3 z-[1000]">
        {!isBasemapMenuOpen ? (
          /* Collapsed - just the icon button */
          <button
            onClick={() => setIsBasemapMenuOpen(true)}
            className="flex items-center justify-center w-8 h-8 bg-white rounded shadow-md border border-slate-300 hover:bg-slate-50 transition-colors"
            title="Basemap Gallery"
          >
            <Layers size={16} className="text-slate-600" />
          </button>
        ) : (
          /* Expanded - gallery panel */
          <div className="bg-white rounded shadow-lg border border-slate-300 overflow-hidden" style={{ width: '260px' }}>
            {/* Header with collapse button */}
            <div className="flex items-center justify-end px-2 py-1 bg-white border-b border-slate-200">
              <button
                onClick={() => setIsBasemapMenuOpen(false)}
                className="flex items-center justify-center w-6 h-6 hover:bg-slate-100 rounded transition-colors"
                title="Collapse"
              >
                <ChevronRight size={16} className="text-slate-500" />
              </button>
            </div>

            {/* Basemap List */}
            <div className="max-h-80 overflow-y-auto">
              {Object.entries(BASEMAPS).map(([name, config]) => (
                <button
                  key={name}
                  onClick={() => changeBasemap(name as keyof typeof BASEMAPS)}
                  className={`w-full flex items-center gap-3 p-2 text-left transition-colors border-2 ${
                    currentBasemap === name
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-transparent hover:bg-slate-50'
                  }`}
                >
                  <img
                    src={config.thumbnail}
                    alt={name}
                    className="w-16 h-16 object-cover rounded flex-shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <span className={`text-sm ${
                    currentBasemap === name ? 'font-medium text-slate-900' : 'text-slate-700'
                  }`}>
                    {name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MapView;
