import path from 'path';
import fs from 'fs';
import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Sample Data is the folders listed in public/data/index.json. Everything
// else in public/data (regions kept around for development) is copied into
// dist by Vite like any public file, so it is removed again here.
function shipOnlySampleData(): Plugin {
  return {
    name: 'ship-only-sample-data',
    apply: 'build',
    closeBundle() {
      const indexPath = path.resolve(__dirname, 'public/data/index.json');
      const keep = new Set<string>(JSON.parse(fs.readFileSync(indexPath, 'utf-8')).regions.map((r: { id: string }) => r.id));
      const distData = path.resolve(__dirname, 'dist/data');
      for (const entry of fs.readdirSync(distData, { withFileTypes: true })) {
        if (entry.isDirectory() && !keep.has(entry.name)) {
          fs.rmSync(path.join(distData, entry.name), { recursive: true, force: true });
        }
      }
    },
  };
}

// Serves LOCAL_ZARR_DIR at /local-zarr/ from the dev server only, so a store
// can be previewed before it is published. A production build pointed at one
// of these URLs drops the setting instead (see services/gldasFetch.ts).
function serveLocalZarr(dir: string): Plugin {
  return {
    name: 'serve-local-zarr',
    apply: 'serve',
    configureServer(server) {
      const root = path.resolve(dir.replace(/^~(?=\/)/, process.env.HOME || '~'));
      if (!fs.existsSync(root)) {
        server.config.logger.warn(`[local-zarr] LOCAL_ZARR_DIR does not exist: ${root}`);
        return;
      }
      server.config.logger.info(`[local-zarr] serving ${root} at /local-zarr/`);
      server.middlewares.use('/local-zarr', (req, res, next) => {
        // connect strips the prefix, so req.url is the store-relative path
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const file = path.resolve(root, rel);
        if (file !== root && !file.startsWith(root + path.sep)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          // A chunk that was never written is all fill value, as on the CDN
          res.statusCode = 404;
          res.end();
          return;
        }
        if (!stat.isFile()) return next();
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // The analysis workers import shared modules, so they are split into
      // chunks, which the default iife worker format cannot express
      worker: { format: 'es' },
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), shipOnlySampleData(), ...(env.LOCAL_ZARR_DIR ? [serveLocalZarr(env.LOCAL_ZARR_DIR)] : [])],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.USGS_API_KEY': JSON.stringify(env.USGS_API_KEY || '')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
