declare module 'shpjs' {
  interface GeoJSONFeature {
    type: 'Feature';
    geometry: any;
    properties: Record<string, any>;
  }

  interface GeoJSONFeatureCollection {
    type: 'FeatureCollection';
    features: GeoJSONFeature[];
  }

  function shp(input: ArrayBuffer | string): Promise<GeoJSONFeatureCollection | GeoJSONFeature>;

  export default shp;
}
