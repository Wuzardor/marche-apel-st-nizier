/* Outils carte partagés entre l'accueil et les pages circuit (Leaflet) */
window.MarcheMap = (function () {
  'use strict';

  const LAYER_KEY = 'marche-apel:fond';
  const ign = (layer, format) =>
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM' +
    '&LAYER=' + layer + '&FORMAT=' + format + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

  function createMap(el, options) {
    const map = L.map(el, Object.assign({ zoomSnap: 0.5 }, options));
    const osmCredit = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    const ignCredit = '© <a href="https://www.ign.fr/">IGN</a>';
    const bases = {
      'Plan OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmCredit }),
      'Plan IGN': L.tileLayer(ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'), { maxZoom: 19, attribution: ignCredit }),
      'Photo aérienne': L.tileLayer(ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), { maxZoom: 19, attribution: ignCredit })
    };
    let name = 'Plan OpenStreetMap';
    try {
      const saved = localStorage.getItem(LAYER_KEY);
      if (saved && bases[saved]) name = saved;
    } catch (e) { /* stockage indisponible : fond par défaut */ }
    bases[name].addTo(map);
    L.control.layers(bases, null, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', function (e) {
      try { localStorage.setItem(LAYER_KEY, e.name); } catch (err) { /* ignoré */ }
    });
    return map;
  }

  // Tracé avec liseré blanc (lisible sur tous les fonds) + zone de clic élargie pour le doigt
  function drawRoute(latlngs, color, weight) {
    const casing = L.polyline(latlngs, { color: '#fff', weight: weight + 4, opacity: 0.95, lineJoin: 'round', lineCap: 'round', interactive: false });
    const line = L.polyline(latlngs, { color: color, weight: weight, opacity: 1, lineJoin: 'round', lineCap: 'round', interactive: false });
    const hit = L.polyline(latlngs, { color: color, weight: 22, opacity: 0 });
    const group = L.featureGroup([casing, line, hit]);
    group.casing = casing;
    group.line = line;
    group.hit = hit;
    return group;
  }

  function labelMarker(latlng, text) {
    return L.circleMarker(latlng, { radius: 7, color: '#fff', weight: 3, fillColor: '#1D2528', fillOpacity: 1 })
      .bindTooltip(text, { permanent: true, direction: 'top', offset: [0, -8], className: 'start-label' });
  }

  // points : [lat, lon, altitude, distance cumulée en m]
  function pointAt(points, d) {
    const n = points.length;
    const make = (p, i) => ({ lat: p[0], lon: p[1], ele: p[2], i: i });
    if (d <= 0) return make(points[0], 0);
    if (d >= points[n - 1][3]) return make(points[n - 1], n - 1);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid][3] <= d) lo = mid; else hi = mid;
    }
    const a = points[lo], b = points[hi];
    const t = b[3] > a[3] ? (d - a[3]) / (b[3] - a[3]) : 0;
    const ele = typeof a[2] === 'number' && typeof b[2] === 'number' ? a[2] + (b[2] - a[2]) * t : null;
    return { lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, ele: ele, i: lo };
  }

  function bearing(a, b) {
    const rad = Math.PI / 180;
    const y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad);
    const x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const fmt = {
    km: m => nf1.format(m / 1000) + ' km',
    m: v => nf0.format(v) + ' m',
    dist: v => (v < 1000 ? nf0.format(Math.round(v / 10) * 10) + ' m' : nf1.format(v / 1000) + ' km')
  };

  return { createMap, drawRoute, labelMarker, pointAt, bearing, fmt };
})();
