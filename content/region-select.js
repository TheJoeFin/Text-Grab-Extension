// Select-region control: a resizable, movable rectangle over the page with
// a mode toolbar (Screenshot / Direct Text / Table). Drag on the dimmed
// backdrop to draw a new rectangle; drag the rectangle to move it; drag a
// handle to resize. Esc cancels, Enter confirms.
//
// The rectangle is anchored to the PAGE (document coordinates), so it stays
// over the same content while scrolling; the confirmed rect is reported in
// page coordinates. Only the dimming backdrop is viewport-fixed.
//
// Lives in its own shadow host so capture flows can hide it independently
// of the rest of the extension UI.
//
// Classic script injected on demand; registers on the shared namespace. The
// shadow-root CSS is inlined here (rather than fetched) so it works on pages
// whose Content-Security-Policy would block fetching extension files.
(() => {
  const TG = (globalThis.__TGX ??= {});

  const HOST_TAG = 'text-grab-extension-region';
  const MIN_SIZE = 12;

  // Text Grab palette: Teal #308E98, DarkTeal #18474C, hover #1E595F,
  // pressed #071818 (mirrors Text-Grab/Styles/Colors.xaml + ButtonStyles.xaml)
  const REGION_CSS = `
:host {
  all: initial;
}

.tg-region-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  cursor: crosshair;
  background: transparent;
}

.tg-region-rect {
  position: absolute;
  z-index: 2147483646;
  border: 2px solid #308e98;
  cursor: move;
  box-sizing: border-box;
}

/* Screenshot mode dims the whole page outside the selection rectangle. */
.tg-region-rect.shade-rect {
  box-shadow: 0 0 0 100000px rgba(7, 24, 24, 0.4);
}

/* Direct Text / Table mode dims the whole page EXCEPT the text rects or table
   cells that will actually be captured, so it is obvious what is included: an
   SVG mask punches the included rects out of a full-document dim layer. */
.tg-region-shade {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2147483645;
  pointer-events: none;
}

.tg-region-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  background: #ffffff;
  border: 1.5px solid #308e98;
  border-radius: 2px;
  box-sizing: border-box;
}

.tg-region-handle.nw { top: -6px; left: -6px; cursor: nwse-resize; }
.tg-region-handle.n  { top: -6px; left: calc(50% - 5px); cursor: ns-resize; }
.tg-region-handle.ne { top: -6px; right: -6px; cursor: nesw-resize; }
.tg-region-handle.e  { top: calc(50% - 5px); right: -6px; cursor: ew-resize; }
.tg-region-handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }
.tg-region-handle.s  { bottom: -6px; left: calc(50% - 5px); cursor: ns-resize; }
.tg-region-handle.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
.tg-region-handle.w  { top: calc(50% - 5px); left: -6px; cursor: ew-resize; }

.tg-region-size {
  position: absolute;
  top: -26px;
  left: 0;
  padding: 2px 7px;
  border-radius: 4px;
  background: #18474c;
  color: #f0f0f0;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 11.5px;
  white-space: nowrap;
  pointer-events: none;
}

.tg-region-toolbar {
  position: absolute;
  z-index: 2147483647;
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 5px;
  background: #18474c;
  border: 1px solid #1e595f;
  border-radius: 8px;
  box-shadow: 0 4px 14px rgba(7, 24, 24, 0.45);
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 12.5px;
  cursor: default;
}

.tg-region-toolbar button {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: #f0f0f0;
  font: inherit;
  padding: 6px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.tg-region-toolbar button:hover {
  background: #1e595f;
}

.tg-region-toolbar button:active {
  background: #071818;
}

.tg-region-toolbar button.mode.active {
  background: #1e595f;
  border-color: #308e98;
}

.tg-region-toolbar .divider {
  width: 1px;
  align-self: stretch;
  background: #1e595f;
  margin: 0 2px;
}

.tg-region-toolbar .hidden {
  display: none;
}

.tg-region-toolbar button.tg-send {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
}

.tg-region-toolbar button.tg-send:hover {
  background: #1e595f;
}

.tg-region-toolbar button.tg-send .track {
  position: relative;
  flex: none;
  width: 34px;
  height: 18px;
  border-radius: 9px;
  background: #071818;
  box-sizing: border-box;
  transition: background 0.15s ease;
}

.tg-region-toolbar button.tg-send .track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #9fb7b9;
  transition: transform 0.15s ease, background 0.15s ease;
}

.tg-region-toolbar button.tg-send[aria-checked='true'] .track {
  background: #308e98;
}

.tg-region-toolbar button.tg-send[aria-checked='true'] .track::after {
  transform: translateX(16px);
  background: #ffffff;
}

.tg-region-toolbar button.confirm {
  background: #308e98;
  color: #ffffff;
  font-weight: 600;
}

.tg-region-toolbar button.confirm:hover {
  background: #3fa5b0;
}

.tg-region-toolbar button.confirm:active {
  background: #1e595f;
}

.tg-region-toolbar button.cancel {
  padding: 6px 8px;
}

/* Table-mode "Copy table / Copy list" hint pinned to each table or list on the
   page. Sits above the dim shade so it stays visible and clickable; one click
   copies the whole structure without dragging a region. */
.tg-region-hint {
  position: absolute;
  z-index: 2147483646;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  background: #18474c;
  border: 1px solid #308e98;
  border-radius: 7px;
  color: #f0f0f0;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(7, 24, 24, 0.5);
}

.tg-region-hint:hover {
  background: #308e98;
  color: #ffffff;
}

.tg-region-hint:active {
  background: #071818;
}

/* Preview of exactly what a hint will copy, shown while hovering it. Sits above
   the dim shade so it reads clearly even over dimmed page content. */
.tg-region-highlight {
  position: absolute;
  z-index: 2147483646;
  pointer-events: none;
  background: rgba(48, 142, 152, 0.22);
  border: 2px solid #308e98;
  border-radius: 3px;
  box-shadow: 0 0 0 2px rgba(48, 142, 152, 0.25);
}
`;

  let session = null; // active selection session

  /**
   * @param {{
   *   mode: 'screenshot'|'text'|'table',
   *   sendToTextGrab?: boolean,
   *   isWindows?: boolean,
   *   onConfirm: (mode: string, rect: {x:number,y:number,width:number,height:number}, sendToTextGrab: boolean) => void,
   *   onModeChange?: (mode: string) => void,
   *   onSendToggleChange?: (sendToTextGrab: boolean) => void,
   *   onCopyStructure?: (payload: { kind: 'table'|'list', table?: Element, set?: object, sendToTextGrab: boolean }) => void,
   * }} options rect is in page (document) CSS pixels.
   */
  function startRegionSelect({
    mode,
    sendToTextGrab,
    isWindows = true,
    onConfirm,
    onModeChange,
    onSendToggleChange,
    onCopyStructure,
  }) {
    cancelRegionSelect();

    const host = document.createElement(HOST_TAG);
    // absolute at the document origin so children in page coordinates land
    // exactly on the content they cover
    host.style.cssText = 'position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483645;';
    const root = host.attachShadow({ mode: 'closed' });

    const styleEl = document.createElement('style');
    styleEl.textContent = REGION_CSS;

    const backdrop = document.createElement('div');
    backdrop.className = 'tg-region-backdrop';

    // Page-anchored SVG (document origin) that dims everything except the text
    // rects / table cells the capture will include; sits below the selection
    // rect so its border/handles stay on top. Shown only in text/table modes.
    // A luminance mask (white = dimmed, black = clear) punches the included
    // rects out of a single full-document dim fill, so overlapping rects stay
    // clean rather than compounding their darkness.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const shadeMaskId = 'tg-region-shade-mask';
    const shade = document.createElementNS(SVG_NS, 'svg');
    shade.setAttribute('class', 'tg-region-shade');
    const shadeMaskBase = document.createElementNS(SVG_NS, 'rect'); // white: dim
    const shadeHoles = document.createElementNS(SVG_NS, 'g'); // black: cut-outs
    const shadeDim = document.createElementNS(SVG_NS, 'rect'); // the dim fill
    {
      const defs = document.createElementNS(SVG_NS, 'defs');
      const mask = document.createElementNS(SVG_NS, 'mask');
      mask.setAttribute('id', shadeMaskId);
      mask.setAttribute('maskUnits', 'userSpaceOnUse');
      shadeMaskBase.setAttribute('x', '0');
      shadeMaskBase.setAttribute('y', '0');
      shadeMaskBase.setAttribute('fill', 'white');
      mask.append(shadeMaskBase, shadeHoles);
      defs.append(mask);
      shadeDim.setAttribute('x', '0');
      shadeDim.setAttribute('y', '0');
      shadeDim.setAttribute('fill', '#071818');
      shadeDim.setAttribute('fill-opacity', '0.4');
      shadeDim.setAttribute('mask', `url(#${shadeMaskId})`);
      shade.append(defs, shadeDim);
    }

    const rectEl = document.createElement('div');
    rectEl.className = 'tg-region-rect';
    for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const handle = document.createElement('div');
      handle.className = `tg-region-handle ${dir}`;
      handle.dataset.dir = dir;
      rectEl.append(handle);
    }
    const sizeEl = document.createElement('div');
    sizeEl.className = 'tg-region-size';
    rectEl.append(sizeEl);

    const toolbar = document.createElement('div');
    toolbar.className = 'tg-region-toolbar';
    const modeDefs = [
      // Screenshot always hands off to the Text Grab desktop app, so it is only
      // offered on Windows; macOS/Linux keep the clipboard-only modes.
      { id: 'screenshot', label: 'Screenshot' },
      { id: 'text', label: 'Direct Text' },
      { id: 'table', label: 'Table' },
    ].filter((def) => isWindows || def.id !== 'screenshot');
    const modeButtons = new Map();
    for (const def of modeDefs) {
      const button = document.createElement('button');
      button.className = 'mode';
      button.textContent = def.label;
      button.addEventListener('click', () => setMode(def.id));
      modeButtons.set(def.id, button);
      toolbar.append(button);
    }
    // "Send to Text Grab" toggle: when on, Direct Text / Table results are
    // copied AND opened in Text Grab for further refinement; when off they
    // only go to the clipboard. Hidden in Screenshot mode, which always
    // hands off to Text Grab's Grab Frame regardless. Only built on Windows —
    // the desktop app and its text-grab:// protocol do not exist elsewhere.
    let divider = null;
    let sendToggle = null;
    if (isWindows) {
      divider = document.createElement('div');
      divider.className = 'divider';

      sendToggle = document.createElement('button');
      sendToggle.type = 'button';
      sendToggle.className = 'tg-send';
      sendToggle.setAttribute('role', 'switch');
      sendToggle.title =
        'Send the result to Text Grab for further refinement instead of only copying to the clipboard';
      const sendTrack = document.createElement('span');
      sendTrack.className = 'track';
      const sendLabel = document.createElement('span');
      sendLabel.className = 'label';
      sendLabel.textContent = 'Send to Text Grab';
      sendToggle.append(sendTrack, sendLabel);
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Cancel (Esc)';
    toolbar.append(...[divider, sendToggle, confirmBtn, cancelBtn].filter(Boolean));

    root.append(styleEl, backdrop, shade, rectEl, toolbar);
    document.documentElement.append(host);

    // Default rectangle: centered in the current viewport, ~55% x 40% of it,
    // expressed in page coordinates.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const docWidth = Math.max(document.documentElement.scrollWidth, vw);
    const docHeight = Math.max(document.documentElement.scrollHeight, vh);
    let rect = {
      x: Math.round(window.scrollX + vw * 0.225),
      y: Math.round(window.scrollY + vh * 0.3),
      width: Math.round(vw * 0.55),
      height: Math.round(vh * 0.4),
    };

    session = {
      host,
      mode: modeButtons.has(mode) ? mode : modeDefs[0].id,
      sendToTextGrab: !!sendToTextGrab,
      onKeyDown: null,
      cleanup: null,
    };

    function updateConfirmLabel() {
      if (session.mode === 'screenshot') confirmBtn.textContent = 'Capture';
      else if (session.sendToTextGrab) confirmBtn.textContent = 'Open in Text Grab';
      else confirmBtn.textContent = session.mode === 'text' ? 'Copy text' : 'Copy table';
    }

    function setMode(newMode) {
      session.mode = newMode;
      for (const [id, button] of modeButtons) button.classList.toggle('active', id === newMode);
      // Screenshot always goes to Text Grab — the toggle has no meaning there.
      const screenshot = newMode === 'screenshot';
      sendToggle?.classList.toggle('hidden', screenshot);
      divider?.classList.toggle('hidden', screenshot);
      // Screenshot dims outside the rectangle via the rect's own box-shadow;
      // text/table dim everything but the included content via the SVG mask.
      rectEl.classList.toggle('shade-rect', screenshot);
      shade.style.display = screenshot ? 'none' : '';
      updateConfirmLabel();
      scheduleHighlights();
      // Per-table/list copy hints are a Table-mode affordance only; other modes
      // capture whatever the rectangle covers, so the whole-structure shortcut
      // does not apply (and its buttons must not linger over the shade).
      renderTableHints();
      onModeChange?.(newMode);
    }

    function setSend(on) {
      session.sendToTextGrab = on;
      sendToggle?.setAttribute('aria-checked', on ? 'true' : 'false');
      updateConfirmLabel();
    }
    sendToggle?.addEventListener('click', () => {
      setSend(!session.sendToTextGrab);
      onSendToggleChange?.(session.sendToTextGrab);
    });

    function layout() {
      rect.x = Math.max(0, Math.min(rect.x, docWidth - MIN_SIZE));
      rect.y = Math.max(0, Math.min(rect.y, docHeight - MIN_SIZE));
      rect.width = Math.max(MIN_SIZE, Math.min(rect.width, docWidth - rect.x));
      rect.height = Math.max(MIN_SIZE, Math.min(rect.height, docHeight - rect.y));

      rectEl.style.left = `${rect.x}px`;
      rectEl.style.top = `${rect.y}px`;
      rectEl.style.width = `${rect.width}px`;
      rectEl.style.height = `${rect.height}px`;
      sizeEl.textContent = `${Math.round(rect.width)} x ${Math.round(rect.height)}`;
      sizeEl.style.display = rect.y < 30 ? 'none' : '';

      // Toolbar below the rectangle, or above when there is no room.
      const toolbarHeight = 44;
      const below = rect.y + rect.height + 8;
      toolbar.style.top =
        below + toolbarHeight <= docHeight
          ? `${below}px`
          : `${Math.max(8, rect.y - toolbarHeight - 8)}px`;
      const tbWidth = toolbar.offsetWidth || 330;
      toolbar.style.left = `${Math.max(8, Math.min(rect.x, docWidth - tbWidth - 8))}px`;

      scheduleHighlights();
    }

    // ---- capture preview tint ----
    // Mirror (approximately) what text/table capture will actually grab, so
    // the user sees which content is inside the rectangle. Recomputed lazily,
    // coalesced to one pass per animation frame to stay cheap during drags.

    let hitsRAF = null;
    let hintEls = [];
    let highlightEls = [];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME']);
    const MAX_HITS = 800; // guardrail for pathologically large selections
    const MAX_HINTS = 40; // keep a busy page legible

    // Match the dim layer to the document so the shade always covers the page.
    function sizeShade() {
      shade.setAttribute('width', docWidth);
      shade.setAttribute('height', docHeight);
      shadeMaskBase.setAttribute('width', docWidth);
      shadeMaskBase.setAttribute('height', docHeight);
      shadeDim.setAttribute('width', docWidth);
      shadeDim.setAttribute('height', docHeight);
    }

    function scheduleHighlights() {
      if (!session || session.mode === 'screenshot') {
        shadeHoles.replaceChildren();
        return;
      }
      if (hitsRAF != null) return;
      hitsRAF = requestAnimationFrame(() => {
        hitsRAF = null;
        renderHits(computeHits());
      });
    }

    // The selection rect lives in page coords; capture uses the viewport.
    function viewportRegion() {
      return {
        x: rect.x - window.scrollX,
        y: rect.y - window.scrollY,
        width: rect.width,
        height: rect.height,
      };
    }

    function hitIntersects(r, region) {
      if (r.width === 0 && r.height === 0) return false;
      return (
        r.left < region.x + region.width &&
        r.right > region.x &&
        r.top < region.y + region.height &&
        r.bottom > region.y
      );
    }

    // Clip a viewport rect to the region and convert to page coords, or null
    // if it falls outside / collapses.
    function clipToPage(r, region) {
      const left = Math.max(r.left, region.x);
      const top = Math.max(r.top, region.y);
      const right = Math.min(r.right, region.x + region.width);
      const bottom = Math.min(r.bottom, region.y + region.height);
      if (right - left < 1 || bottom - top < 1) return null;
      return {
        x: left + window.scrollX,
        y: top + window.scrollY,
        width: right - left,
        height: bottom - top,
      };
    }

    // Convert a viewport rect to page coords, clamped only to the document
    // bounds (not the region) — used for table cells, which are revealed in
    // full even where they reach outside the selection.
    function clampToPage(r) {
      const left = Math.max(0, r.left + window.scrollX);
      const top = Math.max(0, r.top + window.scrollY);
      const right = Math.min(docWidth, r.right + window.scrollX);
      const bottom = Math.min(docHeight, r.bottom + window.scrollY);
      if (right - left < 1 || bottom - top < 1) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    }

    function isOurNode(el) {
      return !!el?.closest?.('text-grab-extension-ui, text-grab-extension-region');
    }

    // An element's on-screen rect, clipped to scrolling ancestors (null if it is
    // scrolled/clipped out of view). Falls back to the raw box if the helper is
    // somehow absent so the tint still renders something.
    function visibleHitRect(el) {
      return TG.visibility ? TG.visibility.visibleRect(el) : el.getBoundingClientRect();
    }

    // Tint the visible text rects intersecting the region — matches
    // lib/region-text.js's text-node walk closely enough to preview it.
    function textHits(region, out) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || SKIP_TAGS.has(parent.tagName) || isOurNode(parent)) {
            return NodeFilter.FILTER_REJECT;
          }
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          // Clip to scrolling ancestors so text scrolled out of an overflow
          // container is not tinted (matching what capture will include).
          const vis = TG.visibility ? TG.visibility.clipToScrollAncestors(r, parent) : r;
          if (!vis || !hitIntersects(vis, region)) continue;
          const clip = clipToPage(vis, region);
          if (clip) out.push(clip);
          if (out.length >= MAX_HITS) return;
        }
      }
    }

    // Reveal the cells of the table overlapping the region the most (what table
    // mode would grid); fall back to text rects when no table is involved.
    //
    // Table capture (lib/table-to-grid.js clipRect) keeps WHOLE cells, plus the
    // full rectangular block of rows and columns those cells span — it does not
    // clip them to the region. So we cut out each cell's full box: find the
    // cells touching the region, take the block they span, and reveal every
    // cell inside it, so content reaching past the selection still reads as
    // included.
    function tableHits(region, out) {
      let best = null;
      let bestArea = 0;
      for (const table of document.querySelectorAll('table')) {
        if (isOurNode(table)) continue;
        const r = table.getBoundingClientRect();
        const ox = Math.min(r.right, region.x + region.width) - Math.max(r.left, region.x);
        const oy = Math.min(r.bottom, region.y + region.height) - Math.max(r.top, region.y);
        const area = Math.max(0, ox) * Math.max(0, oy);
        if (area > bestArea) {
          bestArea = area;
          best = table;
        }
      }
      if (!best) {
        // No real <table> here — try a repeating structure (a <ul>/<ol> or a
        // run of cards). Reveal the records the region touches so the tint
        // signals the list will be captured; fall back to raw text rects.
        if (!repeatHits(region, out)) textHits(region, out);
        return;
      }

      const cells = [...best.querySelectorAll('th, td')].filter((c) => !isOurNode(c));
      // Pass 1: the pixel block spanned by the cells intersecting the region.
      // Each cell's VISIBLE rect is used so cells scrolled out of a table body
      // with its own scrollbar neither expand the block nor get revealed.
      let block = null;
      for (const cell of cells) {
        const r = visibleHitRect(cell);
        if (!r || !hitIntersects(r, region)) continue;
        block = block
          ? {
              left: Math.min(block.left, r.left),
              top: Math.min(block.top, r.top),
              right: Math.max(block.right, r.right),
              bottom: Math.max(block.bottom, r.bottom),
            }
          : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
      if (!block) {
        textHits(region, out);
        return;
      }

      // Pass 2: reveal every cell whose full box lies within that block.
      const blockRegion = {
        x: block.left,
        y: block.top,
        width: block.right - block.left,
        height: block.bottom - block.top,
      };
      for (const cell of cells) {
        const r = visibleHitRect(cell);
        if (!r || !hitIntersects(r, blockRegion)) continue;
        const page = clampToPage(r);
        if (page) out.push(page);
        if (out.length >= MAX_HITS) return;
      }
    }

    // Repeating structures (lists, card runs) the region intersects. Detection
    // scans the whole document, so it is run once per selection session and
    // cached; the per-frame picking against the cached sets is cheap geometry.
    function detectedRecordSets() {
      if (!TG.repeatDetect) return [];
      return (session._recordSets ??= TG.repeatDetect.detectRecordSets(document.body));
    }

    // Reveal each record the region touches (whole box, clamped to the page),
    // mirroring how table cells are revealed in full. Returns false when no
    // list is involved so the caller can fall back to text rects.
    function repeatHits(region, out) {
      const picked = TG.repeatDetect?.pickRecordSetInRegion(detectedRecordSets(), region);
      if (!picked) return false;
      for (const item of picked.items) {
        const vis = visibleHitRect(item);
        const page = vis && clampToPage(vis);
        if (page) out.push(page);
        if (out.length >= MAX_HITS) break;
      }
      return out.length > 0;
    }

    function computeHits() {
      if (!session || session.mode === 'screenshot') return [];
      const region = viewportRegion();
      const out = [];
      if (session.mode === 'table') tableHits(region, out);
      else textHits(region, out);
      return out;
    }

    function renderHits(hits) {
      const frag = document.createDocumentFragment();
      for (const h of hits) {
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', h.x);
        r.setAttribute('y', h.y);
        r.setAttribute('width', h.width);
        r.setAttribute('height', h.height);
        r.setAttribute('rx', '1');
        r.setAttribute('fill', 'black');
        frag.append(r);
      }
      shadeHoles.replaceChildren(frag);
    }

    // ---- table-mode copy hints ----
    // A little "Copy table" / "Copy list" button pinned to every data table and
    // repeating list on the page. Page-anchored (like the rect and toolbar), so
    // they scroll with their structure; shown only in Table mode. Clicking one
    // copies that whole structure and ends the selection.

    function clearHints() {
      clearHighlight();
      for (const el of hintEls) el.remove();
      hintEls = [];
    }

    function clearHighlight() {
      for (const el of highlightEls) el.remove();
      highlightEls = [];
    }

    // Outline exactly what a hint would copy: the whole table for a table, each
    // record's box for a list (mirroring what the copy actually grabs). Boxes
    // are clamped to the page and skipped when scrolled out of an overflow
    // container, so the preview lines up with reality.
    function showHighlight(s) {
      clearHighlight();
      const targets = s.kind === 'list' && s.set?.items?.length ? s.set.items : [s.el];
      const anchor = hintEls[0] ?? toolbar; // keep highlights beneath the hint buttons
      let drawn = 0;
      for (const el of targets) {
        const page = clampToPage(visibleHitRect(el) ?? el.getBoundingClientRect());
        if (!page) continue;
        const hl = document.createElement('div');
        hl.className = 'tg-region-highlight';
        hl.style.left = `${page.x}px`;
        hl.style.top = `${page.y}px`;
        hl.style.width = `${page.width}px`;
        hl.style.height = `${page.height}px`;
        root.insertBefore(hl, anchor);
        highlightEls.push(hl);
        if (++drawn >= MAX_HITS) break;
      }
    }

    // Every copy-worthy structure on the page: real data tables first, then the
    // repeating lists/card-runs the tint already understands. A list nested in
    // (or wrapping) a table we already offer is dropped so we don't double up.
    function collectStructures() {
      const out = [];
      const tables = [];
      if (TG.tableGrid?.isDataTable) {
        for (const table of document.querySelectorAll('table')) {
          if (isOurNode(table) || !TG.tableGrid.isDataTable(table)) continue;
          tables.push(table);
          out.push({ kind: 'table', el: table });
        }
      }
      for (const set of detectedRecordSets()) {
        const c = set.container;
        if (!c || isOurNode(c)) continue;
        if (tables.some((t) => t.contains(c) || c.contains(t))) continue;
        out.push({ kind: 'list', el: c, set });
      }
      return out.slice(0, MAX_HINTS);
    }

    function renderTableHints() {
      clearHints();
      if (!session || session.mode !== 'table') return;
      for (const s of collectStructures()) {
        // Skip structures scrolled entirely out of an overflow container — their
        // geometric box would float a hint over unrelated content.
        if (!visibleHitRect(s.el)) continue;
        const box = s.el.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) continue;

        const hint = document.createElement('button');
        hint.type = 'button';
        hint.className = 'tg-region-hint';
        hint.textContent = s.kind === 'table' ? 'Copy table' : 'Copy list';
        hint.title =
          s.kind === 'table'
            ? 'Copy this whole table'
            : 'Copy this whole list as a table';
        // Preview what this hint copies while the pointer is over it (or it has
        // keyboard focus).
        hint.addEventListener('mouseenter', () => showHighlight(s));
        hint.addEventListener('mouseleave', clearHighlight);
        hint.addEventListener('focus', () => showHighlight(s));
        hint.addEventListener('blur', clearHighlight);
        // Swallow the pointerdown so it never reaches the backdrop's draw handler.
        hint.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        hint.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const sendToTextGrab = !!session?.sendToTextGrab;
          const payload =
            s.kind === 'table'
              ? { kind: 'table', table: s.el, sendToTextGrab }
              : { kind: 'list', set: s.set, sendToTextGrab };
          cancelRegionSelect();
          onCopyStructure?.(payload);
        });
        // Below the toolbar (which stays on top) but above the shade and backdrop.
        root.insertBefore(hint, toolbar);
        hint.style.top = `${Math.max(0, box.top + window.scrollY + 4)}px`;
        hint.style.left = `${Math.max(0, box.right + window.scrollX - hint.offsetWidth - 4)}px`;
        hintEls.push(hint);
      }
    }

    // ---- pointer interactions ----

    let drag = null; // { kind: 'draw'|'move'|'resize', dir?, startX, startY, startRect }
    // Last pointer position in VIEWPORT (client) coordinates, kept so the
    // auto-scroll loop can re-derive page coordinates after each scroll step.
    let lastClientX = 0;
    let lastClientY = 0;
    let autoScrollRAF = null;

    // How close (CSS px) the pointer must get to a viewport edge before the
    // page starts scrolling, and the peak scroll speed (px per frame) reached
    // at the very edge.
    const EDGE_ZONE = 60;
    const MAX_SCROLL_SPEED = 24;

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      const target = e.target;
      e.preventDefault();
      e.stopPropagation();

      lastClientX = e.clientX;
      lastClientY = e.clientY;

      if (target.classList?.contains('tg-region-handle')) {
        drag = { kind: 'resize', dir: target.dataset.dir, startX: e.pageX, startY: e.pageY, startRect: { ...rect } };
      } else if (target === rectEl || rectEl.contains(target)) {
        drag = { kind: 'move', startX: e.pageX, startY: e.pageY, startRect: { ...rect } };
      } else {
        drag = { kind: 'draw', startX: e.pageX, startY: e.pageY };
        rect = { x: e.pageX, y: e.pageY, width: MIN_SIZE, height: MIN_SIZE };
        layout();
      }
      window.addEventListener('pointermove', onPointerMove, true);
      window.addEventListener('pointerup', onPointerUp, true);
    };

    // Apply the current drag using a page-coordinate pointer position. Called
    // both from real pointer moves and from the auto-scroll loop (where the
    // pointer is stationary but the page underneath it has scrolled).
    const applyDrag = (pageX, pageY) => {
      const dx = pageX - drag.startX;
      const dy = pageY - drag.startY;

      if (drag.kind === 'draw') {
        rect = {
          x: Math.min(drag.startX, pageX),
          y: Math.min(drag.startY, pageY),
          width: Math.abs(dx),
          height: Math.abs(dy),
        };
      } else if (drag.kind === 'move') {
        rect.x = Math.max(0, Math.min(drag.startRect.x + dx, docWidth - drag.startRect.width));
        rect.y = Math.max(0, Math.min(drag.startRect.y + dy, docHeight - drag.startRect.height));
      } else {
        const s = drag.startRect;
        const dir = drag.dir;
        let { x, y, width, height } = s;
        if (dir.includes('e')) width = s.width + dx;
        if (dir.includes('s')) height = s.height + dy;
        if (dir.includes('w')) {
          width = s.width - dx;
          x = s.x + dx;
        }
        if (dir.includes('n')) {
          height = s.height - dy;
          y = s.y + dy;
        }
        if (width < MIN_SIZE) {
          if (dir.includes('w')) x = s.x + s.width - MIN_SIZE;
          width = MIN_SIZE;
        }
        if (height < MIN_SIZE) {
          if (dir.includes('n')) y = s.y + s.height - MIN_SIZE;
          height = MIN_SIZE;
        }
        rect = { x, y, width, height };
      }
      layout();
    };

    const applyDragFromLastClient = () => {
      applyDrag(lastClientX + window.scrollX, lastClientY + window.scrollY);
    };

    // Scroll velocity (px/frame) implied by how deep the pointer sits inside an
    // edge zone. Ramps linearly from 0 at the zone boundary to MAX at the edge.
    const edgeVelocity = (pos, size) => {
      if (pos < EDGE_ZONE) return -((EDGE_ZONE - pos) / EDGE_ZONE) * MAX_SCROLL_SPEED;
      if (pos > size - EDGE_ZONE) return ((pos - (size - EDGE_ZONE)) / EDGE_ZONE) * MAX_SCROLL_SPEED;
      return 0;
    };

    const autoScrollTick = () => {
      autoScrollRAF = null;
      if (!drag) return;
      // Only edges that can still scroll further should pull. Move/draw aren't
      // bounded by direction so we just rely on scrollBy clamping at the ends.
      const vx = edgeVelocity(lastClientX, window.innerWidth);
      const vy = edgeVelocity(lastClientY, window.innerHeight);
      if (vx === 0 && vy === 0) return;

      const beforeX = window.scrollX;
      const beforeY = window.scrollY;
      window.scrollBy(vx, vy);
      // Stop the loop if nothing actually moved (hit a document boundary).
      if (window.scrollX === beforeX && window.scrollY === beforeY) return;

      applyDragFromLastClient();
      autoScrollRAF = requestAnimationFrame(autoScrollTick);
    };

    const maybeAutoScroll = () => {
      if (autoScrollRAF != null) return;
      if (edgeVelocity(lastClientX, window.innerWidth) === 0 &&
          edgeVelocity(lastClientY, window.innerHeight) === 0) return;
      autoScrollRAF = requestAnimationFrame(autoScrollTick);
    };

    const stopAutoScroll = () => {
      if (autoScrollRAF != null) {
        cancelAnimationFrame(autoScrollRAF);
        autoScrollRAF = null;
      }
    };

    const onPointerMove = (e) => {
      if (!drag) return;
      e.preventDefault();
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      applyDrag(e.pageX, e.pageY);
      maybeAutoScroll();
    };

    const onPointerUp = () => {
      drag = null;
      stopAutoScroll();
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
    };

    // Let cancelRegionSelect() tear down an in-flight drag/scroll loop.
    session.cleanup = () => {
      drag = null;
      stopAutoScroll();
      clearHints();
      if (hitsRAF != null) {
        cancelAnimationFrame(hitsRAF);
        hitsRAF = null;
      }
    };

    backdrop.addEventListener('pointerdown', onPointerDown);
    rectEl.addEventListener('pointerdown', onPointerDown);

    // ---- toolbar / keyboard ----

    const confirm = () => {
      const finalMode = session.mode;
      // Screenshot ignores the toggle (it always opens in Text Grab).
      const finalSend = finalMode !== 'screenshot' && session.sendToTextGrab;
      const finalRect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      cancelRegionSelect();
      onConfirm(finalMode, finalRect, finalSend);
    };

    confirmBtn.addEventListener('click', confirm);
    cancelBtn.addEventListener('click', cancelRegionSelect);

    session.onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelRegionSelect();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        confirm();
      }
    };
    window.addEventListener('keydown', session.onKeyDown, true);

    // Hints are positioned once per render; a resize reflows the page, so
    // recompute their anchors. (Scrolling needs nothing — they are page-anchored.)
    session.onResize = () => {
      if (session?.mode === 'table') renderTableHints();
    };
    window.addEventListener('resize', session.onResize);

    sizeShade();
    setSend(session.sendToTextGrab);
    setMode(session.mode);
    layout();
  }

  function cancelRegionSelect() {
    if (!session) return;
    session.cleanup?.();
    window.removeEventListener('keydown', session.onKeyDown, true);
    if (session.onResize) window.removeEventListener('resize', session.onResize);
    session.host.remove();
    session = null;
  }

  TG.regionSelect = { startRegionSelect, cancelRegionSelect };
})();
