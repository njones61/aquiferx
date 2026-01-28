
export interface Region {
  id: string;
  name: string;
  geojson: any;
  bounds: [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]
}

export interface Aquifer {
  id: string;
  name: string;
  regionId: string;
  geojson: any;
  bounds: [number, number, number, number];
}

export interface Well {
  id: string;
  name: string;
  lat: number;
  lng: number;
  gse: number; // Ground Surface Elevation
  aquiferId: string;
  aquiferName: string;
  regionId: string;
}

export interface Measurement {
  wellId: string;
  wellName: string;
  date: string; // ISO or human readable
  wte: number; // Water Table Elevation
  aquiferId: string;
}

export interface ChartPoint {
  date: number; // timestamp
  wte: number;
  isInterpolated: boolean;
}
