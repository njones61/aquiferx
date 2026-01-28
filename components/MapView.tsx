
import React, { useEffect, useRef, useMemo } from 'react';
import L from 'leaflet';
import { Region, Aquifer, Well, Measurement } from '../types';

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
  const regionLayerRef = useRef<L.FeatureGroup | null>(null);
  const aquiferLayerRef = useRef<L.FeatureGroup | null>(null);
  const wellLayerRef = useRef<L.FeatureGroup | null>(null);

  useEffect(() => {
    if (!mapRef.current) {
      mapRef.current = L.map('map-container').setView([37.1, -113.5], 10);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO'
      }).addTo(mapRef.current);

      regionLayerRef.current = L.featureGroup().addTo(mapRef.current);
      aquiferLayerRef.current = L.featureGroup().addTo(mapRef.current);
      wellLayerRef.current = L.featureGroup().addTo(mapRef.current);
    }
  }, []);

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
    <div id="map-container" className="w-full h-full" />
  );
};

export default MapView;
