#!/usr/bin/env node
/**
 * prepare-data.mjs
 * -----------------------------------------------------------------------
 * Data pipeline for "Marche APEL Saint-Nizier-sous-Charlieu".
 *
 * Reads the raw GPX tracks exported by the route-planning tool (read-only,
 * never modified), cleans them up (drops routing-shaping <wpt> points),
 * densifies them so no segment exceeds 25 m, fetches elevation for every
 * point from the IGN Geoplateforme altimetry API (with an Open-Meteo
 * fallback), computes per-circuit stats (distance, ascent/descent, bounds,
 * loop detection, ...), and writes:
 *   - clean GPX files for watch/bike-computer import  -> data/gpx/*.gpx
 *   - a single circuits.json consumed by the front-end -> data/circuits.json
 *
 * Re-runnable: elevation results are cached per circuit in
 * cache/elevation/<id>.json keyed by rounded coordinates, so a re-run with
 * unchanged source coordinates makes ZERO network calls.
 *
 * Usage:  node scripts/prepare-data.mjs      (run from the marche-web folder)
 *
 * Node 24+ required (built-in fetch, no npm dependencies).
 * -----------------------------------------------------------------------
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// =========================================================================
// EDITABLE CONSTANTS
// =========================================================================

/** Folder (relative to the project root) holding the original GPX exports, never modified. */
const SOURCE_DIR = 'sources/gpx';

/** Short prefix used to build the (watch-screen-friendly) track names. */
const TRACK_NAME_PREFIX = 'Marche APEL';

/**
 * Common start/finish of the event (111 rue de la République,
 * Saint-Nizier-sous-Charlieu). A closed loop given `startAt` is re-started
 * at the nearest point of its track: same route, same direction.
 */
const COMMON_START = { lat: 46.153632, lon: 4.120596 };

/**
 * The five circuits, in the display order requested for circuits.json.
 *  - id          : stable short id used everywhere (file names, JSON, cache)
 *  - sourceFile  : file name inside SOURCE_DIR (original export, renamed
 *                  without the literal "%20"/"%2C" of the exported names)
 *  - name        : human display name (as given by the organisers)
 *  - shortLabel  : short label appended to TRACK_NAME_PREFIX for the track
 *                  name shown on watches ("Marche APEL <shortLabel>")
 *  - activity    : "walk" | "stroller" | "mtb" (JSON contract value)
 *  - gpxType     : <type> element written into the output GPX
 *  - expectedPoints: original trkpt count, used only as a sanity check
 *  - startAt     : optional {lat, lon} - re-start a closed loop there
 */
const CIRCUITS = [
  {
    id: '5km',
    sourceFile: 'circuit-5km-poussette.gpx',
    name: 'Circuit 5 km poussette',
    shortLabel: '5 km',
    activity: 'stroller',
    gpxType: 'hiking',
    expectedPoints: 149,
  },
  {
    id: '10km',
    sourceFile: 'circuit-10km.gpx',
    name: 'Circuit 10 km',
    shortLabel: '10 km',
    activity: 'walk',
    gpxType: 'hiking',
    expectedPoints: 250,
  },
  {
    id: '14km',
    sourceFile: 'circuit-14km.gpx',
    name: 'Circuit 14 km',
    shortLabel: '14 km',
    activity: 'walk',
    gpxType: 'hiking',
    expectedPoints: 349,
  },
  {
    id: '18km',
    sourceFile: 'circuit-18km.gpx',
    name: 'Circuit 18 km',
    shortLabel: '18 km',
    activity: 'walk',
    gpxType: 'hiking',
    expectedPoints: 433,
  },
  {
    id: 'vtt',
    sourceFile: 'circuit-vtt-22-2km.gpx',
    name: 'Circuit VTT 22,2 km',
    shortLabel: 'VTT 22 km',
    activity: 'mtb',
    gpxType: 'mountain_biking',
    expectedPoints: 542,
    // The source loop starts ~2.4 km east but passes through the common start at km 2.81
    startAt: COMMON_START,
  },
];

/** No inserted segment may exceed this length (metres). */
const MAX_SEGMENT_M = 25;

/** Elevation smoothing window (points) before computing ascent/descent. */
const SMOOTHING_WINDOW = 5;

/** Hysteresis threshold (metres) for ascent/descent accumulation. */
const HYSTERESIS_THRESHOLD_M = 2.5;

/** A start/end gap below this is considered a "loop". */
const LOOP_GAP_THRESHOLD_M = 100;

/** IGN Geoplateforme altimetry API (free, no key). */
const IGN_ELEVATION_URL =
  'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_CHUNK_SIZE = 120; // points per GET request
const IGN_REQUEST_DELAY_MS = 250; // delay between sequential requests
const IGN_MAX_RETRIES = 3;
const IGN_RETRY_BASE_DELAY_MS = 600;

/** Open-Meteo fallback (coarser 90 m DEM), used only if IGN is unusable. */
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/elevation';
const OPEN_METEO_CHUNK_SIZE = 100;

/** "No data" sentinel returned by the IGN API. */
const IGN_NODATA_VALUE = -99999;

// =========================================================================
// Paths (derived - not meant to be edited)
// =========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_GPX_DIR = path.join(PROJECT_ROOT, 'data', 'gpx');
const OUT_JSON_PATH = path.join(PROJECT_ROOT, 'data', 'circuits.json');
const CACHE_DIR = path.join(PROJECT_ROOT, 'cache', 'elevation');

// =========================================================================
// Small utilities
// =========================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EARTH_RADIUS_M = 6371008.8; // mean earth radius (metres)

/** Great-circle distance between two lat/lon points, in metres. */
function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Round to N decimals, returned as a Number (trims trailing zeros). */
function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function coordKey(lat, lon) {
  // 6 decimals (~11 cm) is plenty to dedup/cache coordinates safely.
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

// =========================================================================
// 1. GPX parsing (hand-rolled, tolerant of attribute order / self-closing)
// =========================================================================

/**
 * Extract all <trkpt lat=".." lon="..">...</trkpt> (or self-closing)
 * points from a raw GPX string, concatenating points from every
 * <trk>/<trkseg> found, in document order. <wpt> elements (routing
 * shaping points) live outside <trk> and are therefore never visited.
 *
 * Returns { points: [{lat, lon}], trkCount, trkSegCount, wptCount }.
 */
function parseGpxTrackPoints(xml) {
  const trkBlocks = [...xml.matchAll(/<trk\b[^>]*>([\s\S]*?)<\/trk>/g)];
  const wptCount = (xml.match(/<wpt\b/g) || []).length;

  let trkSegCount = 0;
  const points = [];

  for (const [, trkContent] of trkBlocks) {
    const segBlocks = [
      ...trkContent.matchAll(/<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/g),
    ];
    for (const [, segContent] of segBlocks) {
      trkSegCount += 1;
      const ptMatches = segContent.matchAll(
        /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g
      );
      for (const [, attrs] of ptMatches) {
        const latMatch = attrs.match(/\blat=["']([-0-9.]+)["']/);
        const lonMatch = attrs.match(/\blon=["']([-0-9.]+)["']/);
        if (!latMatch || !lonMatch) {
          throw new Error(`trkpt missing lat/lon attribute: <trkpt${attrs}`);
        }
        points.push({
          lat: parseFloat(latMatch[1]),
          lon: parseFloat(lonMatch[1]),
        });
      }
    }
  }

  return { points, trkCount: trkBlocks.length, trkSegCount, wptCount };
}

// =========================================================================
// 2. Cleanup: dedup consecutive duplicates + densify to <=25 m segments
// =========================================================================

function dedupConsecutive(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.lat !== p.lat || last.lon !== p.lon) out.push(p);
  }
  return out;
}

/** Big jumps between consecutive ORIGINAL points (post-dedup), for report. */
function findBigJumps(points, thresholdM) {
  const jumps = [];
  for (let i = 1; i < points.length; i++) {
    const d = haversineM(
      points[i - 1].lat,
      points[i - 1].lon,
      points[i].lat,
      points[i].lon
    );
    if (d > thresholdM) {
      jumps.push({ index: i, distanceM: Math.round(d) });
    }
  }
  return jumps;
}

/**
 * Insert linearly-interpolated points so that no consecutive pair is
 * farther apart than maxSegmentM. Keeps every original point.
 */
function densify(points, maxSegmentM) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    out.push(points[i]);
    if (i === points.length - 1) break;
    const a = points[i];
    const b = points[i + 1];
    const d = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (d > maxSegmentM) {
      const segments = Math.ceil(d / maxSegmentM);
      for (let k = 1; k < segments; k++) {
        const t = k / segments;
        out.push({
          lat: a.lat + (b.lat - a.lat) * t,
          lon: a.lon + (b.lon - a.lon) * t,
        });
      }
    }
  }
  return out;
}

/**
 * Re-start a closed loop at the point of its track nearest to `target`.
 * The route and its direction are unchanged: the loop is cut at the
 * projection of `target` onto the nearest segment and the two parts are
 * swapped. Returns { points, offsetM } (offsetM = target-to-track distance).
 */
function rotateLoopToStart(points, target) {
  const first = points[0];
  const last = points[points.length - 1];
  const gapM = haversineM(first.lat, first.lon, last.lat, last.lon);
  if (gapM > LOOP_GAP_THRESHOLD_M) {
    throw new Error(`startAt needs a closed loop, but the start-end gap is ${Math.round(gapM)} m`);
  }
  const ring = gapM < 0.5 ? points.slice(0, -1) : points.slice();
  const n = ring.length;
  // Local equirectangular projection centred on the target (metres)
  const kx = 111320 * Math.cos((target.lat * Math.PI) / 180);
  const ky = 110574;
  let best = { offsetM: Infinity, i: 0, t: 0 };
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const ax = (a.lon - target.lon) * kx;
    const ay = (a.lat - target.lat) * ky;
    const dx = (b.lon - target.lon) * kx - ax;
    const dy = (b.lat - target.lat) * ky - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const offsetM = Math.hypot(ax + t * dx, ay + t * dy);
    if (offsetM < best.offsetM) best = { offsetM, i, t };
  }
  const a = ring[best.i];
  const b = ring[(best.i + 1) % n];
  const startPt = { lat: a.lat + (b.lat - a.lat) * best.t, lon: a.lon + (b.lon - a.lon) * best.t };
  // start -> b -> ... around the ring ... -> a -> start
  const rotated = [startPt];
  for (let k = 1; k <= n; k++) rotated.push(ring[(best.i + k) % n]);
  rotated.push({ ...startPt });
  return { points: dedupConsecutive(rotated), offsetM: best.offsetM };
}

// =========================================================================
// 3. Elevation lookup (IGN primary, Open-Meteo fallback) + cache
// =========================================================================

async function loadCache(id) {
  const file = path.join(CACHE_DIR, `${id}.json`);
  if (!existsSync(file)) return {};
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(id, cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${id}.json`);
  await writeFile(file, JSON.stringify(cache), 'utf8');
}

async function fetchJsonWithRetry(url, options, retries, baseDelayMs) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * Fetch elevations for a list of {lat, lon} from IGN, chunked.
 * Returns an array (same length/order) of numbers or null (no data / error).
 */
async function fetchElevationsIGN(coords, stats) {
  const results = new Array(coords.length).fill(null);
  for (let i = 0; i < coords.length; i += IGN_CHUNK_SIZE) {
    const chunk = coords.slice(i, i + IGN_CHUNK_SIZE);
    const lonStr = chunk.map((c) => c.lon).join('|');
    const latStr = chunk.map((c) => c.lat).join('|');
    const url =
      `${IGN_ELEVATION_URL}?lon=${encodeURIComponent(lonStr)}` +
      `&lat=${encodeURIComponent(latStr)}` +
      `&resource=ign_rge_alti_wld&zonly=true`;

    const data = await fetchJsonWithRetry(
      url,
      undefined,
      IGN_MAX_RETRIES,
      IGN_RETRY_BASE_DELAY_MS
    );
    stats.ignCalls += 1;

    const elevations = data && data.elevations;
    if (!Array.isArray(elevations) || elevations.length !== chunk.length) {
      throw new Error(
        `Unexpected IGN response shape (got ${
          Array.isArray(elevations) ? elevations.length : typeof elevations
        }, expected ${chunk.length})`
      );
    }
    for (let j = 0; j < chunk.length; j++) {
      const v = elevations[j];
      results[i + j] = v === IGN_NODATA_VALUE ? null : v;
    }

    if (i + IGN_CHUNK_SIZE < coords.length) {
      await sleep(IGN_REQUEST_DELAY_MS);
    }
  }
  return results;
}

/** Open-Meteo fallback: max 100 coords/call, coarser 90 m DEM. */
async function fetchElevationsOpenMeteo(coords, stats) {
  const results = new Array(coords.length).fill(null);
  for (let i = 0; i < coords.length; i += OPEN_METEO_CHUNK_SIZE) {
    const chunk = coords.slice(i, i + OPEN_METEO_CHUNK_SIZE);
    const latStr = chunk.map((c) => c.lat).join(',');
    const lonStr = chunk.map((c) => c.lon).join(',');
    const url =
      `${OPEN_METEO_URL}?latitude=${encodeURIComponent(latStr)}` +
      `&longitude=${encodeURIComponent(lonStr)}`;

    const data = await fetchJsonWithRetry(url, undefined, IGN_MAX_RETRIES, IGN_RETRY_BASE_DELAY_MS);
    stats.openMeteoCalls += 1;

    const elevations = data && data.elevation;
    if (!Array.isArray(elevations) || elevations.length !== chunk.length) {
      throw new Error('Unexpected Open-Meteo response shape');
    }
    for (let j = 0; j < chunk.length; j++) {
      results[i + j] = elevations[j];
    }

    if (i + OPEN_METEO_CHUNK_SIZE < coords.length) {
      await sleep(IGN_REQUEST_DELAY_MS);
    }
  }
  return results;
}

/** Fill nulls (missing elevation) by interpolating from nearest valid neighbours. */
function fillMissingElevations(elevations) {
  const n = elevations.length;
  const out = elevations.slice();
  let i = 0;
  while (i < n) {
    if (out[i] !== null && out[i] !== undefined) {
      i += 1;
      continue;
    }
    // find the run of missing values [i, j)
    let j = i;
    while (j < n && (out[j] === null || out[j] === undefined)) j += 1;
    const prevVal = i > 0 ? out[i - 1] : null;
    const nextVal = j < n ? out[j] : null;
    if (prevVal === null && nextVal === null) {
      // entire track has no data - fall back to 0 to avoid NaN propagation
      for (let k = i; k < j; k++) out[k] = 0;
    } else if (prevVal === null) {
      for (let k = i; k < j; k++) out[k] = nextVal;
    } else if (nextVal === null) {
      for (let k = i; k < j; k++) out[k] = prevVal;
    } else {
      const span = j - i + 1;
      for (let k = i; k < j; k++) {
        const t = (k - i + 1) / span;
        out[k] = prevVal + (nextVal - prevVal) * t;
      }
    }
    i = j;
  }
  return out;
}

/**
 * Resolve elevations for `points` (array of {lat, lon}) using the on-disk
 * cache first, then network calls only for coordinates not yet cached.
 * Mutates nothing; returns an array of elevation numbers (metres), same
 * order/length as `points`. Updates `netStats` with call counts / source.
 */
async function resolveElevations(id, points, netStats) {
  const cache = await loadCache(id);

  const missingCoords = [];
  const missingIndexes = [];
  for (let i = 0; i < points.length; i++) {
    const key = coordKey(points[i].lat, points[i].lon);
    if (!(key in cache)) {
      missingCoords.push(points[i]);
      missingIndexes.push(i);
    }
  }
  netStats.cacheHits += points.length - missingCoords.length;

  if (missingCoords.length > 0) {
    let fetched;
    let sourceUsed = 'ign';
    try {
      fetched = await fetchElevationsIGN(missingCoords, netStats);
    } catch (err) {
      console.warn(
        `  [${id}] IGN elevation lookup failed (${err.message}); falling back to Open-Meteo.`
      );
      sourceUsed = 'open-meteo';
      fetched = await fetchElevationsOpenMeteo(missingCoords, netStats);
    }
    netStats.sourcesUsed.add(sourceUsed);

    // Interpolate nulls (no-data) within this newly-fetched batch using
    // neighbours from the same batch (best effort; a further pass below
    // interpolates using the full track once merged with the cache).
    for (let k = 0; k < missingIndexes.length; k++) {
      const idx = missingIndexes[k];
      const key = coordKey(points[idx].lat, points[idx].lon);
      cache[key] = fetched[k]; // may be null; resolved after merge below
    }
    await saveCache(id, cache);
  }

  const raw = points.map((p) => {
    const key = coordKey(p.lat, p.lon);
    const v = cache[key];
    return v === undefined ? null : v;
  });

  const missingCount = raw.filter((v) => v === null).length;
  if (missingCount > 0) {
    netStats.noDataPoints[id] = missingCount;
  }

  return fillMissingElevations(raw);
}

// =========================================================================
// 4. Stats: distance, smoothing, ascent/descent (hysteresis), bounds, loop
// =========================================================================

/** Cumulative distance (m) at each point, and total distance. */
function computeCumulativeDistances(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const d = haversineM(
      points[i - 1].lat,
      points[i - 1].lon,
      points[i].lat,
      points[i].lon
    );
    cum.push(cum[i - 1] + d);
  }
  return cum;
}

/** Simple centred moving average over `window` points. */
function movingAverage(values, window) {
  const n = values.length;
  const half = Math.floor(window / 2);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) {
      sum += values[k];
      count += 1;
    }
    out[i] = sum / count;
  }
  return out;
}

/**
 * Ascent/descent with a hysteresis (threshold-reference) filter: this
 * absorbs +/-1-2 m DEM noise (typical for RGE ALTI / SRTM-derived data)
 * that would otherwise make a flat path look like it has spurious climb.
 *
 * Algorithm: keep a single "reference" elevation (initially the first
 * point). For each subsequent point, compute its delta from the
 * reference. As long as |delta| stays below `thresholdM`, it is treated
 * as noise and ignored (the reference does NOT move, so small
 * back-and-forth wiggles keep accumulating against the same reference
 * until they either cancel out or exceed the threshold). Once |delta|
 * reaches the threshold, that delta is committed to ascent (if positive)
 * or descent (if negative), and the reference jumps to the current
 * elevation, so the next leg starts fresh from there.
 *
 * This is the standard, simple hysteresis method for elevation gain from
 * a noisy DEM profile (equivalent to a "minimum climb/descent" filter):
 * a real climb/descent that happens to include a small dip/bump below the
 * noise threshold is still counted in full once it clears the threshold,
 * while genuine noise that never exceeds the threshold contributes 0.
 */
function computeAscentDescent(elevations, thresholdM) {
  if (elevations.length < 2) return { ascentM: 0, descentM: 0 };

  let ascent = 0;
  let descent = 0;
  let reference = elevations[0];

  for (let i = 1; i < elevations.length; i++) {
    const delta = elevations[i] - reference;
    if (delta >= thresholdM) {
      ascent += delta;
      reference = elevations[i];
    } else if (delta <= -thresholdM) {
      descent += -delta;
      reference = elevations[i];
    }
  }

  return { ascentM: ascent, descentM: descent };
}

function computeBounds(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return [
    [round(minLat, 6), round(minLon, 6)],
    [round(maxLat, 6), round(maxLon, 6)],
  ];
}

// =========================================================================
// 5. GPX output writer + round-trip validation
// =========================================================================

function buildGpxXml(trackName, gpxType, points, elevations) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<gpx version="1.1" creator="Marche APEL Saint-Nizier-sous-Charlieu" ' +
      'xmlns="http://www.topografix.com/GPX/1/1" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 ' +
      'http://www.topografix.com/GPX/1/1/gpx.xsd">'
  );
  lines.push(`  <metadata><name>${xmlEscape(trackName)}</name></metadata>`);
  lines.push('  <trk>');
  lines.push(`    <name>${xmlEscape(trackName)}</name>`);
  lines.push(`    <type>${xmlEscape(gpxType)}</type>`);
  lines.push('    <trkseg>');
  for (let i = 0; i < points.length; i++) {
    const lat = round(points[i].lat, 6);
    const lon = round(points[i].lon, 6);
    const ele = round(elevations[i], 1).toFixed(1);
    lines.push(`      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>`);
  }
  lines.push('    </trkseg>');
  lines.push('  </trk>');
  lines.push('</gpx>');
  lines.push('');
  return lines.join('\n');
}

/** Round-trip validation: reparse the written GPX, check point count + well-formedness. */
function validateGpx(xml, expectedCount) {
  // "well-formed enough" check: balanced core tags + parseable trkpts.
  const openGpx = (xml.match(/<gpx\b/g) || []).length;
  const closeGpx = (xml.match(/<\/gpx>/g) || []).length;
  if (openGpx !== 1 || closeGpx !== 1) {
    throw new Error('Validation failed: <gpx> not balanced/singular');
  }
  const { points, trkCount, trkSegCount } = parseGpxTrackPoints(xml);
  if (points.length !== expectedCount) {
    throw new Error(
      `Validation failed: expected ${expectedCount} trkpt, got ${points.length}`
    );
  }
  if (trkCount !== 1 || trkSegCount !== 1) {
    throw new Error(
      `Validation failed: expected exactly 1 trk/1 trkseg, got ${trkCount}/${trkSegCount}`
    );
  }
  for (const p of points) {
    if (Number.isNaN(p.lat) || Number.isNaN(p.lon)) {
      throw new Error('Validation failed: NaN coordinate found');
    }
  }
  return true;
}

// =========================================================================
// Main
// =========================================================================

async function processCircuit(circuit, netStats, report) {
  const sourcePath = path.join(PROJECT_ROOT, SOURCE_DIR, circuit.sourceFile);
  const rawXml = await readFile(sourcePath, 'utf8');

  const parsed = parseGpxTrackPoints(rawXml);
  const originalCount = parsed.points.length;

  if (originalCount !== circuit.expectedPoints) {
    report.warnings.push(
      `[${circuit.id}] parsed ${originalCount} trkpt, expected ${circuit.expectedPoints} (source file may have changed)`
    );
  }
  if (parsed.trkCount > 1 || parsed.trkSegCount > 1) {
    report.warnings.push(
      `[${circuit.id}] multiple track segments concatenated: ${parsed.trkCount} <trk>, ${parsed.trkSegCount} <trkseg>`
    );
  }
  if (parsed.wptCount > 0) {
    report.notes.push(
      `[${circuit.id}] dropped ${parsed.wptCount} <wpt> routing-shaping point(s)`
    );
  }

  let deduped = dedupConsecutive(parsed.points);
  const dupDropped = parsed.points.length - deduped.length;
  if (dupDropped > 0) {
    report.notes.push(
      `[${circuit.id}] dropped ${dupDropped} consecutive exact-duplicate point(s)`
    );
  }

  if (circuit.startAt) {
    const rotated = rotateLoopToStart(deduped, circuit.startAt);
    deduped = rotated.points;
    report.notes.push(
      `[${circuit.id}] loop re-started at the common start (track passes ${rotated.offsetM.toFixed(1)} m from it)`
    );
  }

  const bigJumps = findBigJumps(deduped, 300);
  if (bigJumps.length > 0) {
    report.warnings.push(
      `[${circuit.id}] ${bigJumps.length} jump(s) >300 m between consecutive original points: ` +
        bigJumps.map((j) => `#${j.index}:${j.distanceM}m`).join(', ')
    );
  }

  const densified = densify(deduped, MAX_SEGMENT_M);

  const elevations = await resolveElevations(circuit.id, densified, netStats);

  const cumDist = computeCumulativeDistances(densified);
  const totalDistanceM = cumDist[cumDist.length - 1];

  const smoothed = movingAverage(elevations, SMOOTHING_WINDOW);
  const { ascentM, descentM } = computeAscentDescent(
    smoothed,
    HYSTERESIS_THRESHOLD_M
  );

  const eleMinM = Math.min(...elevations);
  const eleMaxM = Math.max(...elevations);

  const start = densified[0];
  const end = densified[densified.length - 1];
  const startEndGapM = haversineM(start.lat, start.lon, end.lat, end.lon);
  const loop = startEndGapM < LOOP_GAP_THRESHOLD_M;

  const bounds = computeBounds(densified);

  const trackName = `${TRACK_NAME_PREFIX} ${circuit.shortLabel}`;

  // ---- write GPX ----
  const gpxXml = buildGpxXml(trackName, circuit.gpxType, densified, elevations);
  validateGpx(gpxXml, densified.length);
  await mkdir(OUT_GPX_DIR, { recursive: true });
  const gpxFileName = `marche-apel-${circuit.id}.gpx`;
  const gpxOutPath = path.join(OUT_GPX_DIR, gpxFileName);
  await writeFile(gpxOutPath, gpxXml, 'utf8');

  // ---- points for JSON contract: [lat, lon, ele, cumulativeDistanceM] ----
  const jsonPoints = densified.map((p, i) => [
    round(p.lat, 6),
    round(p.lon, 6),
    round(elevations[i], 1),
    Math.round(cumDist[i]),
  ]);

  const circuitJson = {
    id: circuit.id,
    name: circuit.name,
    activity: circuit.activity,
    gpxFile: gpxFileName,
    trackName,
    distanceM: Math.round(totalDistanceM),
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    eleMinM: Math.round(eleMinM),
    eleMaxM: Math.round(eleMaxM),
    loop,
    startEndGapM: Math.round(startEndGapM),
    start: [round(start.lat, 5), round(start.lon, 5)],
    bounds,
    points: jsonPoints,
  };

  report.rows.push({
    id: circuit.id,
    originalPoints: originalCount,
    densifiedPoints: densified.length,
    distanceKm: totalDistanceM / 1000,
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    eleMinM: Math.round(eleMinM),
    eleMaxM: Math.round(eleMaxM),
    loop,
    startEndGapM: Math.round(startEndGapM),
    start: circuitJson.start,
  });

  return circuitJson;
}

async function main() {
  console.log('Marche APEL - data pipeline\n');

  const netStats = {
    ignCalls: 0,
    openMeteoCalls: 0,
    cacheHits: 0,
    sourcesUsed: new Set(),
    noDataPoints: {},
  };
  const report = { warnings: [], notes: [], rows: [] };

  const circuitsJson = [];
  for (const circuit of CIRCUITS) {
    console.log(`Processing ${circuit.id} (${circuit.name})...`);
    const result = await processCircuit(circuit, netStats, report);
    circuitsJson.push(result);
    console.log(
      `  -> ${result.points.length} pts, ${(result.distanceM / 1000).toFixed(
        2
      )} km, D+${result.ascentM} D-${result.descentM}, ele ${result.eleMinM}-${result.eleMaxM} m`
    );
  }

  const elevationSource =
    netStats.sourcesUsed.size === 0
      ? 'IGN RGE ALTI (Géoplateforme)' // fully cached run, no calls made
      : netStats.sourcesUsed.has('open-meteo') && netStats.sourcesUsed.has('ign')
      ? 'IGN RGE ALTI (Géoplateforme) + Open-Meteo fallback'
      : netStats.sourcesUsed.has('open-meteo')
      ? 'Open-Meteo (fallback, 90 m DEM)'
      : 'IGN RGE ALTI (Géoplateforme)';

  const output = {
    generatedAt: new Date().toISOString(),
    elevationSource,
    circuits: circuitsJson,
  };

  await mkdir(path.dirname(OUT_JSON_PATH), { recursive: true });
  await writeFile(OUT_JSON_PATH, JSON.stringify(output, null, 2), 'utf8');

  // -----------------------------------------------------------------------
  // Cross-circuit sanity checks
  // -----------------------------------------------------------------------
  const nameKm = {
    '5km': 5,
    '10km': 10,
    '14km': 14,
    '18km': 18,
    vtt: 22.2,
  };
  for (const row of report.rows) {
    const expectedKm = nameKm[row.id];
    if (expectedKm) {
      const pctDiff = (Math.abs(row.distanceKm - expectedKm) / expectedKm) * 100;
      if (pctDiff > 5) {
        report.warnings.push(
          `[${row.id}] measured distance ${row.distanceKm.toFixed(
            2
          )} km differs from nominal ${expectedKm} km by ${pctDiff.toFixed(1)}%`
        );
      }
    }
  }

  const starts = report.rows.map((r) => r.start);
  const startDistances = [];
  for (let i = 1; i < starts.length; i++) {
    const d = haversineM(starts[0][0], starts[0][1], starts[i][0], starts[i][1]);
    startDistances.push({ id: report.rows[i].id, distanceM: Math.round(d) });
  }

  // -----------------------------------------------------------------------
  // Console report
  // -----------------------------------------------------------------------
  console.log('\n=== Summary table ===');
  console.log(
    'id       orig  dense   km     D+    D-   eleMin eleMax loop  gap(m)'
  );
  for (const r of report.rows) {
    console.log(
      `${r.id.padEnd(8)} ${String(r.originalPoints).padStart(4)}  ${String(
        r.densifiedPoints
      ).padStart(5)}  ${r.distanceKm.toFixed(2).padStart(5)}  ${String(
        r.ascentM
      ).padStart(4)}  ${String(r.descentM).padStart(4)}   ${String(
        r.eleMinM
      ).padStart(5)}  ${String(r.eleMaxM).padStart(5)}  ${(r.loop ? 'yes' : 'no').padEnd(
        4
      )}  ${r.startEndGapM}`
    );
  }

  console.log('\n=== Elevation source ===');
  console.log(`Used: ${elevationSource}`);
  console.log(
    `IGN calls: ${netStats.ignCalls}, Open-Meteo calls: ${netStats.openMeteoCalls}, cache-only points: ${netStats.cacheHits}`
  );
  if (Object.keys(netStats.noDataPoints).length > 0) {
    console.log('No-data points interpolated from neighbours:', netStats.noDataPoints);
  }

  console.log('\n=== Start points (distance from 5km start) ===');
  console.log(`5km start: [${starts[0][0]}, ${starts[0][1]}]`);
  for (const s of startDistances) {
    console.log(`  ${s.id}: ${s.distanceM} m away`);
  }

  if (report.notes.length > 0) {
    console.log('\n=== Notes ===');
    for (const n of report.notes) console.log(' -', n);
  }
  if (report.warnings.length > 0) {
    console.log('\n=== Warnings / anomalies ===');
    for (const w of report.warnings) console.log(' !', w);
  } else {
    console.log('\nNo anomalies detected.');
  }

  console.log('\n=== Files written ===');
  console.log(' -', OUT_JSON_PATH);
  for (const c of circuitsJson) {
    console.log(' -', path.join(OUT_GPX_DIR, c.gpxFile));
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exitCode = 1;
});
