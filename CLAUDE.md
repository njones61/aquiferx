# Aquifer Analyst

## Project Overview
- React 19 + TypeScript 5.8 + Vite 6 groundwater data visualization app
- No backend: the app builds to static files. `services/dataStore.ts` is the only way to read or write region files
- **Sample Data** (read-only) ships in `public/data/{region}/`; the folders are listed in `scripts/sample-regions.mjs` and indexed into `public/data/index.json` by `scripts/build-sample-index.mjs` (run by `npm run dev` and `npm run build`). Other folders in `public/data` are dev-only and are stripped from `dist/`
- **My Data** (the user's own) lives in IndexedDB in the browser, one record per file under the same relative path (`{region}/wells.csv`). Backup = zip download, Restore = zip upload, same `{region}/...` layout. A My Data region id may never equal a sample id, so a path's first segment says which store it is in
- Tailwind CSS for styling, Recharts for charts, Leaflet for maps
- Light (default) and dark themes: `utils/theme.ts` sets `data-theme` on `<html>`. Panel tokens (`--surface`, `--text`, ...) are in `index.css`; `tailwind.config.js` maps slate, `bg-white` and accent tints to CSS variables, so Tailwind classes follow the theme. Write new UI with the tokens or with ordinary light-palette Tailwind classes; avoid literal hex colors except for data (series, map symbols)

## Architecture
- **Hub-and-spoke data management**: `components/import/ImportDataHub.tsx` is the entry point, launching sub-wizards for Region, Aquifer, Well, and Measurement imports
- **Data type model**: `public/data/catalog_wq.json` is the global vocabulary of standard water quality parameters. Every region implicitly has every catalog entry — a catalog type "exists" in a region only when its `data_{code}.csv` exists in the region. Region-specific non-catalog parameters (BOD5, trichloroethane, etc.) live in `region.json` as `customDataTypes`. `effectiveDataTypes` (WTE + catalog-with-data + custom-with-data) is computed at load time via `services/catalog.ts#computeEffectiveDataTypes`.
- **Measurements**: use `value` field + `dataType` code. Per-file: `data_{code}.csv` naming (e.g. `data_wte.csv`, `data_nitrate.csv`)
- **Per-folder metadata**: Each region folder has `region.json` with id, name, lengthUnit, singleUnit, customDataTypes
- **CRS reprojection**: proj4 library in `services/reprojection.ts`, auto-detects from GeoJSON `crs` property or shapefile `.prj`
- **USGS API**: `services/usgsApi.ts` for downloading wells and measurements from USGS Water Data API
- **Smart well discovery**: `services/wellMatching.ts` provides ID → name → proximity matching for CSV imports, plus per-column catalog-aware data type detection and `aqx-` ID generation for new wells. `services/gseLookup.ts` batches USGS 3DEP / Open-Meteo elevation fetches.

## Key Files
- `App.tsx` — main component, state management, data type selector
- `types.ts` — DataType, RegionMeta (customDataTypes), Region (effectiveDataTypes), CatalogParameter, ParameterCatalog, Measurement, ChartPoint interfaces
- `services/dataStore.ts` — Sample Data (static) + My Data (IndexedDB): listRegions, readFile/readText/readJson, saveFiles (with `ifVersion`/`mustNotExist` conflict checks), deleteFile/deleteFolder, listRasters/listModels, backup/restore/copyToMyData
- `services/dataLoader.ts` — loads every region from the store, computes effectiveDataTypes, loads measurements from each `data_{code}.csv`
- `services/catalog.ts` — `loadCatalog()`, `computeEffectiveDataTypes()`, `groupCatalog()`
- `services/wellMatching.ts` — matchWells (ID/name/proximity), generateAqxId, suggestDataTypesFromColumns
- `services/gseLookup.ts` — batched elevation lookup (USGS 3DEP / Open-Meteo)
- `services/importUtils.ts` — CSV parsing, file processing, point-in-polygon (re-exports saveFiles/deleteFile from dataStore)
- `services/reprojection.ts` — proj4 coordinate reprojection
- `services/usgsApi.ts` — USGS Water Data API integration
- `components/CatalogBrowser.tsx` — read-only catalog viewer, opened from DataTypeEditor and MeasurementImporter
- `components/import/` — ImportDataHub, RegionImporter, AquiferImporter, WellImporter, MeasurementImporter, DataTypeEditor, ColumnMapperModal, ConfirmDialog
- `public/data/catalog_wq.json` — global water quality parameter catalog (~38 entries with WQP mapping + MCL/WHO)
- `services/gldasFetch.ts` — imputation's soil moisture (NOAA CPC v2, 1948 on) read with zarrita from `cdn.apps.geoglows.org/aqx/cpc-soil-moisture-0.5-v1.zarr`, built by `scripts/soil_moisture_store.py`
- `components/PanelActions.tsx` — the panel's Add Data / Back up / Restore / Settings grid, backup status note, restore dialog
- `components/SettingsDialog.tsx` — light mode, map label size, storage use, Delete all My Data
- Map display options (`MapDisplay` in types.ts) live in App, are set from the panel's MAP section and read by MapView
- `vite.config.ts` — strips non-sample regions from `dist/`; dev-only `/local-zarr/` server for previewing a zarr store (`LOCAL_ZARR_DIR`)
- `scripts/make-backup.mjs` — package `public/data` folders as a backup zip to Restore into My Data

## Conventions
- Data type codes: lowercase alphanumeric + underscore, max 20 chars; "wte" is the reserved default (water table elevation)
- **Catalog is authoritative**: standard WQ parameters (nitrate, arsenic, pH, etc.) live in `catalog_wq.json` and cannot be overridden per-region. If a region needs a different unit or name for a parameter, make a custom type with a non-catalog code (e.g. `hardness_caco3`) — not a rename of the catalog entry
- **No pre-staging empty types**: a data type exists in a region exactly when its `data_{code}.csv` exists on disk. There is no way to "declare a type in advance" — importing data is the only action that creates one. DataTypeEditor only manages non-catalog customs; even those must have a data file to appear in the header dropdown
- **Custom codes must not collide with catalog codes**: DataTypeEditor and the importer's detection panel both enforce this
- Single-unit regions: aquifer section dimmed in UI, all data auto-assigned `aquifer_id=0`
- CSV delimiter auto-detection (comma vs tab)
- Date format auto-detection (ISO, US, EU variants)
- Measurement values stored in `value` column (not `wte`)
- A region folder (sample, My Data record prefix, or backup zip) holds: `region.json`, `region.geojson`, `aquifers.geojson`, `wells.csv`, `data_{code}.csv`, and per-aquifer `raster_*.json` / `model_*.json`
- Anything that writes must not run on a sample region: App routes such actions through a "Copy to My Data" prompt

## Commands
- `npm run dev` — rebuild the sample index, start dev server on port 3000
- `npx tsc --noEmit` — type check
- `npm run build` — production build (`npx vite build` skips the sample index)
