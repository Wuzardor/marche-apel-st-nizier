/* Page circuit : carte, repères kilométriques, profil altimétrique et suivi de position */
(function () {
  'use strict';

  const C = window.CIRCUIT;
  const P = C.points; // [lat, lon, altitude, distance cumulée en m]
  const total = P[P.length - 1][3];
  const latlngs = P.map(p => [p[0], p[1]]);
  const hasEle = P.every(p => typeof p[2] === 'number');
  const fmt = MarcheMap.fmt, pointAt = MarcheMap.pointAt;

  const ICON = {
    fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    locate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" style="fill:var(--c);stroke:var(--c-casing)" stroke-width="2"/><path d="M10 5 14.5 13h-9z" style="fill:var(--c-ink)"/></svg>'
  };

  // État du suivi de position
  let watchId = null, follow = true, firstFix = true, lastProgress = null, lastFix = null;
  let you = null, halo = null, link = null;

  // ---------- Carte ----------
  const map = MarcheMap.createMap('map');
  // Calque au-dessus des bornes kilométriques : position de la personne et repère du profil
  map.createPane('focus').style.zIndex = 640;
  const route = MarcheMap.drawRoute(latlngs, C.color, 6, C.casing).addTo(map);
  const fitRoute = () => map.fitBounds(route.getBounds(), { padding: [28, 28] });
  fitRoute();
  MarcheMap.labelMarker(latlngs[0], C.loop ? 'Départ / arrivée' : 'Départ').addTo(map);
  if (!C.loop) MarcheMap.labelMarker(latlngs[latlngs.length - 1], 'Arrivée').addTo(map);

  // Bornes kilométriques et flèches de sens (affichées quand on zoome)
  const deco = L.layerGroup();
  const decoOpts = { interactive: false, keyboard: false };
  for (let d = 1000; d < total - 250; d += 1000) {
    const p = pointAt(P, d);
    L.marker([p.lat, p.lon], Object.assign({ icon: L.divIcon({ className: 'km-marker', html: '<span>' + d / 1000 + '</span>', iconSize: [24, 24] }) }, decoOpts)).addTo(deco);
  }
  for (let d = 500; d < total - 150; d += 1000) {
    const a = pointAt(P, d - 25), b = pointAt(P, d + 25), p = pointAt(P, d);
    const deg = Math.round(MarcheMap.bearing([a.lat, a.lon], [b.lat, b.lon]));
    L.marker([p.lat, p.lon], Object.assign({ icon: L.divIcon({ className: 'route-arrow', html: '<span style="--r:' + deg + 'deg">' + ICON.arrow + '</span>', iconSize: [20, 20] }) }, decoOpts)).addTo(deco);
  }
  const syncDeco = () => (map.getZoom() >= 13 ? deco.addTo(map) : deco.remove());
  map.on('zoomend', syncDeco);
  syncDeco();

  const Tools = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const box = L.DomUtil.create('div', 'leaflet-bar map-tools');
      box.innerHTML =
        '<a href="#" role="button" data-act="fit" title="Voir tout le parcours" aria-label="Voir tout le parcours">' + ICON.fit + '</a>' +
        '<a href="#" role="button" data-act="locate" title="Me situer" aria-label="Me situer">' + ICON.locate + '</a>';
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(box, 'click', function (e) {
        const a = e.target.closest('a');
        if (!a) return;
        L.DomEvent.preventDefault(e);
        if (a.dataset.act === 'fit') {
          follow = false;
          fitRoute();
        } else if (watchId === null) {
          startLocate();
        } else {
          follow = true;
          if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 16));
        }
      });
      return box;
    }
  });
  new Tools().addTo(map);
  const toolLocate = document.querySelector('.map-tools [data-act="locate"]');
  map.on('dragstart', () => { follow = false; });

  // ---------- Position sur le tracé ----------
  // Projection locale équirectangulaire : largement suffisante à l'échelle de quelques kilomètres
  const lat0 = P[0][0] * Math.PI / 180, KX = 111320 * Math.cos(lat0), KY = 110574;
  const XY = P.map(p => [p[1] * KX, p[0] * KY]);

  // Point du tracé le plus proche. Quand le tracé repasse au même endroit (départ/arrivée d'une boucle,
  // tronçon emprunté deux fois), on regroupe les candidats par passage puis :
  //   prev === undefined → le plus proche (clic sur la carte)
  //   prev === null      → le premier passage (première position reçue)
  //   prev = nombre      → le passage le plus cohérent avec la progression précédente
  function locateOnRoute(lat, lon, prev) {
    const x = lon * KX, y = lat * KY;
    const cands = [];
    let best = Infinity;
    for (let i = 0; i < XY.length - 1; i++) {
      const x1 = XY[i][0], y1 = XY[i][1], dx = XY[i + 1][0] - x1, dy = XY[i + 1][1] - y1;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
      const dist = Math.hypot(x - x1 - t * dx, y - y1 - t * dy);
      if (dist < best) best = dist;
      cands.push({ dist: dist, progress: P[i][3] + t * (P[i + 1][3] - P[i][3]) });
    }
    const passes = [];
    cands.filter(c => c.dist <= best + 25).sort((a, b) => a.progress - b.progress).forEach(function (c) {
      const g = passes[passes.length - 1];
      if (g && c.progress - g.last <= 100) {
        g.last = c.progress;
        if (c.dist < g.best.dist) g.best = c;
      } else {
        passes.push({ last: c.progress, best: c });
      }
    });
    const bests = passes.map(g => g.best);
    if (prev === undefined) return bests.reduce((a, b) => (b.dist < a.dist ? b : a));
    if (prev === null) return bests[0];
    return bests.reduce((a, b) => (Math.abs(b.progress - prev) < Math.abs(a.progress - prev) ? b : a));
  }

  route.hit.on('click', function (e) {
    const m = locateOnRoute(e.latlng.lat, e.latlng.lng);
    const p = pointAt(P, m.progress);
    L.popup({ closeButton: false })
      .setLatLng([p.lat, p.lon])
      .setContent('<strong>' + fmt.km(m.progress) + '</strong>' + (hasEle ? ' · altitude ' + fmt.m(p.ele) : ''))
      .openOn(map);
  });

  // ---------- Profil altimétrique ----------
  const profile = (function () {
    const host = document.getElementById('profile');
    if (!host || !hasEle) {
      const section = host && host.closest('section');
      if (section) section.hidden = true;
      return { setYou: function () {} };
    }
    const H = 170, padL = 46, padR = 12, padT = 34, padB = 24;
    const eles = P.map(p => p[2]);
    const eMin = Math.min.apply(null, eles), eMax = Math.max.apply(null, eles);
    // Graduations rondes (tous les 10, 20, 25, 50… m), quatre intervalles au plus
    const eStep = [10, 20, 25, 50, 100, 200].find(s => (eMax - eMin + 4) / s <= 4) || 500;
    const lo = Math.floor((eMin - 2) / eStep) * eStep, hi = Math.ceil((eMax + 2) / eStep) * eStep;
    let W = 0, svg = null, youAt = null;
    const X = d => padL + (d / total) * (W - padL - padR);
    const Y = e => padT + (1 - (e - lo) / (hi - lo)) * (H - padT - padB);
    const hoverMarker = L.circleMarker([0, 0], { pane: 'focus', radius: 7, color: C.casing, weight: 3, fillColor: C.color, fillOpacity: 1, interactive: false });

    function draw() {
      const w = Math.round(host.clientWidth);
      if (!w || w === W) return;
      W = w;
      const base = H - padB;
      let line = '';
      for (let i = 0; i < P.length; i++) line += (i ? 'L' : 'M') + X(P[i][3]).toFixed(1) + ',' + Y(P[i][2]).toFixed(1);
      const area = line + 'L' + X(total).toFixed(1) + ',' + base + 'L' + padL + ',' + base + 'Z';
      const maxTicks = Math.max(2, Math.floor((W - padL - padR) / 44));
      const step = [1, 2, 5, 10].find(s => total / 1000 / s <= maxTicks) || 10;
      let grid = '';
      for (let k = 0; k * 1000 <= total; k += step) {
        const x = X(k * 1000).toFixed(1);
        grid += '<line class="pg" x1="' + x + '" x2="' + x + '" y1="' + padT + '" y2="' + base + '"/>' +
          '<text x="' + x + '" y="' + (H - 7) + '" text-anchor="middle">' + k + (k === 0 ? ' km' : '') + '</text>';
      }
      for (let e = lo; e <= hi; e += eStep) {
        const y = Y(e);
        grid += '<line class="pg" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>' +
          '<text x="' + (padL - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + e + ' m</text>';
      }
      host.innerHTML =
        '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Profil altimétrique : altitude de ' + Math.round(eMin) + ' à ' + Math.round(eMax) + ' mètres">' +
        '<g>' + grid + '</g>' +
        '<path d="' + area + '" fill="' + C.line + '" fill-opacity="0.14"/>' +
        '<path d="' + line + '" fill="none" stroke="' + C.line + '" stroke-width="2" stroke-linejoin="round"/>' +
        '<g class="you" style="display:none"><line y1="' + padT + '" y2="' + base + '"/><circle r="5"/></g>' +
        '<g class="hover" style="display:none"><line y1="' + padT + '" y2="' + base + '"/><circle r="4.5"/><rect rx="6" y="4" height="22"/><text y="19" text-anchor="middle"></text></g>' +
        '</svg>';
      svg = host.firstChild;
      bind();
      setYou(youAt);
    }

    function place(g, d) {
      const p = pointAt(P, d), x = X(d);
      const l = g.querySelector('line'), c = g.querySelector('circle');
      l.setAttribute('x1', x);
      l.setAttribute('x2', x);
      c.setAttribute('cx', x);
      c.setAttribute('cy', Y(p.ele));
      g.style.display = '';
      return { p: p, x: x };
    }

    function hover(d) {
      const g = svg.querySelector('.hover');
      if (d === null) {
        g.style.display = 'none';
        hoverMarker.remove();
        return;
      }
      const r = place(g, d);
      const text = g.querySelector('text'), rect = g.querySelector('rect');
      text.textContent = fmt.km(d) + ' · ' + fmt.m(r.p.ele);
      const bw = text.getComputedTextLength() + 16;
      const bx = Math.max(0, Math.min(W - bw, r.x - bw / 2));
      rect.setAttribute('x', bx);
      rect.setAttribute('width', bw);
      text.setAttribute('x', bx + bw / 2);
      hoverMarker.setLatLng([r.p.lat, r.p.lon]).addTo(map);
    }

    function setYou(d) {
      youAt = d;
      if (!svg) return;
      const g = svg.querySelector('.you');
      if (d === null) g.style.display = 'none';
      else place(g, d);
    }

    function bind() {
      const distAt = function (e) {
        const r = svg.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left - padL) / (W - padL - padR))) * total;
      };
      svg.addEventListener('pointermove', e => hover(distAt(e)));
      svg.addEventListener('pointerdown', e => hover(distAt(e)));
      svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hover(null); });
      svg.addEventListener('pointercancel', () => hover(null));
    }

    if ('ResizeObserver' in window) new ResizeObserver(() => requestAnimationFrame(draw)).observe(host);
    else window.addEventListener('resize', draw);
    draw();
    return { setYou: setYou };
  })();

  // ---------- Suivi de position ----------
  const ON_ROUTE_M = 50; // tolérance minimale pour être « sur le parcours »
  const NEARBY_M = 3000; // au-delà, la personne n'est pas encore sur place
  const guide = document.getElementById('guide');
  const guideMain = guide.querySelector('.guide-main');
  const guideSub = guide.querySelector('.guide-sub');
  const locateBtn = document.getElementById('locate');
  const locateLabel = locateBtn.querySelector('span');

  function setGuide(state, main, sub) {
    guide.hidden = false;
    guide.dataset.state = state;
    guideMain.innerHTML = main;
    guideSub.textContent = sub || '';
  }

  function setLocating(on) {
    locateBtn.setAttribute('aria-pressed', String(on));
    locateLabel.textContent = on ? 'Arrêter la localisation' : 'Me situer sur le parcours';
    if (toolLocate) toolLocate.classList.toggle('is-active', on);
  }

  function startLocate() {
    if (!('geolocation' in navigator)) {
      setGuide('error', 'Localisation indisponible', "Ce navigateur ne permet pas d'afficher votre position.");
      return;
    }
    if (!window.isSecureContext) {
      setGuide('error', 'Localisation indisponible', 'La page doit être ouverte en https.');
      return;
    }
    follow = true;
    firstFix = true;
    setGuide('pending', 'Recherche de votre position…', 'Autorisez la localisation si le téléphone le demande.');
    watchId = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    setLocating(true);
  }

  function stopLocate() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    lastProgress = null;
    lastFix = null;
    [you, halo, link].forEach(l => l && l.remove());
    you = halo = link = null;
    guide.hidden = true;
    profile.setYou(null);
    setLocating(false);
  }

  function onPosition(pos) {
    const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy || 0;
    const here = [lat, lon];
    lastFix = here;
    if (!you) {
      halo = L.circle(here, { pane: 'focus', radius: acc, color: '#1A73E8', weight: 1, opacity: 0.35, fillOpacity: 0.12, interactive: false }).addTo(map);
      you = L.circleMarker(here, { pane: 'focus', radius: 8, color: '#fff', weight: 3, fillColor: '#1A73E8', fillOpacity: 1, interactive: false }).addTo(map);
    } else {
      halo.setLatLng(here).setRadius(acc);
      you.setLatLng(here);
    }

    const m = locateOnRoute(lat, lon, lastProgress);
    const snap = pointAt(P, m.progress);
    const tolerance = Math.max(ON_ROUTE_M, Math.min(acc, 150));

    if (m.dist <= tolerance) {
      lastProgress = m.progress;
      if (link) { link.remove(); link = null; }
      setGuide('on',
        '<strong>' + fmt.km(m.progress) + '</strong> parcourus · reste <strong>' + fmt.km(Math.max(0, total - m.progress)) + '</strong>',
        (hasEle ? 'Altitude ≈ ' + fmt.m(snap.ele) + ' · ' : '') + 'précision ± ' + fmt.m(acc));
      profile.setYou(m.progress);
    } else {
      if (m.dist < NEARBY_M) {
        const target = [snap.lat, snap.lon];
        if (link) link.setLatLngs([here, target]);
        else link = L.polyline([here, target], { pane: 'focus', color: '#1A73E8', weight: 3, dashArray: '6 8', interactive: false }).addTo(map);
        setGuide('off', 'Vous êtes à <strong>' + fmt.dist(m.dist) + '</strong> du parcours', 'Rejoignez le tracé en suivant les pointillés bleus.');
      } else {
        if (link) { link.remove(); link = null; }
        setGuide('far', 'Vous êtes à <strong>' + fmt.dist(m.dist) + '</strong> du parcours', 'Le suivi démarrera une fois sur place.');
      }
      profile.setYou(null);
    }

    if (firstFix) {
      firstFix = false;
      if (m.dist < NEARBY_M) map.setView(here, Math.max(map.getZoom(), 16));
      else map.fitBounds(route.getBounds().extend(here), { padding: [28, 28] });
    } else if (follow && m.dist < NEARBY_M) {
      map.panTo(here);
    }
  }

  function onError(err) {
    if (err.code === 1) {
      stopLocate();
      setGuide('error', 'Localisation refusée', 'Autorisez la localisation pour ce site dans les réglages du navigateur, puis réessayez.');
    } else if (err.code === 2) {
      setGuide('error', 'Position introuvable', 'Vérifiez que la localisation du téléphone est activée.');
    } else if (!lastFix) {
      setGuide('pending', 'Recherche de votre position…', "Cela peut prendre quelques secondes, surtout à l'intérieur.");
    }
  }

  locateBtn.addEventListener('click', () => (watchId === null ? startLocate() : stopLocate()));
  guide.querySelector('.guide-close').addEventListener('click', stopLocate);
})();
