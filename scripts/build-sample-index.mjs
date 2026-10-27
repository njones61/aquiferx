#!/usr/bin/env node
/**
 * Write public/data/index.json, the listing of Sample Data.
 *
 * A static host cannot list a folder, so this does once, at build time, what
 * the dev server's /api/regions, /api/list-rasters and /api/list-models did on
 * every request. services/dataStore.ts reads it.
 *
 * Sample regions are the folders named in scripts/sample-regions.mjs. Any other folder in
 * public/data is ignored here, and the build leaves it out of dist/.
 *
 * Usage: node scripts/build-sample-index.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_REGIONS } from './sample-regions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'public', 'data');

const RASTER_RE = /^raster_([a-z0-9_]+?)_(.+)\.json$/;

function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), r));
    else out.push(r);
  }
  return out;
}

const regions = [];
const rasters = [];
const models = [];

for (const id of SAMPLE_REGIONS) {
  const regionDir = path.join(dataDir, id);
  const meta = JSON.parse(fs.readFileSync(path.join(regionDir, 'region.json'), 'utf-8'));
  const files = walk(regionDir).map(f => `${id}/${f}`);
  const dataFiles = files
    .filter(f => f.split('/').length === 2)
    .map(f => f.split('/')[1])
    .filter(f => f.startsWith('data_') && f.endsWith('.csv'));
  regions.push({ ...meta, id, dataFiles, files });

  for (const filePath of files) {
    const parts = filePath.split('/');
    if (parts.length !== 3) continue;
    const file = parts[2];
    const raster = file.match(RASTER_RE);
    const isModel = file.startsWith('model_') && file.endsWith('.json');
    if (!raster && !isModel) continue;
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, filePath), 'utf-8'));
    const common = {
      title: data.title || file,
      aquiferId: data.aquiferId || '',
      aquiferName: data.aquiferName || '',
      regionId: data.regionId || id,
      filePath,
      params: data.params || {},
      createdAt: data.createdAt || '',
    };
    if (raster) {
      rasters.push({
        ...common,
        code: data.code || raster[2],
        dataType: data.dataType || raster[1],
        options: data.options || undefined,
        generatedAt: data.generatedAt || undefined,
      });
    } else {
      models.push({
        ...common,
        code: data.code || file.replace('.json', ''),
        dataType: data.dataType || 'wte',
        wellMetrics: data.wellMetrics || {},
      });
    }
  }
}

fs.writeFileSync(path.join(dataDir, 'index.json'), JSON.stringify({ regions, rasters, models }));
console.log(`Wrote public/data/index.json: ${regions.length} regions, ${rasters.length} rasters, ${models.length} models`);
