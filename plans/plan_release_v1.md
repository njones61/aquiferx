# Release 1: getting Aquifer Analyst ready for apps.geoglows.org

Goal: a static build that deploys the way webapp-grace-groundwater does (Vercel, `vercel.json`), with docs on
training.geoglows.org written after the code settles. Storage stays simple: the user's data lives in the browser,
and a downloaded zip is the backup they restore from. The BYOS / Supabase plans in `plan_data_mgmt.md` and
`user_and_data_strategy.md` are deferred past this release.

## Current state that drives the work

- Every read and write goes through dev-server middleware in `vite.config.ts` (`/api/regions`, `/api/save-data`,
  `/api/delete-*`, `/api/list-rasters`, `/api/list-models`, `/api/rename-*`) or fetches `/data/...` directly, about
  55 call sites across App.tsx, the importers, dataLoader, rasterAnalysis and imputationPipeline. None of it exists
  in a static build.
- `/api/wqp-proxy` exists only to expose WQP's count headers. WQP itself sends `Access-Control-Allow-Origin: *`.
- `/api/gldas-proxy` fronts `legacy-apps.geoglows.org` THREDDS, which sends no CORS headers (and timed out on
  2026-10-27). Imputation needs a server-side path to it.
- The left panel, top bar, chart pane and map chrome are dark-only (`index.css` tokens on `:root`). The import
  dialogs are light, with colors hard-coded in roughly 700 Tailwind `slate-*`/`white` classes.
- Map display options (min obs, font, date filter, labels) float over the map; data type and analysis commands sit
  in the top bar; data management is a database icon in the top-right corner.

## Phase 1: storage layer

1. `services/dataStore.ts`: one interface for list regions, read file, write file, delete file/folder, list
   rasters/models, rename. Two implementations:
   - **Sample** — read-only, static files under `public/data/sample/`, with a generated `index.json` replacing
     `/api/regions` and the list endpoints (a build script writes it).
   - **My Data** — IndexedDB, keyed by the same relative paths (`{region}/wells.csv`, `{region}/data_wte.csv`,
     `{region}/{aquifer}/raster_*.json`), so the file format and the zip format do not change.
2. Move every call site onto the store. The optimistic-locking preconditions in save-data become a no-op or a
   version counter per key.
3. Request `navigator.storage.persist()` on first write so the browser is less likely to evict data.
4. **Back up My Data** (zip download, reusing the existing export) and **Restore backup** (zip upload). One rule on
   restore: replace regions with the same ID, after a confirm that lists them.
5. Replace the "Sync active" footer with a backup status line: "Last backup: 3 days ago · 2 changes since"
   with the Back up button beside it.
6. **Copy to My Data** on a sample region's menu, giving it a new ID if one exists.
7. Dev mode uses the same two stores, so dev and production behave identically. The middleware is deleted except
   what Phase 5 moves to a serverless function.

## Phase 2: Sample Data / My Data in the interface

- A segmented control at the top of the left panel, styled like GRACE's Regions / Global: **Sample Data | My Data**.
  The tree below lists that set's regions.
- Sample regions have no edit/delete/import actions; their menu offers Copy to My Data and Download.
- Every import writes to My Data and switches the panel to it.
- Empty My Data shows a short explanation plus **Add region**, **Restore backup**, and **Copy a sample region**.

## Phase 3: light and dark themes, light by default

- Move the tokens in `index.css` into a light set on `:root` and a dark set under `[data-theme="dark"]`, the
  pattern GRACE uses in `src/theme.js` (persisted in localStorage; GRACE defaults dark, this app defaults light).
- Point Tailwind's `slate`, `white` and the accent colors at CSS variables in `tailwind.config.js`, so the ~700
  hard-coded classes in the dialogs follow the theme without being rewritten one by one. Fix the stragglers by hand
  (137 literal hex colors, mostly chart and map symbology).
- Chart series colors and map symbols read per-theme values through a theme-change listener.
- Light mode checkbox in the panel and in Settings, as in GRACE.

## Phase 4: layout closer to GRACE

Left panel, top to bottom:
1. GEOGLOWS wordmark, sign-in, app title (drop "v1").
2. Sample Data | My Data.
3. Button grid: **Add Data**, **Back up**, **Restore**, **Settings**.
4. DATA TYPE dropdown (moved from the top bar).
5. DISPLAY: min observations, date filter, aquifer/well labels and IDs, label font (moved from the floating map box).
6. Light mode checkbox.
7. REGIONS tree.

Top bar keeps the breadcrumb on the left and the analysis commands on the right (Analyze Trends with its window
stepper, Spatial Analysis, Impute), as GRACE keeps Color by / Window / Analyze there. Leaflet stays; matching the
chrome does not need ArcGIS.

## Phase 5: import and data-management simplifications

From the review on 2026-10-27, in order:

1. New regions default to single-unit. Dimmed hub cards say why ("Add aquifers first, or make this a single-unit
   region"), and single-unit can be switched after creation.
2. Ground-elevation lookup runs automatically after wells load and never blocks Save; wells without it save with
   an empty value and a warning.
3. Detect location columns instead of asking with a checkbox; auto-run CRS detection when the preview falls outside
   the region; generate aquifer IDs when the file has only names.
4. One "existing data" choice in the measurement importer: Add new only (default) / Add and update / Replace all,
   replacing Import Mode + USGS Refresh Mode.
5. Plain language: "ground elevation" for GSE, "water level elevation" for WTE, "assign by location" for
   point-in-polygon, hover help for IQR, EPSG, ELM; data-type names instead of codes on the hub cards. Drop
   "Folder: …".
6. One place per edit action: per-item edit/delete in the sidebar menus, the hub only for adding data. Remove the
   hub's Edit Regions table and aquifer pencil (RegionEditor, AquiferEditor).
7. Three zip actions become the two from Phase 1; remove "Import Region Package" and the per-region "Download"
   becomes "Download region" with the same format.
8. Remove "Add Custom Type" from DataTypeEditor (custom types already come from the measurement importer); keep
   rename and delete.
9. Changing a region's unit converts its stored values, or the unit becomes read-only after data exists.

Later, if time allows: sample values in the column mappers, region boundary from the data extent or a drawn box,
USGS water levels finding their own wells, a well list with delete.

## Phase 6: production

- Vite `base` for the deploy path, `vercel.json` as in GRACE.
- WQP called directly; progress uses row counts from the response instead of the hidden count headers.
- GLDAS through a Vercel serverless function (`api/gldas.ts`), unless the THREDDS server can send CORS headers.
- Remove the esm.sh importmap and unpkg Leaflet CSS left in `index.html` from the original scaffold.
- Push to the geoglows org repo; development continues there after the fork.

## Phase 7: documentation

Start over on training.geoglows.org in the GRACE pattern (Parts, en/es/fr, screenshots via a `shots.mjs`-style
script). The current `docs/` and `mkdocs.yml` here are retired.
