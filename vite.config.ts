import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep the PDF worker, fonts and decoders beside the app, including in offline builds. */
function localPdfAssets(): Plugin {
  const root = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
  const entries = new Map<string, string>();
  const collect = async () => {
    if (entries.size) return;
    entries.set('pdf.worker.min.mjs', path.join(root, 'build/pdf.worker.min.mjs'));
    entries.set('LICENSE', path.join(root, 'LICENSE'));
    for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
      for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true }))
        if (entry.isFile()) entries.set(`${directory}/${entry.name}`, path.join(root, directory, entry.name));
    }
  };
  const contentType = (name: string) => name.endsWith('.mjs') || name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  return {
    name: 'local-pdf-assets',
    async configureServer(server) {
      await collect();
      server.middlewares.use('/pdfjs-assets', (request, response, next) => {
        const name = (request.url || '').split('?')[0].replace(/^\//, '');
        const file = entries.get(name);
        if (!file || !['GET', 'HEAD'].includes(request.method || '')) { next(); return; }
        void fs.readFile(file).then(bytes => {
          response.setHeader('Content-Type', contentType(name));
          response.setHeader('X-Content-Type-Options', 'nosniff');
          response.end(request.method === 'HEAD' ? undefined : bytes);
        }).catch(next);
      });
    },
    async generateBundle() {
      await collect();
      for (const [name, file] of entries) this.emitFile({ type: 'asset', fileName: `pdfjs-assets/${name}`, source: await fs.readFile(file) });
    },
  };
}
export default defineConfig({ plugins: [react(), localPdfAssets()], build: { outDir: 'dist' } });
