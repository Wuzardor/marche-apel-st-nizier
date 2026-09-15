/* Accueil : carte de tous les circuits + sélection par pastille */
(function () {
  'use strict';

  const D = window.HOME_DATA;
  const map = MarcheMap.createMap('map-overview', { scrollWheelZoom: false });
  const routes = {};
  const all = L.featureGroup().addTo(map);

  // Les circuits longs d'abord : les plus courts restent visibles par-dessus
  const drawOrder = D.circuits.slice().reverse();
  drawOrder.forEach(function (c) {
    const g = MarcheMap.drawRoute(c.points, c.color, 4, c.casing).addTo(all);
    g.hit.bindPopup('<strong>Circuit ' + c.label + '</strong><br><a href="/' + c.id + '">Voir le circuit →</a>');
    routes[c.id] = g;
  });
  const fitAll = () => map.fitBounds(all.getBounds(), { padding: [20, 20] });
  fitAll();
  // Après la mise en place de la vue : ajouté avant, ce marqueur retarderait le moteur de rendu des tracés
  D.starts.forEach(s => MarcheMap.labelMarker(s.latlng, s.label).addTo(map));

  const chips = Array.from(document.querySelectorAll('[data-route]'));
  function select(id) {
    chips.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.route === id)));
    Object.keys(routes).forEach(function (k) {
      const on = !id || k === id;
      routes[k].line.setStyle({ opacity: on ? 1 : 0.2 });
      routes[k].casing.setStyle({ opacity: on ? 0.95 : 0.25 });
    });
    const order = id ? [id] : drawOrder.map(c => c.id);
    order.forEach(k => { routes[k].casing.bringToFront(); routes[k].line.bringToFront(); routes[k].hit.bringToFront(); });
    if (id) map.fitBounds(routes[id].getBounds(), { padding: [20, 20] });
    else fitAll();
  }
  chips.forEach(b => b.addEventListener('click', () => select(b.dataset.route)));
})();
