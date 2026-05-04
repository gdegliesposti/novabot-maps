/**
 * editor.js
 * Frontend canvas-based path editor - multi-percorso.
 *
 * Stato globale frontend:
 *   multiState.paths       = array di tutti i percorsi (con punti)
 *   multiState.activePathId = id del percorso in editing
 *
 * Il campo "state" (points, closed, selectedId) rispecchia sempre
 * il percorso attivo ed e' l'unico su cui operano gli strumenti di editing.
 */

// -- State locale del percorso attivo -----------------------------------------

const state = {
  points:     [],
  closed:     false,
  selectedId: null,
};

// -- Stato multi-percorso ------------------------------------------------------

const multiState = {
  paths:        [],   // copia locale di tutti i percorsi (con punti)
  activePathId: null,
};

// Viewport transform: screen = world * zoom + pan
const view = {
  zoom: 1,
  panX: 0,
  panY: 0,
};

let lastFitView = { zoom: 1, panX: 0, panY: 0 };

// -- Undo / Redo ---------------------------------------------------------------
// Snapshot completo dell'intero multiState per supportare operazioni
// che creano/eliminano/rinominano percorsi oltre a modificare punti.

const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 50;

function snapMulti() {
  return {
    paths:        multiState.paths.map(p => ({
      ...p,
      points: p.points.map(pt => ({ ...pt })),
    })),
    activePathId: multiState.activePathId,
  };
}

function snapState() {
  // Snapshot legacy (solo percorso attivo) - usato dalle operazioni di editing
  return {
    points:     state.points.map(p => ({ ...p })),
    closed:     state.closed,
    selectedId: state.selectedId,
    // Conserva anche il contesto multi per undo completo
    _multi:     snapMulti(),
  };
}

function pushUndo(before) {
  undoStack.push({ before });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

function commitUndo() {
  const entry = undoStack[undoStack.length - 1];
  if (entry && !entry.after) {
    entry.after = snapState();
  }
  updateUndoButtons();
}

async function applySnapshot(snap) {
  // Se lo snapshot contiene il contesto multi, ripristina l'intero store
  if (snap._multi) {
    await apiPost('/api/path/paths/fullstate', {
      paths:        snap._multi.paths,
      activePathId: snap._multi.activePathId,
    });
    multiState.paths        = snap._multi.paths.map(p => ({
      ...p, points: p.points.map(pt => ({ ...pt })),
    }));
    multiState.activePathId = snap._multi.activePathId;
  } else {
    // Undo legacy (solo percorso attivo)
    await apiPost('/api/path/state', { points: snap.points, closed: snap.closed });
  }
  state.points     = snap.points.map(p => ({ ...p }));
  state.closed     = snap.closed;
  state.selectedId = snap.selectedId;
  updateUI();
}

async function undo() {
  if (!undoStack.length) return;
  const entry = undoStack.pop();
  redoStack.push(entry);
  await applySnapshot(entry.before);
  updateUndoButtons();
  toast('Annullato');
}

async function redo() {
  if (!redoStack.length) return;
  const entry = redoStack.pop();
  undoStack.push(entry);
  await applySnapshot(entry.after);
  updateUndoButtons();
  toast('Ripristinato');
}

function updateUndoButtons() {
  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');
  if (btnUndo) btnUndo.disabled = undoStack.length === 0;
  if (btnRedo) btnRedo.disabled = redoStack.length === 0;
}

// -- Tool / interaction state --------------------------------------------------

let currentTool   = 'add';
let isPanning     = false;
let panStart      = { mx: 0, my: 0, px: 0, py: 0 };
let mouseWorld    = { x: 0, y: 0 };

let isDragging    = false;
let dragId        = null;
let dragOffsetX   = 0;
let dragOffsetY   = 0;
let dragHasMoved  = false;
let dragBefore    = null;

let hoveredSegIdx = -1;
let ghostPoint    = null;
let zoomRect      = null;

// -- Canvas setup --------------------------------------------------------------

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  const wrap    = canvas.parentElement;
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  render();
}
window.addEventListener('resize', resizeCanvas);

// -- Coordinate helpers --------------------------------------------------------

function screenToWorld(sx, sy) {
  return {
    x:  (sx - view.panX) / view.zoom,
    y: -(sy - view.panY) / view.zoom,
  };
}

function worldToScreen(wx, wy) {
  return {
    x:  wx * view.zoom + view.panX,
    y: -wy * view.zoom + view.panY,
  };
}

// -- Rendering -----------------------------------------------------------------

const POINT_R       = 5;
const POINT_R_HOVER = 8;
const GRID_STEP     = 50;

// Palette colori per percorsi non attivi (ciclica)
const PATH_COLORS = [
  'rgba(168,85,247,0.55)',   // viola
  'rgba(251,146,60,0.55)',   // arancio
  'rgba(52,211,153,0.55)',   // verde
  'rgba(251,191,36,0.55)',   // giallo
  'rgba(236,72,153,0.55)',   // rosa
];

function pathColor(pathId) {
  const idx = multiState.paths.findIndex(p => p.id === pathId);
  return PATH_COLORS[idx % PATH_COLORS.length];
}

function render() {
  const W = canvas.width;
  const H = canvas.height;

  ctx.fillStyle = '#0d0f12';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  drawGrid(W, H);
  ctx.restore();

  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, -view.zoom);

  // Disegna prima tutti i percorsi non attivi (sfondo)
  multiState.paths.forEach(path => {
    if (path.id !== multiState.activePathId) {
      drawPathInactive(path);
    }
  });

  // Disegna il percorso attivo sopra (con hover, ghost, ecc.)
  drawChain();
  drawPoints();

  ctx.restore();

  // Rubber-band (zoom o erase) in screen space
  if (zoomRect !== null) {
    if (currentTool === 'zoom')  drawZoomRect(false);
    if (currentTool === 'erase') drawZoomRect(true);
  }
}

/**
 * Disegna un percorso non attivo con colore attenuato e senza interazioni.
 */
function drawPathInactive(path) {
  const pts = path.points;
  const n   = pts.length;
  if (n < 1) return;

  const color    = pathColor(path.id);
  const segCount = path.closed ? n : Math.max(0, n - 1);

  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.2 / view.zoom;

  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Punti
  const pr = POINT_R * 0.7 / view.zoom;
  pts.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // Label nome percorso sul primo punto (se zoom sufficiente)
  if (n > 0 && view.zoom > 0.3) {
    const fp = pts[0];
    ctx.save();
    ctx.translate(fp.x, fp.y);
    ctx.scale(1, -1);
    ctx.fillStyle = color;
    ctx.font = (11 / view.zoom) + 'px JetBrains Mono, monospace';
    ctx.fillText(path.name, POINT_R / view.zoom + 2 / view.zoom, -4 / view.zoom);
    ctx.restore();
  }
}

function drawZoomRect(isErase) {
  const x0 = zoomRect.sx, y0 = zoomRect.sy;
  const x1 = mouseWorld._sx !== undefined ? mouseWorld._sx : x0;
  const y1 = mouseWorld._sy !== undefined ? mouseWorld._sy : y0;
  const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
  const rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);

  const stroke = isErase ? 'rgba(255,68,68,0.9)'  : 'rgba(74,222,128,0.9)';
  const fill   = isErase ? 'rgba(255,68,68,0.08)' : 'rgba(74,222,128,0.06)';

  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.fillStyle = fill;
  ctx.fillRect(rx, ry, rw, rh);
  ctx.setLineDash([]);
  ctx.restore();
}

function drawGrid(W, H) {
  const step    = GRID_STEP * view.zoom;
  const offsetX = (( view.panX % step) + step) % step;
  const offsetY = ((-view.panY % step) + step) % step;

  ctx.strokeStyle = 'rgba(0,229,255,0.045)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  for (let x = offsetX; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = offsetY; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  const origin = worldToScreen(0, 0);
  ctx.strokeStyle = 'rgba(0,229,255,0.12)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(origin.x, 0); ctx.lineTo(origin.x, H);
  ctx.moveTo(0, origin.y); ctx.lineTo(W, origin.y);
  ctx.stroke();
}

function drawChain() {
  const pts = state.points;
  const n   = pts.length;
  if (n < 2) return;

  const segCount = state.closed ? n : n - 1;

  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];

    const isHovered     = (i === hoveredSegIdx);
    const isSplitTarget = (currentTool === 'split' && i === hoveredSegIdx);

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = isSplitTarget
      ? 'rgba(74,222,128,0.9)'
      : (isHovered ? 'rgba(255,107,53,0.85)' : 'rgba(0,229,255,0.45)');
    ctx.lineWidth = (isHovered ? 2.5 : 1.5) / view.zoom;
    ctx.stroke();
  }

  if (currentTool === 'split' && ghostPoint !== null) {
    const gr = (POINT_R_HOVER + 2) / view.zoom;
    ctx.beginPath();
    ctx.arc(ghostPoint.x, ghostPoint.y, gr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(74,222,128,0.55)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ghostPoint.x, ghostPoint.y, gr + 4 / view.zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(74,222,128,0.3)';
    ctx.lineWidth   = 1.5 / view.zoom;
    ctx.stroke();
  }
}

function drawPoints() {
  state.points.forEach(p => {
    const isSelected = p.id === state.selectedId;
    const isHovered  = isNearPoint(mouseWorld.x, mouseWorld.y, p);
    const r = (isHovered || isSelected) ? POINT_R_HOVER / view.zoom : POINT_R / view.zoom;

    if (isSelected) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4 / view.zoom, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,229,255,0.25)';
      ctx.lineWidth   = 1.5 / view.zoom;
      ctx.stroke();
    }

    const insideEraseRect = (currentTool === 'erase' && zoomRect !== null)
      ? isPointInEraseRect(p) : false;

    let fill = '#00e5ff';
    if (insideEraseRect)                           fill = '#ff4444';
    else if (isHovered && currentTool === 'erase') fill = '#ff4444';
    else if (isHovered)                            fill = '#ffaa00';
    if (isSelected) fill = '#ffffff';

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    if (view.zoom > 0.5) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(1, -1);
      ctx.fillStyle = 'rgba(200,208,224,0.6)';
      ctx.font = (10 / view.zoom) + 'px JetBrains Mono, monospace';
      ctx.fillText('#' + p.id, r + 3 / view.zoom, -3 / view.zoom);
      ctx.restore();
    }
  });
}

// -- Hit testing ---------------------------------------------------------------

function isNearPoint(wx, wy, p) {
  return Math.hypot(wx - p.x, wy - p.y) < (POINT_R_HOVER + 2) / view.zoom;
}

function hitTestPoint(wx, wy) {
  let closest = null;
  let minDist = Infinity;
  const threshold = (POINT_R_HOVER + 4) / view.zoom;
  state.points.forEach(p => {
    const d = Math.hypot(wx - p.x, wy - p.y);
    if (d < threshold && d < minDist) { minDist = d; closest = p; }
  });
  return closest;
}

function hitTestSegment(wx, wy) {
  const pts = state.points;
  const n   = pts.length;
  if (n < 2) return -1;

  const threshold = 6 / view.zoom;
  const segCount  = state.closed ? n : n - 1;
  let closest = -1;
  let minDist = Infinity;

  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const d = pointToSegmentDist(wx, wy, a.x, a.y, b.x, b.y);
    if (d < threshold && d < minDist) { minDist = d; closest = i; }
  }
  return closest;
}

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function projectOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: ax, y: ay };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return { x: +(ax + t * dx).toFixed(4), y: +(ay + t * dy).toFixed(4) };
}

function isPointInEraseRect(p) {
  if (!zoomRect || mouseWorld._sx === undefined) return false;
  const minSx = Math.min(zoomRect.sx, mouseWorld._sx);
  const maxSx = Math.max(zoomRect.sx, mouseWorld._sx);
  const minSy = Math.min(zoomRect.sy, mouseWorld._sy);
  const maxSy = Math.max(zoomRect.sy, mouseWorld._sy);
  const ps = worldToScreen(p.x, p.y);
  return ps.x >= minSx && ps.x <= maxSx && ps.y >= minSy && ps.y <= maxSy;
}

// -- Mouse events --------------------------------------------------------------

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  mouseWorld     = screenToWorld(sx, sy);
  mouseWorld._sx = sx;
  mouseWorld._sy = sy;

  document.getElementById('cursorPos').textContent =
    mouseWorld.x.toFixed(3) + ', ' + mouseWorld.y.toFixed(3);

  if (currentTool === 'add' && !e.buttons) {
    document.getElementById('inputX').value = +mouseWorld.x.toFixed(4);
    document.getElementById('inputY').value = +mouseWorld.y.toFixed(4);
  }

  if (isPanning) {
    view.panX = panStart.px + (e.clientX - panStart.mx);
    view.panY = panStart.py + (e.clientY - panStart.my);
  }

  if (isDragging && dragId !== null) {
    dragHasMoved = true;
    const pt = state.points.find(p => p.id === dragId);
    if (pt) {
      pt.x = parseFloat((mouseWorld.x - dragOffsetX).toFixed(4));
      pt.y = parseFloat((mouseWorld.y - dragOffsetY).toFixed(4));
      document.getElementById('inputX').value = pt.x;
      document.getElementById('inputY').value = pt.y;
    }
  }

  if (currentTool === 'select' && !isPanning) {
    const hit = hitTestPoint(mouseWorld.x, mouseWorld.y);
    canvas.style.cursor = isDragging ? 'grabbing' : (hit ? 'grab' : 'default');
  }

  if (currentTool === 'erase' && zoomRect !== null) {
    canvas.style.cursor = 'crosshair';
  }

  if (currentTool === 'select' && !isDragging) {
    hoveredSegIdx = hitTestSegment(mouseWorld.x, mouseWorld.y);
    ghostPoint    = null;
  } else if (currentTool === 'split') {
    hoveredSegIdx = hitTestSegment(mouseWorld.x, mouseWorld.y);
    if (hoveredSegIdx >= 0) {
      const n = state.points.length;
      const a = state.points[hoveredSegIdx];
      const b = state.points[(hoveredSegIdx + 1) % n];
      ghostPoint = projectOnSegment(mouseWorld.x, mouseWorld.y, a.x, a.y, b.x, b.y);
    } else {
      ghostPoint = null;
    }
  } else {
    hoveredSegIdx = -1;
    ghostPoint    = null;
  }

  render();
});

canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const w    = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    isPanning = true;
    panStart  = { mx: e.clientX, my: e.clientY, px: view.panX, py: view.panY };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  if (e.button === 0) {
    if (currentTool === 'add') {
      const hit = hitTestPoint(w.x, w.y);
      if (hit) {
        state.selectedId = hit.id;
        updateSidebar();
        render();
      } else {
        addPointAt(+w.x.toFixed(4), +w.y.toFixed(4));
      }
    } else if (currentTool === 'select') {
      const hit = hitTestPoint(w.x, w.y);
      if (hit) {
        isDragging   = true;
        dragId       = hit.id;
        dragOffsetX  = w.x - hit.x;
        dragOffsetY  = w.y - hit.y;
        dragHasMoved = false;
        dragBefore   = snapState();
        state.selectedId = hit.id;
        canvas.style.cursor = 'grabbing';
        updateSidebar();
        render();
      } else {
        state.selectedId = null;
        updateSidebar();
        render();
      }
    } else if (currentTool === 'split') {
      const segIdx = hitTestSegment(w.x, w.y);
      if (segIdx >= 0) {
        const n  = state.points.length;
        const a  = state.points[segIdx];
        const b  = state.points[(segIdx + 1) % n];
        const pt = projectOnSegment(w.x, w.y, a.x, a.y, b.x, b.y);
        splitSegment(segIdx, pt.x, pt.y);
      }
    } else if (currentTool === 'zoom') {
      const canvasRect = canvas.getBoundingClientRect();
      zoomRect = { sx: e.clientX - canvasRect.left, sy: e.clientY - canvasRect.top };
      canvas.style.cursor = 'crosshair';
    } else if (currentTool === 'erase') {
      const hit = hitTestPoint(w.x, w.y);
      if (hit) {
        erasePoint(hit.id);
      } else {
        const canvasRect = canvas.getBoundingClientRect();
        zoomRect = { sx: e.clientX - canvasRect.left, sy: e.clientY - canvasRect.top };
      }
    }
  }
});

canvas.addEventListener('mouseup', async e => {
  if (currentTool === 'erase' && zoomRect !== null && e.button === 0) {
    const canvasRect = canvas.getBoundingClientRect();
    const ex = e.clientX - canvasRect.left;
    const ey = e.clientY - canvasRect.top;
    const rw = Math.abs(ex - zoomRect.sx);
    const rh = Math.abs(ey - zoomRect.sy);

    if (rw > 4 && rh > 4) {
      const toDelete = state.points.filter(p => isPointInEraseRect(p)).map(p => p.id);
      if (toDelete.length > 0) await erasePointSet(toDelete);
    }
    zoomRect = null;
    render();
    return;
  }

  if (currentTool === 'zoom' && zoomRect !== null && e.button === 0) {
    const canvasRect = canvas.getBoundingClientRect();
    const ex   = e.clientX - canvasRect.left;
    const ey   = e.clientY - canvasRect.top;
    const minSx = Math.min(zoomRect.sx, ex), maxSx = Math.max(zoomRect.sx, ex);
    const minSy = Math.min(zoomRect.sy, ey), maxSy = Math.max(zoomRect.sy, ey);
    if (maxSx - minSx > 4 && maxSy - minSy > 4) {
      applyZoomWindow(minSx, minSy, maxSx, maxSy);
    }
    zoomRect = null;
    render();
    return;
  }

  if (isPanning) {
    isPanning = false;
    canvas.style.cursor = currentTool === 'add' ? 'crosshair' : 'default';
  }

  if (isDragging) {
    isDragging = false;
    canvas.style.cursor = 'grab';

    if (dragHasMoved && dragId !== null) {
      const pt = state.points.find(p => p.id === dragId);
      if (pt) {
        try {
          await apiPost('/api/path/point/' + pt.id + '/move', { x: pt.x, y: pt.y });
          pushUndo(dragBefore);
          commitUndo();
          syncActiveToMulti();
          updateSidebar();
        } catch (err) {
          toast('Errore salvataggio posizione: ' + err.message, true);
        }
      }
    }

    dragId       = null;
    dragBefore   = null;
    dragHasMoved = false;
  }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect   = canvas.getBoundingClientRect();
  const sx     = e.clientX - rect.left;
  const sy     = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.1 : 0.909;

  view.panX = sx - (sx - view.panX) * factor;
  view.panY = sy - (sy - view.panY) * factor;
  view.zoom = view.zoom * factor;

  render();
}, { passive: false });

canvas.addEventListener('contextmenu', e => e.preventDefault());

// -- Tool switching ------------------------------------------------------------

function setTool(tool) {
  currentTool   = tool;
  hoveredSegIdx = -1;
  ghostPoint    = null;
  zoomRect      = null;

  document.getElementById('toolAdd').classList.toggle('active',    tool === 'add');
  document.getElementById('toolSelect').classList.toggle('active', tool === 'select');
  document.getElementById('toolSplit').classList.toggle('active',  tool === 'split');
  document.getElementById('toolZoom').classList.toggle('active',   tool === 'zoom');
  document.getElementById('toolErase').classList.toggle('active',  tool === 'erase');

  const labels  = { add: 'AGGIUNGI', select: 'SELEZIONA', split: 'SPEZZA',
                    zoom: 'ZOOM FINESTRA', erase: 'CANCELLA' };
  document.getElementById('modeLbl').textContent = labels[tool] || tool.toUpperCase();

  const cursors = { add: 'crosshair', select: 'default', split: 'crosshair',
                    zoom: 'crosshair', erase: 'cell' };
  canvas.style.cursor = cursors[tool] || 'default';

  const hints = {
    add:    'Click su vuoto = nuovo punto &nbsp;|&nbsp; Scroll = zoom &nbsp;|&nbsp; Alt+drag = pan',
    select: 'Drag punto = sposta &nbsp;|&nbsp; Click = seleziona &nbsp;|&nbsp; Del = elimina &nbsp;|&nbsp; Alt+drag = pan',
    split:  'Hover segmento = anteprima punto &nbsp;|&nbsp; Click segmento = inserisci punto intermedio',
    zoom:   'Trascina per definire la finestra di zoom &nbsp;|&nbsp; Scroll = zoom &nbsp;|&nbsp; Alt+drag = pan',
    erase:  'Click su punto = cancella &nbsp;|&nbsp; Trascina su vuoto = rettangolo selezione &nbsp;|&nbsp; Ctrl+Z = annulla',
  };
  document.getElementById('hintText').innerHTML = hints[tool] || '';
}

document.getElementById('toolAdd').addEventListener('click',    () => setTool('add'));
document.getElementById('toolSelect').addEventListener('click', () => setTool('select'));
document.getElementById('toolSplit').addEventListener('click',  () => setTool('split'));
document.getElementById('toolZoom').addEventListener('click',   () => setTool('zoom'));
document.getElementById('toolErase').addEventListener('click',  () => setTool('erase'));

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }

  if (!e.ctrlKey && !e.metaKey) {
    if (e.key === 'a' || e.key === 'A') setTool('add');
    if (e.key === 's' || e.key === 'S') setTool('select');
    if (e.key === 'x' || e.key === 'X') setTool('split');
    if (e.key === 'z' || e.key === 'Z') setTool('zoom');
    if (e.key === 'd' || e.key === 'D') setTool('erase');
    if (e.key === 'r' || e.key === 'R') zoomReset();
  }

  if (e.key === 'Escape') {
    state.selectedId = null;
    render();
    updateSidebar();
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
    deletePoint(state.selectedId);
  }
});

// -- API helpers ---------------------------------------------------------------

async function apiPost(url, body) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPut(url, body) {
  const res = await fetch(url, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPatch(url, body) {
  const res = await fetch(url, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiDelete(url) {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// -- Sync helpers --------------------------------------------------------------

/**
 * Copia i dati del percorso attivo da state -> multiState.paths.
 * Chiamata dopo ogni operazione di editing sul percorso attivo.
 */
function syncActiveToMulti() {
  const ap = multiState.paths.find(p => p.id === multiState.activePathId);
  if (!ap) return;
  ap.points = state.points.map(p => ({ ...p }));
  ap.closed = state.closed;
}

/**
 * Carica il percorso attivo da multiState -> state.
 * Chiamata dopo aver cambiato activePathId.
 */
function loadActiveFromMulti() {
  const ap = multiState.paths.find(p => p.id === multiState.activePathId);
  if (!ap) {
    state.points     = [];
    state.closed     = false;
    state.selectedId = null;
    return;
  }
  state.points     = ap.points.map(p => ({ ...p }));
  state.closed     = ap.closed;
  state.selectedId = null;
}

// -- Caricamento iniziale ------------------------------------------------------

async function loadStateFromServer() {
  const data = await fetch('/api/path/paths/fullstate').then(r => r.json());
  multiState.paths        = data.paths || [];
  multiState.activePathId = data.activePathId || null;
  loadActiveFromMulti();
  if (state.points.length > 0) fitView();
  updateUI();
}

// -- Point operations ----------------------------------------------------------

async function addPointAt(x, y) {
  const before = snapState();
  try {
    const data = await apiPost('/api/path/point', { x, y });
    state.points.push(data.point);
    state.selectedId = data.point.id;
    pushUndo(before);
    commitUndo();
    syncActiveToMulti();
    updateUI();
    toast('Punto #' + data.point.id + ' aggiunto (' + x + ', ' + y + ')');
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

async function addPointFromInputs() {
  const x = parseFloat(document.getElementById('inputX').value);
  const y = parseFloat(document.getElementById('inputY').value);
  if (isNaN(x) || isNaN(y)) { toast('Inserisci coordinate X e Y valide', true); return; }
  await addPointAt(x, y);
}

async function deletePoint(id) {
  const before = snapState();
  try {
    await apiDelete('/api/path/point/' + id);
    state.points = state.points.filter(p => p.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    pushUndo(before);
    commitUndo();
    syncActiveToMulti();
    updateUI();
    toast('Punto #' + id + ' eliminato');
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

async function erasePoint(id) {
  const before = snapState();
  try {
    await apiDelete('/api/path/point/' + id);
    state.points = state.points.filter(p => p.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    pushUndo(before);
    commitUndo();
    syncActiveToMulti();
    updateUI();
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

async function erasePointSet(ids) {
  if (!ids.length) return;
  const before = snapState();
  try {
    for (const id of ids) {
      await apiDelete('/api/path/point/' + id);
    }
    state.points = state.points.filter(p => !ids.includes(p.id));
    if (ids.includes(state.selectedId)) state.selectedId = null;
    pushUndo(before);
    commitUndo();
    syncActiveToMulti();
    updateUI();
    toast(ids.length + ' punt' + (ids.length === 1 ? 'o' : 'i') +
          ' eliminat' + (ids.length === 1 ? 'o' : 'i'));
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

async function splitSegment(segIdx, x, y) {
  const before = snapState();
  try {
    const data = await apiPost('/api/path/point', { x, y, afterIndex: segIdx });
    state.points.splice(segIdx + 1, 0, data.point);
    state.selectedId = data.point.id;
    ghostPoint = null;
    pushUndo(before);
    commitUndo();
    syncActiveToMulti();
    updateUI();
    toast('Segmento spezzato: nuovo punto #' + data.point.id + ' (' + x + ', ' + y + ')');
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

// -- Closed toggle -------------------------------------------------------------

async function toggleClosed() {
  const newVal = !state.closed;
  try {
    await apiPatch('/api/path/closed', { closed: newVal });
    state.closed = newVal;
    syncActiveToMulti();
    updateClosedButton();
    updateSegmentCount();
    render();
    toast(newVal ? 'Percorso chiuso' : 'Percorso aperto');
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

function updateClosedButton() {
  const btn = document.getElementById('btnClosed');
  if (state.closed) {
    btn.textContent       = 'Apri percorso';
    btn.style.borderColor = '#a78bfa';
    btn.style.color       = '#a78bfa';
  } else {
    btn.textContent       = 'Chiudi percorso';
    btn.style.borderColor = '';
    btn.style.color       = '';
  }
}

function updateSegmentCount() {
  const n        = state.points.length;
  const segCount = n < 2 ? 0 : (state.closed ? n : n - 1);
  document.getElementById('statSegs').textContent = segCount;
}

// -- Multi-path operations -----------------------------------------------------

/**
 * Crea un nuovo percorso vuoto sul server e lo rende attivo.
 */
async function newPath() {
  const name   = prompt('Nome del nuovo percorso:', 'Percorso ' + (multiState.paths.length + 1));
  if (!name) return;
  const before = snapState();
  try {
    const data = await apiPost('/api/path/paths', { name });
    multiState.paths.push({ ...data.path, points: [] });
    multiState.activePathId = data.activePathId;
    loadActiveFromMulti();
    pushUndo(before);
    commitUndo();
    updateUI();
    toast('Nuovo percorso: ' + name);
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

/**
 * Attiva un percorso esistente per l'editing.
 */
async function activatePath(pid) {
  if (pid === multiState.activePathId) return;
  try {
    await apiPut('/api/path/paths/active', { pathId: pid });
    multiState.activePathId = pid;
    loadActiveFromMulti();
    updateUI();
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

/**
 * Rinomina un percorso (prompt inline).
 */
async function renamePath(pid) {
  const path = multiState.paths.find(p => p.id === pid);
  if (!path) return;
  const newName = prompt('Rinomina percorso:', path.name);
  if (!newName || newName === path.name) return;
  try {
    await apiPatch('/api/path/paths/' + pid, { name: newName });
    path.name = newName;
    updatePathList();
    toast('Percorso rinominato: ' + newName);
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

/**
 * Elimina un percorso (con conferma).
 */
async function deletePath(pid) {
  const path = multiState.paths.find(p => p.id === pid);
  if (!path) return;
  if (!confirm('Eliminare il percorso "' + path.name + '"?')) return;

  const before = snapState();
  try {
    const data = await apiDelete('/api/path/paths/' + pid);
    multiState.paths = multiState.paths.filter(p => p.id !== pid);
    multiState.activePathId = data.activePathId;
    loadActiveFromMulti();
    pushUndo(before);
    commitUndo();
    updateUI();
    toast('Percorso "' + path.name + '" eliminato');
  } catch (err) {
    toast('Errore: ' + err.message, true);
  }
}

/**
 * Scarica il CSV di un percorso specifico.
 */
function savePathCsv(pid) {
  window.location.href = '/api/path/paths/' + pid + '/save';
  toast('Download CSV avviato');
}

/**
 * Carica un CSV come nuovo percorso aggiuntivo (non sostituisce).
 */
function loadPathCsv() {
  document.getElementById('fileInputAdd').click();
}

// -- UI update -----------------------------------------------------------------

function updateUI() {
  updatePathList();
  updateSidebar();
  updateClosedButton();
  render();
}

function updatePathList() {
  const list = document.getElementById('pathList');
  list.innerHTML = '';

  multiState.paths.forEach(path => {
    const isActive = path.id === multiState.activePathId;
    const color    = pathColor(path.id);

    const item = document.createElement('div');
    item.className = 'path-item' + (isActive ? ' active' : '');
    item.style.setProperty('--path-color', color);

    item.innerHTML =
      '<span class="path-dot"></span>' +
      '<span class="path-name">' + escHtml(path.name) + '</span>' +
      '<span class="path-count">' + path.points.length + 'pt</span>' +
      '<button class="path-btn" data-action="rename" title="Rinomina">&#x270E;</button>' +
      '<button class="path-btn" data-action="save"   title="Salva CSV">&#x2193;</button>' +
      '<button class="path-btn path-btn-del" data-action="delete" title="Elimina">&#xD7;</button>';

    // Click sulla riga = attiva il percorso
    item.addEventListener('click', e => {
      if (e.target.dataset.action) return;   // gestito dai bottoni
      activatePath(path.id);
    });

    item.querySelector('[data-action="rename"]').addEventListener('click', () => renamePath(path.id));
    item.querySelector('[data-action="save"]').addEventListener('click',   () => savePathCsv(path.id));
    item.querySelector('[data-action="delete"]').addEventListener('click', () => deletePath(path.id));

    list.appendChild(item);
  });
}

function updateSidebar() {
  const list = document.getElementById('pointList');
  list.innerHTML = '';

  state.points.forEach(p => {
    const item = document.createElement('div');
    item.className = 'point-item' + (p.id === state.selectedId ? ' selected' : '');
    item.innerHTML =
      '<span class="pt-id">#' + p.id + '</span>' +
      '<span class="pt-coords">' + p.x.toFixed(4) + ', ' + p.y.toFixed(4) + '</span>' +
      '<button class="pt-del" title="Elimina">&#xD7;</button>';

    item.addEventListener('click', e => {
      if (e.target.classList.contains('pt-del')) return;
      state.selectedId = p.id;
      centerOnPoint(p);
      updateUI();
    });
    item.querySelector('.pt-del').addEventListener('click', () => deletePoint(p.id));
    list.appendChild(item);
  });

  document.getElementById('ptCount').textContent  = state.points.length;
  document.getElementById('statPts').textContent   = state.points.length;
  updateSegmentCount();
}

function centerOnPoint(p) {
  view.panX = canvas.width  / 2 - p.x * view.zoom;
  view.panY = canvas.height / 2 + p.y * view.zoom;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// -- File I/O ------------------------------------------------------------------

// Carica CSV nel percorso attivo (comportamento legacy - sostituisce i punti)
document.getElementById('btnLoad').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/path/load', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(await res.text());
    const s = await res.json();
    state.points     = s.points;
    state.closed     = s.closed;
    state.selectedId = null;
    syncActiveToMulti();
    // Aggiorna anche il nome nella lista
    const ap = multiState.paths.find(p => p.id === multiState.activePathId);
    if (ap) updatePathList();
    fitView();
    updateUI();
    toast('Caricati ' + s.points.length + ' punti da ' + file.name);
  } catch (err) {
    toast('Errore caricamento: ' + err.message, true);
  }
  e.target.value = '';
});

// Carica CSV come NUOVO percorso aggiuntivo
document.getElementById('fileInputAdd').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/path/paths/load', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    multiState.paths.push(data.path);
    multiState.activePathId = data.activePathId;
    loadActiveFromMulti();
    fitView();
    updateUI();
    toast('Aggiunto percorso "' + data.path.name + '" (' + data.path.points.length + ' punti)');
  } catch (err) {
    toast('Errore caricamento: ' + err.message, true);
  }
  e.target.value = '';
});

document.getElementById('btnSave').addEventListener('click', () => {
  window.location.href = '/api/path/save';
  toast('Download CSV avviato');
});

document.getElementById('btnNewPath').addEventListener('click', newPath);
document.getElementById('btnLoadPath').addEventListener('click', loadPathCsv);

document.getElementById('btnClear').addEventListener('click', async () => {
  if (!confirm('Svuotare il disegno? Tutti i percorsi saranno eliminati.')) return;
  await apiDelete('/api/path/clear');
  multiState.paths        = [];
  multiState.activePathId = null;
  state.points            = [];
  state.closed            = false;
  state.selectedId        = null;
  updateUI();
  toast('Disegno svuotato');
});

document.getElementById('btnClosed').addEventListener('click',    toggleClosed);
document.getElementById('btnUndo').addEventListener('click',      undo);
document.getElementById('btnRedo').addEventListener('click',      redo);
document.getElementById('btnZoomReset').addEventListener('click', zoomReset);
document.getElementById('btnAddPoint').addEventListener('click',  addPointFromInputs);
document.getElementById('inputY').addEventListener('keydown', e => {
  if (e.key === 'Enter') addPointFromInputs();
});

// -- Viewport ------------------------------------------------------------------

function applyZoomWindow(minSx, minSy, maxSx, maxSy) {
  const W  = canvas.width, H = canvas.height;
  const rw = maxSx - minSx, rh = maxSy - minSy;
  const newZoom = Math.min(W / rw, H / rh) * view.zoom;
  const cx = (minSx + maxSx) / 2, cy = (minSy + maxSy) / 2;
  const wc = screenToWorld(cx, cy);
  view.zoom = newZoom;
  view.panX = W / 2 - wc.x * newZoom;
  view.panY = H / 2 + wc.y * newZoom;
}

function zoomReset() {
  view.zoom = lastFitView.zoom;
  view.panX = lastFitView.panX;
  view.panY = lastFitView.panY;
  render();
  toast('Zoom reimpostato');
}

function fitView() {
  // Calcola il bounding box su TUTTI i percorsi visibili
  const allPts = multiState.paths.flatMap(p => p.points);
  const n = allPts.length;
  if (n === 0) return;

  const W = canvas.width, H = canvas.height, pad = 60;

  if (n === 1) {
    view.zoom = 1;
    view.panX = W / 2 - allPts[0].x;
    view.panY = H / 2 + allPts[0].y;
    lastFitView = { zoom: view.zoom, panX: view.panX, panY: view.panY };
    return;
  }

  const xs   = allPts.map(p => p.x);
  const ys   = allPts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX, rangeY = maxY - minY;

  let zoom;
  if      (rangeX === 0 && rangeY === 0) zoom = 1;
  else if (rangeX === 0)                 zoom = (H - pad * 2) / rangeY;
  else if (rangeY === 0)                 zoom = (W - pad * 2) / rangeX;
  else                                   zoom = Math.min((W - pad * 2) / rangeX, (H - pad * 2) / rangeY);

  view.zoom = zoom;
  view.panX = W / 2 - ((minX + maxX) / 2) * zoom;
  view.panY = H / 2 + ((minY + maxY) / 2) * zoom;
  lastFitView = { zoom: view.zoom, panX: view.panX, panY: view.panY };
}

// -- Toast ---------------------------------------------------------------------

let toastTimer;
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2800);
}

// -- Init ----------------------------------------------------------------------

resizeCanvas();

function initView() {
  view.panX = canvas.width  / 2;
  view.panY = canvas.height / 2;
  view.zoom = 1;
}
initView();
loadStateFromServer();
render();