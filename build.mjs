// Génère le site statique dans public/ à partir de :
//   config.json         infos de l'événement et présentation des circuits
//   data/circuits.json  traces nettoyées + altitudes (produit par scripts/prepare-data.mjs)
//   data/gpx/           fichiers GPX proposés au téléchargement
//   content/howto.json  aide « suivre le parcours / charger le GPX »
//   src/                CSS et JS du site
// Usage : node build.mjs, puis node scripts/serve.mjs pour prévisualiser.
// Quand config.siteUrl est renseigné, génère aussi l'affiche (/affiche) et les QR codes PNG (qr-codes/).
import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'public');
const at = (...parts) => path.join(ROOT, ...parts);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

const config = await readJson(at('config.json'));
const data = await readJson(at('data', 'circuits.json'));
const howto = existsSync(at('content', 'howto.json')) ? await readJson(at('content', 'howto.json')) : null;
const ev = config.event;
const SITE_URL = (config.siteUrl || '').replace(/\/+$/, '');

// ---------- Formatage ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const rich = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const fmtKm = m => `${nf1.format(m / 1000)} km`;
const fmtM = v => `${Math.round(v)} m`;

function haversine(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(((b[1] - a[1]) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

// Durée indicative : vitesse moyenne du circuit + temps ajouté par la montée, arrondie au quart d'heure
function duration(c) {
  const hours = c.distanceM / 1000 / c.speedKmh + (c.ascentM / 100) * (c.climbMinPer100m / 60);
  const minutes = Math.max(15, Math.round((hours * 60) / 15) * 15);
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

// ---------- Couleurs ----------
// Une couleur claire (jaune, gris clair…) disparaît en trait fin sur fond clair : on en déduit
// un texte lisible posé dessus (ink), une variante plus soutenue pour les traits fins (line)
// et un liseré foncé autour du tracé sur la carte (casing).
function palette(hex) {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const lin = rgb.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const light = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.4;
  const darker = '#' + rgb.map(v => Math.round(v * 0.7).toString(16).padStart(2, '0')).join('');
  return light
    ? { color: hex, ink: '#1D2528', line: darker, casing: '#27272A' }
    : { color: hex, ink: '#FFFFFF', line: hex, casing: '#FFFFFF' };
}
const cssVars = c => `--c:${c.color};--c-ink:${c.ink};--c-line:${c.line};--c-casing:${c.casing}`;

// ---------- Données ----------
const circuits = data.circuits.map(c => {
  const meta = config.circuits[c.id];
  if (!meta) throw new Error(`config.json : aucune présentation pour le circuit « ${c.id} »`);
  return { ...c, ...meta, ...palette(meta.color) };
});

// Même échelle verticale pour tous les mini-profils : on compare d'un coup d'œil le relief des circuits
const allEle = circuits.flatMap(c => c.points.map(p => p[2]));
const ELE_LO = Math.min(...allEle), ELE_SPAN = Math.max(Math.max(...allEle) - ELE_LO, 40);

function sparkline(c) {
  const W = 300, H = 40;
  const step = Math.max(1, Math.floor(c.points.length / 120));
  const pts = c.points.filter((_, i) => i % step === 0 || i === c.points.length - 1);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${((p[3] / c.distanceM) * W).toFixed(1)} ${(H - 2 - ((p[2] - ELE_LO) / ELE_SPAN) * (H - 6)).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${line}L${W} ${H}L0 ${H}Z" fill="currentColor" opacity=".13"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

// Points de départ distincts (à plus de 150 m les uns des autres)
const starts = [];
for (const c of circuits) {
  const s = starts.find(s => haversine(s.latlng, c.start) < 150);
  if (s) s.loop = s.loop && c.loop;
  else starts.push({ latlng: c.start, loop: c.loop });
}

// Tracé allégé pour la carte d'accueil (un point tous les ~30 m)
function lighten(points, minStep = 30) {
  const out = [];
  let last = -Infinity;
  points.forEach((p, i) => {
    if (p[3] - last >= minStep || i === points.length - 1) {
      out.push([+p[0].toFixed(5), +p[1].toFixed(5)]);
      last = p[3];
    }
  });
  return out;
}

// ---------- Sortie ----------
await mkdir(OUT, { recursive: true });
for (const entry of await readdir(OUT)) {
  if (entry !== '.vercel') await rm(path.join(OUT, entry), { recursive: true, force: true });
}
async function put(rel, content) {
  const file = path.join(OUT, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function copy(from, rel) {
  const file = path.join(OUT, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await copyFile(from, file);
}

const LEAFLET = at('node_modules', 'leaflet', 'dist');
await copy(path.join(LEAFLET, 'leaflet.js'), 'vendor/leaflet/leaflet.js');
await copy(path.join(LEAFLET, 'leaflet.css'), 'vendor/leaflet/leaflet.css');
for (const img of await readdir(path.join(LEAFLET, 'images'))) {
  await copy(path.join(LEAFLET, 'images', img), `vendor/leaflet/images/${img}`);
}

const asset = {};
for (const name of ['styles.css', 'map.js', 'home.js', 'circuit.js']) {
  const buf = await readFile(at('src', name));
  await put(`assets/${name}`, buf);
  asset[name] = `/assets/${name}?v=${createHash('sha1').update(buf).digest('hex').slice(0, 8)}`;
}

for (const c of circuits) await copy(at('data', 'gpx', c.gpxFile), `gpx/${c.gpxFile}`);

// ---------- Gabarits ----------
const ICON = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>',
  locate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>'
};
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🥾</text></svg>");
const orgLine = [ev.organizer, ev.town].filter(Boolean).join(' · ');

function page({ title, description, pagePath = '/', bodyClass = '', bodyStyle = '', body, scripts = '', leaflet = true }) {
  const url = SITE_URL ? SITE_URL + (pagePath === '/' ? '' : pagePath) : '';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#F6F4EF">
<meta property="og:type" content="website">
<meta property="og:locale" content="fr_FR">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${url ? `<meta property="og:url" content="${esc(url)}">\n<link rel="canonical" href="${esc(url)}">\n` : ''}<link rel="icon" href="${FAVICON}">
${leaflet ? '<link rel="stylesheet" href="/vendor/leaflet/leaflet.css">\n' : ''}<link rel="stylesheet" href="${asset['styles.css']}">
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}${bodyStyle ? ` style="${bodyStyle}"` : ''}>
${body}
${leaflet ? `<script src="/vendor/leaflet/leaflet.js"></script>\n<script src="${asset['map.js']}"></script>\n` : ''}${scripts}
</body>
</html>
`;
}

function howtoSection() {
  if (!howto) return '';
  const items = howto.items.map(it => `
      <details${it.open ? ' open' : ''}>
        <summary>${esc(it.title)}</summary>
        ${it.steps?.length ? `<ol>${it.steps.map(s => `<li>${rich(s)}</li>`).join('')}</ol>` : ''}
        ${it.note ? `<p class="note">${rich(it.note)}</p>` : ''}
      </details>`).join('');
  return `<section class="panel howto" aria-labelledby="h-howto">
      <h2 id="h-howto">${esc(howto.title)}</h2>
      ${howto.intro ? `<p class="muted">${rich(howto.intro)}</p>` : ''}${items}
    </section>`;
}

function footer() {
  return `<footer class="site-footer">
  <div class="wrap">
    <p>${esc(orgLine)}${ev.contact ? ` · Contact : ${esc(ev.contact)}` : ''}</p>
    <p>Fonds de carte © contributeurs OpenStreetMap, © IGN · Altitudes : ${esc(data.elevationSource || 'IGN')} · Durées indicatives, hors pauses.</p>
  </div>
</footer>`;
}

function card(c) {
  return `      <li>
        <a class="circuit-card" href="/${c.id}" style="${cssVars(c)}">
          <span class="cc-top"><span class="cc-label">${esc(c.label)}</span><span class="cc-kind">${esc(c.kind)}</span></span>
          ${c.subtitle ? `<span class="cc-sub">${esc(c.subtitle)}</span>` : ''}
          ${sparkline(c)}
          <span class="cc-stats"><span><b>${fmtKm(c.distanceM)}</b></span><span>D+ <b>${fmtM(c.ascentM)}</b></span><span>≈ <b>${duration(c)}</b></span>${c.loop ? '<span>Boucle</span>' : ''}</span>
          <span class="cc-go">${ICON.chevron}</span>
        </a>
      </li>`;
}

// ---------- Accueil ----------
const eventMeta = [ev.date, ev.time, ev.startPlace, ev.price].filter(Boolean);
const homeData = {
  circuits: circuits.map(c => ({ id: c.id, label: c.label, color: c.color, casing: c.casing, points: lighten(c.points) })),
  starts: starts.map(s => ({ latlng: s.latlng, label: s.loop ? 'Départ / arrivée' : 'Départ' }))
};
await put('index.html', page({
  title: `${ev.title} · ${ev.town}`,
  description: `Les circuits de la marche (${circuits.map(c => c.label).join(', ')}) : carte, suivi de position et fichiers GPX pour montre ou compteur.`,
  body: `
<header class="hero wrap">
  <p class="eyebrow">${esc(orgLine)}</p>
  <h1>${esc(ev.title)}</h1>
  ${ev.intro ? `<p class="lead">${rich(ev.intro)}</p>` : ''}
  ${eventMeta.length ? `<ul class="event-meta">${eventMeta.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
</header>
<main class="wrap home">
  <div class="home-top">
  <section class="overview" aria-label="Carte des circuits">
    <div class="chips" role="group" aria-label="Afficher un circuit sur la carte">
      <button type="button" class="chip" data-route="" aria-pressed="true">Tous</button>
      ${circuits.map(c => `<button type="button" class="chip" data-route="${c.id}" aria-pressed="false" style="${cssVars(c)}"><i></i>${esc(c.short)}</button>`).join('\n      ')}
    </div>
    <div id="map-overview" class="map"></div>
  </section>
  <section aria-labelledby="h-circuits">
    <h2 id="h-circuits">Choisissez votre circuit</h2>
    <ul class="circuit-list">
${circuits.map(card).join('\n')}
    </ul>
  </section>
  </div>
  ${howtoSection()}
</main>
${footer()}`,
  scripts: `<script>window.HOME_DATA=${json(homeData)};</script>\n<script src="${asset['home.js']}"></script>`
}));

// ---------- Pages circuit ----------
for (const c of circuits) {
  const pointsData = { id: c.id, label: c.label, color: c.color, line: c.line, casing: c.casing, loop: c.loop, points: c.points };
  await put(`${c.id}.html`, page({
    title: `Circuit ${c.label} · ${ev.title}`,
    description: `Carte, suivi de position et fichier GPX du circuit ${c.label} (${fmtKm(c.distanceM)}, D+ ${fmtM(c.ascentM)}) à ${ev.town}.`,
    pagePath: `/${c.id}`,
    bodyStyle: cssVars(c),
    body: `
<header class="topbar">
  <div class="wrap topbar-inner">
    <a class="back" href="/">${ICON.back}Tous les circuits</a>
    <nav class="topnav" aria-label="Changer de circuit">
      ${circuits.map(o => `<a href="/${o.id}" style="${cssVars(o)}"${o.id === c.id ? ' aria-current="page"' : ''}>${esc(o.short)}</a>`).join('')}
    </nav>
  </div>
</header>
<main class="wrap circuit-page">
  <div class="c-title">
    <span class="dot" aria-hidden="true"></span>
    <h1>Circuit ${esc(c.label)}</h1>
    <span class="pill">${esc(c.kind)}</span>
    ${c.subtitle ? `<p class="c-sub">${esc(c.subtitle)}</p>` : ''}
  </div>
  <div class="map-wrap">
    <div id="map" class="map" role="region" aria-label="Carte du circuit ${esc(c.label)}"></div>
    <div id="guide" class="guide" role="status" aria-live="polite" hidden>
      <div class="guide-text"><div class="guide-main"></div><div class="guide-sub"></div></div>
      <button type="button" class="guide-close" aria-label="Arrêter la localisation">×</button>
    </div>
  </div>
  <div class="c-actions">
    <a class="btn btn-primary" href="/gpx/${c.gpxFile}" download="${c.gpxFile}">${ICON.download}Télécharger le GPX</a>
    <button type="button" class="btn btn-secondary" id="locate" aria-pressed="false">${ICON.locate}<span>Me situer sur le parcours</span></button>
  </div>
  <div class="c-details">
    <dl class="stats-grid">
      <div><dt>Distance</dt><dd>${fmtKm(c.distanceM)}</dd></div>
      <div><dt>Dénivelé +</dt><dd>${fmtM(c.ascentM)}</dd></div>
      <div><dt>Dénivelé −</dt><dd>${fmtM(c.descentM)}</dd></div>
      <div><dt>Altitude</dt><dd>${Math.round(c.eleMinM)}–${fmtM(c.eleMaxM)}</dd></div>
      <div><dt>Durée</dt><dd>≈ ${duration(c)}</dd></div>
      <div><dt>Type</dt><dd>${c.loop ? 'Boucle' : 'Aller simple'}</dd></div>
    </dl>
    <p class="footnote">Durée indicative hors pauses, sur une base de ${nf.format(c.speedKmh)} km/h.</p>
    <section class="panel profile" aria-labelledby="h-profile">
      <h2 id="h-profile">Profil altimétrique</h2>
      <div id="profile" class="profile-box"></div>
      <p class="footnote">Glissez le doigt sur le profil pour repérer le point sur la carte.</p>
    </section>
    ${howtoSection()}
  </div>
</main>
${footer()}`,
    scripts: `<script>window.CIRCUIT=${json(pointsData)};</script>\n<script src="${asset['circuit.js']}"></script>`
  }));
}

// ---------- 404 ----------
await put('404.html', page({
  title: `Page introuvable · ${ev.title}`,
  description: ev.title,
  leaflet: false,
  body: `
<main class="wrap hero">
  <p class="eyebrow">Erreur 404</p>
  <h1>Page introuvable</h1>
  <p class="lead">Ce lien ne mène à aucun circuit.</p>
  <p><a class="btn btn-primary" style="display:inline-flex;width:auto" href="/">Voir tous les circuits</a></p>
</main>`
}));

// ---------- Affiche imprimable + QR codes ----------
if (SITE_URL) {
  const shortUrl = SITE_URL.replace(/^https?:\/\//, '');
  const qrOpts = { errorCorrectionLevel: 'M', color: { dark: '#1D2528', light: '#FFFFFF' } };
  const qrSvg = url => QRCode.toString(url, { ...qrOpts, type: 'svg', margin: 0 });
  // QR codes statiques : l'adresse est encodée dans l'image, ils n'expirent jamais. PNG + SVG pour l'impression.
  const saveQr = async (name, url) => {
    await QRCode.toFile(at('qr-codes', `${name}.png`), url, { ...qrOpts, margin: 2, width: 1200 });
    await writeFile(at('qr-codes', `${name}.svg`), await QRCode.toString(url, { ...qrOpts, type: 'svg', margin: 2 }));
  };
  await mkdir(at('qr-codes'), { recursive: true });
  await saveQr('qr-accueil', SITE_URL);
  const items = [];
  for (const c of circuits) {
    const url = `${SITE_URL}/${c.id}`;
    await saveQr(`qr-${c.id}`, url);
    items.push(`<div class="poster-item" style="${cssVars(c)}">
      <div class="qr">${await qrSvg(url)}</div>
      <p class="pi-label">${esc(c.label)}</p>
      <p class="pi-stats">${esc(c.kind)} · D+ ${fmtM(c.ascentM)}</p>
    </div>`);
  }
  await put('affiche.html', page({
    title: `Affiche QR codes · ${ev.title}`,
    description: ev.title,
    pagePath: '/affiche',
    bodyClass: 'poster-page',
    leaflet: false,
    body: `
<main class="poster">
  <header class="poster-head">
    <p class="eyebrow">${esc(orgLine)}</p>
    <h1>${esc(ev.title)}</h1>
    ${eventMeta.length ? `<p class="poster-meta">${eventMeta.map(esc).join(' · ')}</p>` : ''}
  </header>
  <section class="poster-main">
    <div class="qr qr-lg">${await qrSvg(SITE_URL)}</div>
    <div>
      <p class="poster-cta">Scannez pour voir les circuits</p>
      <ul>
        <li>Carte et position en direct sur votre téléphone</li>
        <li>Fichiers GPX pour montre, compteur vélo ou appli</li>
        <li>Sans application ni inscription</li>
      </ul>
      <p class="poster-url">${esc(shortUrl)}</p>
    </div>
  </section>
  <section class="poster-grid">
    ${items.join('\n    ')}
  </section>
</main>
<div class="print-bar no-print"><button type="button" class="btn btn-primary" onclick="window.print()">Imprimer l'affiche</button></div>`
  }));
}

// ---------- Configuration Vercel ----------
await put('vercel.json', JSON.stringify({
  cleanUrls: true,
  trailingSlash: false,
  headers: [
    {
      source: '/gpx/(.*)',
      headers: [
        { key: 'Content-Type', value: 'application/gpx+xml; charset=utf-8' },
        { key: 'Content-Disposition', value: 'attachment' },
        { key: 'Cache-Control', value: 'public, max-age=600' }
      ]
    },
    { source: '/(assets|vendor)/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/affiche', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] }
  ]
}, null, 2) + '\n');
// `vercel link` dépose .env.local (jeton OIDC) et .gitignore dans ce dossier : ils ne doivent jamais être publiés
await put('.vercelignore', '.env*\n.gitignore\n');

console.log(`Site généré dans ${OUT}`);
for (const c of circuits) {
  console.log(`  /${c.id.padEnd(5)} ${fmtKm(c.distanceM).padStart(8)}  D+ ${fmtM(c.ascentM).padStart(5)}  ≈ ${duration(c)}`);
}
console.log(SITE_URL ? `  Affiche : ${SITE_URL}/affiche · QR codes PNG : qr-codes/` : '  siteUrl vide dans config.json : affiche et QR codes non générés');
