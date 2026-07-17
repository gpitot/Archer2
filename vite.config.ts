import { defineConfig, Plugin } from 'vite';
import { resolve, basename } from 'path';
import * as fs from 'fs';

/**
 * Serves custom maps from `maps/` and accepts editor saves.
 *
 * Dev server routes (the SPA html fallback would otherwise shadow missing
 * files with a 200 index.html):
 *   GET  /maps/index.json     → list of map base names
 *   GET  /maps/<file>         → the map file, correct type, real 404s
 *   PUT  /maps/<file>         → write file (map editor save/publish)
 *
 * At build time every map file is emitted into `dist/maps/` so deployed
 * clients can load custom maps too (players fetch the tiny .amap; the
 * .map.json fallback is only fetched when no .amap was published).
 */
function mapsPlugin(): Plugin {
  const mapsDir = resolve(__dirname, 'maps');
  const fileRe = /^[a-z0-9][a-z0-9_-]{0,31}(\.amap|\.map\.json)$/;

  return {
    name: 'archer-maps',
    configureServer(server) {
      server.middlewares.use('/maps', (req, res, next) => {
        const url = (req.url ?? '').split('?')[0].replace(/^\//, '');

        if (req.method === 'GET' && url === 'index.json') {
          const names = fs.existsSync(mapsDir)
            ? [...new Set(fs.readdirSync(mapsDir)
                .filter((f) => fileRe.test(f))
                .map((f) => f.replace(/\.amap$|\.map\.json$/, '')))].sort()
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(names));
          return;
        }

        if (!fileRe.test(url)) {
          next();
          return;
        }
        const file = resolve(mapsDir, url);

        if (req.method === 'GET' || req.method === 'HEAD') {
          if (!fs.existsSync(file)) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          res.setHeader(
            'Content-Type',
            url.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          );
          res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
          return;
        }

        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            fs.mkdirSync(mapsDir, { recursive: true });
            fs.writeFileSync(file, Buffer.concat(chunks));
            res.statusCode = 204;
            res.end();
          });
          return;
        }

        next();
      });
    },
    generateBundle() {
      if (!fs.existsSync(mapsDir)) return;
      for (const f of fs.readdirSync(mapsDir)) {
        if (!fileRe.test(f)) continue;
        this.emitFile({
          type: 'asset',
          fileName: `maps/${basename(f)}`,
          source: fs.readFileSync(resolve(mapsDir, f)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [mapsPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/ws': {
        target: 'http://localhost:8787',
        ws: true,
      },
    },
  },
});
