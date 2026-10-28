import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  reprojectPoint,
  COMMON_CRS_OPTIONS,
  fetchEpsgDefinition,
  autoDetectCrs,
  normalizeEpsgCode,
  SampleCoord,
} from '../services/reprojection';

export interface UseCrsPickerOptions {
  regionBounds: [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]
  /** Sample coordinates pulled from the CSV's lat/long columns. Consumer
   *  should memoize this so it only updates when the underlying data
   *  actually changes — otherwise the preview will thrash. */
  samples: SampleCoord[];
  /** Called whenever the CRS changes so consumers can invalidate derived
   *  state (e.g. match results). */
  onCrsChange?: () => void;
}

export interface CrsPreview {
  ok: boolean;
  text: string;
}

export interface UseCrsPickerReturn {
  // State
  coordinateCrs: string;
  crsName: string;
  crsInputMode: 'preset' | 'epsg';
  epsgCodeInput: string;
  crsLookupError: string;
  isLookingUpCrs: boolean;
  isAutoDetecting: boolean;
  // Setters exposed for UI inputs
  setEpsgCodeInput: (s: string) => void;
  setCrsInputMode: (m: 'preset' | 'epsg') => void;
  setCrsLookupError: (s: string) => void;
  // Handlers
  handleCrsPresetChange: (value: string) => void;
  handleEpsgLookup: () => Promise<void>;
  handleAutoDetectCrs: () => Promise<void>;
  // Preview
  crsPreview: CrsPreview | null;
  // Core helper — reprojects raw lat/lng through the selected CRS and
  // validates against WGS84 ranges
  parseRowCoords: (latRaw: string | undefined, lngRaw: string | undefined) => { lat: number | undefined; lng: number | undefined };
  // Exposed so callers can reuse the same option list in their pickers
  COMMON_CRS_OPTIONS: typeof COMMON_CRS_OPTIONS;
}

export function useCrsPicker({ regionBounds, samples, onCrsChange }: UseCrsPickerOptions): UseCrsPickerReturn {
  const [coordinateCrs, setCoordinateCrs] = useState<string>('EPSG:4326');
  const [crsName, setCrsName] = useState<string>('WGS84 — latitude / longitude');
  const [crsInputMode, setCrsInputMode] = useState<'preset' | 'epsg'>('preset');
  const [epsgCodeInput, setEpsgCodeInput] = useState('');
  const [crsLookupError, setCrsLookupError] = useState('');
  const [isLookingUpCrs, setIsLookingUpCrs] = useState(false);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);

  const handleCrsPresetChange = useCallback((value: string) => {
    setCrsLookupError('');
    if (value === '__epsg__') {
      setCrsInputMode('epsg');
      return;
    }
    setCrsInputMode('preset');
    setCoordinateCrs(value);
    const opt = COMMON_CRS_OPTIONS.find(o => o.code === value);
    setCrsName(opt?.label || value);
    onCrsChange?.();
  }, [onCrsChange]);

  const handleEpsgLookup = useCallback(async () => {
    const code = normalizeEpsgCode(epsgCodeInput);
    if (!code) {
      setCrsLookupError('Enter a numeric EPSG code, e.g. 3448');
      return;
    }
    setCrsLookupError('');
    setIsLookingUpCrs(true);
    try {
      const def = await fetchEpsgDefinition(code);
      if (!def) {
        setCrsLookupError(`Could not resolve ${code}. Check the code and your network.`);
        return;
      }
      setCoordinateCrs(def.code);
      setCrsName(`${def.code} — ${def.name}`);
      onCrsChange?.();
    } finally {
      setIsLookingUpCrs(false);
    }
  }, [epsgCodeInput, onCrsChange]);

  const handleAutoDetectCrs = useCallback(async () => {
    if (samples.length === 0) {
      setCrsLookupError('No coordinate samples — map the latitude and longitude columns first.');
      return;
    }
    setCrsLookupError('');
    setIsAutoDetecting(true);
    try {
      const [minLat, minLng, maxLat, maxLng] = regionBounds;
      const result = await autoDetectCrs(samples, { minLat, minLng, maxLat, maxLng });
      if (!result) {
        setCrsLookupError(
          'Could not auto-detect a CRS. Your coordinates do not match any common system for this region — check your CSV or enter an EPSG code manually.'
        );
        return;
      }
      setCoordinateCrs(result.crs);
      setCrsName(result.name);
      setCrsInputMode('preset');
      onCrsChange?.();
    } finally {
      setIsAutoDetecting(false);
    }
  }, [samples, regionBounds, onCrsChange]);

  const parseRowCoords = useCallback((latRaw: string | undefined, lngRaw: string | undefined): { lat: number | undefined; lng: number | undefined } => {
    if (!latRaw || !lngRaw) return { lat: undefined, lng: undefined };
    const rawLat = parseFloat(latRaw);
    const rawLng = parseFloat(lngRaw);
    if (isNaN(rawLat) || isNaN(rawLng)) return { lat: undefined, lng: undefined };
    // proj4 uses (x, y) = (easting/lng, northing/lat)
    const reprojected = reprojectPoint(rawLng, rawLat, coordinateCrs);
    if (!reprojected) return { lat: undefined, lng: undefined };
    const [lng, lat] = reprojected;
    if (!isFinite(lat) || !isFinite(lng)) return { lat: undefined, lng: undefined };
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { lat: undefined, lng: undefined };
    }
    return { lat, lng };
  }, [coordinateCrs]);

  const crsPreview = useMemo<CrsPreview | null>(() => {
    if (samples.length === 0) return null;
    const { x, y } = samples[0];
    const out = reprojectPoint(x, y, coordinateCrs);
    if (!out) return { ok: false, text: 'Could not reproject with this CRS.' };
    const [lng, lat] = out;
    const [minLat, minLng, maxLat, maxLng] = regionBounds;
    const dLat = Math.max(0.1, (maxLat - minLat) * 2);
    const dLng = Math.max(0.1, (maxLng - minLng) * 2);
    const inside =
      lat >= minLat - dLat && lat <= maxLat + dLat &&
      lng >= minLng - dLng && lng <= maxLng + dLng;
    return { ok: inside, text: `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
  }, [samples, coordinateCrs, regionBounds]);

  // When a new set of coordinates lands outside the region under the CRS in
  // use, try auto-detect once for that set, without waiting for the button
  const autoTriedFor = useRef<SampleCoord[] | null>(null);
  useEffect(() => {
    if (!crsPreview || crsPreview.ok || isAutoDetecting) return;
    if (autoTriedFor.current === samples) return;
    autoTriedFor.current = samples;
    handleAutoDetectCrs();
  }, [crsPreview, samples, isAutoDetecting, handleAutoDetectCrs]);

  return {
    coordinateCrs,
    crsName,
    crsInputMode,
    epsgCodeInput,
    crsLookupError,
    isLookingUpCrs,
    isAutoDetecting,
    setEpsgCodeInput,
    setCrsInputMode,
    setCrsLookupError,
    handleCrsPresetChange,
    handleEpsgLookup,
    handleAutoDetectCrs,
    crsPreview,
    parseRowCoords,
    COMMON_CRS_OPTIONS,
  };
}
