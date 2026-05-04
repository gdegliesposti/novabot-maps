# Novabot Maps

Interactive Map Editor for NovaBot maps

Editor grafico interattivo per mappe utilizzate dal tagliaerbe NovaBot.
L'editor consente di modificare percorsi poligonali, è costruito con Node.js +
Express sul backend e Canvas 2D vanilla JS sul frontend. Permette di creare,
modificare ed esportare catene di punti collegati da segmenti impliciti,
con supporto a percorsi aperti e chiusi. Gestisce il formato file utilizzato
dalle mappe di Novabot, composto da semplici file CSV di coppie di punti che
identificano coordinate in metri rispetto all'origine (antenna)

---

## Struttura del progetto

```
novabot-maps/
├── server.js        # Entry point Express, serve static e monta le API
├── pathRoutes.js    # REST API: gestione punti, CSV, flag closed
├── public/
│   ├── index.html   # UI single-page: header, canvas, pannello laterale
│   └── editor.js    # Canvas editor: rendering, viewport, tool, undo/redo
├── data/
│   └── sample.csv   # Esempio di file CSV
└── package.json
```

**Dipendenze runtime:** `express`, `multer`, `csv-parse`, `csv-stringify`.

---

## Avvio

```bash
npm install
npm start
# → http://localhost:3000
```

Porta custom:
```bash
PORT=8080 node server.js
```

Uso come modulo in un server esistente:
```js
const express = require('express');
const app = express();
app.use('/editor', require('./novabot-maps/pathRoutes'));
```

---

## Architettura

### Modello dati

Il percorso e' una **catena ordinata di punti**. I segmenti sono **impliciti**
nell'ordine dell'array: il segmento i collega `points[i]` a `points[i+1]`.
Se `closed = true` esiste anche il segmento di chiusura `points[n-1] → points[0]`.

```
state = {
  points: [{ id, x, y }, ...],  // ordine = ordine della catena
  closed: boolean                // default false = percorso aperto
}
```

Non esistono oggetti segmento espliciti: aggiungere, rimuovere o spostare
un punto riconnette automaticamente la catena senza operazioni aggiuntive.

### Asse Y

L'asse Y e' orientato **verso l'alto** (convenzione matematica standard).
Il flip viene applicato nel layer di rendering tramite `ctx.scale(zoom, -zoom)`;
i dati CSV usano coordinate matematiche standard e non subiscono trasformazioni.

### Viewport transform

```
screen.x =  world.x * zoom + panX
screen.y = -world.y * zoom + panY   // flip Y
```

Pan e zoom vengono calcolati sempre in coordinate schermo e sono indipendenti
dal flip. `fitView()` calcola zoom e pan ottimali dopo ogni caricamento e
salva uno snapshot `lastFitView` per il reset.

### Undo / Redo

Ogni operazione modificante salva uno snapshot `{ points, closed, selectedId }`
prima (`before`) e dopo (`after`). Undo e redo applicano il rispettivo snapshot
via `POST /api/path/state`, sincronizzando sia lo state locale che il server.
Stack limitato a 50 operazioni. Una nuova operazione dopo un undo svuota il
redoStack.

---

## REST API

| Metodo | Path | Descrizione |
|--------|------|-------------|
| GET | /api/path/state | Stato corrente `{ points, closed }` |
| POST | /api/path/state | Sostituisce lo stato completo (usato da undo/redo) |
| POST | /api/path/point | Aggiunge un punto `{ x, y, afterIndex? }` |
| DELETE | /api/path/point/:id | Rimuove un punto (riconnessione automatica) |
| POST | /api/path/point/:id/move | Sposta un punto `{ x, y }` |
| PATCH | /api/path/closed | Cambia il flag `{ closed: bool }` |
| POST | /api/path/load | Upload CSV, ricarica i punti |
| GET | /api/path/save | Download CSV dei punti correnti |
| DELETE | /api/path/clear | Svuota tutto |

`POST /api/path/point` accetta `afterIndex` opzionale: omesso o `-1` aggiunge
in coda; con `afterIndex = i` inserisce dopo `points[i]` (usato da Spezza).

---

## Formato CSV

Header `X,Y` **opzionale** in lettura e in scrittura.

In lettura il parser rileva automaticamente se la prima riga e' un header
testuale o un dato numerico. Separatore colonne: virgola. Separatore
decimale: punto (garantito anche in ambienti con locale europeo).

```csv
0,0
100.5,50.25
200,0
```

oppure con header esplicito:

```csv
X,Y
0,0
100.5,50.25
200,0
```

I file CSV descrivono sempre percorsi aperti (`closed = false`).
Per abilitare la scrittura dell'header impostare `writeHeader = true`
in `pathRoutes.js` nella route `GET /api/path/save`.

---

## Scorciatoie tastiera

| Tasto | Azione |
|-------|--------|
| `A` | Modalita' Aggiungi punto |
| `S` | Modalita' Seleziona / sposta |
| `X` | Modalita' Spezza segmento |
| `Z` | Modalita' Zoom a finestra |
| `D` | Modalita' Cancella |
| `R` | Zoom reset |
| `Ctrl+Z` | Annulla ultima operazione |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Ripristina operazione annullata |
| `Del` / `Backspace` | Elimina punto selezionato |
| `Esc` | Deseleziona / annulla |
| Scroll | Zoom in/out centrato sul cursore (nessun limite) |
| `Alt` + drag | Pan |
| Tasto centrale + drag | Pan alternativo |

---

## Strumenti

### Aggiungi (A)
Click su spazio vuoto aggiunge un punto **in coda** alla catena.
Click su un punto esistente lo seleziona senza aggiungere.
Le coordinate nel pannello laterale seguono il cursore in tempo reale.

### Seleziona (S)
Click su un punto lo seleziona. Drag lo sposta; la posizione viene
persistita sul server al rilascio. Click su spazio vuoto deseleziona.
`Del` / `Backspace` elimina il punto selezionato.
Hover su un segmento lo evidenzia in arancione.

### Spezza (X)
Hover su un segmento mostra un **punto fantasma verde** proiettato
perpendicolarmente dal cursore. Click inserisce il punto nella posizione
proiettata, spezzando il segmento in due tramite `afterIndex`.

### Zoom a finestra (Z)
Trascina un rettangolo verde tratteggiato sul canvas. Al rilascio la
porzione selezionata viene ingrandita per occupare l'intera viewport.
Il centro del rettangolo viene convertito in world coords e ricentrato.

### Cancella (D)
**Click su un punto**: lo cancella immediatamente (una operazione undo).
**Drag su spazio vuoto**: disegna un rettangolo rosso tratteggiato; i punti
contenuti si evidenziano in rosso durante il trascinamento. Al rilascio
tutti i punti nel rettangolo vengono cancellati in **un'unica operazione undo**.

### Undo / Redo (Ctrl+Z / Ctrl+Y)
Copre tutte le operazioni: aggiunta, eliminazione singola, cancellazione
rettangolare, spostamento drag, split segmento. Limite 50 operazioni.

### Zoom reset (R)
Ripristina zoom e pan all'ultimo `fitView` eseguito (post-caricamento
o post-clear). Lo snapshot e' salvato in `lastFitView`.

### Chiudi / Apri percorso
Pulsante nell'header: aggiunge o rimuove il segmento di chiusura
`points[n-1] → points[0]`. Il flag `closed` viene persistito sul server.

---

## Comportamento viewport

- **fitView**: calcolato dopo ogni caricamento e al restore da server.
  Gestisce punto singolo, punti collineari (range zero su un asse) e
  il caso generale. Nessun clamp artificiale sullo zoom.
- **Zoom scroll**: zoom infinito, centrato sul cursore.
- **Grid**: le linee della griglia rimangono ancorate all'origine world
  anche durante pan e zoom, con il corretto offset per il flip Y.
- **Label punti**: il testo viene "deflippato" localmente con
  `ctx.scale(1, -1)` per non risultare specchiato.

---

## Roadmap

### Priorita' alta
- [ ] **Snap a griglia** — aggancio opzionale dei punti alla griglia con
      passo configurabile; indicatore visivo della griglia attiva
- [ ] **closed nei CSV** — colonna o metadato opzionale per persistere
      il flag aperto/chiuso nel file
- [ ] **Inserimento ordinato** — in modalita' Aggiungi, inserire il nuovo
      punto dopo il punto selezionato invece che sempre in coda

### Priorita' media
- [ ] **Snap a punto** — aggancio del cursore ai punti esistenti entro
      una soglia configurabile; utile per chiudere percorsi manualmente
- [ ] **Misure** — lunghezza di ogni segmento e perimetro totale
      visualizzati direttamente sul canvas
- [ ] **Editing numerico inline** — click sulle coordinate nel pannello
      laterale per modificarle direttamente senza trascinare il punto
- [ ] **Info zoom nella status bar** — mostrare lo zoom corrente
      (es. "1:2.5") e le coordinate world del cursore con piu' decimali

### Priorita' bassa / future
- [ ] **Multi-percorso** — gestione di piu' catene indipendenti;
      struttura anticipata: `{ paths: [{ id, points, closed }] }`
- [ ] **Persistenza su disco** — salvataggio automatico in JSON o SQLite
      nella cartella `data/` (gia' prevista nella struttura)
- [ ] **Sessioni multiple** — stato per-sessione invece di stato globale
      condiviso (richiede session middleware o ID client)
- [ ] **Esportazione vettoriale** — download del percorso come SVG o DXF
- [ ] **Semplificazione percorso** — riduzione vertici con Douglas-Peucker
      (libreria `simplify-js` compatibile)
- [ ] **Offset percorso** — espansione / riduzione di percorsi chiusi
      mantenendo la forma (libreria `clipper-lib`)