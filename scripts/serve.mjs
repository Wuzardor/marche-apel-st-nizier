// Serveur local de prévisualisation, avec les mêmes URL propres que sur Vercel (/10km → 10km.html).
// Usage : node scripts/serve.mjs  (PORT=xxxx pour changer de port)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 4173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gpx': 'application/gpx+xml; charset=utf-8'
};

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const tries = clean.endsWith('/') ? [clean + 'index.html'] : [clean, clean + '.html'];
  for (const t of tries) {
    const file = path.join(ROOT, t);
    if (!file.startsWith(ROOT)) return null;
    try {
      if ((await stat(file)).isFile()) return file;
    } catch { /* essai suivant */ }
  }
  return null;
}

http.createServer(async (req, res) => {
  const file = await resolveFile(req.url);
  if (!file) {
    res.writeHead(404, { 'Content-Type': TYPES['.html'] });
    res.end(await readFile(path.join(ROOT, '404.html')).catch(() => 'Page introuvable'));
    return;
  }
  const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
  if (file.endsWith('.gpx')) headers['Content-Disposition'] = 'attachment';
  res.writeHead(200, headers);
  res.end(await readFile(file));
}).listen(PORT, () => console.log(`Prévisualisation : http://localhost:${PORT}`));
