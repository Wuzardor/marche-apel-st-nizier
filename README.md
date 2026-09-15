# Marche APEL — Saint-Nizier-sous-Charlieu

Site des circuits de la marche solidaire organisée par l'APEL au profit de l'école : carte de chaque circuit, suivi de sa position sur téléphone et fichiers GPX à télécharger **sans compte ni application** (montre, compteur vélo, appli GPS).

- Site : https://marche-des-ecoles-saint-nizerote.vercel.app
- Affiche imprimable avec les QR codes : https://marche-des-ecoles-saint-nizerote.vercel.app/affiche

## Les circuits

| Circuit | Page | Distance | Dénivelé + |
|---|---|---|---|
| 5 km poussettes | [/5km](https://marche-des-ecoles-saint-nizerote.vercel.app/5km) | 5,0 km | 83 m |
| 10 km | [/10km](https://marche-des-ecoles-saint-nizerote.vercel.app/10km) | 10,2 km | 223 m |
| 14 km | [/14km](https://marche-des-ecoles-saint-nizerote.vercel.app/14km) | 14,6 km | 257 m |
| 18 km | [/18km](https://marche-des-ecoles-saint-nizerote.vercel.app/18km) | 18,4 km | 328 m |
| VTT | [/vtt](https://marche-des-ecoles-saint-nizerote.vercel.app/vtt) | 22,2 km | 497 m |

Tous les circuits partent du 111 rue de la République et y reviennent. La trace VTT d'origine démarrait à 2,4 km de là ; comme la boucle passait déjà par ce point, elle a seulement été redémarrée à cet endroit (même tracé, même sens).

## QR codes

Le dossier [`qr-codes/`](qr-codes) contient les QR codes de l'accueil et de chaque circuit, en PNG (1200 px) et en SVG (vectoriel). Le sous-dossier [`qr-codes/pdf/`](qr-codes/pdf) les propose mis en page sur une feuille A4 prête à imprimer (un PDF par QR code, et `qr-codes-tous.pdf` qui regroupe les 6 pages).

Ce sont des QR codes **statiques** : l'adresse du site est inscrite dans l'image elle-même, sans service intermédiaire. Ils n'ont donc pas de date d'expiration et restent valables tant que le site est en ligne à la même adresse.

## Organisation du dépôt

| Dossier / fichier | Rôle |
|---|---|
| `sources/gpx/` | traces d'origine fournies par les organisateurs (contenu non modifié) |
| `scripts/prepare-data.mjs` | nettoie les traces, ajoute l'altitude IGN, calcule distances et dénivelés |
| `data/` | résultat : `circuits.json` et les GPX proposés au téléchargement |
| `config.json` | textes de l'événement (titre, date, lieu…) et présentation des circuits |
| `content/howto.json` | aide « suivre le parcours / charger le GPX sur sa montre » |
| `src/` | CSS et JavaScript du site |
| `build.mjs` | génère le site dans `public/`, l'affiche et les QR codes |
| `tests/check_site.py` | vérifications automatiques avec Playwright (Python) |

## Mettre à jour le site

Prérequis : Node.js 20 ou plus récent, la CLI Vercel (`npm install -g vercel`) et, pour les tests, Python avec Playwright.

```bash
npm install

# 1. Seulement si les traces changent (fichiers dans sources/gpx/ et tableau CIRCUITS du script)
npm run data

# 2. Après toute modification de config.json, content/ ou src/
npm run build
npm run qr-pdf   # QR codes en PDF A4 dans qr-codes/pdf/ (nécessite Python + Playwright)

# 3. Prévisualiser sur http://localhost:4173, puis vérifier dans un autre terminal
npm run serve
python tests/check_site.py

# 4. Publier (la première fois sur un nouvel ordinateur : vercel link --project marche-des-ecoles-saint-nizerote)
cd public
vercel deploy --prod
```

Pour une nouvelle édition : mettre à jour `config.json` (date, horaires, lieu, tarif…), remplacer les traces dans `sources/gpx/` si les circuits changent, puis suivre les étapes ci-dessus.

## Crédits

Fonds de carte © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright) et © IGN · Altitudes IGN RGE ALTI® (Géoplateforme) · Carte interactive [Leaflet](https://leafletjs.com) · QR codes [node-qrcode](https://github.com/soldair/node-qrcode).
