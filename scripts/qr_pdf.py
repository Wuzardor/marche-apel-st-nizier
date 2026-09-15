"""Met les QR codes en page au format PDF A4, prêts à imprimer.

Usage : npm run build (génère qr-codes/*.svg avec l'adresse du site), puis
        python scripts/qr_pdf.py [--apercu DOSSIER]
Résultat : qr-codes/pdf/qr-<nom>.pdf (une page A4 par QR code) et qr-codes/pdf/qr-codes-tous.pdf
--apercu enregistre aussi une capture PNG de chaque page, pour vérification.
"""
import argparse
import html
import json
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parents[1]
QR_DIR = ROOT / "qr-codes"
OUT = QR_DIR / "pdf"

config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
data = json.loads((ROOT / "data" / "circuits.json").read_text(encoding="utf-8"))
SITE = config["siteUrl"].rstrip("/")
if not SITE:
    sys.exit("config.json : siteUrl est vide")
EV = config["event"]
esc = html.escape


def km(m):
    return f"{m / 1000:.1f}".replace(".", ",") + " km"


def qr_svg(name):
    file = QR_DIR / f"{name}.svg"
    if not file.exists():
        sys.exit(f"{file} introuvable : lancer d'abord npm run build")
    return file.read_text(encoding="utf-8")


circuits = [{**c, **config["circuits"][c["id"]]} for c in data["circuits"]]
legend = "".join(f'<span class="chip"><i style="background:{c["color"]}"></i>{esc(c["label"])}</span>' for c in circuits)
pages = [{
    "name": "qr-accueil", "title": "Tous les circuits", "color": "#1D2528", "url": SITE,
    "detail": f'<p class="legend">{legend}</p>',
}]
for c in circuits:
    pages.append({
        "name": f"qr-{c['id']}", "title": f"Circuit {c['label']}", "color": c["color"], "url": f"{SITE}/{c['id']}",
        "detail": f'<p class="meta">{esc(c["kind"])} · {km(c["distanceM"])} · D+ {c["ascentM"]} m</p>',
    })

STYLE = """
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; background: #fff; color: #1D2528; font-family: system-ui, "Segoe UI", Roboto, Arial, sans-serif; }
.page { position: relative; display: flex; flex-direction: column; align-items: center; width: 210mm; height: 297mm;
  padding: 26mm 18mm 16mm; overflow: hidden; text-align: center; break-after: page; }
.page:last-child { break-after: auto; }
.band { position: absolute; inset: 0 0 auto; height: 11mm; background: var(--c); box-shadow: inset 0 -0.3mm 0 rgba(0,0,0,.25); }
.eyebrow { margin: 0; font-size: 11pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #5A6569; }
.event { margin: 2mm 0 0; font-size: 20pt; font-weight: 800; letter-spacing: -.02em; }
h1 { display: flex; align-items: center; gap: 4mm; margin: 12mm 0 0; font-size: 44pt; font-weight: 800; letter-spacing: -.03em; line-height: 1; }
h1 .dot { width: 11mm; height: 11mm; border-radius: 50%; background: var(--c); box-shadow: inset 0 0 0 .4mm rgba(0,0,0,.25); }
.meta { margin: 4mm 0 0; font-size: 15pt; color: #5A6569; }
.legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 2.5mm; margin: 5mm 0 0; }
.chip { display: inline-flex; align-items: center; gap: 2mm; padding: 1.5mm 4mm; border: .3mm solid #D8D4CB; border-radius: 99px; font-size: 12pt; font-weight: 700; }
.chip i { width: 4mm; height: 4mm; border-radius: 50%; box-shadow: inset 0 0 0 .3mm rgba(0,0,0,.25); }
.qr { width: 128mm; margin: 11mm 0 0; padding: 5mm; border: .8mm solid #1D2528; border-radius: 6mm; }
.qr svg { display: block; width: 100%; height: auto; }
.cta { margin: 9mm 0 0; font-size: 22pt; font-weight: 800; }
.sub { margin: 2mm 0 0; font-size: 13pt; color: #5A6569; }
.url { margin: auto 0 0; font: 700 13pt/1.3 Consolas, "Courier New", monospace; }
"""


def page_html(p):
    return f"""<section class="page" style="--c:{p['color']}">
  <div class="band"></div>
  <p class="eyebrow">{esc(EV['organizer'])} · {esc(EV['town'])}</p>
  <p class="event">{esc(EV['title'])}</p>
  <h1>{'' if p['name'] == 'qr-accueil' else '<span class="dot"></span>'}{esc(p['title'])}</h1>
  {p['detail']}
  <div class="qr">{qr_svg(p['name'])}</div>
  <p class="cta">Scannez avec l'appareil photo</p>
  <p class="sub">Carte, position en direct et fichier GPX · sans application ni inscription</p>
  <p class="url">{esc(re.sub(r'^https?://', '', p['url']))}</p>
</section>"""


def document(selection):
    body = "\n".join(page_html(p) for p in selection)
    return f'<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>{STYLE}</style></head><body>{body}</body></html>'


def pdf(page, selection, target):
    page.set_content(document(selection))
    page.pdf(path=target, format="A4", print_background=True, prefer_css_page_size=True)
    count = target.read_bytes().count(b"/Type /Page") - target.read_bytes().count(b"/Type /Pages")
    if count != len(selection):
        sys.exit(f"{target.name} : {count} page(s) au lieu de {len(selection)}")
    print(f"  {target.relative_to(ROOT)} ({count} page{'s' if count > 1 else ''})")


parser = argparse.ArgumentParser()
parser.add_argument("--apercu", type=pathlib.Path, help="dossier où enregistrer une capture PNG de chaque page")
args = parser.parse_args()
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 794, "height": 1123})
    print("PDF générés :")
    for p in pages:
        pdf(page, [p], OUT / f"{p['name']}.pdf")
        if args.apercu:
            args.apercu.mkdir(parents=True, exist_ok=True)
            page.emulate_media(media="print")
            page.screenshot(path=args.apercu / f"{p['name']}.png")
            page.emulate_media(media="screen")
    pdf(page, pages, OUT / "qr-codes-tous.pdf")
    browser.close()
