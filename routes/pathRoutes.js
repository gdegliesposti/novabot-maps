/**
 * routes/pathRoutes.js
 * REST API - modello multi-percorso a catena ordinata di punti.
 *
 * Montato su /api/path in server.js.
 *
 * Struttura dello stato in memoria:
 *   store = {
 *     paths:        [{ id, name, closed, points: [{id, x, y}] }],
 *     activePathId: number | null,
 *     nextPathId:   number,
 *     nextPointId:  number
 *   }
 *
 * Route multi-percorso:  /paths/*
 * Route editing attivo:  /state  /point  /closed  /load  /save  /clear
 *   (retrocompatibili - operano sempre sul percorso attivo)
 *
 * ORDINE DELLE ROUTE: le route statiche devono precedere quelle con :pid
 * per evitare che Express interpreti "active" o "fullstate" come id numerico.
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { parse }     = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// ── Stato in memoria ──────────────────────────────────────────────────────────

let store = {
  paths:        [],
  activePathId: null,
  nextPathId:   1,
  nextPointId:  1,
};

const upload = multer({ storage: multer.memoryStorage() });

// ── Helpers interni ───────────────────────────────────────────────────────────

function makePoint(x, y) {
  return { id: store.nextPointId++, x: Number(x), y: Number(y) };
}

function makePath(name) {
  return {
    id:     store.nextPathId++,
    name:   String(name || 'Percorso'),
    closed: false,
    points: [],
  };
}

function activePath() {
  if (store.activePathId === null) return null;
  return store.paths.find(p => p.id === store.activePathId) || null;
}

function ensureActivePath() {
  let ap = activePath();
  if (!ap) {
    ap = makePath('Percorso ' + store.nextPathId);
    store.paths.push(ap);
    store.activePathId = ap.id;
  }
  return ap;
}

function resyncCounters() {
  let maxPid = 0, maxPtId = 0;
  store.paths.forEach(path => {
    if (path.id > maxPid) maxPid = path.id;
    path.points.forEach(p => { if (p.id > maxPtId) maxPtId = p.id; });
  });
  store.nextPathId   = maxPid   + 1;
  store.nextPointId  = maxPtId  + 1;
}

function parseCsvBuffer(buffer) {
  const text      = buffer.toString('utf-8');
  const firstLine = text.split(/\r?\n/).find(l => l.trim() !== '');
  const firstCell = firstLine ? firstLine.split(',')[0].trim() : '';
  const hasHeader = firstCell !== '' && isNaN(Number(firstCell));

  const records = hasHeader
    ? parse(text, { columns: true,  skip_empty_lines: true, trim: true })
    : parse(text, { columns: false, skip_empty_lines: true, trim: true });

  return records.map((row, idx) => {
    const x = parseFloat(hasHeader ? (row.X ?? row.x) : row[0]);
    const y = parseFloat(hasHeader ? (row.Y ?? row.y) : row[1]);
    if (isNaN(x) || isNaN(y)) {
      throw new Error('Riga ' + (idx + 1) + ' non valida: ' + JSON.stringify(row));
    }
    return { x, y };
  });
}

function serializeCsv(points) {
  const cast = { number: v => String(v) };
  return stringify(points.map(p => [p.x, p.y]), { header: false, cast });
}

function pathMeta(path) {
  return { id: path.id, name: path.name, closed: path.closed, count: path.points.length };
}

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-]/g, '_') || 'percorso';
}

// =============================================================================
// ROUTE MULTI-PERCORSO  /paths/*
// ATTENZIONE: le route statiche (/paths/active, /paths/fullstate, /paths/load)
// DEVONO essere registrate PRIMA di /paths/:pid altrimenti Express le
// interpreterebbe come id.
// =============================================================================

// GET /paths ------------------------------------------------------------------
router.get('/paths', (req, res) => {
  res.json({ paths: store.paths.map(pathMeta), activePathId: store.activePathId });
});

// POST /paths -----------------------------------------------------------------
// Crea un nuovo percorso vuoto e lo attiva.
router.post('/paths', (req, res) => {
  const name = String(req.body.name || ('Percorso ' + store.nextPathId));
  const path = makePath(name);
  store.paths.push(path);
  store.activePathId = path.id;
  res.json({ path: pathMeta(path), activePathId: store.activePathId });
});

// GET /paths/fullstate --------------------------------------------------------
// Stato completo (tutti i percorsi con punti). Usato dall'init frontend.
router.get('/paths/fullstate', (req, res) => {
  res.json({ paths: store.paths, activePathId: store.activePathId });
});

// POST /paths/fullstate -------------------------------------------------------
// Sostituisce l'intero stato (undo/redo multi-percorso).
router.post('/paths/fullstate', (req, res) => {
  const { paths, activePathId } = req.body;
  if (!Array.isArray(paths)) {
    return res.status(400).json({ error: 'paths deve essere un array' });
  }
  store.paths        = paths;
  store.activePathId = activePathId !== undefined ? activePathId : store.activePathId;
  resyncCounters();
  res.json({ ok: true });
});

// GET /paths/active -----------------------------------------------------------
// Metadati + punti del percorso attivo.
router.get('/paths/active', (req, res) => {
  const ap = activePath();
  res.json({ activePathId: store.activePathId, path: ap || null });
});

// PUT /paths/active -----------------------------------------------------------
// Cambia il percorso attivo. Body: { pathId }
router.put('/paths/active', (req, res) => {
  const pid = parseInt(req.body.pathId, 10);
  if (!store.paths.find(p => p.id === pid)) {
    return res.status(404).json({ error: 'Percorso ' + pid + ' non trovato' });
  }
  store.activePathId = pid;
  res.json({ activePathId: pid });
});

// POST /paths/load ------------------------------------------------------------
// Carica un CSV come NUOVO percorso (non sostituisce nulla).
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

// PATCH /paths/:pid -----------------------------------------------------------
// Aggiorna name e/o closed di un percorso.
router.patch('/paths/:pid', (req, res) => {
  const pid  = parseInt(req.params.pid, 10);
  const path = store.paths.find(p => p.id === pid);
  if (!path) return res.status(404).json({ error: 'Percorso ' + pid + ' non trovato' });

  if (req.body.name   !== undefined) path.name   = String(req.body.name);
  if (req.body.closed !== undefined) path.closed = !!req.body.closed;

  res.json(pathMeta(path));
});

// GET /paths/:pid/save --------------------------------------------------------
// Scarica CSV del percorso specificato con nome file = nome percorso.
router.get('/paths/:pid/save', (req, res) => {
  const pid  = parseInt(req.params.pid, 10);
  const path = store.paths.find(p => p.id === pid);
  if (!path) return res.status(404).json({ error: 'Percorso ' + pid + ' non trovato' });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName(path.name) + '.csv"');
  res.send(serializeCsv(path.points));
});

// DELETE /paths/:pid ----------------------------------------------------------
// Elimina un percorso. Se era attivo, attiva il primo rimasto (o null).
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

// =============================================================================
// ROUTE EDITING SUL PERCORSO ATTIVO  (retrocompatibili)
// =============================================================================

// GET /state ------------------------------------------------------------------
router.get('/state', (req, res) => {
  const ap = activePath();
  res.json(ap ? { points: ap.points, closed: ap.closed } : { points: [], closed: false });
});

// POST /state -----------------------------------------------------------------
// Sostituisce points+closed del percorso attivo (usato da undo/redo).
router.post('/state', (req, res) => {
  const { points, closed } = req.body;
  if (!Array.isArray(points)) {
    return res.status(400).json({ error: 'points deve essere un array' });
  }
  const ap = ensureActivePath();
  ap.points = points;
  ap.closed = !!closed;
  resyncCounters();
  res.json({ ok: true });
});

// POST /point -----------------------------------------------------------------
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

// DELETE /point/:id -----------------------------------------------------------
router.delete('/point/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ap = activePath();
  if (!ap) return res.status(404).json({ error: 'Nessun percorso attivo' });

  const idx = ap.points.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Punto ' + id + ' non trovato' });

  ap.points.splice(idx, 1);
  res.json({ ok: true, state: { points: ap.points, closed: ap.closed } });
});

// POST /point/:id/move --------------------------------------------------------
router.post('/point/:id/move', (req, res) => {
  const id   = parseInt(req.params.id, 10);
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

// PATCH /closed ---------------------------------------------------------------
router.patch('/closed', (req, res) => {
  if (typeof req.body.closed !== 'boolean') {
    return res.status(400).json({ error: 'closed deve essere boolean' });
  }
  const ap = ensureActivePath();
  ap.closed = req.body.closed;
  res.json({ ok: true, closed: ap.closed });
});

// POST /load ------------------------------------------------------------------
// Carica CSV NEL percorso attivo (sostituisce i punti). Comportamento legacy.
router.post('/load', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  try {
    const rawPoints = parseCsvBuffer(req.file.buffer);
    const ap        = ensureActivePath();
    ap.points       = rawPoints.map(rp => makePoint(rp.x, rp.y));
    ap.closed       = false;
    ap.name         = req.file.originalname.replace(/\.csv$/i, '');
    res.json({ points: ap.points, closed: ap.closed });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// GET /save -------------------------------------------------------------------
// Scarica CSV del percorso attivo con nome file = nome percorso.
router.get('/save', (req, res) => {
  const ap = activePath();
  if (!ap) return res.status(404).json({ error: 'Nessun percorso attivo' });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName(ap.name) + '.csv"');
  res.send(serializeCsv(ap.points));
});

// DELETE /clear ---------------------------------------------------------------
router.delete('/clear', (req, res) => {
  store = { paths: [], activePathId: null, nextPathId: 1, nextPointId: 1 };
  res.json({ ok: true });
});

module.exports = router;