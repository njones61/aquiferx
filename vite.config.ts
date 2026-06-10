import path from 'path';
import fs from 'fs';
import type { IncomingMessage } from 'http';
import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Read and JSON-parse a request body. Accumulates raw Buffers and decodes
// once — per-chunk toString() corrupts multi-byte UTF-8 characters that
// straddle chunk boundaries. Also rejects on request errors (an aborted
// upload would otherwise never fire 'end', leaving the response open forever).
function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function saveDataPlugin(): Plugin {
  return {
    name: 'save-data',
    configureServer(server) {
      // GET /api/regions — scan public/data/ subdirectories for region.json
      server.middlewares.use('/api/regions', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const dataDir = path.resolve(__dirname, 'public/data');
          const entries = fs.readdirSync(dataDir, { withFileTypes: true });
          const regions: any[] = [];
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const regionDir = path.join(dataDir, entry.name);
            const regionJsonPath = path.join(regionDir, 'region.json');
            if (fs.existsSync(regionJsonPath)) {
              try {
                const meta = JSON.parse(fs.readFileSync(regionJsonPath, 'utf-8'));
                // Scan for data_*.csv so the client can compute effective
                // data types without needing to probe each file individually.
                const dataFiles: string[] = [];
                try {
                  for (const f of fs.readdirSync(regionDir)) {
                    if (f.startsWith('data_') && f.endsWith('.csv')) dataFiles.push(f);
                  }
                } catch {}
                regions.push({ ...meta, dataFiles });
              } catch (e) {
                // skip malformed region.json
              }
            }
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(regions));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // POST /api/delete-file — delete a single file within public/data/
      server.middlewares.use('/api/delete-file', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const { filePath } = await readJsonBody<{ filePath: string }>(req);
          const dataDir = path.resolve(__dirname, 'public/data');
          const fullPath = path.resolve(dataDir, filePath);
          // Safety: ensure we're deleting inside public/data
          if (!fullPath.startsWith(dataDir + path.sep) || fullPath === dataDir) {
            res.statusCode = 400;
            res.end(`Invalid path: ${filePath}`);
            return;
          }
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            // Clean up empty parent directory (only within public/data/)
            const parentDir = path.dirname(fullPath);
            if (parentDir !== dataDir && parentDir.startsWith(dataDir + path.sep)) {
              try {
                const remaining = fs.readdirSync(parentDir);
                if (remaining.length === 0) fs.rmdirSync(parentDir);
              } catch { /* ignore */ }
            }
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Delete a region folder
      server.middlewares.use('/api/delete-folder', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const { folder } = await readJsonBody<{ folder: string }>(req);
          if (typeof folder !== 'string' || !folder) {
            res.statusCode = 400;
            res.end('Missing folder');
            return;
          }
          const dataDir = path.resolve(__dirname, 'public/data');
          const folderPath = path.resolve(dataDir, folder);
          // Safety: ensure we're deleting inside public/data
          if (!folderPath.startsWith(dataDir + path.sep) || folderPath === dataDir) {
            res.statusCode = 400;
            res.end(`Invalid folder: ${folder}`);
            return;
          }
          fs.rmSync(folderPath, { recursive: true, force: true });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // GET /api/list-rasters?region={id} — list raster analysis metadata
      server.middlewares.use('/api/list-rasters', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const regionId = url.searchParams.get('region');
          if (!regionId) {
            res.statusCode = 400;
            res.end('Missing region parameter');
            return;
          }
          const dataDir = path.resolve(__dirname, 'public/data');
          const regionDir = path.resolve(dataDir, regionId);
          if (!regionDir.startsWith(dataDir + path.sep)) {
            res.statusCode = 400;
            res.end('Invalid region');
            return;
          }
          const results: any[] = [];
          if (fs.existsSync(regionDir)) {
            // Scan subdirectories for raster_*.json (new layout)
            for (const sub of fs.readdirSync(regionDir, { withFileTypes: true })) {
              if (!sub.isDirectory()) continue;
              const subDir = path.join(regionDir, sub.name);
              for (const file of fs.readdirSync(subDir)) {
                if (file.startsWith('raster_') && file.endsWith('.json')) {
                  try {
                    const data = JSON.parse(fs.readFileSync(path.join(subDir, file), 'utf-8'));
                    // Parse dataType from filename: raster_{dataType}_{code}.json
                    const match = file.match(/^raster_([a-z0-9_]+?)_(.+)\.json$/);
                    const filePath = `${regionId}/${sub.name}/${file}`;
                    results.push({
                      title: data.title || file,
                      code: data.code || (match ? match[2] : file.replace('.json', '')),
                      aquiferId: data.aquiferId || '',
                      aquiferName: data.aquiferName || '',
                      regionId: data.regionId || regionId,
                      filePath,
                      dataType: data.dataType || (match ? match[1] : 'wte'),
                      params: data.params || {},
                      createdAt: data.createdAt || '',
                      options: data.options || undefined,
                      generatedAt: data.generatedAt || undefined,
                    });
                  } catch { /* skip malformed */ }
                }
              }
            }
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(results));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // POST /api/rename-raster — rename a raster analysis file
      server.middlewares.use('/api/rename-raster', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const { oldPath, newPath, newCode, newTitle } = await readJsonBody<{
            oldPath: string; newPath: string; newCode: string; newTitle: string;
          }>(req);
          const dataDir = path.resolve(__dirname, 'public/data');
          const fullOldPath = path.resolve(dataDir, oldPath);
          const fullNewPath = path.resolve(dataDir, newPath);

          // Safety: ensure both paths are within public/data
          if (!fullOldPath.startsWith(dataDir + path.sep) || !fullNewPath.startsWith(dataDir + path.sep)) {
            res.statusCode = 400;
            res.end('Invalid path');
            return;
          }

          if (!fs.existsSync(fullOldPath)) {
            res.statusCode = 404;
            res.end('File not found');
            return;
          }

          // Read, update, write
          const data = JSON.parse(fs.readFileSync(fullOldPath, 'utf-8'));
          data.code = newCode;
          data.title = newTitle;

          fs.mkdirSync(path.dirname(fullNewPath), { recursive: true });
          fs.writeFileSync(fullNewPath, JSON.stringify(data), 'utf-8');

          // Delete old file if path changed
          if (fullOldPath !== fullNewPath) {
            fs.unlinkSync(fullOldPath);
            // Clean up empty parent directory
            const parentDir = path.dirname(fullOldPath);
            if (parentDir !== dataDir && parentDir.startsWith(dataDir + path.sep)) {
              try {
                const remaining = fs.readdirSync(parentDir);
                if (remaining.length === 0) fs.rmdirSync(parentDir);
              } catch { /* ignore */ }
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // GET /api/list-models?region={id} — list imputation model metadata
      server.middlewares.use('/api/list-models', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const regionId = url.searchParams.get('region');
          if (!regionId) {
            res.statusCode = 400;
            res.end('Missing region parameter');
            return;
          }
          const dataDir = path.resolve(__dirname, 'public/data');
          const regionDir = path.resolve(dataDir, regionId);
          if (!regionDir.startsWith(dataDir + path.sep)) {
            res.statusCode = 400;
            res.end('Invalid region');
            return;
          }
          const results: any[] = [];
          if (fs.existsSync(regionDir)) {
            for (const sub of fs.readdirSync(regionDir, { withFileTypes: true })) {
              if (!sub.isDirectory()) continue;
              const subDir = path.join(regionDir, sub.name);
              for (const file of fs.readdirSync(subDir)) {
                if (file.startsWith('model_') && file.endsWith('.json')) {
                  try {
                    const data = JSON.parse(fs.readFileSync(path.join(subDir, file), 'utf-8'));
                    const filePath = `${regionId}/${sub.name}/${file}`;
                    // Strip data and log arrays for performance
                    results.push({
                      title: data.title || file,
                      code: data.code || file.replace('.json', ''),
                      aquiferId: data.aquiferId || '',
                      aquiferName: data.aquiferName || '',
                      regionId: data.regionId || regionId,
                      filePath,
                      dataType: data.dataType || 'wte',
                      params: data.params || {},
                      createdAt: data.createdAt || '',
                      wellMetrics: data.wellMetrics || {},
                    });
                  } catch { /* skip malformed */ }
                }
              }
            }
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(results));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // GET /api/gldas-proxy?url={encodedUrl} — proxy GLDAS THREDDS requests for CORS
      // Proxy for the Water Quality Portal. WQP doesn't send
      // Access-Control-Expose-Headers, so the browser hides count
      // headers (Total-Result-Count, Total-Site-Count, etc.) from JS
      // even though they're in the response. We forward the request
      // server-side, then re-emit those headers with the proper expose
      // header. Also avoids future CORS surprises like the HEAD-403
      // gotcha.
      server.middlewares.use('/api/wqp-proxy', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const targetUrl = url.searchParams.get('url');
          const headersOnly = url.searchParams.get('headersOnly') === '1';
          if (!targetUrl || !targetUrl.startsWith('https://www.waterqualitydata.us/')) {
            res.statusCode = 400;
            res.end('Missing or non-WQP url parameter');
            return;
          }
          const controller = new AbortController();
          // The timer must cover the entire exchange — clearing it when
          // headers arrive would let a stall mid-body hang the browser
          // request forever
          const timeout = setTimeout(() => controller.abort(), 120000);
          try {
            const response = await fetch(targetUrl, { signal: controller.signal });
            // Copy headers we care about (counts + content)
            const passthrough = [
              'content-type',
              'total-site-count', 'nwis-site-count', 'storet-site-count',
              'total-activity-count', 'nwis-activity-count', 'storet-activity-count',
              'total-result-count', 'nwis-result-count', 'storet-result-count',
            ];
            for (const h of passthrough) {
              const v = response.headers.get(h);
              if (v) res.setHeader(h, v);
            }
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Expose-Headers', passthrough.join(','));
            res.statusCode = response.status;
            if (headersOnly) {
              // Cancel the upstream body stream so we don't pay for the
              // full CSV download just to read count headers.
              try { await response.body?.cancel(); } catch {}
              res.end('');
            } else {
              const body = await response.text();
              res.end(body);
            }
          } catch (fetchErr: any) {
            res.statusCode = 502;
            res.end(`WQP proxy error: ${fetchErr.message || fetchErr}`);
          } finally {
            clearTimeout(timeout);
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      server.middlewares.use('/api/gldas-proxy', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const targetUrl = url.searchParams.get('url');
          // Whitelist the GLDAS THREDDS host — an open proxy would let
          // anyone who can reach this dev server fetch arbitrary URLs
          // through it
          if (!targetUrl || !targetUrl.startsWith('https://apps.geoglows.org/')) {
            res.statusCode = 400;
            res.end('Missing or non-GLDAS url parameter');
            return;
          }
          const controller = new AbortController();
          // Timer covers headers + body (see wqp-proxy note above)
          const timeout = setTimeout(() => controller.abort(), 15000);
          try {
            const response = await fetch(targetUrl, { signal: controller.signal });
            const contentType = response.headers.get('content-type') || 'text/plain';
            res.setHeader('Content-Type', contentType);
            res.setHeader('Access-Control-Allow-Origin', '*');
            const body = await response.text();
            res.end(body);
          } catch (fetchErr: any) {
            res.statusCode = 502;
            res.end(`GLDAS proxy error: ${fetchErr.message || fetchErr}`);
          } finally {
            clearTimeout(timeout);
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // POST /api/rename-model — rename an imputation model file
      server.middlewares.use('/api/rename-model', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const { oldPath, newPath, newCode, newTitle } = await readJsonBody<{
            oldPath: string; newPath: string; newCode: string; newTitle: string;
          }>(req);
          const dataDir = path.resolve(__dirname, 'public/data');
          const fullOldPath = path.resolve(dataDir, oldPath);
          const fullNewPath = path.resolve(dataDir, newPath);

          if (!fullOldPath.startsWith(dataDir + path.sep) || !fullNewPath.startsWith(dataDir + path.sep)) {
            res.statusCode = 400;
            res.end('Invalid path');
            return;
          }

          if (!fs.existsSync(fullOldPath)) {
            res.statusCode = 404;
            res.end('File not found');
            return;
          }

          const data = JSON.parse(fs.readFileSync(fullOldPath, 'utf-8'));
          data.code = newCode;
          data.title = newTitle;

          fs.mkdirSync(path.dirname(fullNewPath), { recursive: true });
          fs.writeFileSync(fullNewPath, JSON.stringify(data), 'utf-8');

          if (fullOldPath !== fullNewPath) {
            fs.unlinkSync(fullOldPath);
            const parentDir = path.dirname(fullOldPath);
            if (parentDir !== dataDir && parentDir.startsWith(dataDir + path.sep)) {
              try {
                const remaining = fs.readdirSync(parentDir);
                if (remaining.length === 0) fs.rmdirSync(parentDir);
              } catch { /* ignore */ }
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      server.middlewares.use('/api/save-data', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        try {
          const { files } = await readJsonBody<{
            files: {
              path: string;
              content: string;
              // Optimistic-lock preconditions for read-modify-write saves:
              // ifUnmodifiedSince = the Last-Modified the client saw when it
              // read the file; mustNotExist = the client read a 404 and is
              // creating it. Either failing means another tab/operation
              // changed the file since the client read it.
              ifUnmodifiedSince?: string;
              mustNotExist?: boolean;
            }[];
          }>(req);
          const dataDir = path.resolve(__dirname, 'public/data');

          // Validate every path and precondition before writing anything,
          // so a bad entry can't leave a multi-file save half-applied
          const resolved: { filePath: string; content: string }[] = [];
          const conflicts: string[] = [];
          for (const file of files) {
            const filePath = path.resolve(dataDir, file.path);
            // Safety: ensure we're writing inside public/data (the path.sep
            // suffix prevents escapes into sibling dirs like public/data-x)
            if (!filePath.startsWith(dataDir + path.sep)) {
              res.statusCode = 400;
              res.end(`Invalid path: ${file.path}`);
              return;
            }

            if (file.mustNotExist && fs.existsSync(filePath)) {
              conflicts.push(file.path);
            } else if (file.ifUnmodifiedSince) {
              const since = Date.parse(file.ifUnmodifiedSince);
              if (!isNaN(since)) {
                let mtimeMs: number | null = null;
                try { mtimeMs = (await fs.promises.stat(filePath)).mtimeMs; } catch { /* deleted since read */ }
                // Last-Modified has 1s resolution — compare at whole seconds
                if (mtimeMs === null || Math.floor(mtimeMs / 1000) * 1000 > since) {
                  conflicts.push(file.path);
                }
              }
            }
            resolved.push({ filePath, content: file.content });
          }

          if (conflicts.length > 0) {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, conflicts }));
            return;
          }

          // Async writes so large saves don't block the dev server's
          // event loop (tiles, CSV loads, HMR) for the whole batch
          for (const { filePath, content } of resolved) {
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await fs.promises.writeFile(filePath, content, 'utf-8');
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, count: files.length }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    }
  };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), saveDataPlugin()],
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
