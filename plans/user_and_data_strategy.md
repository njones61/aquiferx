# Aquifer Analyst — User & Data Management Strategy

> **⚠️ Partially superseded — the cloud data plane has changed. See [`plan_data_mgmt.md`](./plan_data_mgmt.md).**
> This document's core cloud-storage model — **storing all data (measurements, wells, boundaries) as rows in a Supabase Postgres database that we host** — has been **superseded**. We do not want to host and maintain everyone's groundwater data. The current decision keeps the file format and splits storage into a small **metadata plane** we host (accounts, orgs, roles, credentials, dataset pointers) and a **data plane** the user/org hosts (Bring Your Own Storage; S3-compatible first, HydroShare on-ramp), with autosync and per-file conflict checks.
>
> **Still valid from this document:** the `DataProvider` abstraction layer (§7), the IndexedDB **local-only mode** (Phase 2), the **sample-region** approach (§9), Supabase for **auth + the metadata plane**, and Vercel serverless hosting. Treat §5–6 (full relational schema + RLS for bulk data) and the "everything in Postgres" framing as historical; read `plan_data_mgmt.md` for the authoritative storage strategy.

## Executive Summary

The Aquifer Analyst currently runs as a local-only prototype with no user accounts and no remote data storage. This document defines the strategy to evolve it into a cloud-backed application with simple user accounts while preserving a fully offline mode for users who cannot or prefer not to store data remotely.

### Goals

- **Simple user accounts** — individual login via email/password or social provider (Google, GitHub). Each user owns their own data.
- **Cloud data persistence** — users can revisit and manage their data across sessions and devices.
- **Local-only mode** — data never leaves the browser. For users who treat groundwater data as confidential or who need to work offline.
- **Sample data** — new users can explore demo regions immediately to understand the app's capabilities.

### Approach

The recommended stack is **Supabase** (authentication, Postgres database, file storage) and **Vercel** (hosting, serverless API routes, GitHub CI/CD). Both offer generous free tiers and scale affordably. Supabase is open-source and can be self-hosted if institutional requirements demand it.

The core architectural change is a **Data Provider abstraction layer** — a TypeScript interface that all components use instead of calling APIs directly. Two implementations back this interface: a `SupabaseDataProvider` for cloud mode and a `LocalDataProvider` (IndexedDB) for local-only mode. This allows the entire visualization and analysis layer to remain unchanged regardless of where data lives.

Implementation is organized into **6 phases**: (1) data abstraction layer, (2) local/air-gapped mode, (3) Supabase setup, (4) authentication + cloud data, (5) Vercel deployment, (6) sample regions.

---

## Table of Contents

1. [Technology Stack](#1-technology-stack)
2. [Use Cases & Access Patterns](#2-use-cases--access-patterns)
3. [App Modes & Entry Flow](#3-app-modes--entry-flow)
4. [Current On-Disk Data Layout (Reference)](#4-current-on-disk-data-layout-reference)
5. [Database Schema](#5-database-schema)
6. [Row-Level Security (RLS)](#6-row-level-security-rls)
7. [Data Provider Abstraction Layer](#7-data-provider-abstraction-layer)
8. [Vercel API Routes](#8-vercel-api-routes)
9. [Sample Regions](#9-sample-regions)
10. [Implementation Phases](#10-implementation-phases)
11. [What Changes and What Doesn't](#11-what-changes-and-what-doesnt)
12. [Potential Future Features](#12-potential-future-features)

---

## 1. Technology Stack

| Layer | Technology | Cost |
|---|---|---|
| Frontend | React 19 + Vite 6 | Free |
| Hosting | Vercel | Free (hobby) / $20/mo (pro) |
| Auth + DB + Storage | Supabase | Free tier / $25/mo (pro) |
| Repo + CI/CD | GitHub → Vercel auto-deploy | Free |

### Why Supabase

- **Free tier is generous** — 50K monthly active users, 500MB database, 1GB storage.
- **Auth is built in** — Google, GitHub, email/password. No separate service to manage.
- **Postgres database** — Real SQL with Row-Level Security (RLS) policies. Permissions are enforced at the database level, not just in application code.
- **Storage bucket** — For GeoJSON files, raster results, and other binary uploads that don't belong in Postgres tables.
- **Open source** — If the app ever needs to be self-hosted (university IT requirements, etc.), Supabase can be deployed on your own infrastructure.

### Why Vercel

- Automatic deployments on every push to `main` via GitHub integration.
- Every pull request gets a preview deployment with a unique URL for testing.
- Build settings auto-detect Vite projects — near-zero configuration.
- Serverless API routes (`api/` directory) replace the current Vite dev server middleware.
- Environment variables managed in the Vercel dashboard (Supabase keys, etc.).
- Free hobby tier for development; Pro ($20/mo) for production.

### Cost Estimate

| Item | Cost |
|---|---|
| Supabase Pro | $25/mo |
| Vercel Pro | $20/mo |
| **Total** | **~$45/mo** |

Usage overages (MAUs, storage, egress) would add to this if traffic is high. For a modest academic/research user base, the base cost covers it.

---

## 2. Use Cases & Access Patterns

| Pattern | Auth Required | Data Location |
|---|---|---|
| **Logged-in user** | Login | Cloud (Supabase) — full read/write access to own data |
| **Local-only user** | None | Browser only (IndexedDB) — data never leaves the machine |
| **Sample explorer** | None | Cloud (Supabase) — read-only access to demo regions |

### Local-Only Use Case

Some users consider groundwater data confidential or need to work without internet access. For these users:

- The app runs entirely in the browser. No data is transmitted over the network.
- Users upload a zip file containing their region data. It is loaded into IndexedDB (browser-local storage).
- All visualization and analysis features work identically to cloud mode.
- Users can export their data back as a zip file when done.
- When the browser tab closes, the data can be cleared (with a warning).

---

## 3. App Modes & Entry Flow

```
User visits app
  │
  ├─→ "Sign In" → Supabase Auth → Cloud Mode
  │     ├─→ Dashboard: your regions
  │     ├─→ Import data (writes to Supabase)
  │     └─→ Full app functionality
  │
  ├─→ "Use Locally" → Local Mode
  │     ├─→ Upload zip file → IndexedDB
  │     ├─→ Full app functionality (view, analyze, import)
  │     ├─→ Export zip when done
  │     └─→ Data never leaves the browser
  │
  └─→ "Explore Sample Data" → Read-Only Mode (no login)
        └─→ Browse pre-loaded demo regions
```

---

## 4. Current On-Disk Data Layout (Reference)

This section documents the current file-based storage structure for reference during migration.

### Directory Structure

```
public/data/
├── {region-id}/                        # e.g. "jamaica", "utah", "great-salt-lake-basin"
│   ├── region.json                     # Region metadata (id, name, lengthUnit, singleUnit, dataTypes[])
│   ├── region.geojson                  # Region boundary (FeatureCollection, single polygon)
│   ├── aquifers.geojson                # Aquifer boundaries (FeatureCollection, multiple polygons)
│   │                                   #   Properties: { aquifer_id: "2", aquifer_name: "Kingston" }
│   ├── wells.csv                       # Well locations
│   │                                   #   Columns: well_id, well_name, lat, long, gse, aquifer_id
│   ├── data_{code}.csv                 # One file per data type (e.g. data_wte.csv, data_salt.csv)
│   │                                   #   Columns: well_id, well_name, date, value, aquifer_id
│   └── {aquifer-slug}/                 # One subfolder per aquifer that has spatial analyses
│       └── raster_{dataType}_{code}.json   # Spatial analysis result (~0.5–2 MB each)
```

### Aquifer Slug Convention

Aquifer subfolders are named using `slugify(aquifer_name)`:

```typescript
const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
```

Examples: `"Kingston"` → `"kingston"`, `"Blue Mountain South"` → `"blue_mountain_south"`

### Raster Analysis Files

Each file contains the full analysis result:

```json
{
  "version": 1,
  "title": "kriging",
  "code": "kriging",
  "aquiferId": "2",
  "aquiferName": "Kingston",
  "regionId": "jamaica",
  "dataType": "wte",
  "params": { "startDate": "...", "endDate": "...", "resolution": 50, ... },
  "options": { "temporal": { ... }, "spatial": { ... } },
  "grid": { "minLng": ..., "minLat": ..., "dx": ..., "dy": ..., "nx": 50, "ny": 40, "mask": [...] },
  "frames": [ { "date": "...", "values": [...] }, ... ],
  "createdAt": "...",
  "generatedAt": "..."
}
```

### Current Dataset Summary

| Region | Wells | Measurement Rows | Data Types | Spatial Analyses |
|---|---|---|---|---|
| Dominican Republic | 699 | 15,080 | wte, tce | — |
| Great Salt Lake Basin | 3,150 | 177,209 | wte | — |
| Guam | 21 | 602 | wte | — |
| Jamaica | 699 | 116,913 | wte, salt | 5 (Kingston aquifer) |
| Jordan | 34 | 5,868 | wte | — |
| Niger | 125 | 2,323 | wte | — |
| Oregon | 246 | 3,983 | wte | — |
| Utah | 1,876 | 179,665 | wte | — |
| Volta Basin | 14 | 619 | wte | — |
| **Total** | **6,864** | **502,262** | | **5** |

---

## 5. Database Schema

### User Profiles

```sql
-- Users (extends Supabase auth.users)
CREATE TABLE public.profiles (
    id          uuid PRIMARY KEY REFERENCES auth.users(id),
    email       text NOT NULL,
    display_name text,
    created_at  timestamptz DEFAULT now()
);
```

### Aquifer Analyst Tables (`aquifer` schema)

```sql
CREATE SCHEMA IF NOT EXISTS aquifer;

-- Regions (owned by individual users)
CREATE TABLE aquifer.regions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    slug        text NOT NULL,
    name        text NOT NULL,
    length_unit text NOT NULL CHECK (length_unit IN ('ft', 'm')),
    single_unit boolean NOT NULL DEFAULT false,
    boundary    jsonb,                        -- GeoJSON geometry
    is_sample   boolean NOT NULL DEFAULT false,
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now(),
    UNIQUE (user_id, slug)
);

-- Data types (per region)
CREATE TABLE aquifer.data_types (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   uuid NOT NULL REFERENCES aquifer.regions(id) ON DELETE CASCADE,
    code        varchar(20) NOT NULL,
    name        text NOT NULL,
    unit        text NOT NULL,
    UNIQUE (region_id, code)
);

-- Aquifers
CREATE TABLE aquifer.aquifers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   uuid NOT NULL REFERENCES aquifer.regions(id) ON DELETE CASCADE,
    aquifer_id  text NOT NULL,      -- user-facing ID ("0", "1", etc.)
    aquifer_name text NOT NULL,
    boundary    jsonb,              -- GeoJSON geometry
    UNIQUE (region_id, aquifer_id)
);

-- Wells
CREATE TABLE aquifer.wells (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   uuid NOT NULL REFERENCES aquifer.regions(id) ON DELETE CASCADE,
    aquifer_id  uuid REFERENCES aquifer.aquifers(id) ON DELETE SET NULL,
    well_id     text NOT NULL,      -- user-facing ID
    well_name   text,
    lat         double precision NOT NULL,
    long        double precision NOT NULL,
    gse         double precision,   -- ground surface elevation
    created_at  timestamptz DEFAULT now(),
    UNIQUE (region_id, well_id)
);

-- Measurements
CREATE TABLE aquifer.measurements (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   uuid NOT NULL REFERENCES aquifer.regions(id) ON DELETE CASCADE,
    well_id     uuid NOT NULL REFERENCES aquifer.wells(id) ON DELETE CASCADE,
    data_type   varchar(20) NOT NULL,
    date        date NOT NULL,
    value       double precision NOT NULL
);
CREATE INDEX idx_measurements_lookup
    ON aquifer.measurements (region_id, well_id, data_type, date);

-- Spatial analyses (raster interpolations: kriging, IDW, etc.)
-- Metadata stored in Postgres; large result data stored in Supabase Storage.
--
-- Each raster JSON file is ~0.5–2 MB (grids, frames, masks). Storing these
-- as JSONB in Postgres would bloat the database. Instead, the result data
-- goes into a Supabase Storage bucket and this table stores a reference.
CREATE TABLE aquifer.spatial_analyses (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id     uuid NOT NULL REFERENCES aquifer.regions(id) ON DELETE CASCADE,
    aquifer_id    uuid REFERENCES aquifer.aquifers(id) ON DELETE CASCADE,
    data_type     varchar(20) NOT NULL,    -- e.g. "wte", "salt"
    title         text NOT NULL,
    code          text NOT NULL,           -- slugified title, used in filenames
    params        jsonb NOT NULL,          -- RasterAnalysisParams (dates, resolution, method, etc.)
    options       jsonb,                   -- TemporalOptions, SpatialOptions
    storage_path  text NOT NULL,           -- path in Supabase Storage bucket
    created_at    timestamptz DEFAULT now(),
    generated_at  timestamptz,
    UNIQUE (region_id, aquifer_id, data_type, code)
);

-- Sample region templates (for the "Explore Sample Data" feature)
CREATE TABLE aquifer.sample_region_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    description text,
    thumbnail_url text,
    bundle_path text NOT NULL,      -- path in Supabase Storage to the zip
    created_at  timestamptz DEFAULT now()
);
```

---

## 6. Row-Level Security (RLS)

All tables have RLS enabled. With single-user ownership, policies are straightforward.

### Profiles

```sql
-- Users can read all profiles, update only their own
CREATE POLICY "Profiles are publicly readable"
    ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE USING (id = auth.uid());
```

### Regions

```sql
-- Users can read their own regions and sample regions
CREATE POLICY "Users can view own and sample regions"
    ON aquifer.regions FOR SELECT
    USING (user_id = auth.uid() OR is_sample = true);

-- Users can only write their own regions
CREATE POLICY "Users can modify own regions"
    ON aquifer.regions FOR ALL
    USING (user_id = auth.uid());
```

### Child Tables (aquifers, wells, measurements, data_types, spatial_analyses)

All inherit access from their parent region:

```sql
-- Read: allowed if the parent region is readable
CREATE POLICY "Readable if region is readable"
    ON aquifer.wells FOR SELECT
    USING (region_id IN (
        SELECT id FROM aquifer.regions
        WHERE user_id = auth.uid() OR is_sample = true
    ));

-- Write: allowed if user owns the parent region
CREATE POLICY "Writable if user owns region"
    ON aquifer.wells FOR ALL
    USING (region_id IN (
        SELECT id FROM aquifer.regions
        WHERE user_id = auth.uid()
    ));
```

The same pattern applies to all child tables in the `aquifer` schema.

---

## 7. Data Provider Abstraction Layer

The abstraction layer is the key architectural piece that enables both cloud and local modes. Components never call Supabase or fetch APIs directly — they go through a provider interface.

### Interface

```typescript
interface DataProvider {
  // Regions
  listRegions(): Promise<RegionMeta[]>;
  getRegion(id: string): Promise<Region>;
  saveRegion(region: RegionInput): Promise<Region>;
  updateRegion(id: string, updates: { name?: string; lengthUnit?: 'ft' | 'm' }): Promise<void>;
  deleteRegion(id: string): Promise<void>;

  // Aquifers
  getAquifers(regionId: string): Promise<Aquifer[]>;
  saveAquifers(regionId: string, aquifers: AquiferInput[], mode: 'append' | 'replace'): Promise<void>;
  renameAquifer(regionId: string, aquiferId: string, newName: string): Promise<void>;
  deleteAquifer(regionId: string, aquiferId: string): Promise<void>;  // cascades to wells + measurements

  // Wells
  getWells(regionId: string): Promise<Well[]>;
  saveWells(regionId: string, wells: WellInput[], mode: 'append' | 'replace'): Promise<void>;

  // Measurements
  getMeasurements(regionId: string, dataType: string): Promise<Measurement[]>;
  saveMeasurements(regionId: string, dataType: string, data: MeasurementInput[], mode: 'append' | 'replace'): Promise<void>;
  updateMeasurement(regionId: string, wellId: string, dataType: string, date: string, value: number): Promise<void>;
  deleteMeasurement(regionId: string, wellId: string, dataType: string, date: string): Promise<void>;

  // Spatial analyses (raster interpolations)
  listSpatialAnalyses(regionId: string): Promise<RasterAnalysisMeta[]>;
  getSpatialAnalysis(regionId: string, filePath: string): Promise<RasterAnalysisResult>;
  saveSpatialAnalysis(regionId: string, result: RasterAnalysisResult): Promise<void>;
  deleteSpatialAnalysis(regionId: string, filePath: string): Promise<void>;
  renameSpatialAnalysis(regionId: string, oldPath: string, newTitle: string, newCode: string): Promise<void>;

  // Imputation models
  listModels(regionId: string): Promise<ImputationModelMeta[]>;
  getModel(regionId: string, filePath: string): Promise<ImputationModelResult>;
  deleteModel(regionId: string, filePath: string): Promise<void>;
  renameModel(regionId: string, oldPath: string, newTitle: string, newCode: string): Promise<void>;

  // GeoJSON boundaries
  getRegionBoundary(regionId: string): Promise<GeoJSON.FeatureCollection>;
  getAquiferBoundaries(regionId: string): Promise<GeoJSON.FeatureCollection>;

  // Data types
  getDataTypes(regionId: string): Promise<DataType[]>;
  saveDataType(regionId: string, dataType: DataType): Promise<void>;
  deleteDataType(regionId: string, code: string): Promise<void>;

  // Bulk import/export (zip-based)
  exportRegion(regionId: string): Promise<Blob>;                     // returns zip
  exportDatabase(): Promise<Blob>;                                    // returns zip of all regions
  importRegionFromZip(file: File): Promise<{ regionId: string }>;
  importDatabaseFromZip(file: File, mode: 'append' | 'replace'): Promise<ImportResult>;
}
```

### Implementations

Three implementations back this interface, built in order:

1. **`ViteDataProvider`** — Wraps the current Vite dev server middleware (`/api/*` endpoints and `/data/*` file reads). This is the first implementation, built during Phase 1. It preserves all existing behavior while routing through the interface. Used during development.

2. **`IndexedDBDataProvider`** — Reads and writes to browser IndexedDB. Built during Phase 2. Data is loaded from a user-uploaded zip and stored in IndexedDB object stores (one per entity type). Spatial analysis results are stored as IndexedDB blobs. Zero network requests. Used in local-only mode.

3. **`SupabaseDataProvider`** — Reads and writes to Supabase Postgres via the Supabase JS client SDK. Built later (Phase 4). Scopes all queries by the authenticated user's ID from `AuthContext`. Spatial analysis results stored in a Supabase Storage bucket. Used in cloud mode.

### React Integration

```typescript
// Context provides the active data provider
const DataProviderContext = createContext<DataProvider>(null!);

// Hook used by all components
function useDataProvider(): DataProvider {
  return useContext(DataProviderContext);
}

// App root selects the provider based on mode
function App() {
  const [mode, setMode] = useState<'vite' | 'local' | 'cloud'>('vite');
  const provider = useMemo(() => {
    switch (mode) {
      case 'vite':  return new ViteDataProvider();
      case 'local': return new IndexedDBDataProvider();
      case 'cloud': return new SupabaseDataProvider(supabaseClient);
    }
  }, [mode]);

  return (
    <DataProviderContext.Provider value={provider}>
      {/* ... */}
    </DataProviderContext.Provider>
  );
}
```

### ViteDataProvider Method Mapping

**Reads (wrapping current fetch/freshFetch calls):**

| Method | Current location | What it wraps |
|---|---|---|
| `listRegions()` | `dataLoader.ts:179`, `ImportDataHub.tsx:28` | `GET /api/regions` |
| `getRegion(id)` | `dataLoader.ts:393` | Load `region.json` + `region.geojson`, compute bounds |
| `getAquifers(regionId)` | `dataLoader.ts:203` | Load `aquifers.geojson`, group by `aquifer_id` |
| `getWells(regionId)` | `dataLoader.ts:294` | Parse `wells.csv` |
| `getMeasurements(regionId, dataType)` | `dataLoader.ts:336` | Parse `data_{code}.csv` |
| `getRegionBoundary(regionId)` | `dataLoader.ts:393` | Load `region.geojson` |
| `getAquiferBoundaries(regionId)` | Multiple places | Load raw `aquifers.geojson` |
| `getDataTypes(regionId)` | Via `listRegions()` | Extract from `region.json` metadata |
| `listSpatialAnalyses(regionId)` | `dataLoader.ts:426` | `GET /api/list-rasters?region={id}` |
| `getSpatialAnalysis(regionId, path)` | `App.tsx:469` | Load raster JSON from `/data/{path}` |
| `listModels(regionId)` | `dataLoader.ts:437` | `GET /api/list-models?region={id}` |
| `getModel(regionId, path)` | `App.tsx:577` | Load model JSON from `/data/{path}` |

**Writes (wrapping current saveFiles/deleteFile/fetch POST calls):**

| Method | Current location | What it wraps |
|---|---|---|
| `saveRegion(input)` | `RegionImporter.tsx:96,182` | Save `region.json` + `region.geojson` via `POST /api/save-data` |
| `updateRegion(id, updates)` | `App.tsx:810`, `RegionEditor.tsx:98` | Load `region.json`, update fields, save back |
| `deleteRegion(id)` | `App.tsx:833`, `RegionEditor.tsx:61` | `POST /api/delete-folder` |
| `saveAquifers(regionId, ...)` | `AquiferImporter.tsx:80,100` | Save `aquifers.geojson` |
| `renameAquifer(...)` | `App.tsx:880` | Rebuild + save `aquifers.geojson` |
| `deleteAquifer(...)` | `App.tsx:903`, `AquiferEditor.tsx` | Rebuild `aquifers.geojson`, `wells.csv`, all `data_*.csv` |
| `saveWells(regionId, ...)` | `WellImporter.tsx:483–520` | Save `wells.csv` |
| `saveMeasurements(...)` | `MeasurementImporter.tsx:358,401` | Save `data_{code}.csv` |
| `updateMeasurement(...)` | `DataEditor.tsx` | Edit single row in `data_{code}.csv` |
| `deleteMeasurement(...)` | `DataEditor.tsx` | Remove single row from `data_{code}.csv` |
| `saveSpatialAnalysis(...)` | `rasterAnalysis.ts:418` | `POST /api/save-data` with raster JSON |
| `deleteSpatialAnalysis(...)` | `App.tsx:525` | `POST /api/delete-file` |
| `renameSpatialAnalysis(...)` | `App.tsx:543` | `POST /api/rename-raster` |
| `deleteModel(...)` | `App.tsx:601` | `POST /api/delete-file` |
| `renameModel(...)` | `App.tsx:618` | `POST /api/rename-model` |
| `saveDataType(...)` | `DataTypeEditor.tsx:83` | Update `region.json` dataTypes array |
| `deleteDataType(...)` | `DataTypeEditor.tsx:120` | Delete `data_{code}.csv` + update `region.json` |
| `exportRegion(id)` | `Sidebar.tsx` (download) | Fetch all region files, zip via JSZip |
| `exportDatabase()` | `ImportDataHub.tsx:125` | Fetch all regions, zip via JSZip |
| `importRegionFromZip(file)` | `RegionImporter.tsx` (import mode) | Parse zip, save files |
| `importDatabaseFromZip(...)` | `ImportDataHub.tsx:175` | Parse zip, save/replace regions |

---

## 8. Vercel API Routes

The current Vite dev server middleware (`vite.config.ts` plugin) is replaced with Vercel serverless functions in the `api/` directory.

```
api/
  ├── auth/
  │   └── callback.ts              # Supabase auth callback handler
  │
  ├── regions/
  │   ├── index.ts                 # GET: list user's regions; POST: create region
  │   └── [id].ts                  # GET: single region; PUT: update; DELETE: delete
  │
  ├── regions/[id]/
  │   ├── aquifers.ts              # GET: list; POST: save aquifers
  │   ├── wells.ts                 # GET: list; POST: save wells
  │   ├── measurements.ts          # GET: list by data type; POST: save measurements
  │   ├── data-types.ts            # GET: list; POST: add; DELETE: remove
  │   └── spatial/
  │       ├── index.ts             # GET: list spatial analyses; POST: save
  │       └── [analysisId].ts      # GET: fetch result from Storage; PUT: rename; DELETE: remove
  │
  └── samples/
      └── index.ts                 # GET: list sample templates
```

Each route:
1. Extracts the Supabase JWT from the `Authorization` header.
2. Creates a Supabase server client scoped to that user.
3. Performs the database operation with RLS automatically enforced.
4. Returns JSON responses.

---

## 9. Sample Regions

Sample regions allow new users to explore the app immediately without uploading their own data.

### How It Works

- Sample region templates are stored in **Supabase Storage** as zip bundles (same format as the current region folder structure: `region.json`, `region.geojson`, `aquifers.geojson`, `wells.csv`, `data_*.csv`).
- A `sample_region_templates` table stores metadata: name, description, thumbnail URL.
- The app shows a **"Sample Data"** section accessible without login. Users can browse and explore these regions in read-only mode.
- Logged-in users get an **"Import to My Regions"** button that copies a template into their account as a real, editable region.
- In **local mode**, sample regions are downloadable as zip files that the user can then upload.

### Initial Migration

The 9 existing regions in `public/data/` become the initial set of sample region templates:
- dominican-republic
- great-salt-lake-basin
- guam
- jamaica
- jordan
- niger
- oregon
- utah
- volta-basin

---

## 10. Implementation Phases

Phases are ordered so that the data abstraction layer and local mode can be built first (Phases 1–2), independently of Supabase and deployment work (Phases 3–5). This allows parallel workstreams.

### Phase 1 — Data Abstraction Layer + ViteDataProvider

*No user-visible changes. Purely architectural preparation. The app works exactly as before, but all data I/O goes through the provider interface.*

#### 1a. Define the DataProvider interface

- Create `services/dataProvider.ts` with the `DataProvider` interface (Section 7).
- Define input types where needed: `RegionInput`, `AquiferInput`, `WellInput`, `MeasurementInput`, `ImportResult`.

#### 1b. Implement ViteDataProvider

Implement `services/viteDataProvider.ts` — wraps all current Vite middleware calls and `/data/*` file reads behind the interface. This is a mechanical translation: each interface method maps to the existing `fetch()` / `freshFetch()` / `saveFiles()` / `deleteFile()` calls that currently live scattered across components. See the method mapping table in Section 7 for the full list.

#### 1c. Create React context and hook

- Create `services/DataProviderContext.tsx`:
  - `DataProviderContext` — React context holding the active provider
  - `useDataProvider()` — hook that returns the context value
  - `DataProviderWrapper` — component that creates the `ViteDataProvider` and wraps children
- Wrap the app root in `DataProviderWrapper`.
- Initially, mode is always `'vite'`. Mode switching comes in Phase 2.

#### 1d. Refactor components (incremental, one group at a time)

Refactor all components to call `useDataProvider()` instead of direct fetch/API calls. Do this incrementally — one functional area at a time, testing after each:

**Group 1 — Data loading** (highest impact, touches `App.tsx` and `dataLoader.ts`):
- Replace `loadAllData()` in `App.tsx` with provider calls
- `loadRegionManifest()` → `provider.listRegions()`
- Region/aquifer/well/measurement loading → respective `get*()` methods
- Raster and model listing → `provider.listSpatialAnalyses()`, `provider.listModels()`

**Group 2 — Region management** (`Sidebar.tsx`, `App.tsx`, `RegionEditor.tsx`):
- Region rename → `provider.updateRegion()`
- Region delete → `provider.deleteRegion()`

**Group 3 — Aquifer management** (`App.tsx`, `AquiferEditor.tsx`):
- Aquifer rename → `provider.renameAquifer()`
- Aquifer delete → `provider.deleteAquifer()`

**Group 4 — Import wizards** (`ImportDataHub.tsx`, `RegionImporter.tsx`, `AquiferImporter.tsx`, `WellImporter.tsx`, `MeasurementImporter.tsx`, `DataTypeEditor.tsx`):
- Region import → `provider.saveRegion()` / `provider.importRegionFromZip()`
- Aquifer import → `provider.saveAquifers()`
- Well import → `provider.saveWells()`
- Measurement import → `provider.saveMeasurements()`
- Data type add/delete → `provider.saveDataType()` / `provider.deleteDataType()`
- Database export/import → `provider.exportDatabase()` / `provider.importDatabaseFromZip()`

**Group 5 — Spatial analyses and models** (`App.tsx`, `rasterAnalysis.ts`):
- Raster load/save/delete/rename → `provider.get/save/delete/renameSpatialAnalysis()`
- Model load/delete/rename → `provider.get/delete/renameModel()`

**Group 6 — Data editor** (`DataEditor.tsx`):
- Measurement edit/delete → `provider.updateMeasurement()` / `provider.deleteMeasurement()`

#### 1e. Clean up dead code

- Remove direct `fetch()`, `freshFetch()`, `saveFiles()`, `deleteFile()` calls from components (they should only exist inside `ViteDataProvider` now).
- `services/importUtils.ts` — keep CSV parsing, date detection, column mapping, and spatial utilities. Move `saveFiles()`, `deleteFile()`, `freshFetch()` to `ViteDataProvider` internals (or keep them as private helpers imported only by `ViteDataProvider`).
- `services/dataLoader.ts` — most of `loadAllData()` logic moves into `ViteDataProvider`. The file may be eliminated or reduced to helper functions.

#### Validation

- All existing functionality must work identically after this phase.
- Run `npx tsc --noEmit` — no type errors.
- Manual test: import region, add aquifers/wells/measurements, create spatial analysis, edit data, delete data, export database.
- Grep the codebase: no component should contain direct `fetch('/api/` or `fetch('/data/` calls except inside `ViteDataProvider`.

---

### Phase 2 — IndexedDB Data Provider + Local Mode

*First user-visible change: a "Use Locally" option that runs the full app with zero network requests.*

#### 2a. IndexedDB data provider

- Implement `services/indexedDBDataProvider.ts` conforming to the same `DataProvider` interface.
- Create IndexedDB database `aquiferx` with object stores:
  - `regions` — keyed by `id`, stores `RegionMeta` + boundary GeoJSON
  - `aquifers` — keyed by `[regionId, aquiferId]`, stores boundary GeoJSON per aquifer
  - `wells` — keyed by `[regionId, wellId]`, stores well data
  - `measurements` — keyed by `[regionId, wellId, dataType, date]`, stores values
  - `spatialAnalyses` — keyed by path, stores full raster JSON (as blobs for large results)
  - `models` — keyed by path, stores full model JSON
- All operations are async (IndexedDB is async by nature), matching the `Promise`-based interface.
- Use the `idb` library (lightweight IndexedDB wrapper with proper TypeScript types) or raw IndexedDB API.

#### 2b. Zip upload flow

- Build a **mode selector** UI (landing page or modal) with "Use Locally" entry point.
- User selects a zip file → parse in-browser via JSZip (already a dependency).
- Discover regions in the zip (find `region.json` files), same logic as current `importDatabaseFromZip`.
- Populate IndexedDB object stores from the parsed zip data.
- Switch the `DataProviderContext` to `IndexedDBDataProvider`.
- App loads and renders from IndexedDB — full visualization, analysis, import features work.

#### 2c. Zip export flow

- `exportDatabase()` on the IndexedDB provider reads all object stores and builds a zip in the same format as the current file layout.
- User downloads the zip — can re-upload it later or share with others.

#### 2d. Session management

- `beforeunload` listener warns user if IndexedDB has data and they haven't exported.
- "Clear Data" action in the UI that wipes IndexedDB stores and returns to mode selection.
- Optionally persist data across sessions (IndexedDB survives tab close by default) — let user choose "Keep data in browser" vs. "Clear on close".

#### Validation

- Verify zero network requests in local mode (browser DevTools network tab).
- Full test: upload zip → browse regions → view map → view charts → run spatial analysis → export zip → re-import → verify data integrity.
- Test with the existing sample datasets (Jamaica, Utah, etc.) exported as zip.

---

### Phase 3 — Supabase Setup & Database Schema

*Infrastructure only. No app changes. Can be done in parallel with Phases 1–2.*

- Create Supabase project.
- Apply schema: `profiles` table in `public`, all Aquifer Analyst tables in `aquifer` schema (Section 5).
- Write and test RLS policies (Section 6).
- Set up Supabase Storage bucket for raster results and zip files.
- Configure auth providers (email/password, Google).
- Package the existing regions as sample region templates and upload to Supabase Storage.

### Phase 4 — Authentication + Cloud Data Provider

*Users can sign up, log in, and persist data in the cloud.*

- Build login / signup page (email + social provider buttons).
- Update the **landing page** with three entry points: Sign In, Use Locally, Explore Samples.
- Add auth state to React context (current user info).
- Update the header with user menu (avatar, logout).
- Implement `SupabaseDataProvider` with all CRUD operations against Postgres.
- User scoping: provider reads authenticated user ID from `AuthContext` and filters all queries by `user_id`.
- Spatial analysis results stored in Supabase Storage bucket; metadata in `aquifer.spatial_analyses`.
- Handle large measurement datasets (pagination or streaming for regions with 100K+ rows).
- Test the full import → visualize → analyze flow end-to-end.

### Phase 5 — Vercel Deployment

*Go live.*

- Create Vercel project linked to the GitHub repo.
- Implement serverless API routes in `api/` (Section 8) for any operations that require server-side logic.
- Configure environment variables in Vercel dashboard (Supabase URL, anon key, service role key).
- Set up preview deployments for pull requests.
- DNS configuration for the production domain.
- Remove the Vite dev server middleware plugin (no longer needed in production).
- Verify the full flow in the deployed environment.

### Phase 6 — Sample Regions

*Polish. Demo data for new users.*

- Build the **sample regions gallery** UI: grid of cards with thumbnails, names, descriptions.
- Wire up unauthenticated read path through the Supabase provider (anon key + RLS policies for sample regions).
- Implement "Import to My Regions" flow for logged-in users: copy template data into user's account.
- Upload the 9 existing regions as sample templates.

---

## 11. What Changes and What Doesn't

### Unchanged

These components and systems remain as they are today:

- **Visualization**: MapView, TimeSeriesChart, StorageOverlay, CrossSectionChart, DataEditor
- **Import wizard UI/UX**: ImportDataHub, RegionImporter, AquiferImporter, WellImporter, MeasurementImporter, DataTypeEditor, ColumnMapperModal, ConfirmDialog
- **Data formats**: CSV, GeoJSON, region.json — still used for import, export, local mode, and sample region bundles
- **Client-side computation**: Kriging, storage analysis, PCHIP interpolation, trend analysis, CRS reprojection
- **Services**: usgsApi.ts, kriging.ts, storageAnalysis.ts, reprojection.ts

### Changed

- **Data access**: All components read/write through the `DataProvider` interface instead of direct API calls.
- **App entry point**: New landing page with mode selection (Sign In / Use Locally / Explore Samples).
- **Header**: User avatar, login/logout controls.
- **Sidebar**: Regions listed per user. Login-aware (edit controls hidden when not authenticated).
- **Data loading**: `loadAllData()` replaced by provider calls. No more full-reload refresh — incremental updates where possible.
- **Hosting**: Vite dev server middleware → Vercel serverless functions for production. Vite middleware retained for local development.

---

## 12. Potential Future Features

The following features were considered during planning but deferred in favor of a simpler initial release. They can be revisited once the core single-user system is stable.

### Organizational Accounts

Add organizations so that teams can share data:

- **Organizations table** — `id`, `name`, `slug`, `created_by`
- **Org memberships** — `org_id`, `user_id`, `role` (admin/viewer)
- **Region ownership** — regions can optionally belong to an org instead of (or in addition to) a user
- **Role-based access** — admins have read/write; viewers have read-only. Roles apply to all of an org's regions.
- **Self-service creation** — any logged-in user can create an org and invite members via email
- **UI additions** — org selector dropdown in header, member management page, role badges, import hub gated by admin role
- **Optimistic locking** — when multiple admins can edit, add a `version` column to regions for conflict detection

### Public Data Sharing

Allow users or organizations to make regions publicly accessible:

- **Visibility toggle** — region setting: private (default) vs. public
- **Public URL scheme** — e.g. `/public/{user-slug}/{region-slug}` — accessible without login
- **RLS policy update** — add `visibility = 'public'` to SELECT policies for unauthenticated access
- **Read-only mode** — public visitors see data but cannot edit or import

### Multi-App Shared Infrastructure (GEOGLOWS Suite)

The Aquifer Analyst is part of the broader [GEOGLOWS](https://dev.apps.geoglows.org/) web application suite alongside Hydroviewer RFS v2 and GRACE Regional Groundwater Analyst. Future work could:

- **Share one Supabase project** across all three apps — users sign up once and have the same account everywhere
- **Shared Postgres schemas** — `public` schema for profiles/orgs/memberships; app-specific schemas (`aquifer`, `hydroviewer`, `grace`) for each app's data
- **`@geoglows/auth` NPM package** — extract shared auth components (login page, org selector, user menu, React contexts/hooks) so all three apps get consistent auth UI
- **Cross-app organizations** — if a user creates an org, that org's members can access data in all three apps
- **Cross-app SSO** — since apps live on different subdomains, sessions are separate by default. Could add a central auth page or shared cookie domain for seamless single sign-on

### Additional Ideas

- **SAML/SSO** for institutional logins (university identity providers)
- **Real-time collaboration** via Supabase real-time subscriptions (e.g. "someone else just imported new data")
- **API keys** for programmatic access to a user's data
- **Usage analytics** to understand which features and datasets get the most use
