
import { Region, Aquifer, Well, Measurement } from '../types';

export const mockRegions: Region[] = [
  {
    id: 'R1',
    name: 'Virgin River Basin',
    bounds: [36.9, -113.6, 37.3, -113.3],
    geojson: {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-113.6, 36.9], [-113.3, 36.9], [-113.3, 37.3], [-113.6, 37.3], [-113.6, 36.9]
        ]]
      }
    }
  }
];

export const mockAquifers: Aquifer[] = [
  {
    id: '14',
    name: 'Central Virgin River',
    regionId: 'R1',
    bounds: [37.0, -113.55, 37.1, -113.4],
    geojson: {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-113.55, 37.0], [-113.4, 37.0], [-113.4, 37.1], [-113.55, 37.1], [-113.55, 37.0]
        ]]
      }
    }
  }
];

export const mockWells: Well[] = [
  { id: '370037113281401', name: '(C-43-14)31bab- 1', lat: 37.0102604, lng: -113.4713408, gse: 2830, aquiferId: '14', aquiferName: 'Central Virgin River', regionId: 'utah' },
  { id: '370045113284201', name: '(C-43-15)25ddd- 1', lat: 37.01248259, lng: -113.4791188, gse: 2795, aquiferId: '14', aquiferName: 'Central Virgin River', regionId: 'utah' },
  { id: '370125113290401', name: '(C-43-15)24dcc- 1', lat: 37.0233158, lng: -113.4832856, gse: 2850, aquiferId: '14', aquiferName: 'Central Virgin River', regionId: 'utah' },
  { id: '370201113301701', name: '(C-43-15)23bda- 1', lat: 37.03359337, lng: -113.5055084, gse: 2760, aquiferId: '14', aquiferName: 'Central Virgin River', regionId: 'utah' },
  { id: '370204113310701', name: '(C-43-15)23bcb- 1', lat: 37.0344265, lng: -113.5193979, gse: 2860, aquiferId: '14', aquiferName: 'Central Virgin River', regionId: 'utah' },
];

export const mockMeasurements: Measurement[] = [
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2003-02-24', wte: 2656.54, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2004-02-25', wte: 2653.83, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2005-02-24', wte: 2652.9, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2006-02-24', wte: 2652.4, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2007-02-23', wte: 2651.91, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2008-02-20', wte: 2651.06, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2009-02-24', wte: 2653.24, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2010-02-23', wte: 2654.89, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2011-02-23', wte: 2656.67, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2012-02-27', wte: 2658, aquiferId: '14' },
  { wellId: '370037113281401', wellName: '(C-43-14)31bab- 1', date: '2013-02-27', wte: 2658.68, aquiferId: '14' },
];
