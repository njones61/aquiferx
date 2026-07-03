# Data Management

## Problem & Goal

[`user_and_data_strategy.md`](./user_and_data_strategy.md) proposed storing everything a user uploads in a Supabase database. The problem: with our USGS and water-quality download tools, users can accumulate very large datasets very quickly. **As an organization we do not want to be on the hook for hosting and maintaining everyone's groundwater data** — especially given a worldwide mission that includes supporting many organizations in developing countries.

This document defines a strategy that keeps our lightweight file-based format, lets users own (and pay for) the storage of their bulk data, and reserves a small hosted database only for accounts and metadata.

## Current File-Based System (the foundation we keep)

Today, data are stored as a hierarchy of CSV and JSON files under `public/data/`, organized by region and then aquifer (`region-id/region.json`, `data_{code}.csv`, etc.), alongside derived artifacts — `raster_*.json` interpolation rasters and saved interpolation models — that are part of the same synced file tree. The whole database can be zipped for download and restored by uploading a zip. It is lightweight and very responsive because files are loaded on demand. **We keep this file format.** The rest of this plan is about *where* those files live and *how* they sync. Wherever this plan says "regions, aquifers, wells, and measurements," read it to include these derived raster and model artifacts.

---

## Decisions

### 1. Metadata plane vs. data plane

We split storage into two planes with opposite economics. This reconciles this plan with `user_and_data_strategy.md`: we still use a database, but only for the small metadata plane.

- **Metadata plane — we host (tiny).** A small database (Supabase) holds user accounts, organization membership, roles (admin / viewer), public-vs-private flags, encrypted storage credentials, and a *pointer* to where each dataset lives. Kilobytes per user; effectively free to host indefinitely.
- **Data plane — the user/org hosts (potentially huge).** The actual regions, aquifers, wells, and measurements, kept in our file format, stored in storage the user or organization owns.

**Authentication.** Login to the metadata plane uses **Supabase Auth** (email/password and OAuth providers to start; org-level SSO is a later add). An organization is a first-class record; users are provisioned into it with a role (admin can edit and manage members, viewer is read-only). Org membership — not per-file ACLs — is what grants access to a shared BYOS store: every member of an org resolves to the same storage pointer and credentials (§3.2). How a first admin creates an org and invites members is an onboarding flow to be specified alongside the startup screen (§3).

**Multi-user access is granted by org membership, not by sharing credentials.** An admin connects the org's storage *once*; the credentials are then encrypted server-side and reused on each member's behalf — members read and write the shared data without ever seeing a key. Users should **not** pass raw storage credentials around: doing so bypasses the app's viewer/admin roles and the §6 conflict checks, cannot be revoked per-person without rotating the key for everyone, and leaks the secret. Adding or removing a person is a membership change, not a credential change.

**Credential encryption & key management.** Storage credentials are encrypted at rest in the metadata DB and only ever decrypted inside the serverless backend (§2), never sent to the browser. The master/data-encryption key lives in the serverless platform's secret store (e.g. Vercel/host env), rotated independently of user records; the DB never holds plaintext secrets or the master key.

### 2. Production backend: thin serverless functions

The current file API in `vite.config.ts` is **dev-only** and will not exist in a static production deploy. We replace it with a **thin serverless backend** (e.g. Vercel functions) that:

- signs and mediates uploads/downloads to the user's remote storage,
- holds storage credentials **encrypted server-side** (never exposed to the browser),
- enforces conflict checks on writes (see §6).

This is the only clean way to keep third-party cloud secrets off the client and to mediate multi-user conflicts.

**Our backend hands out access passes; it does not carry the data itself.** Bytes move directly between the user's browser and the user's own storage, so we never pay to move data we don't host. Routing data through our backend is a deliberate exception, not the default — this is what keeps the "we're not on the hook for anyone's bulk data" promise intact.

### 3. Three storage modes, chosen at first launch

When a user first launches the app under their account, a startup screen offers three modes. The chosen mode determines save behavior.

1. **Sample database** — a small, read-only dataset we provide so new users see the app working immediately. Nothing to sync.
2. **Remote storage (Bring Your Own Storage)** — connect the organization's own remote store. This is the primary answer to the storage-liability problem and solves organization sharing for free: every admin/viewer in the org points at the same store. Save behavior is **autosync** (§5).
3. **Local-only — no server storage at all.** The working copy lives on the user's own machine and never touches our infrastructure. Originally conceived as the "state-secret" case, this is in practice expected to be **the most common mode** for much of the worldwide audience — organizations that have no cloud account, work on intermittent connections, or simply want their groundwater data to stay on their own computers. It therefore gets first-class design treatment (§3a) rather than being a fallback.

#### 3a. Local mode design (the primary path for many users)

**Save to a real folder on disk — the core of the design.** On Chrome and Edge (via the browser's File System Access API) the app asks the user *once* to pick a folder, then writes the working copy — the same region/aquifer/CSV tree — directly into that real directory on their computer. This is what makes local mode robust rather than flimsy:

- It **auto-saves continuously** as the user works — no Save button, just a **"saved to your folder ✓"** indicator (the local twin of §5's sync chip). Close the tab, reopen, the work is there.
- It **survives the browser clearing its data**, unlike a sandboxed store.
- Storage is **disk-sized**, so the bulk USGS / water-quality downloads fit with room to spare — dataset size is a non-issue on desktop.
- The data sits in a **normal, visible folder** the user can see, copy, and back up with tools they already trust.

**Backup & multi-device, using the user's own tools (we host nothing).** During setup, recommend the user place that data folder *inside a folder their computer already syncs* — OneDrive, Dropbox, Google Drive desktop, or a company network drive. They then get automatic offsite backup, and rough sync across their own machines, **for free and on their own infrastructure**, with the data never touching ours. This is the answer to local mode's single-device risk (a lost or dead laptop) without us hosting anything.

**Browser tiers — steer toward Chrome/Edge.** The real-folder capability is Chromium-only, so onboarding gently steers local-mode users there ("for the best experience with local data, use Chrome or Edge"):

- **Chrome / Edge (recommended):** real folder on disk, as above.
- **Firefox / Safari (supported, weaker):** no folder access, so the working copy falls back to the browser's **sandboxed store (OPFS)**, which is evictable (storage pressure, or the user clearing site data) and size-limited. We request persistent-storage permission to reduce eviction, and — because auto-save alone can't be trusted here — the app **nudges zip export actively**: a **"last backup: N edits ago"** status and prompts before destructive operations (bulk import, imputation, interpolation).

**Zip export/import — backup, transport, and sharing.** Regardless of tier, a deliberate zip export is the portable artifact: back up, move to another computer, or hand to a colleague. It also serves as the local "checkpoint" (the version-you-might-return-to job that §5 gives to bucket versioning in remote mode).

**Sharing has no server, by design.** Getting data to a colleague means moving a file — export a zip, they import it. Two people **must not** live-edit the same synced folder: local mode has none of the per-file conflict protection from §6, so simultaneous edits would silently clobber. The app states this plainly; genuine multi-user editing is what Remote mode (§3.2) is for.

**What local mode does *not* get.** No autosync to a server, no bucket versioning, and no multi-user conflict checks (there is only one editor). Its durability is on-device auto-save plus zip export; its versioning is the zip checkpoint; its backup is the user's own sync folder.

**Transitioning between modes.** The three modes are not one-way doors. A user who starts on the **Sample** database and then makes edits has a working copy (in OPFS) that must not be silently discarded when they connect real storage. On first connecting a Remote store (or choosing Local export), the app offers to **seed the destination from the current working copy** — the same recursive-upload path as migration/seeding below. Sample data itself is read-only, so "graduating" from Sample means: keep the user's own edits, drop the read-only sample regions (or let the user choose which to carry over). Remote ⇄ Local moves reuse zip export/import. Every transition is explicit and preview-before-commit; none silently overwrites an existing destination.

### 4. Remote backends: a generic adapter, S3-compatible first

Because the mission is worldwide — including organizations in developing countries that may not use, or may not trust, US hyperscalers — we do **not** build one-off integrations. We build a **generic storage adapter layer** and ship drivers for:

- **S3-compatible (the global workhorse).** One driver covers AWS S3 *and* the many cheaper regional providers and self-hostable stores (e.g. MinIO) that speak the same API. This is what makes the plan viable worldwide: an org can point at low-cost regional storage, or run their own, without us building anything provider-specific.
- **HydroShare (the research/academic on-ramp).** Free for researchers, purpose-built for hydrologic data, with its own accounts, access control, and DOIs. The friendliest option for the academic slice of the GEOGLOWS audience.

Additional drivers (Box, Google Cloud, Azure) can be added later against the same adapter interface as specific organizations require them.

**Not every backend supports every capability — the adapter must not pretend otherwise.** The sync and conflict machinery in §5 and §6 leans on two primitives that are native to S3-compatible stores but *not* universal: conditional writes (ETag `If-Match`) and native object versioning. HydroShare, a REST resource model, provides neither directly. So the adapter interface declares a per-driver **capability set**, and features degrade rather than break where a primitive is missing:

| Capability | S3-compatible | HydroShare | Local (OPFS) |
|---|---|---|---|
| Conditional write (§6 conflict check) | native (`If-Match`) | app-level version number in metadata DB + reload prompt | n/a (single user) |
| Versioning / rollback (§5 checkpoints) | native bucket versioning | copy-on-checkpoint (snapshot resource) or DOI-versioned publish | manual zip export only |
| Per-file sync (§5) | native | native | native |
| Signed URLs, authenticated only (§7) | native | HydroShare access controls (authenticated) | n/a |

Where a driver lacks a primitive, the fallback is app-level (a version counter in the metadata DB drives the "someone else saved — reload?" prompt; a checkpoint copies rather than tags). The adapter surfaces which guarantees a given org actually has, so the UI can state them honestly instead of implying S3 semantics everywhere.

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

**All access to the app requires a user account** — there is no anonymous entry. So public vs. private is a *scope-of-audience* flag within our authenticated user base, not an open-internet toggle:

- **Private** (default) — visible only to members of the org that owns the dataset.
- **Public** — visible to *any* authenticated Aquifer Analyst user, regardless of org. A shared, cross-org library, still gated behind login.

Because there is no anonymous read, **every read is authenticated** — there are no publicly-readable object URLs. The metadata DB flags each dataset public or private, and the backend decides whether to sign a read URL for the requesting user: for private data, only if the user is in the owning org; for public data, for any logged-in user. Public vs. private simply changes *which set of authenticated users* the backend will sign for. (This supersedes the "public URL prefix / URL-variable" idea in `user_and_data_strategy.md`, which assumed anonymous links.)

### 8. Session resume

On login we use the stored credentials to reconnect to the user's remote store and load their last working dataset (automatically, or behind a one-click prompt).

### 9. Onboarding friction & adoption

The biggest product risk in this plan is not technical — it is that **"bring your own storage" is too hard for a non-technical user, and we lose the majority of the audience before they ever save anything.** Setting up an S3-compatible store means having a cloud account with billing, creating a bucket, minting scoped credentials, and configuring CORS — several steps that a hydrologist at a water agency (especially in a developing country) has no reason to know how to do. If that were the *only* path to persistence, it would drastically limit usage.

It is not the only path. The three storage modes (§3) plus the backend choices (§4) form a **friction ladder**, and most users never need the hard rung:

| Rung | Mode / backend | Setup cost | Who it's for |
|---|---|---|---|
| Try it | Sample database | none | Anyone, first 5 minutes |
| **Primary path for many** | **Local-only (real folder on disk)** | **pick a folder once (Chrome/Edge)** | **Orgs with no cloud account, intermittent connections, or data-sovereignty needs — expected to be the most common mode (§3a)** |
| Low-barrier sharing | HydroShare | one OAuth login, free account | Researchers & academics — a large share of GEOGLOWS |
| Full BYOS | S3-compatible | real setup (bucket, keys, CORS) | Orgs with IT staff |

Two consequences for how we build and present this:

- **HydroShare is not a niche "academic on-ramp" — it is the default low-friction path for anyone without cloud-ops skills.** For much of the audience it makes the BYOS barrier disappear: no billing, no bucket, no CORS, just a login. It should be offered prominently in onboarding, not buried behind S3.
- **Lower the S3 barrier with a guided setup, not raw credential fields.** Ship a per-provider wizard with copy-paste recipes (or a downloadable script) that creates the bucket, a scoped key, and the CORS rule for the user — turning a multi-step ops task into a few screens. This is the single highest-leverage adoption investment.

**The one segment that still falls through:** a small, non-technical organization that wants persistence *and* sharing but has no cloud account and no research/HydroShare affiliation. HydroShare covers the research-adjacent; local-only covers those who don't need sharing; this specific gap is exactly what the deferred, bounded, quota-limited **paid hosted option** (see closing note) is held in reserve for.

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

Since all app access requires a login (§7), **every read is authenticated — we never use anonymous/public object URLs.** All datasets, public and private alike, are stored with `access: private` at the object-store level and served through short-lived signed URLs minted by the backend. The public/private flag in §7 does not change the storage ACL; it changes *who the backend will sign a URL for*: a private dataset is signed only for members of the owning org, a public dataset for any authenticated user. This keeps a single, uniform enforcement path (authenticate → check flag → sign) rather than mixing public CDN prefixes with signed URLs.

---

## Open Questions

1. **Credential model per backend.** Prefer OAuth / scoped tokens over raw access keys; define per backend (S3-compatible, HydroShare, …) how credentials are obtained, stored, and refreshed.
2. **CORS.** Browser-direct transfers to a bucket require per-bucket CORS configuration; document the setup each backend needs (and whether the serverless backend proxies transfers to avoid it).
3. **Dirty-state tracking granularity.** Per file or per region? This drives both the sync queue and the conflict checks.
4. **Migration of the dev-only `vite.config.ts` file API** into the serverless backend.

## Note: managed (we-host) storage — deliberately deferred

We are **not** offering hosted storage in this plan; doing so would recreate the exact liability we are trying to avoid. If a future need arises for small users with nowhere to put data, it could be added as a **bounded, quota-limited, paid opt-in** — never as a silent default. For now, users bring their own storage or work local-only.
