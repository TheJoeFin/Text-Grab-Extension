// Text Grab PDF viewer controller.
//
// Renders the handed-off PDF with pdf.js — a canvas plus a real DOM text layer
// per page — then drives region selection against that rendered DOM. Because
// the text the user sees IS the DOM, region selection maps to it exactly: no
// screenshot registration, no offscreen document, no scroll/zoom guessing.
// Table mode reuses TG.regionGrid directly; text mode uses a position-based
// line reconstruction here (pdf.js spans carry no block structure).
//
// The TG.* helpers (overlay, clipboard, formats, region-grid, region-select,
// capture-helper) are loaded as classic scripts by viewer.html and register on
// globalThis.__TGX before this module runs.

import * as pdfjsLib from '../vendor/pdf.mjs';
import { MSG, REGION_MODE, FORMAT, TEXT_GRAB_URI } from '../lib/messages.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.mjs');

const TG = (globalThis.__TGX ??= {});

const MAX_PAGES = 300; // safety cap so an enormous PDF can't hang the renderer
const OUTPUT_SCALE = window.devicePixelRatio || 1;

const elements = {
  title: document.getElementById('title'),
  status: document.getElementById('status'),
  pages: document.getElementById('pages'),
  selectButton: document.getElementById('select-region'),
};

const params = new URLSearchParams(location.search);

/** @type {Array<{page:any, viewport:any, canvas:HTMLCanvasElement, canvasRendered:boolean}>} */
const pageEntries = [];

main().catch((err) => {
  console.error('[Text Grab Extension] viewer failed:', err);
  setStatus(`Could not open this PDF: ${err.message}`);
});

async function main() {
  wireMessages();
  elements.selectButton.addEventListener('click', () => startSelection());

  const name = params.get('name');
  if (name) {
    elements.title.textContent = name;
    document.title = `Text Grab — ${name}`;
  }

  setStatus('Loading…');
  const data = await loadBytes();
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

  const scale = await computeScale(doc);
  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  for (let i = 1; i <= pageCount; i++) {
    setStatus(`Rendering page ${i} of ${pageCount}…`);
    await addPage(doc, i, scale);
  }
  if (doc.numPages > pageCount) {
    setStatus(`Showing the first ${pageCount} of ${doc.numPages} pages`);
  } else {
    setStatus('');
  }

  observeCanvases();

  // The user invoked "select region" on the original PDF, so go straight into
  // selection now that the document is rendered and fully sized.
  startSelection(params.get('mode') ?? undefined);
}

// ---- PDF source -----------------------------------------------------------

/**
 * The PDF bytes come from the service worker, which the content script handed
 * them to (fetched same-origin in the original tab, so cookies/auth apply). If
 * that relay is unavailable (e.g. the SW unloaded), fall back to fetching the
 * original URL from this extension origin.
 */
async function loadBytes() {
  const id = params.get('id');
  if (id) {
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.GET_PDF_BYTES, id });
      if (res?.ok && res.base64) return base64ToBytes(res.base64);
      if (res?.ok && res.url) return await fetchBytes(res.url);
    } catch {
      // fall through to the URL param
    }
  }
  const url = params.get('url');
  if (url) return await fetchBytes(url);
  throw new Error('no PDF source was provided');
}

async function fetchBytes(url) {
  // fetch() does not support the file: scheme — it rejects with "Failed to
  // fetch" — so read local PDFs with XHR instead, which works in this extension
  // page once the user has granted "Allow access to file URLs".
  if (/^file:/i.test(url)) return xhrBytes(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function xhrBytes(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      // A successful file: read reports status 0, not 200.
      if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
        resolve(new Uint8Array(xhr.response));
      } else {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () =>
      reject(new Error('could not read the local file (is "Allow access to file URLs" on?)'));
    xhr.send();
  });
}

// ---- rendering ------------------------------------------------------------

/** Fit the first page to the viewport width (capped), used for every page. */
async function computeScale(doc) {
  const first = await doc.getPage(1);
  const unscaled = first.getViewport({ scale: 1 });
  const available = elements.pages.clientWidth - 32; // gutter padding
  const fit = available / unscaled.width;
  return Math.max(1, Math.min(2, fit || 1));
}

async function addPage(doc, pageNumber, scale) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  const pageDiv = document.createElement('div');
  pageDiv.className = 'page';
  pageDiv.dataset.index = String(pageEntries.length);
  pageDiv.style.width = `${Math.floor(viewport.width)}px`;
  pageDiv.style.height = `${Math.floor(viewport.height)}px`;
  // pdf.js text layer positions/sizes everything in scale-1 units multiplied by
  // this CSS variable (see setLayerDimensions), so it must match our scale.
  pageDiv.style.setProperty('--scale-factor', String(scale));

  const canvas = document.createElement('canvas');
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';

  pageDiv.append(canvas, textLayerDiv);
  elements.pages.append(pageDiv);

  const entry = { page, viewport, canvas, canvasRendered: false };
  pageEntries.push(entry);

  // The text layer is what region grabbing reads, so render it eagerly for
  // every page; the heavier canvas raster is rendered lazily on scroll.
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: await page.getTextContent(),
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();
}

async function renderCanvas(entry) {
  if (entry.canvasRendered) return;
  entry.canvasRendered = true;
  const { page, viewport, canvas } = entry;
  canvas.width = Math.floor(viewport.width * OUTPUT_SCALE);
  canvas.height = Math.floor(viewport.height * OUTPUT_SCALE);
  const transform = OUTPUT_SCALE !== 1 ? [OUTPUT_SCALE, 0, 0, OUTPUT_SCALE, 0, 0] : undefined;
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform }).promise;
  } catch (err) {
    entry.canvasRendered = false;
    console.warn('[Text Grab Extension] page render failed:', err);
  }
}

function observeCanvases() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        renderCanvas(pageEntries[Number(e.target.dataset.index)]);
      }
    },
    { rootMargin: '400px 0px' }
  );
  for (const div of elements.pages.children) io.observe(div);
}

// ---- region selection -----------------------------------------------------

// Text Grab is Windows-only; its text-grab:// handoff (Screenshot mode and the
// "Send to Text Grab" toggle) is hidden elsewhere. Memoized — the OS is fixed.
let platformOsPromise;
async function isWindows() {
  platformOsPromise ??= chrome.runtime.getPlatformInfo();
  return (await platformOsPromise).os === 'win';
}

async function startSelection(requestedMode) {
  if (pageEntries.length === 0) return;
  const settings = await getSettings();
  const onWindows = await isWindows();
  let mode = requestedMode ?? settings.regionMode;
  if (!onWindows && mode === REGION_MODE.SCREENSHOT) mode = REGION_MODE.TEXT;
  TG.regionSelect.startRegionSelect({
    mode,
    isWindows: onWindows,
    sendToTextGrab: onWindows && settings.regionSendToTextGrab,
    onModeChange: (mode) => saveSettings({ regionMode: mode }),
    onSendToggleChange: (on) => saveSettings({ regionSendToTextGrab: on }),
    onConfirm: async (mode, rect, sendToTextGrab) => {
      try {
        if (mode === REGION_MODE.SCREENSHOT) await regionScreenshot(rect);
        else if (mode === REGION_MODE.TEXT) await regionTextCopy(rect, sendToTextGrab);
        else await regionTableCopy(rect, sendToTextGrab);
      } catch (err) {
        console.warn('[Text Grab Extension] region action failed:', err);
        toast(`Region action failed: ${err.message}`, 'error');
      }
    },
  });
}

// The selection rectangle is page-anchored; client-rect based modes need it in
// viewport coordinates relative to the current scroll position.
function pageRectToViewport(rect) {
  return {
    x: rect.x - window.scrollX,
    y: rect.y - window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

// pdf.js lays the text layer out as absolutely-positioned spans (one per text
// run), so a page has no block structure to derive line breaks from — they live
// in the positions. Reconstruct lines the way the document reads: collect the
// spans intersecting the region, group them by vertical position, and join each
// group left-to-right. (TG.regionText's block-ancestry logic, tuned for normal
// HTML, would otherwise merge a whole page into one line.)
function extractPdfTextInRegion(region) {
  const range = document.createRange();
  const frags = [];
  for (const span of document.querySelectorAll('.textLayer span')) {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.nodeValue.trim()) continue;
    const rect = span.getBoundingClientRect();
    if (!rectIntersects(rect, region)) continue;
    const text = clipSpanToRegion(node, region, range);
    if (!text) continue;
    frags.push({ text, top: rect.top, left: rect.left, height: rect.height || 6 });
  }
  return fragsToLines(frags);
}

// Whole-span fast path; per-word clipping when the span crosses the boundary.
function clipSpanToRegion(node, region, range) {
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()];
  if (rects.length && rects.every((r) => rectInside(r, region))) return node.nodeValue;

  const kept = [];
  const words = /\S+/g;
  let match;
  while ((match = words.exec(node.nodeValue)) !== null) {
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[0].length);
    if (rectIntersects(range.getBoundingClientRect(), region)) kept.push(match[0]);
  }
  return kept.join(' ');
}

function fragsToLines(frags) {
  if (frags.length === 0) return '';
  frags.sort((a, b) => a.top - b.top || a.left - b.left);
  const heights = frags.map((f) => f.height).sort((a, b) => a - b);
  const tol = (heights[heights.length >> 1] || 6) * 0.6;

  const lines = [];
  let line = [];
  let lineTop = null;
  for (const f of frags) {
    if (lineTop === null || Math.abs(f.top - lineTop) <= tol) {
      line.push(f);
      lineTop = lineTop === null ? f.top : (lineTop + f.top) / 2;
    } else {
      lines.push(line);
      line = [f];
      lineTop = f.top;
    }
  }
  if (line.length) lines.push(line);

  return lines
    .map((ln) =>
      ln
        .sort((a, b) => a.left - b.left)
        .map((f) => f.text)
        .join(' ')
        .replaceAll(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

function rectIntersects(r, region) {
  if (r.width === 0 && r.height === 0) return false;
  return (
    r.left < region.x + region.width &&
    r.right > region.x &&
    r.top < region.y + region.height &&
    r.bottom > region.y
  );
}

function rectInside(r, region) {
  return (
    r.left >= region.x &&
    r.right <= region.x + region.width &&
    r.top >= region.y &&
    r.bottom <= region.y + region.height
  );
}

async function regionTextCopy(pageRect, sendToTextGrab) {
  const text = extractPdfTextInRegion(pageRectToViewport(pageRect));
  if (!text) {
    toast('No text found in the region', 'error');
    return;
  }
  const ok = await TG.clipboard.copyMultiFormat({ text });
  if (!ok) {
    toast('Copy failed', 'error');
    return;
  }
  if (sendToTextGrab) {
    launchTextGrab(TEXT_GRAB_URI.EDIT_TEXT);
    toast('PDF region text sent to Text Grab', 'success');
  } else {
    toast('PDF region text copied', 'success');
  }
}

async function regionTableCopy(pageRect, sendToTextGrab) {
  // region-grid walks all body text and skips display:none, so hide our toolbar
  // while it runs to keep it out of a grid drawn near the top of the document.
  const toolbar = document.getElementById('toolbar');
  toolbar.style.display = 'none';
  let result;
  try {
    result = TG.regionGrid.inferGridInRegion(pageRectToViewport(pageRect));
  } finally {
    toolbar.style.display = '';
  }
  if (!result) {
    toast('No table-like layout in the region', 'error');
    return;
  }
  const { grid, rowCount, colCount } = result;
  const settings = await getSettings();
  // A Text Grab handoff always uses Returns & Tab; otherwise honor the setting.
  const format = sendToTextGrab ? FORMAT.SPREADSHEET : settings.tableFormat ?? FORMAT.SPREADSHEET;
  const ok = await TG.clipboard.copyMultiFormat(
    TG.formats.gridToClipboard(grid, { format, flattenNewlines: settings.flattenCellNewlines })
  );
  if (!ok) {
    toast('Copy failed', 'error');
    return;
  }
  if (sendToTextGrab) {
    launchTextGrab(TEXT_GRAB_URI.PASTE_SPREADSHEET);
    toast(`PDF table (${rowCount} x ${colCount}) sent to Text Grab`, 'success');
  } else {
    toast(`PDF table copied: ${rowCount} rows x ${colCount} columns`, 'success');
  }
}

async function regionScreenshot(rect) {
  // Keep our own (sticky) toolbar out of the capture.
  const toolbar = document.getElementById('toolbar');
  toolbar.style.visibility = 'hidden';
  try {
    await captureRegion(rect);
  } finally {
    toolbar.style.visibility = '';
  }
}

async function captureRegion(rect) {
  // A region taller than the viewport is captured band-by-band and stitched by
  // the service worker (which scrolls this tab via the capture-helper messages
  // handled below); shorter regions are a single cropped capture.
  if (rect.height > window.innerHeight) {
    const result = await chrome.runtime.sendMessage({
      type: MSG.REGION_SCREENSHOT_TALL,
      rect,
      viewportWidth: window.innerWidth,
    });
    if (!result?.ok) throw new Error(result?.error ?? 'capture failed');
    toast('Tall region captured — opening in Text Grab', 'success');
    return;
  }

  const originalX = window.scrollX;
  const originalY = window.scrollY;
  const margin = 8;
  window.scrollTo({ left: rect.x - margin, top: rect.y - margin, behavior: 'instant' });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 100));

  const view = pageRectToViewport(rect);
  const clipped = {
    x: Math.max(0, view.x),
    y: Math.max(0, view.y),
    width: Math.min(view.width, window.innerWidth - Math.max(0, view.x)),
    height: Math.min(view.height, window.innerHeight - Math.max(0, view.y)),
  };

  try {
    const result = await chrome.runtime.sendMessage({
      type: MSG.REGION_SCREENSHOT,
      rect: clipped,
      viewportWidth: window.innerWidth,
    });
    if (!result?.ok) throw new Error(result?.error ?? 'capture failed');
  } finally {
    window.scrollTo({ left: originalX, top: originalY, behavior: 'instant' });
  }
  toast('Region captured — opening in Text Grab', 'success');
}

function launchTextGrab(uri) {
  chrome.runtime.sendMessage({ type: MSG.LAUNCH_TEXT_GRAB, uri });
}

// ---- messaging from the service worker ------------------------------------

function wireMessages() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse(result ?? { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true; // async response
  });
}

async function handleMessage(message) {
  switch (message.type) {
    case MSG.START_REGION_SELECT:
      await startSelection(message.mode);
      return { ok: true };
    case MSG.SHOW_TOAST:
      toast(message.text);
      return { ok: true };
    // Tall-region screenshot drives this tab's scrolling through the same
    // capture-helper the content script uses on ordinary pages.
    case MSG.CAPTURE_PREPARE:
      return TG.captureHelper.prepare();
    case MSG.CAPTURE_SCROLL_TO:
      return TG.captureHelper.scrollToY(message.y, message.x);
    case MSG.CAPTURE_RESTORE:
      return TG.captureHelper.restore();
    default:
      return { ok: false, error: `unknown message: ${message.type}` };
  }
}

// ---- small helpers --------------------------------------------------------

function setStatus(text) {
  elements.status.textContent = text;
}

function toast(text, kind = 'info') {
  TG.overlay.showToast(text, kind);
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function saveSettings(partial) {
  return chrome.storage.sync.set(partial);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
