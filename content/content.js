// Text Grab Extension content bootstrap — the ONLY file the manifest injects.
//
// It owns the message listener, the right-click target, and the shared
// isolated-world namespace `globalThis.__TGX`. Every other module is a classic
// script the service worker injects on demand via chrome.scripting (which runs
// in the isolated world and is NOT subject to the page's CSP, unlike dynamic
// import()/fetch of extension resources — that is why this works on
// strict-CSP sites like Reddit where the old import()-based loader did not).
(() => {
  if (window.__textGrabExtensionLoaded) return;
  window.__textGrabExtensionLoaded = true;

  const TG = (globalThis.__TGX ??= {});

  // The element the user last right-clicked, so context-menu actions know
  // which table they were invoked on.
  let lastContextTarget = null;
  document.addEventListener(
    'contextmenu',
    (e) => {
      lastContextTarget = e.target;
    },
    { capture: true, passive: true }
  );

  // ---- on-demand module injection + shared constants ----
  // The only two messages the bootstrap sends to the service worker. The SW
  // injects the requested classic scripts (they register on TG.*) and returns
  // the message/URI/mode constants from lib/messages.js (the single source).

  const injected = new Set();
  async function ensure(files) {
    const need = files.filter((f) => !injected.has(f));
    if (need.length === 0) return;
    const res = await chrome.runtime.sendMessage({ type: 'tg-inject', files: need });
    if (!res?.ok) throw new Error(res?.error ?? 'could not inject extension modules');
    for (const f of need) injected.add(f);
  }

  let constantsPromise;
  async function constants() {
    if (!TG.const) {
      constantsPromise ??= chrome.runtime.sendMessage({ type: 'tg-constants' });
      const res = await constantsPromise;
      if (!res?.ok) throw new Error(res?.error ?? 'could not load constants');
      TG.const = res.consts;
    }
    return TG.const;
  }

  // Thin settings access (chrome.storage wrappers). Defined here rather than
  // injected so lib/settings.js can stay an ES module for the options page;
  // defaults come from the relayed constants (single source of truth).
  const settingsApi = {
    async getSettings() {
      const { DEFAULT_SETTINGS } = await constants();
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS, ...stored };
    },
    saveSettings(partial) {
      return chrome.storage.sync.set(partial);
    },
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse(result ?? { ok: true }))
      .catch((err) => {
        console.warn('[Text Grab Extension]', err);
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      });
    return true; // async response
  });

  async function handleMessage(message) {
    const { MSG, FORMAT } = await constants();
    switch (message.type) {
      case MSG.COPY_TABLE_AT_CONTEXT:
        return copyTableAtContext(message.format ?? FORMAT.SPREADSHEET);
      case MSG.COPY_TABLE_BY_INDEX:
        return copyTableByIndex(message.index, message.format ?? FORMAT.SPREADSHEET);
      case MSG.LIST_TABLES:
        return listTables();
      case MSG.HIGHLIGHT_TABLE:
        return highlightTable(message.index, message.on);
      case MSG.COPY_SELECTION_CLEAN:
        return copySelectionClean();
      case MSG.COPY_SELECTION_MARKDOWN:
        return copySelectionMarkdown();
      case MSG.COPY_LINKS:
        return copyLinksOrImages('links', message.asTable);
      case MSG.COPY_IMAGES:
        return copyLinksOrImages('images', message.asTable);
      case MSG.SHOW_TOAST:
        return toast(message.text);
      case MSG.START_REGION_SELECT:
        return startRegionSelection(message.mode);
      case MSG.CAPTURE_PREPARE:
        await ensure(['content/capture-helper.js']);
        return TG.captureHelper.prepare();
      case MSG.CAPTURE_SCROLL_TO:
        await ensure(['content/capture-helper.js']);
        return TG.captureHelper.scrollToY(message.y, message.x);
      case MSG.CAPTURE_RESTORE:
        await ensure(['content/capture-helper.js']);
        return TG.captureHelper.restore();
      default:
        return { ok: false, error: `unknown message: ${message.type}` };
    }
  }

  async function toast(text, kind = 'info') {
    await ensure(['content/overlay.js']);
    TG.overlay.showToast(text, kind);
    return { ok: true };
  }

  // ---- Table copying ----

  async function copyTableAtContext(format) {
    await ensure(['lib/table-to-grid.js', 'content/table-detect.js']);
    const table =
      (await TG.tableDetect.tableForElement(lastContextTarget)) ??
      (await TG.tableDetect.tableForSelection());
    if (!table) {
      await toast('No table found here', 'error');
      return { ok: false, error: 'no-table' };
    }
    return copyTable(table, format);
  }

  async function copyTableByIndex(index, format) {
    await ensure(['lib/table-to-grid.js', 'content/table-detect.js']);
    const table = (await TG.tableDetect.findDataTables())[index];
    if (!table) return { ok: false, error: 'no-table' };
    return copyTable(table, format);
  }

  // Resolve which output layout to copy in: the user's tableFormat setting,
  // except a Text Grab handoff always uses Returns & Tab (the app pastes
  // tab-separated data via text-grab://paste-spreadsheet).
  async function resolveTableFormat(sendToTextGrab) {
    const { FORMAT } = await constants();
    if (sendToTextGrab) return FORMAT.SPREADSHEET;
    const settings = await settingsApi.getSettings();
    return settings.tableFormat ?? FORMAT.SPREADSHEET;
  }

  async function copyTable(table, format) {
    await ensure(['lib/table-to-grid.js', 'lib/formats.js', 'lib/clipboard.js']);
    const settings = await settingsApi.getSettings();
    let { grid } = TG.tableGrid.tableToGrid(table);
    // With "ignore empty rows/columns" on, drop all-blank rows/columns. Trimming
    // reshapes the grid, so the element's colspan/rowspan no longer map onto it
    // and the HTML must be rebuilt from the flat grid — UNLESS trimming removed
    // nothing, in which case the element still matches the grid and its merged
    // cells are kept (the common case: merges but no fully-blank row/column).
    let htmlSource = table;
    if (settings.ignoreEmptyRowsCols) {
      const trimmed = TG.formats.trimEmptyGrid(grid);
      if (trimmed.length !== grid.length || (trimmed[0]?.length ?? 0) !== (grid[0]?.length ?? 0)) {
        htmlSource = null;
      }
      grid = trimmed;
    }
    const rowCount = grid.length;
    const colCount = grid[0]?.length ?? 0;
    const ok = await TG.clipboard.copyMultiFormat(
      TG.formats.gridToClipboard(grid, {
        format,
        htmlSource,
        flattenNewlines: settings.flattenCellNewlines,
      })
    );
    await toast(
      ok ? `Table copied: ${rowCount} rows x ${colCount} columns` : 'Copy failed',
      ok ? 'success' : 'error'
    );
    return { ok, rowCount, colCount };
  }

  // Copy a whole <table> from a Table-mode hint, optionally handing the result
  // to the Text Grab app when the "Send to Text Grab" toggle is on.
  async function copyWholeTable(table, sendToTextGrab) {
    const { ok } = await copyTable(table, await resolveTableFormat(sendToTextGrab));
    if (ok && sendToTextGrab) {
      const { MSG, TEXT_GRAB_URI } = await constants();
      chrome.runtime.sendMessage({
        type: MSG.LAUNCH_TEXT_GRAB,
        uri: TEXT_GRAB_URI.PASTE_SPREADSHEET,
      });
    }
  }

  // Copy a whole repeating list/card-run from a Table-mode hint, as a table.
  async function copyWholeRecordSet(set, sendToTextGrab) {
    await ensure(['lib/repeat-detect.js', 'lib/formats.js', 'lib/clipboard.js']);
    const { MSG, TEXT_GRAB_URI } = await constants();
    const settings = await settingsApi.getSettings();
    let { grid } = TG.repeatDetect.recordSetToGrid(set);
    if (settings.ignoreEmptyRowsCols) grid = TG.formats.trimEmptyGrid(grid);
    const rowCount = grid.length;
    const colCount = grid[0]?.length ?? 0;
    if (rowCount === 0 || colCount === 0) {
      await toast('Could not read this list', 'error');
      return;
    }
    const ok = await TG.clipboard.copyMultiFormat(
      TG.formats.gridToClipboard(grid, {
        format: await resolveTableFormat(sendToTextGrab),
        flattenNewlines: settings.flattenCellNewlines,
      })
    );
    if (!ok) {
      await toast('Copy failed', 'error');
      return;
    }
    if (sendToTextGrab) {
      chrome.runtime.sendMessage({ type: MSG.LAUNCH_TEXT_GRAB, uri: TEXT_GRAB_URI.PASTE_SPREADSHEET });
      await toast(`List copied (${rowCount} x ${colCount}) — sent to Text Grab`, 'success');
    } else {
      await toast(`List copied: ${rowCount} rows x ${colCount} columns`, 'success');
    }
  }

  async function listTables() {
    await ensure(['lib/table-to-grid.js', 'content/table-detect.js']);
    return { ok: true, tables: await TG.tableDetect.describeTables() };
  }

  let highlighted = null;
  async function highlightTable(index, on) {
    await ensure(['lib/table-to-grid.js', 'content/table-detect.js']);
    if (highlighted) {
      highlighted.style.outline = highlighted.dataset.tgPrevOutline ?? '';
      delete highlighted.dataset.tgPrevOutline;
      highlighted = null;
    }
    if (on === false) return { ok: true };
    const table = (await TG.tableDetect.findDataTables())[index];
    if (!table) return { ok: false, error: 'no-table' };
    table.dataset.tgPrevOutline = table.style.outline;
    table.style.outline = '3px solid #308e98';
    table.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    highlighted = table;
    return { ok: true };
  }

  // ---- Selection / page copying ----

  async function copySelectionClean() {
    await ensure(['lib/clean-text.js', 'lib/clipboard.js']);
    const text = TG.cleanText.selectionToCleanText();
    if (!text) {
      await toast('Nothing selected', 'error');
      return { ok: false, error: 'no-selection' };
    }
    const ok = await TG.clipboard.copyMultiFormat({ text });
    await toast(ok ? 'Selection copied as clean text' : 'Copy failed', ok ? 'success' : 'error');
    return { ok };
  }

  async function copySelectionMarkdown() {
    await ensure([
      'vendor/turndown.js',
      'vendor/turndown-plugin-gfm.js',
      'lib/markdown.js',
      'lib/clipboard.js',
    ]);
    const markdown = await TG.markdown.selectionToMarkdown();
    if (!markdown) {
      await toast('Nothing selected', 'error');
      return { ok: false, error: 'no-selection' };
    }
    const ok = await TG.clipboard.copyMultiFormat({ text: markdown });
    await toast(ok ? 'Selection copied as Markdown' : 'Copy failed', ok ? 'success' : 'error');
    return { ok };
  }

  async function copyLinksOrImages(kind, asTable) {
    await ensure(['lib/links-images.js', 'lib/formats.js', 'lib/clipboard.js']);
    const grid = kind === 'links' ? TG.linksImages.collectLinks() : TG.linksImages.collectImages();
    if (grid.length === 0) {
      await toast(`No ${kind} found`, 'error');
      return { ok: false, error: 'none-found' };
    }
    let ok;
    if (asTable) {
      ok = await TG.clipboard.copyMultiFormat({
        html: TG.formats.toCleanHtmlTable(null, grid),
        text: TG.formats.gridToTsv(grid),
      });
    } else {
      ok = await TG.clipboard.copyMultiFormat({ text: grid.map((row) => row.at(-1)).join('\n') });
    }
    await toast(ok ? `Copied ${grid.length} ${kind}` : 'Copy failed', ok ? 'success' : 'error');
    return { ok, count: grid.length };
  }

  // ---- Select region ----

  async function startRegionSelection(requestedMode) {
    // On a PDF the text lives in the browser's native plugin, not this DOM, so
    // a region drawn here can't be mapped to it reliably. Instead re-open the
    // PDF in our own pdf.js viewer (a new tab), where the rendered text layer
    // gives region selection an exact 1:1 mapping. The viewer takes over from
    // there, so don't start a selection on the native viewer.
    if (isPdfViewer()) return openInPdfViewer(requestedMode);

    // repeat-detect rides along so Table mode can tint repeating lists/cards;
    // visibility lets the tint skip content scrolled out of overflow containers;
    // table-to-grid lets Table mode pin a "Copy table" hint to each data table.
    await ensure([
      'lib/visibility.js',
      'lib/repeat-detect.js',
      'lib/table-to-grid.js',
      'content/region-select.js',
    ]);
    const { REGION_MODE, isWindows } = await constants();
    const settings = await settingsApi.getSettings();
    // Screenshot mode and the "Send to Text Grab" toggle only do anything on
    // Windows (they hand off to the desktop app); fall back to a clipboard mode.
    let mode = requestedMode ?? settings.regionMode;
    if (!isWindows && mode === REGION_MODE.SCREENSHOT) mode = REGION_MODE.TEXT;
    TG.regionSelect.startRegionSelect({
      mode,
      isWindows,
      sendToTextGrab: isWindows && settings.regionSendToTextGrab,
      onModeChange: (newMode) => settingsApi.saveSettings({ regionMode: newMode }),
      onSendToggleChange: (on) => settingsApi.saveSettings({ regionSendToTextGrab: on }),
      // Table mode pins a "Copy table / Copy list" hint to each structure; one
      // click copies the WHOLE thing (no dragging) and ends the selection.
      onCopyStructure: async ({ kind, table, set, sendToTextGrab }) => {
        try {
          if (kind === 'table') await copyWholeTable(table, sendToTextGrab);
          else await copyWholeRecordSet(set, sendToTextGrab);
        } catch (err) {
          console.warn('[Text Grab Extension] copy structure failed:', err);
          await toast(`Copy failed: ${err.message}`, 'error');
        }
      },
      onConfirm: async (mode, rect, sendToTextGrab) => {
        try {
          if (mode === REGION_MODE.SCREENSHOT) await regionScreenshot(rect);
          else if (mode === REGION_MODE.TEXT) await regionTextCopy(rect, sendToTextGrab);
          else await regionTableCopy(rect, sendToTextGrab);
        } catch (err) {
          console.warn('[Text Grab Extension] region action failed:', err);
          await toast(`Region action failed: ${err.message}`, 'error');
        }
      },
    });
    return { ok: true };
  }

  // The selection rectangle is page-anchored; client-rect based modes need
  // it in viewport coordinates relative to the current scroll position.
  function pageRectToViewport(rect) {
    return {
      x: rect.x - window.scrollX,
      y: rect.y - window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }

  async function regionScreenshot(rect) {
    const { MSG } = await constants();

    // A region taller than the viewport can't be shown in one frame, so hand
    // it to the service worker to scroll, capture band-by-band, and stitch —
    // the same technique full-page capture uses, bounded to the region.
    if (rect.height > window.innerHeight) {
      const result = await chrome.runtime.sendMessage({
        type: MSG.REGION_SCREENSHOT_TALL,
        rect, // page (document) CSS px
        viewportWidth: window.innerWidth,
      });
      if (!result?.ok) throw new Error(result?.error ?? 'capture failed');
      const wideClip = rect.width > window.innerWidth;
      await toast(
        wideClip
          ? 'Tall region captured — wider than the screen, so the sides were clipped'
          : 'Tall region captured — opening in Text Grab',
        'success'
      );
      return;
    }

    // Screenshots can only show what is on screen: scroll the region into
    // view, capture the part of it that fits the viewport, then restore.
    const originalX = window.scrollX;
    const originalY = window.scrollY;
    const margin = 8;
    window.scrollTo({ left: rect.x - margin, top: rect.y - margin, behavior: 'instant' });
    // Let the scroll and the selection UI removal paint before capturing.
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

    const wasClipped =
      clipped.width < rect.width - 1 || clipped.height < rect.height - 1;
    await toast(
      wasClipped
        ? 'Region was larger than the screen — captured the visible part'
        : 'Region captured — opening in Text Grab',
      'success'
    );
  }

  async function regionTextCopy(rect, sendToTextGrab) {
    await ensure(['lib/visibility.js', 'lib/region-text.js', 'lib/clipboard.js']);
    const { MSG, TEXT_GRAB_URI } = await constants();
    const text = TG.regionText.extractTextInRegion(pageRectToViewport(rect));
    if (!text) {
      await toast('No text found in the region', 'error');
      return;
    }
    const ok = await TG.clipboard.copyMultiFormat({ text });
    if (!ok) {
      await toast('Copy failed', 'error');
      return;
    }
    if (sendToTextGrab) {
      chrome.runtime.sendMessage({ type: MSG.LAUNCH_TEXT_GRAB, uri: TEXT_GRAB_URI.EDIT_TEXT });
      await toast('Region text sent to Text Grab', 'success');
    } else {
      await toast('Region text copied', 'success');
    }
  }

  // True when the tab is showing the browser's built-in PDF viewer. The PDF's
  // text is not in this document's DOM (it is rendered by an out-of-process
  // plugin), so region selection re-opens it in our own pdf.js viewer instead.
  function isPdfViewer() {
    return (
      document.contentType === 'application/pdf' ||
      !!document.querySelector(
        'embed[type="application/pdf"], embed[type="application/x-google-chrome-pdf"]'
      ) ||
      /\.pdf(?:[?#]|$)/i.test(location.pathname)
    );
  }

  // Re-open the current PDF in our own pdf.js viewer (a new tab). Fetch the
  // bytes same-origin first (most reliable — cache, cookies, file://); if that
  // fails the viewer refetches the URL from its own origin. The service worker
  // opens the viewer and serves the bytes to it.
  async function openInPdfViewer(requestedMode) {
    const { MSG } = await constants();
    await toast('Opening PDF in the Text Grab viewer…');

    let pdfBase64 = null;
    try {
      const buf = await (await fetch(location.href)).arrayBuffer();
      pdfBase64 = bytesToBase64(new Uint8Array(buf));
    } catch {
      // viewer will refetch via the URL fallback
    }

    const res = await chrome.runtime.sendMessage({
      type: MSG.OPEN_PDF_VIEWER,
      pdfBase64,
      url: location.href,
      name: pdfName(),
      mode: requestedMode,
    });
    if (!res?.ok) {
      await toast(`Could not open the PDF viewer: ${res?.error ?? 'unknown error'}`, 'error');
    }
    return res;
  }

  // Best-effort document name from the URL, for the viewer's title bar.
  function pdfName() {
    try {
      const path = new URL(location.href).pathname;
      const base = decodeURIComponent(path.split('/').pop() || '');
      return base || 'document.pdf';
    } catch {
      return 'document.pdf';
    }
  }

  // Base64-encode bytes in chunks (btoa can't take a whole multi-MB string).
  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function regionTableCopy(pageRect, sendToTextGrab) {
    await ensure([
      'lib/visibility.js',
      'lib/table-to-grid.js',
      'content/table-detect.js',
      'lib/repeat-detect.js',
      'lib/formats.js',
      'lib/clipboard.js',
      'lib/region-grid.js',
    ]);
    const { MSG, TEXT_GRAB_URI } = await constants();
    const rect = pageRectToViewport(pageRect);

    // Pick the real <table> overlapping the region the most.
    let best = null;
    let bestArea = 0;
    for (const table of await TG.tableDetect.findDataTables()) {
      const r = table.getBoundingClientRect();
      const overlapX = Math.min(r.right, rect.x + rect.width) - Math.max(r.left, rect.x);
      const overlapY = Math.min(r.bottom, rect.y + rect.height) - Math.max(r.top, rect.y);
      const area = Math.max(0, overlapX) * Math.max(0, overlapY);
      if (area > bestArea) {
        bestArea = area;
        best = table;
      }
    }

    // Capture precedence: a real <table> first, then a repeating structure
    // (a <ul>/<ol> or run of cards) whose records the region covers, and only
    // then raw layout reconstruction from text bounding boxes.
    let grid;
    let rowCount = 0;
    let colCount = 0;
    let source = '';
    // When the region covers the WHOLE table, hand the element to the HTML
    // serializer so merged cells (colspan/rowspan) survive in the text/html
    // flavor that Excel, Sheets, and Word read. A clipped sub-range can't both
    // clip and preserve merges, so it stays a flat grid (htmlSource null).
    let htmlSource = null;
    if (best) {
      ({ grid, rowCount, colCount } = TG.tableGrid.tableToGrid(best, { clipRect: rect }));
      if (rowCount > 0) {
        const full = TG.tableGrid.tableToGrid(best);
        if (full.rowCount === rowCount && full.colCount === colCount) htmlSource = best;
      }
    }
    if (rowCount === 0) {
      const sets = TG.repeatDetect.detectRecordSets(document.body);
      const picked = TG.repeatDetect.pickRecordSetInRegion(sets, rect);
      if (picked) {
        // Copy each record the region touches as a row; no synthetic header.
        ({ grid, rowCount, colCount } = TG.repeatDetect.recordSetToGrid(
          { ...picked.set, items: picked.items },
          { headerMode: 'none' }
        ));
        if (colCount > 0) source = ' from list';
        else rowCount = 0;
      }
    }
    if (rowCount === 0) {
      const result = TG.regionGrid.inferGridInRegion(rect);
      if (!result) {
        await toast('No table or table-like layout in the region', 'error');
        return;
      }
      ({ grid, rowCount, colCount } = result);
      source = ' from layout';
    }

    const settings = await settingsApi.getSettings();
    if (settings.ignoreEmptyRowsCols) {
      const trimmed = TG.formats.trimEmptyGrid(grid);
      // Trimming reshapes the grid; the element's merges no longer map onto it,
      // so drop back to the flat grid. When trimming removes nothing the element
      // still matches and its merged cells are kept.
      if (trimmed.length !== grid.length || (trimmed[0]?.length ?? 0) !== (grid[0]?.length ?? 0)) {
        htmlSource = null;
      }
      grid = trimmed;
      rowCount = grid.length;
      colCount = grid[0]?.length ?? 0;
      if (rowCount === 0 || colCount === 0) {
        await toast('Nothing left after dropping empty rows and columns', 'error');
        return;
      }
    }
    const ok = await TG.clipboard.copyMultiFormat(
      TG.formats.gridToClipboard(grid, {
        format: await resolveTableFormat(sendToTextGrab),
        htmlSource,
        flattenNewlines: settings.flattenCellNewlines,
      })
    );
    if (!ok) {
      await toast('Copy failed', 'error');
      return;
    }
    if (sendToTextGrab) {
      chrome.runtime.sendMessage({ type: MSG.LAUNCH_TEXT_GRAB, uri: TEXT_GRAB_URI.PASTE_SPREADSHEET });
      await toast(`Table region (${rowCount} x ${colCount})${source} sent to Text Grab`, 'success');
    } else {
      await toast(`Table region copied${source}: ${rowCount} rows x ${colCount} columns`, 'success');
    }
  }
})();
