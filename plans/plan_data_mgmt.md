# Data Management

## Problem & Goal

[`user_and_data_strategy.md`](./user_and_data_strategy.md) proposed storing everything a user uploads in a Supabase database. The problem: with our USGS and water-quality download tools, users can accumulate very large datasets very quickly. **As an organization we do not want to be on the hook for hosting and maintaining everyone's groundwater data** — especially given a worldwide mission that includes supporting many organizations in developing countries.

This document defines a strategy that keeps our lightweight file-based format, lets users own (and pay for) the storage of their bulk data, and reserves a small hosted database only for accounts and metadata.

## Current File-Based System (the foundation we keep)

Today, data are stored as a hierarchy of CSV and JSON files under `public/data/`, organized by region and then aquifer (`region-id/region.json`, `data_{code}.csv`, etc.). The whole database can be zipped for download and restored by uploading a zip. It is lightweight and very responsive because files are loaded on demand. **We keep this file format.** The rest of this plan is about *where* those files live and *how* they sync.

---

## Decisions

### 1. Metadata plane vs. data plane

We split storage into two planes with opposite economics. This reconciles this plan with `user_and_data_strategy.md`: we still use a database, but only for the small metadata plane.

- **Metadata plane — we host (tiny).** A small database (Supabase) holds user accounts, organization membership, roles (admin / viewer), public-vs-private flags, encrypted storage credentials, and a *pointer* to where each dataset lives. Kilobytes per user; effectively free to host indefinitely.
- **Data plane — the user/org hosts (potentially huge).** The actual regions, aquifers, wells, and measurements, kept in our file format, stored in storage the user or organization owns.

### 2. Production backend: thin serverless functions

The current file API in `vite.config.ts` is **dev-only** and will not exist in a static production deploy. We replace it with a **thin serverless backend** (e.g. Vercel functions) that:

- signs and mediates uploads/downloads to the user's remote storage,
- holds storage credentials **encrypted server-side** (never exposed to the browser),
- enforces conflict checks on writes (see §6).

This is the only clean way to keep third-party cloud secrets off the client and to mediate multi-user conflicts.

### 3. Three storage modes, chosen at first launch

When a user first launches the app under their account, a startup screen offers three modes. The chosen mode determines save behavior.

1. **Sample database** — a small, read-only dataset we provide so new users see the app working immediately. Nothing to sync.
2. **Remote storage (Bring Your Own Storage)** — connect the organization's own remote store. This is the primary answer to the storage-liability problem and solves organization sharing for free: every admin/viewer in the org points at the same store. Save behavior is **autosync** (§5).
3. **Local-only (state-secret case)** — no server storage at all. An unzipped working copy is kept on the user's own machine via the browser File System Access API / OPFS, with zip export/import for backup and transport. Data never touches our infrastructure. Save behavior is **manual export**.

### 4. Remote backends: a generic adapter, S3-compatible first

Because the mission is worldwide — including organizations in developing countries that may not use, or may not trust, US hyperscalers — we do **not** build one-off integrations. We build a **generic storage adapter layer** and ship drivers for:

- **S3-compatible (the global workhorse).** One driver covers AWS S3 *and* the many cheaper regional providers and self-hostable stores (e.g. MinIO) that speak the same API. This is what makes the plan viable worldwide: an org can point at low-cost regional storage, or run their own, without us building anything provider-specific.
- **HydroShare (the research/academic on-ramp).** Free for researchers, purpose-built for hydrologic data, with its own accounts, access control, and DOIs. The friendliest option for the academic slice of the GEOGLOWS audience.

Additional drivers (Box, Google Cloud, Azure) can be added later against the same adapter interface as specific organizations require them.

### 5. Sync model: autosync + versioning + explicit checkpoints

For the **remote** mode, changed files sync automatically rather than waiting for a manual Save. We separate the two jobs the word "save" performs:

- **Durability ("my work won't be lost") → autosync.** Changed files upload automatically as the user works (Google-Docs style: no Save button, an "all changes saved ✓" indicator instead). This removes the biggest failure mode of a manual-save model — forgetting to save.
- **Checkpointing ("a deliberate version I might return to") → explicit snapshot.** A separate action tags a milestone version. Autosync does not replace this.

Design details:

- **Preserve the file hierarchy; sync per file.** Mirror the existing folder tree directly onto the remote store as object keys. **Save = upload only the files that changed** — never re-zip and re-upload the whole database. Zip is reserved for import / export / backup / transport (and the local mode). This preserves load-on-demand responsiveness; a 500 MB dataset never round-trips as a single blob.
- **Bucket versioning** (native to S3-compatible stores) retains prior versions, so rollback is free — important because our destructive operations (bulk import, well imputation, spatial interpolation) regularly produce results a user wants to discard. The "checkpoint" action tags a version rather than copying data.
- **Debounce / coalesce.** Sync after an *operation* completes (import done, interpolation applied, edit committed), not per row. A 50k-row import is one `data_{code}.csv` PUT.
- **Visible sync status.** A persistent status chip — *Synced ✓ / Syncing… / Offline — N changes pending / Sync failed ⟳* — replaces the idea of a manual save button. Interface clarity comes from status, not from a button users must remember to press.
- **Offline / failure queue.** A local dirty-file queue (OPFS / IndexedDB) drains when connectivity returns, so autosync degrades gracefully into local storage instead of erroring — valuable for users on intermittent connections.

### 6. Concurrency & conflicts

Organizations may have multiple admins editing at once. We reuse the optimistic-locking approach already in `save-data`:

- **Per-file conditional writes** (ETag `If-Match` / S3 conditional writes). On mismatch: "this region was changed by someone else — reload / overwrite / merge." Per-file granularity keeps conflicts rare and small — another reason we sync per file rather than as one monolithic zip (which would silently clobber).
- A per-dataset version number in the metadata DB plus a "someone else saved since you loaded — reload?" prompt covers the multi-admin case. Real-time collaborative editing is out of scope.

### 7. Public vs. private sharing

Because data lives in object storage, the metadata DB flags each dataset public or private, and public datasets are exposed via a public URL prefix or signed URLs (aligning with the URL-variable idea in `user_and_data_strategy.md`).

### 8. Session resume

On login we use the stored credentials to reconnect to the user's remote store and load their last working dataset (automatically, or behind a one-click prompt).

---

## Implementation Reference: Data-Plane Serverless Layer

_Ingested from a prior `vercel_blob.md` plan, which prototyped exactly this idea — the file format on an S3-compatible object store (Vercel Blob) behind serverless functions. That plan was single-tenant and we-host (no auth, no BYOS), but its mechanics map almost directly onto the storage adapter (§4) and the thin serverless backend (§2). Vercel Blob is itself S3-compatible, so it is a valid backend driver and a reasonable first target to build/test the adapter against before wiring up user-owned buckets._

### Why reads change, not just writes

Today the browser fetches data files directly as static assets (`/data/utah/wells.csv`) because Vite builds `public/data/` into the static bundle. Once files live in an object store instead of the static build, **reads must also route through the storage layer** — either through the serverless backend or via the store's own (optionally signed) object URLs. This is easy to miss: the dev-only middleware only ever intercepted *writes*.

### Serverless function surface

The adapter/backend needs roughly this set of operations against any object-store driver (`list` / `get` / `put` / `del`), mirroring the current dev middleware:

| Operation | Purpose | Object-store calls |
|---|---|---|
| list regions | scan for `*/region.json` under the dataset prefix | `list(prefix, folded)` + `get` each |
| read file | fetch one data file (replaces direct `/data/*`) | `get(path)` |
| save files | write one or more changed files (per-file sync, §5) | `put(path, content)` × N |
| delete file | remove a file, clean up now-empty prefixes | `del(path)` |
| delete folder | remove an entire region | `list(prefix)` → `del(...)` |
| list rasters | enumerate `raster_*.json` for a region | `list(prefix)` + `get` |
| rename raster/model | read → rewrite metadata → put new → del old | `get` + `put` + `del` |

Writes should use conditional puts (ETag `If-Match`) for the per-file conflict checks in §6.

### Dev vs. prod routing

Keep the existing `vite.config.ts` middleware for **local development** (filesystem, `npm run dev` unchanged). In production, route the same logical paths to the storage layer. A single environment-aware helper keeps call sites clean:

```typescript
// dev:  /data/utah/wells.csv          (Vite serves from public/)
// prod: routed to the storage adapter (serverless API or signed object URL)
export function dataUrl(path: string): string {
  return import.meta.env.PROD ? toStorageUrl(path) : path;
}
```

Two ways to wire prod reads: (a) a Vercel rewrite (`/data/:path* → /api/...`) for zero front-end changes but a serverless hop on every read, or (b) the explicit `dataUrl()` helper, which can later point directly at CDN/object URLs for faster reads. Prefer (b) for the BYOS case, since different users' data lives at different origins.

### Migration / seeding

A one-time recursive upload script walks `public/data/` and `put`s each file at the same relative key — the seed path for moving the existing nine sample regions into a store, and the template for "export local → push to remote."

### Access control

Object `access: public` yields a CDN URL anyone with the link can read; `private` + signed URLs restricts it. This maps onto the public/private dataset flag in §7 — private datasets use signed URLs, public ones can expose a stable prefix.

---

## Open Questions

1. **Credential model per backend.** Prefer OAuth / scoped tokens over raw access keys; define per backend (S3-compatible, HydroShare, …) how credentials are obtained, stored, and refreshed.
2. **CORS.** Browser-direct transfers to a bucket require per-bucket CORS configuration; document the setup each backend needs (and whether the serverless backend proxies transfers to avoid it).
3. **Dirty-state tracking granularity.** Per file or per region? This drives both the sync queue and the conflict checks.
4. **Migration of the dev-only `vite.config.ts` file API** into the serverless backend.

## Note: managed (we-host) storage — deliberately deferred

We are **not** offering hosted storage in this plan; doing so would recreate the exact liability we are trying to avoid. If a future need arises for small users with nowhere to put data, it could be added as a **bounded, quota-limited, paid opt-in** — never as a silent default. For now, users bring their own storage or work local-only.
