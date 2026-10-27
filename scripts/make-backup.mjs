#!/usr/bin/env node
/**
 * Package region folders from public/data as a My Data backup zip, the same
 * format the app's Back up button writes, so they can be loaded with Restore.
 *
 * This is how regions that lived on disk while the app had a dev-server file
 * API get into My Data now that it lives in the browser.
 *
 * Usage:
 *   node scripts/make-backup.mjs out.zip                  every folder that is not Sample Data
 *   node scripts/make-backup.mjs out.zip jamaica niger    just these
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { SAMPLE_REGIONS } from './sample-regions.mjs';

const [out, ...named] = process.argv.slice(2);
if (!out) {
  console.error('Usage: node scripts/make-backup.mjs <out.zip> [region ...]');
  process.exit(1);
}

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const regions = named.length
  ? named
  : fs.readdirSync(dataDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !SAMPLE_REGIONS.includes(e.name) && fs.existsSync(path.join(dataDir, e.name, 'region.json')))
      .map(e => e.name);

const zip = new JSZip();
const addDir = (dir, prefix) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) addDir(full, `${prefix}/${entry.name}`);
    else zip.file(`${prefix}/${entry.name}`, fs.readFileSync(full, 'utf-8'));
  }
};
for (const id of regions) addDir(path.join(dataDir, id), id);

fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Wrote ${out}: ${regions.join(', ')}`);
