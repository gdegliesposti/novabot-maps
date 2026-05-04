# Novabot Maps

Interactive Map Editor for NovaBot Maps

A graphical editor for creating and modifying polygon paths used by NovaBot lawn mowers. Built with Node.js and Express on the backend, and vanilla Canvas 2D on the frontend. The editor allows you to create, modify, and export chains of points connected by implicit segments, with support for both open and closed paths. It handles the CSV file format used by Novabot maps, which consist of simple coordinate pairs in meters relative to the origin (antenna).

---

## Project Structure

```
novabot-maps/
├── server.js        # Express entry point, serves static files and mounts API routes
├── pathRoutes.js    # REST API: point management, CSV handling, closed flag
├── public/
│   ├── index.html   # Single-page UI: header, canvas, side panel
│   └── editor.js    # Canvas editor: rendering, viewport, tools, undo/redo
├── data/
│   └── sample.csv   # Example CSV file
└── package.json
```

**Runtime dependencies:** `express`, `multer`, `csv-parse`, `csv-stringify`.

---

## Getting Started

```bash
npm install
npm start
# → http://localhost:3000
```

Custom port:
```bash
PORT=8080 node server.js
```

To use as a module in an existing server:
```js
const express = require('express');
const app = express();
app.use('/editor', require('./routes/pathRoutes'));
```

---

## Architecture

### Data Model

A path is an **ordered chain of points**. Segments are **implicit** in the array order: segment i connects `points[i]` to `points[i+1]`. If `closed = true`, there is also a closing segment `points[n-1] → points[0]`.

```
state = {
  points: [{ id, x, y }, ...],  // order = chain order
  closed: boolean                // default false = open path
}
```

There are no explicit segment objects: adding, removing, or moving a point automatically reconnects the chain without additional operations.

### Y-Axis Orientation

The Y-axis is oriented **upward** (standard mathematical convention). The flip is applied at the rendering layer via `ctx.scale(zoom, -zoom)`; CSV data uses standard mathematical coordinates and is not transformed.

### Viewport Transform

```
screen.x =  world.x * zoom + panX
screen.y = -world.y * zoom + panY   // Y flip
```

Pan and zoom are always calculated in screen coordinates and are independent of the flip. `fitView()` calculates optimal zoom and pan after each load and saves a `lastFitView` snapshot for resetting.

### Undo / Redo

Each modifying operation saves a snapshot `{ points, closed, selectedId }` before (`before`) and after (`after`). Undo and redo apply the respective snapshot via `POST /api/path/state`, synchronizing both local state and server. Stack is limited to 50 operations. A new operation after an undo clears the redoStack.

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/path/state | Current state `{ points, closed }` |
| POST | /api/path/state | Replace complete state (used by undo/redo) |
| POST | /api/path/point | Add a point `{ x, y, afterIndex? }` |
| DELETE | /api/path/point/:id | Remove a point (auto-reconnect) |
| POST | /api/path/point/:id/move | Move a point `{ x, y }` |
| PATCH | /api/path/closed | Toggle the closed flag `{ closed: bool }` |
| POST | /api/path/load | Upload CSV, reload points |
| GET | /api/path/save | Download CSV of current points |
| DELETE | /api/path/clear | Clear everything |

`POST /api/path/point` accepts optional `afterIndex`: omitted or `-1` appends to the end; with `afterIndex = i` inserts after `points[i]` (used by Split tool).

---

## CSV Format

The header `X,Y` is **optional** on both read and write.

When reading, the parser automatically detects whether the first row is a text header or numeric data. Column separator: comma. Decimal separator: period (guaranteed even in European locale environments).

```csv
0,0
100.5,50.25
200,0
```

Or with explicit header:

```csv
X,Y
0,0
100.5,50.25
200,0
```

CSV files always describe open paths (`closed = false`). To enable header writing, set `writeHeader = true` in `pathRoutes.js` in the `GET /api/path/save` route.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `A` | Add Point mode |
| `S` | Select / Move mode |
| `X` | Split Segment mode |
| `Z` | Window Zoom mode |
| `D` | Delete mode |
| `R` | Reset zoom |
| `Ctrl+Z` | Undo last operation |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo operation |
| `Del` / `Backspace` | Delete selected point |
| `Esc` | Deselect / cancel |
| Scroll | Zoom in/out centered on cursor (unlimited) |
| `Alt` + drag | Pan |
| Middle button + drag | Pan (alternative) |

---

## Tools

### Add (A)
Clicking on empty space adds a point **at the end** of the chain. Clicking on an existing point selects it without adding. Coordinates in the side panel follow the cursor in real time.

### Select (S)
Clicking a point selects it. Dragging moves it; the position is persisted to the server on release. Clicking empty space deselects. `Del` / `Backspace` deletes the selected point. Hovering over a segment highlights it in orange.

### Split (X)
Hovering over a segment shows a **green ghost point** projected perpendicularly from the cursor. Clicking inserts the point at the projected position, splitting the segment in two using `afterIndex`.

### Window Zoom (Z)
Drag a green dashed rectangle on the canvas. On release, the selected region is magnified to fill the entire viewport. The rectangle's center is converted to world coordinates and recentered.

### Delete (D)
**Click on a point**: deletes it immediately (one undo operation). **Drag on empty space**: draws a red dashed rectangle; contained points highlight in red during dragging. On release, all points within the rectangle are deleted in **a single undo operation**.

### Undo / Redo (Ctrl+Z / Ctrl+Y)
Covers all operations: adding, single deletion, rectangular deletion, drag movement, segment split. Limited to 50 operations.

### Reset Zoom (R)
Restores zoom and pan to the last `fitView` executed (post-load or post-clear). The snapshot is saved in `lastFitView`.

### Toggle Closed Path
Button in header: adds or removes the closing segment `points[n-1] → points[0]`. The `closed` flag is persisted to the server.

---

## Viewport Behavior

- **fitView**: calculated after each load and on server restore. Handles single point, collinear points (zero range on an axis), and the general case. No artificial zoom clamping.
- **Scroll zoom**: unlimited zoom, centered on cursor.
- **Grid**: grid lines remain anchored to the world origin even during pan and zoom, with correct offset for Y flip.
- **Point labels**: text is locally "un-flipped" with `ctx.scale(1, -1)` to prevent mirroring.

---

## Roadmap

### High Priority
- [ ] **Grid Snap** — optional point snapping to grid with configurable step; visual indicator for active grid
- [ ] **Closed Flag in CSV** — optional column or metadata to persist the open/closed flag in file
- [ ] **Ordered Insertion** — in Add mode, insert new point after selected point instead of always at the end

### Medium Priority
- [ ] **Point Snap** — cursor snapping to existing points within configurable threshold; useful for manually closing paths
- [ ] **Measurements** — length of each segment and total perimeter displayed directly on canvas
- [ ] **Inline Numeric Editing** — click coordinates in side panel to modify directly without dragging the point
- [ ] **Zoom Info in Status Bar** — show current zoom (e.g., "1:2.5") and cursor world coordinates with more decimals

### Low Priority / Future
- [ ] **Multi-Path** — management of multiple independent chains; anticipated structure: `{ paths: [{ id, points, closed }] }`
- [ ] **Disk Persistence** — automatic saving in JSON or SQLite in the `data/` folder (already planned in structure)
- [ ] **Multiple Sessions** — per-session state instead of global shared state (requires session middleware or client ID)
- [ ] **Vector Export** — download path as SVG or DXF
- [ ] **Path Simplification** — vertex reduction with Douglas-Peucker (`simplify-js` library compatible)
- [ ] **Path Offset** — expansion / reduction of closed paths while maintaining shape (`clipper-lib` library)