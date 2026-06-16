# Text Grab Extension

A Chromium (Manifest V3) extension for improved copying of web content, with
handoff to the [Text Grab](https://github.com/TheJoeFin/Text-Grab) Windows app.

**Killer feature:** copy HTML tables *as tables*. The extension writes both a
clean HTML `<table>` and tab-separated text to the clipboard, so a single
paste lands as a real table in Excel, Google Sheets, LibreOffice Calc, or
Text Grab's spreadsheet mode — including merged (colspan/rowspan) cells.

## The one feature at launch: Select region

Click the toolbar icon, right-click → **Select region**, or press
`Alt+Shift+R`. A resizable, movable rectangle appears, anchored to the page
content (it stays over the same content while you scroll; drag the dimmed
backdrop to redraw it, drag the handles to resize, `Esc` cancels, `Enter`
confirms). Three modes:

- **Screenshot** — captures the region and opens it in Text Grab's Grab
  Frame for OCR. A region that fits on screen is captured in one shot; a
  region taller than the viewport is captured by scrolling it past the
  screen band by band and stitching the bands into one image (the same
  technique as full-page capture, bounded to the region). Regions *wider*
  than the viewport are still clipped to the screen width.
- **Direct Text** — copies the text of the HTML elements inside the region
  (words that cross the edge are clipped to the region). On a **PDF** the
  document is first re-opened in the extension's own pdf.js viewer, where the
  text is real DOM, so the same element walk applies — perfectly accurate, not
  OCR (see [PDF support](#pdf-support) below).
- **Table** — copies only the rows/columns of the table whose cells
  intersect the region, written to the clipboard as both a real HTML table
  and tab-separated text, so it pastes as a table into Excel, Google
  Sheets, LibreOffice, or Text Grab's spreadsheet mode — merged
  (colspan/rowspan) cells included. The shade tints exactly what will be
  captured. When the region holds no `<table>`, the mode tries two fallbacks
  in order:
  1. **Repeating structures** — a `<ul>`/`<ol>`, an ARIA `role="list"`/`feed`/
     `table`/`grid`, or a run of structurally similar `<div>` cards (the
     classic web "data record extraction" problem). Each repeated block the
     region touches becomes a row, and the fields inside it are aligned into
     columns by their position within the block, so ragged records (a list
     item missing one field) still line up with empty cells. The records that
     will be captured are tinted, so it's obvious the list was recognized.
  2. **Raw layout** — if it isn't a repeating structure either, it reconstructs
     a grid from the page *layout*: the bounding boxes of the text inside the
     region, grouped into rows and columns by position (handy for CSS grid/flex
     "tables" built from `<div>`s).

  On a **PDF** the same fallbacks run on the rendered text layer in the pdf.js
  viewer (see [PDF support](#pdf-support)).

  In **Table** mode, a small **Copy table** / **Copy list** button is also
  pinned to every data table and repeating list on the page (above the shade,
  so it stays clickable). Clicking one copies that *whole* structure in a single
  click — no dragging a region — and closes the selection; it honors the **Send
  to Text Grab** toggle just like a region copy. The buttons appear only in
  Table mode (switching to Screenshot or Direct Text hides them), so they are
  never part of what a region capture grabs.

For the **Direct Text** and **Table** modes the toolbar shows a
**Send to Text Grab** toggle. With it on, the result is still copied to the
clipboard but Text Grab is also opened for further refinement — the Edit
Text window for Direct Text, spreadsheet mode for Table. With it off the
result only goes to the clipboard. (Screenshot always opens Text Grab's
Grab Frame, so the toggle is hidden in that mode.)

The last-used mode and the toggle state are remembered.

## PDF support

The browser keeps rendering PDFs in its own built-in viewer, where the text
lives in an out-of-process plugin (not the page DOM) and there is no API for the
scroll position or zoom — so a region drawn over it can't be mapped to the text
reliably. Instead of fighting that, **starting a region selection on a PDF
re-opens it in the extension's own pdf.js viewer in a new tab.** This does not
take over PDF reading in general; it happens only when you invoke a grab.

1. The content script fetches the PDF bytes same-origin (so cookies/auth and
   the cache apply) and hands them to the service worker, which opens
   `viewer/viewer.html` in a new tab and serves the bytes to it. If the fetch
   fails, the viewer refetches the URL from its own origin as a fallback.
2. The viewer renders each page with **pdf.js** — a `<canvas>` plus a real,
   selectable DOM **text layer** positioned exactly over it. The text you see is
   the DOM, so there is a true 1:1 mapping between the rendered page and the
   embedded text. (Canvases render lazily on scroll; text layers render up front
   so every page is immediately grabbable.)
3. Region selection then runs against that DOM, so **Direct Text** and
   **Table** reuse the ordinary web paths (`lib/region-text.js` and
   `lib/region-grid.js`) unchanged — no screenshots, no registration, no
   guesswork. Because the user just asked to grab, the viewer starts a region
   selection automatically once the pages are rendered; the toolbar's **Select
   region** button (or `Alt+Shift+R`) starts another.

**Screenshot mode** works in the viewer too (useful for figures or
scanned/image-only PDFs with no text layer): it captures the rendered region and
hands it to Text Grab's Grab Frame, scrolling and stitching for tall regions
just like on a web page.

**Limitations.** The PDF must be fetchable (same-origin https, or a `file://`
PDF with "Allow access to file URLs" enabled). Only the first 300 pages are
rendered. Scanned/image-only PDFs have no text layer, so use Screenshot mode for
those.

## Right-click an image

Right-clicking an image adds two actions that hand the image to Text Grab:

- **Grab Text** — downloads the image and OCRs it straight to the
  clipboard (no window), via `text-grab://grab-text`.
- **Grab Frame** — downloads the image and opens it in Text Grab's Grab
  Frame for interactive OCR, via `text-grab://grab-frame`.

Decodable images are re-encoded to PNG so Text Grab can always read them;
formats that can't be decoded in the background (e.g. SVG) are saved with
their original bytes. The image is saved under `Downloads/TextGrab/`.

### Dormant capabilities

The codebase also implements full-table copy, clean-text and Markdown
selection copy, links/image extraction, and full-page stitched capture.
These are intentionally not surfaced in the v0.2 launch UI (no popup, single
context-menu item, single command) but remain message-reachable in
`content/content.js` and `background/service-worker.js`, ready to be
re-enabled.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Text Grab integration

Copy/paste works with any Text Grab version: copy a table here, then paste
into Text Grab's spreadsheet mode (it parses the HTML table from the
clipboard, including merged cells).

The one-click **Send to Text Grab** and **Capture full page** actions use the
`text-grab://` protocol, which requires a Text Grab build that registers the
protocol handler:

| URI | Action |
| --- | --- |
| `text-grab://paste-spreadsheet` | Edit Text window → spreadsheet mode → paste clipboard |
| `text-grab://edit-text` | Edit Text window with clipboard text |
| `text-grab://grab-frame?path=<url-encoded path>` | Grab Frame opening a local image/PDF |
| `text-grab://grab-text?path=<url-encoded path>` | OCR a local image/PDF straight to the clipboard (no window) |
| `text-grab://fullscreen` | Fullscreen grab |
| `text-grab://quick-lookup` | Quick Simple Lookup |
| `text-grab://settings` | Settings window |

Data never travels in the URI — the clipboard is the data channel and the
URI is only the command channel.

The first time the extension launches Text Grab, Chrome shows an
*"Open Text Grab?"* confirmation. Check **"Always allow"** to skip it on
that site in the future.

## Development notes

- Vanilla JS, no build step. The manifest injects only `content/content.js`
  (the bootstrap). Every other `lib/`/`content/`/`vendor/` script is a classic
  script that the service worker injects on demand via
  `chrome.scripting.executeScript`, each registering its API on the shared
  isolated-world namespace `globalThis.__TGX` (e.g. `TG.formats`,
  `TG.regionSelect`). Programmatic injection runs in the isolated world and is
  **not** subject to the page's Content-Security-Policy, so the extension works
  on strict-CSP sites (e.g. Reddit) where the previous
  `import(chrome.runtime.getURL(...))` loader was blocked. There is no
  `web_accessible_resources` — nothing is loaded by URL from the page, and
  shadow-root CSS is inlined in the relevant scripts.
- The bootstrap learns the shared constants (message types, `text-grab://`
  URIs, default settings) by asking the service worker over a `tg-constants`
  message, so `lib/messages.js` and `lib/settings.js` stay ES modules (the
  single source of truth) imported by the service worker, the options page,
  and the PDF viewer, and are never injected into a page.
- `vendor/turndown.js` and `vendor/turndown-plugin-gfm.js` are vendored
  single-file builds (MIT) patched to register `TG.TurndownService` /
  `TG.turndownPluginGfm` on the namespace.
- `vendor/pdf.mjs` and `vendor/pdf.worker.mjs` are the vendored pdf.js
  (pdfjs-dist, Apache-2.0) minified ESM builds. They are loaded only by
  `viewer/viewer.html` — an extension page in our own origin — so no
  `web_accessible_resources` entry is needed. That viewer renders the PDF to a
  canvas + DOM text layer; `viewer/viewer.js` reuses the shared `TG.*` region
  modules (loaded there as classic scripts) to grab against the rendered DOM.
  The service worker hands the bytes to it (`OPEN_PDF_VIEWER` / `GET_PDF_BYTES`
  in `background/service-worker.js`).
  - **Local patch (reapply on re-vendor):** `pdf.worker.mjs` has one
    `TG-PATCH`. Stock pdf.js throws `FormatError("invalid font name")` and
    drops any font whose `FontDescriptor` omits `/FontName` while the font dict
    omits `/BaseFont` — which silently yields an empty text layer. Some tools
    emit exactly that (e.g. Type 3 outline fonts in certain résumé/web-to-PDF
    exports), so the patch synthesizes a unique fallback name instead of
    throwing, letting the font's `/ToUnicode` + `CharProcs` load so text is
    still selectable/extractable. Find it by searching the file for `TG-PATCH`.
- Test fixtures live in `test-pages/` — open them as `file://` pages
  (enable "Allow access to file URLs" for the extension) or serve them with
  any static server:
  - `spans-table.html` — rowspan/colspan expansion, hidden rows, multi-line cells
  - `nested-table.html` — nested tables and `role="presentation"` skipping
  - `sticky-header.html` — sticky/fixed elements during full-page capture
  - `tall-page.html` — ~30,000 px page exercising the canvas downscale path
  - `layout-table.html` — CSS grid / flex "tables" with no `<table>`
    element, for the Table-mode layout-reconstruction fallback
  - `repeat-list.html` — a semantic issue list, an ARIA article feed, and a
    plain-`<div>` card grid, for Table mode's repeating-structure detection
    (`lib/repeat-detect.js`)

## Known limitations (v1)

- Tables inside iframes are not picked up (top frame only).
- PDFs are grabbed by re-opening them in the extension's pdf.js viewer (see
  [PDF support](#pdf-support)); the PDF must be fetchable and only the first
  300 pages are rendered. Scanned/image-only PDFs have no text layer — use
  Screenshot mode there.
- Full-page capture cannot stitch virtualized/infinite-scroll pages, and
  capture speed is limited to ~2 frames/second by the browser API.
- Pages taller than ~16,000 device pixels are downscaled to fit a single
  PNG.
