"""Vérifie le site généré (public/) servi en local et produit des captures d'écran.

Usage : lancer `node scripts/serve.mjs`, puis `python tests/check_site.py [dossier_captures] [url_de_base]`
"""
import json
import math
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests" / "screens"
BASE = (sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4173").rstrip("/")
OUT.mkdir(parents=True, exist_ok=True)

data = json.loads((ROOT / "data" / "circuits.json").read_text(encoding="utf-8"))
circuits = {c["id"]: c for c in data["circuits"]}
failures = []


def check(ok, label):
    print(("OK    " if ok else "ÉCHEC ") + label)
    if not ok:
        failures.append(label)


def point_at(points, d):
    return min(points, key=lambda p: abs(p[3] - d))


def dist_to_route(lat, lon, points):
    kx, ky = 111320 * math.cos(math.radians(lat)), 110574
    return min(math.hypot((lon - p[1]) * kx, (lat - p[0]) * ky) for p in points)


def watch_errors(page, bucket):
    # Le script de mesure d'audience peut manquer (local, ou mesure désactivée) : ce n'est pas une erreur du site.
    # L'adresse fautive est dans m.location, pas dans m.text.
    def on_console(m):
        if m.type != "error":
            return
        url = (m.location or {}).get("url", "")
        if "_vercel/insights" in url or "_vercel/insights" in m.text:
            return
        bucket.append(f"console: {m.text} ({url})")

    page.on("console", on_console)
    page.on("pageerror", lambda e: bucket.append(f"pageerror: {e}"))


OVERLAP_JS = """([sticky, next]) => {
  const a = document.querySelector(sticky), b = document.querySelector(next);
  const hit = (r, s) => r.left < s.right && s.left < r.right && r.top < s.bottom && s.top < r.bottom;
  let found = -1;
  for (let y = 0; y < document.documentElement.scrollHeight && found < 0; y += 100) {
    window.scrollTo(0, y);
    if (hit(a.getBoundingClientRect(), b.getBoundingClientRect())) found = y;
  }
  window.scrollTo(0, 0);
  return found;
}"""


def no_overlap(page, sticky, nxt, label):
    y = page.evaluate(OVERLAP_JS, [sticky, nxt])
    check(y < 0, f"{label} : la carte ne recouvre pas la suite de la page" + ("" if y < 0 else f" (chevauchement à {y}px de défilement)"))


def all_visible(page, selector):
    """Chaque élément tient dans son conteneur et dans l'écran : rien à faire défiler sur le côté."""
    return page.evaluate("""(sel) => [...document.querySelectorAll(sel)].every(e => {
      const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect();
      return r.width > 0 && r.left >= p.left - 1 && r.right <= p.right + 1 && r.right <= window.innerWidth;
    })""", selector)


def wait_tiles(page):
    try:
        page.wait_for_function("document.querySelectorAll('.leaflet-tile-loaded').length >= 4", timeout=15000)
        page.wait_for_timeout(400)
    except Exception:
        print("      (tuiles de carte lentes ou indisponibles)")


def wait_guide(page, state):
    try:
        page.wait_for_function(f"document.querySelector('#guide')?.dataset.state === '{state}'", timeout=10000)
        return True
    except Exception:
        return False


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ---------- Bureau ----------
    errors = []
    ctx = browser.new_context(viewport={"width": 1366, "height": 900}, locale="fr-FR", accept_downloads=True)
    page = ctx.new_page()
    watch_errors(page, errors)

    page.goto(BASE + "/")
    wait_tiles(page)
    check(page.locator(".circuit-card").count() == len(circuits), "accueil : une fiche par circuit")
    check(page.locator("#map-overview path.leaflet-interactive").count() >= len(circuits), "accueil : tracés dessinés sur la carte")
    page.screenshot(path=OUT / "desktop-accueil.png", full_page=True)
    no_overlap(page, ".overview", ".howto", "accueil (bureau)")
    page.locator('.chip[data-route="vtt"]').click()
    page.wait_for_timeout(700)
    check(page.locator('.chip[data-route="vtt"]').get_attribute("aria-pressed") == "true", "accueil : pastille VTT sélectionnée")
    page.screenshot(path=OUT / "desktop-accueil-vtt.png")

    page.goto(BASE + "/10km")
    wait_tiles(page)
    check(page.locator(".stats-grid dd").count() == 6, "10km : statistiques")
    box = page.locator("#profile svg").bounding_box()
    check(box is not None and box["width"] > 200, "10km : profil altimétrique affiché")
    if box:
        page.mouse.move(box["x"] + box["width"] * 0.55, box["y"] + box["height"] * 0.5)
        page.wait_for_timeout(250)
        check(page.locator("#profile .hover").is_visible(), "10km : survol du profil → repère affiché")
    with page.expect_download() as dl:
        page.locator(".btn-primary", has_text="GPX").click()
    check(dl.value.suggested_filename == "marche-apel-10km.gpx", f"10km : téléchargement GPX ({dl.value.suggested_filename})")
    page.screenshot(path=OUT / "desktop-10km.png")
    no_overlap(page, ".map-wrap", ".site-footer", "10km (bureau)")

    page404 = ctx.new_page()  # page non surveillée : le navigateur journalise lui-même la réponse 404
    resp = page404.goto(BASE + "/n-existe-pas")
    check(resp is not None and resp.status == 404, "page inexistante → 404")
    page404.close()

    if (ROOT / "public" / "affiche.html").exists():
        page.goto(BASE + "/affiche")
        page.screenshot(path=OUT / "desktop-affiche.png", full_page=True)
        pdf = page.pdf(path=OUT / "affiche.pdf", format="A4", print_background=True)
        pages = pdf.count(b"/Type /Page") - pdf.count(b"/Type /Pages")
        check(pages == 1, f"affiche : tient sur une page A4 ({pages} page(s))")

    check(not errors, "bureau : aucune erreur JavaScript" + ("" if not errors else " → " + " | ".join(errors[:5])))
    ctx.close()

    # ---------- Mobile + géolocalisation simulée ----------
    c10 = circuits["10km"]
    p = point_at(c10["points"], 3000)
    errors = []
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
        locale="fr-FR", permissions=["geolocation"],
        geolocation={"latitude": p[0], "longitude": p[1], "accuracy": 8},
    )
    page = ctx.new_page()
    watch_errors(page, errors)

    page.goto(BASE + "/")
    wait_tiles(page)
    page.screenshot(path=OUT / "mobile-accueil.png", full_page=True)
    scroll_w = page.evaluate("document.documentElement.scrollWidth")
    check(scroll_w <= 390, f"mobile accueil : pas de défilement horizontal ({scroll_w}px)")
    check(all_visible(page, ".chip"), "mobile accueil : toutes les pastilles de circuit visibles d'un coup")

    page.goto(BASE + "/10km")
    wait_tiles(page)
    scroll_w = page.evaluate("document.documentElement.scrollWidth")
    check(scroll_w <= 390, f"mobile 10km : pas de défilement horizontal ({scroll_w}px)")
    check(all_visible(page, ".topnav a"), "mobile 10km : tous les circuits visibles dans la barre du haut")
    page.screenshot(path=OUT / "mobile-10km.png")
    page.locator("#locate").click()
    on_route = wait_guide(page, "on")
    text = page.locator("#guide .guide-main").inner_text()
    check(on_route and "parcourus" in text, f"10km : suivi sur le parcours à ~3 km ({text})")
    wait_tiles(page)
    page.screenshot(path=OUT / "mobile-10km-suivi.png")

    lat = p[0]
    for k in range(1, 30):
        lat = p[0] + 0.0005 * k
        if dist_to_route(lat, p[1], c10["points"]) > 150:
            break
    ctx.set_geolocation({"latitude": lat, "longitude": p[1], "accuracy": 8})
    off_route = wait_guide(page, "off")
    check(off_route, f"10km : alerte hors parcours ({page.locator('#guide .guide-main').inner_text()})")
    page.wait_for_timeout(600)
    page.screenshot(path=OUT / "mobile-10km-hors-parcours.png")

    for cid in ("5km", "vtt"):
        page.goto(BASE + f"/{cid}")
        wait_tiles(page)
        page.screenshot(path=OUT / f"mobile-{cid}.png", full_page=True)

    check(not errors, "mobile : aucune erreur JavaScript" + ("" if not errors else " → " + " | ".join(errors[:5])))
    browser.close()

print("\n" + ("Tout est OK" if not failures else f"{len(failures)} échec(s)"))
sys.exit(1 if failures else 0)
