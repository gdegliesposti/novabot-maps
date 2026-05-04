/**
 * pathRoutes.js
 * REST API - modello multi-percorso a catena ordinata di punti.
 *
 * Struttura dello stato:
 *   {
 *     paths: [{ id, name, closed, points: [{id, x, y}] }],
 *     activePathId: number | null,
 *     nextPathId: number,
 *     nextPointId: number
 *   }
 *
 * I segmenti sono IMPLICITI nell'ordine dell'array:
 *   segmento i = points[i] -> points[i+1]
 *   se closed=true esiste anche points[n-1] -> points[0]
 *
 * Le operazioni di editing (point add/move/delete, split, closed toggle)
 * operano sempre sul percorso attivo (activePathId).
 * Le route /api/path/* sono retrocompatibili con il frontend esistente.
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { parse }     = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// -- Stato in memoria ----------------------------------------------------------

let store = {
  paths:        [],   // [{ id, name, closed, points: [{id, x, y}] }]
  activePathId: null,
  nextPathId:   1,
  nextPointId:  1,
};

const upload = multer({ storage: multer.memoryStorage() });

// -- Helpers interni -----------------------------------------------------------

function makePoint(x, y) {
  return { id: store.nextPointId++, x: Number(x), y: Number(y) };
}

function makePath(name) {
  return { id: store.nextPathId++, name: String(name || 'Percorso'), closed: false, points: [] };
}

/** Ritorna il percorso attivo o null. */
function activePath() {
  if (store.activePathId === null) return null;
  return store.paths.find(p => p.id === store.activePathId) || null;
}

/** Ritorna il percorso attivo; se non esiste ne crea uno e lo attiva. */
function ensureActivePath() {
  let ap = activePath();
  if (!ap) {
    ap = makePath('Percorso 1');
    store.paths.push(ap);
    store.activePathId = ap.id;
  }
  return ap;
}

/**
 * Ricalcola nextPointId come max(id)+1 su tutti i punti di tutti i percorsi.
 * Usato dopo un POST /state o /load che inietta id esterni.
 */
function resyncPointId() {
  let max = 0;
  store.paths.forEach(path => {
    path.points.forEach(p => { if (p.id > max) max = p.id; });
  });
  store.nextPointId = max + 1;
}

/**
 * Analizza un buffer CSV e ritorna un array di punti {x, y} (senza id).
 * Supporta header opzionale X,Y (case-insensitive) e dati senza header.
 */
function parseCsvBuffer(buffer) {
  const text      = buffer.toString('utf-8');
  const firstLine = text.split(/\r?\n/).find(l => l.trim() !== '');
  const firstCell = firstLine ? firstLine.split(',')[0].trim() : '';
  const hasHeader = firstCell !== '' && isNaN(Number(firstCell));

  let records;
  if (hasHeader) {
    records = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  } else {
    records = parse(text, { columns: false, skip_empty_lines: true, trim: true });
  }

  return records.map((row, idx) => {
    const x = parseFloat(hasHeader ? (row.X ?? row.x) : row[0]);
    const y = parseFloat(hasHeader ? (row.Y ?? row.y) : row[1]);
    if (isNaN(x) || isNaN(y)) {
      throw new Error('Riga ' + (idx + 1) + ' non valida: ' + JSON.stringify(row));
    }
    return { x, y };
  });
}

/** Serializza i punti di un percorso in CSV (senza header, punto decimale). */
function serializeCsv(points) {
  const cast = { number: value => String(value) };
  const rows  = points.map(p => [p.x, p.y]);
  return stringify(rows, { header: false, cast });
}

/** Metadati pubblici di un percorso (senza array punti, per liste). */
function pathMeta(path) {
  return { id: path.id, name: path.name, closed: path.closed, count: path.points.length };
}

// =============================================================================
// ROUTE MULTI-PERCORSO  /api/paths/*
// =============================================================================

// -- GET /api/paths ------------------------------------------------------------
// Lista tutti i percorsi (metadati, senza array punti).
router.get('/paths', (req, res) => {
  res.json({ paths: store.paths.map(pathMeta), activePathId: store.activePathId });
});

// -- POST /api/paths -----------------------------------------------------------
// Crea un nuovo percorso vuoto e lo rende attivo.
// Body: { name? }
router.post('/paths', (req, res) => {
  const name = req.body.name || ('Percorso ' + store.nextPathId);
  const path = makePath(name);
  store.paths.push(path);
  store.activePathId = path.id;
  res.json({ path: pathMeta(path), activePathId: store.activePathId });
});

// -- DELETE /api/paths/:pid ---------------------------------------------------
// Elimina un percorso. Se era quello attivo, attiva il primo rimasto (o null).
router.delete('/paths/:pid', (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const idx = store.paths.findIndex(p => p.id === pid);
  if (idx === -1) return res.status(404).json({ error: 'Percorso ' + pid + ' non trovato' });

  store.paths.splice(idx, 1);

  if (store.activePathId === pid) {
    store.activePathId = store.paths.length > 0 ? store.paths[0].id : null;
  }

  res.json({ ok: true, activePathId: store.activePathId });
});

// -- PATCH /api/paths/:pid ----------------------------------------------------
// Aggiorna name e/o closed di un percorso.
// Body: { name?, closed? }
router.patch('/paths/:pid', (req, res) => {
  const pid  = parseInt(req.params.pid, 10);
  const path = store.paths.find(p => p.id === pid);
  if (!path) return res.status(404).json({ error: 'Percorso ' + pid + ' non trovato' });

  if (req.body.name !== undefined)   path.name   = String(req.body.name);
  if (req.body.closed !== undefined) path.closed = !!req.body.closed;

  res.json(pathMeta(path));
});

// -- GET /api/paths/active ----------------------------------------------------
// Ritorna id e dati completi del percorso attivo.
router.get('/paths/active', (req, res) => {
  const ap = activePath();
  if (!ap) return res.json({ activePathId: null, path: null });
  res.json({ activePathId: store.activePathId, path: ap });
});

// -- PUT /api/paths/active ----------------------------------------------------
// Cambia il percorso attivo.
// Body: { pathId }
router.put('/paths/active', (req, res) => {
  const pid = parseInt(req.body.pathId, 10);
  if (!store.paths.find(p => p.id === pid)) {
    return res.status(404).json({ error: 'Percorso ' + pid + ' non trovato' });
  }
  store.activePathId = pid;
  res.json({ activePathId: store.activePathId });
});

// -- GET /api/paths/:pid/save -------------------------------------------------
// Scarica i punti del percorso specificato come CSV.
router.get('/paths/:pid/save', (req, res) => {
  const pid  = parseInt(req.params.pid, 10);
  const path = store.paths.find(p => p.id === pid);
  if (!path) return res.status(404).json({ error: 'Percorso ' + pid + ' non trovato' });

  const csv      = serializeCsv(path.points);
  const safeName = path.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.csv"');
  res.send(csv);
});

// -- POST /api/paths/load -----------------------------------------------------
// Carica un CSV come NUOVO percorso aggiunto al disegno corrente.
// Rende il nuovo percorso attivo.
// Body: multipart/form-data con field "file"; opzionale field "name".
router.post('/paths/load', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  try {
    const rawPoints = parseCsvBuffer(req.file.buffer);
    const name      = req.body.name || req.file.originalname.replace(/\.csv$/i, '');
    const path      = makePath(name);
    path.points     = rawPoints.map(rp => makePoint(rp.x, rp.y));
    store.paths.push(path);
    store.activePathId = path.id;
    res.json({ path, activePathId: store.activePathId });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// -- GET /api/paths/fullstate -------------------------------------------------
// Ritorna lo stato completo (tutti i percorsi con punti). Usato dall'init frontend.
router.get('/paths/fullstate', (req, res) => {
  res.json({ paths: store.paths, activePathId: store.activePathId });
});

// -- POST /api/paths/fullstate ------------------------------------------------
// Sostituisce l'intero stato (usato da undo/redo multi-percorso).
// Body: { paths, activePathId }
router.post('/paths/fullstate', (req, res) => {
  const { paths, activePathId } = req.body;
  if (!Array.isArray(paths)) {
    return res.status(400).json({ error: 'paths deve essere un array' });
  }
  let maxPid = 0;
  paths.forEach(p => { if (p.id > maxPid) maxPid = p.id; });

  store.paths        = paths;
  store.activePathId = activePathId !== undefined ? activePathId : store.activePathId;
  store.nextPathId   = maxPid + 1;
  resyncPointId();
  res.json({ ok: true });
});

// =============================================================================
// ROUTE EDITING SUL PERCORSO ATTIVO  /api/path/*
// Retrocompatibili con il frontend esistente.
// =============================================================================

// -- GET /api/path/state ------------------------------------------------------
// Ritorna { points, closed } del percorso attivo (struttura legacy).
router.get('/state', (req, res) => {
  const ap = activePath();
  if (!ap) return res.json({ points: [], closed: false });
  res.json({ points: ap.points, closed: ap.closed });
});

// -- POST /api/path/state -----------------------------------------------------
// Sostituisce points e closed del percorso attivo (usato da undo/redo legacy).
router.post('/state', (req, res) => {
  const { points, closed } = req.body;
  if (!Array.isArray(points)) {
    return res.status(400).json({ error: 'points deve essere un array' });
  }
  const ap = ensureActivePath();
  ap.points = points;
  ap.closed = !!closed;
  resyncPointId();
  res.json({ ok: true });
});

// -- POST /api/path/point -----------------------------------------------------
// Aggiunge un punto al percorso attivo.
// Body: { x, y, afterIndex? }
router.post('/point', (req, res) => {
  const { x, y, afterIndex } = req.body;
  if (x == null || y == null) {
    return res.status(400).json({ error: 'x e y sono obbligatori' });
  }
  const ap = ensureActivePath();
  const pt = makePoint(x, y);
  const n  = ap.points.length;

  if (afterIndex == null || afterIndex < 0 || afterIndex >= n) {
    ap.points.push(pt);
  } else {
    ap.points.splice(afterIndex + 1, 0, pt);
  }

  res.json({ point: pt, state: { points: ap.points, closed: ap.closed } });
});

// -- DELETE /api/path/point/:id -----------------------------------------------
// Elimina un punto dal percorso attivo.
router.delete('/point/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ap = activePath();
  if (!ap) return res.status(404).json({ error: 'Nessun percorso attivo' });

  const idx = ap.points.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Punto ' + id + ' non trovato' });

  const n          = ap.points.length;
  const isInternal = n >= 3 && idx > 0 && idx < n - 1;
  const isEndpoint = idx === 0 || idx === n - 1;

  ap.points.splice(idx, 1);
  res.json({ ok: true, wasInternal: isInternal, wasEndpoint: isEndpoint,
             state: { points: ap.points, closed: ap.closed } });
});

// -- POST /api/path/point/:id/move --------------------------------------------
router.post('/point/:id/move', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { x, y } = req.body;
  if (x == null || y == null) {
    return res.status(400).json({ error: 'x e y sono obbligatori' });
  }
  const ap = activePath();
  if (!ap) return res.status(404).json({ error: 'Nessun percorso attivo' });

  const pt = ap.points.find(p => p.id === id);
  if (!pt) return res.status(404).json({ error: 'Punto ' + id + ' non trovato' });
  pt.x = Number(x);
  pt.y = Number(y);
  res.json(pt);
});

// -- PATCH /api/path/closed ---------------------------------------------------
router.patch('/closed', (req, res) => {
  if (typeof req.body.closed !== 'boolean') {
    return res.status(400).json({ error: 'closed deve essere boolean' });
  }
  const ap = ensureActivePath();
  ap.closed = req.body.closed;
  res.json({ ok: true, closed: ap.closed });
});

// -- POST /api/path/load ------------------------------------------------------
// Carica CSV SOSTITUENDO i punti del percorso attivo (comportamento legacy).
// Se non esiste un percorso attivo, ne crea uno nuovo.
router.post('/load', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  try {
    const rawPoints = parseCsvBuffer(req.file.buffer);
    const ap        = ensureActivePath();
    ap.points       = rawPoints.map(rp => makePoint(rp.x, rp.y));
    ap.closed       = false;
    if (ap.name === 'Percorso 1' || ap.name === 'Percorso') {
      ap.name = req.file.originalname.replace(/\.csv$/i, '');
    }
    res.json({ points: ap.points, closed: ap.closed });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// -- GET /api/path/save -------------------------------------------------------
// Scarica il percorso attivo come CSV.
router.get('/save', (req, res) => {
  const ap = activePath();
  if (!ap) return res.status(404).json({ error: 'Nessun percorso attivo' });

  const csv      = serializeCsv(ap.points);
  const safeName = ap.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.csv"');
  res.send(csv);
});

// -- DELETE /api/path/clear ---------------------------------------------------
// Svuota TUTTI i percorsi e azzera lo stato (clear all).
router.delete('/clear', (req, res) => {
  store = { paths: [], activePathId: null, nextPathId: 1, nextPointId: 1 };
  res.json({ ok: true });
});

module.exports = router;