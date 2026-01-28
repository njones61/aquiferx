# AquiferX

An interactive groundwater data visualization and exploration tool for monitoring aquifer water levels across multiple regions.

## Features

### Interactive Map Visualization
- View regions, aquifers, and monitoring wells on an interactive Leaflet map
- Click to drill down from regions → aquifers → individual wells
- Wells color-coded by data availability (blue = sufficient data, red = insufficient)
- Automatic map zooming and panning as you navigate the hierarchy

### Time Series Analysis
- View historical water table elevation (WTE) measurements for any well
- Interactive charts powered by Recharts
- See measurement trends over time

### Multi-Region Support
- Pre-loaded data for Oregon (Klamath Basin), Utah, Dominican Republic, and Niger
- Easily add new regions through the Data Manager

### Data Import
- Import new regions with the built-in Data Manager wizard
- Supports GeoJSON and zipped Shapefiles for boundaries
- CSV import for wells and water level measurements
- Automatic column mapping with manual override
- Multiple date format support (ISO, US, EU)
- Data validation with detailed error reporting

## Tech Stack

- **React 19** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Leaflet** - Interactive maps
- **Recharts** - Time series charts
- **Lucide React** - Icons
- **shpjs** - Shapefile parsing
- **JSZip** - Zip file generation for exports

## Getting Started

### Prerequisites
- Node.js (v18 or higher recommended)

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open your browser to the URL shown in the terminal (typically http://localhost:5173).

### Build for Production

```bash
npm run build
npm run preview
```

## Data Structure

Each region folder in `public/data/` contains:

```
region-name/
├── region.geojson     # Region boundary polygon
├── aquifers.geojson   # Aquifer boundary polygons
├── wells.csv          # Well locations (well_id, lat, long, aquifer_id)
└── water_levels.csv   # Measurements (well_id, date, wte, aquifer_id)
```

The `public/data/regions.json` manifest lists all available regions.

## Adding New Regions

1. Click **Manage Data** in the app header
2. Follow the 6-step wizard:
   - Enter region name
   - Upload region boundary (GeoJSON or zipped Shapefile)
   - Upload aquifer boundaries
   - Upload wells CSV
   - Upload water levels CSV
3. Download the generated zip file
4. Extract contents to `public/data/`
5. Refresh the app

## License

MIT
