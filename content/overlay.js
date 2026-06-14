// In-page UI: toast notifications and the hover overlay button that
// appears at the top-right of data tables. Everything lives in a closed
// shadow root so page styles cannot leak in.
//
// Classic script injected on demand; registers on the shared namespace.
// The shadow-root CSS is inlined here (rather than fetched) so it works on
// pages whose Content-Security-Policy would block fetching extension files.
(() => {
  const TG = (globalThis.__TGX ??= {});

  // Text Grab palette: Teal #308E98, DarkTeal #18474C, hover #1E595F
  const OVERLAY_CSS = `
:host {
  all: initial;
}

.tg-overlay {
  position: absolute;
  z-index: 2147483646;
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 4px;
  background: #18474c;
  border: 1px solid #1e595f;
  border-radius: 8px;
  box-shadow: 0 4px 14px rgba(7, 24, 24, 0.45);
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 12px;
}

.tg-overlay button {
  appearance: none;
  border: none;
  border-radius: 5px;
  background: #1e595f;
  color: #f0f0f0;
  font: inherit;
  padding: 5px 9px;
  cursor: pointer;
  white-space: nowrap;
}

.tg-overlay button:hover {
  background: #308e98;
  color: #ffffff;
}

.tg-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  display: none;
  flex-direction: column;
  min-width: 190px;
  padding: 4px;
  background: #18474c;
  border: 1px solid #1e595f;
  border-radius: 8px;
  box-shadow: 0 4px 14px rgba(7, 24, 24, 0.45);
}

.tg-menu.open {
  display: flex;
}

.tg-menu button {
  text-align: left;
  background: transparent;
}

.tg-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(8px);
  z-index: 2147483647;
  max-width: 70vw;
  padding: 10px 18px;
  border-radius: 8px;
  background: #18474c;
  color: #f0f0f0;
  border-left: 4px solid #308e98;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  box-shadow: 0 4px 14px rgba(7, 24, 24, 0.45);
  opacity: 0;
  transition: opacity 0.18s ease, transform 0.18s ease;
  pointer-events: none;
}

.tg-toast.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.tg-toast.success {
  border-left-color: #3fa5b0;
}

.tg-toast.error {
  border-left-color: #f85149;
}
`;

  let shadowHost = null;
  let shadowRoot = null;

  function ensureShadowRoot() {
    if (shadowRoot) return shadowRoot;
    shadowHost = document.createElement('text-grab-extension-ui');
    shadowHost.style.cssText = 'position: absolute; top: 0; left: 0; width: 0; height: 0;';
    shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

    const styleEl = document.createElement('style');
    styleEl.textContent = OVERLAY_CSS;
    shadowRoot.append(styleEl);

    document.documentElement.append(shadowHost);
    return shadowRoot;
  }

  // ---- Toast ----

  let toastEl = null;
  let toastTimer = null;

  function showToast(text, kind = 'info') {
    const root = ensureShadowRoot();
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'tg-toast';
      root.append(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.remove('success', 'error');
    if (kind === 'success' || kind === 'error') toastEl.classList.add(kind);
    // restart the show animation
    toastEl.classList.remove('visible');
    void toastEl.offsetWidth;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2600);
  }

  // ---- Hover overlay ----

  let overlayEl = null;
  let menuEl = null;
  let currentTable = null;
  let hideTimer = null;
  let actions = null;
  let enabled = false;
  let repositionScheduled = false;

  function enableHoverOverlay(overlayActions) {
    actions = overlayActions;
    if (enabled) return;
    enabled = true;
    document.addEventListener('mouseover', onMouseOver, { passive: true });
    window.addEventListener('scroll', scheduleReposition, { passive: true, capture: true });
    window.addEventListener('resize', scheduleReposition, { passive: true });
  }

  function disableHoverOverlay() {
    enabled = false;
    document.removeEventListener('mouseover', onMouseOver);
    window.removeEventListener('scroll', scheduleReposition, { capture: true });
    window.removeEventListener('resize', scheduleReposition);
    hideOverlay();
  }

  /**
   * True while this script's extension context is alive. After the extension
   * is reloaded or updated, old content scripts keep running on open tabs but
   * every chrome.* call throws "Extension context invalidated".
   */
  function contextAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  /** Remove all listeners and UI left behind by a dead extension context. */
  function teardownDeadContext() {
    disableHoverOverlay();
    clearTimeout(toastTimer);
    shadowHost?.remove();
    shadowHost = null;
    shadowRoot = null;
    toastEl = null;
    overlayEl = null;
    menuEl = null;
  }

  function onMouseOver(e) {
    if (!enabled) return;
    if (!contextAlive()) {
      teardownDeadContext();
      return;
    }
    if (overlayEl && (e.target === shadowHost || shadowHost?.contains(e.target))) {
      clearTimeout(hideTimer);
      return;
    }
    const table = e.target instanceof Element ? e.target.closest('table') : null;
    if (table && table === currentTable) {
      clearTimeout(hideTimer);
      return;
    }
    if (!table) {
      scheduleHide();
      return;
    }
    if (!TG.tableGrid?.isDataTable(table)) {
      scheduleHide();
      return;
    }
    clearTimeout(hideTimer);
    currentTable = table;
    showOverlayFor(table);
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideOverlay, 350);
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = 'none';
    if (menuEl) menuEl.classList.remove('open');
    currentTable = null;
  }

  function showOverlayFor() {
    const root = ensureShadowRoot();
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.className = 'tg-overlay';

      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy table';
      copyBtn.title = 'Copy for pasting into a spreadsheet';
      copyBtn.addEventListener('click', () => {
        if (currentTable) actions?.copyTable(currentTable, 'spreadsheet');
        menuEl.classList.remove('open');
      });

      const moreBtn = document.createElement('button');
      moreBtn.textContent = '⋮';
      moreBtn.title = 'More copy options';
      moreBtn.addEventListener('click', () => menuEl.classList.toggle('open'));

      menuEl = document.createElement('div');
      menuEl.className = 'tg-menu';

      const markdownBtn = document.createElement('button');
      markdownBtn.textContent = 'Copy as Markdown';
      markdownBtn.addEventListener('click', () => {
        if (currentTable) actions?.copyTable(currentTable, 'markdown');
        menuEl.classList.remove('open');
      });

      const sendBtn = document.createElement('button');
      sendBtn.textContent = 'Send to Text Grab spreadsheet';
      sendBtn.addEventListener('click', () => {
        if (currentTable) actions?.sendToTextGrab?.(currentTable);
        menuEl.classList.remove('open');
      });
      if (!actions?.sendToTextGrab) sendBtn.style.display = 'none';

      menuEl.append(markdownBtn, sendBtn);
      overlayEl.append(copyBtn, moreBtn, menuEl);
      overlayEl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      overlayEl.addEventListener('mouseleave', scheduleHide);
      root.append(overlayEl);
    }
    overlayEl.style.display = 'flex';
    menuEl.classList.remove('open');
    positionOverlay();
  }

  function scheduleReposition() {
    if (!currentTable || !overlayEl || repositionScheduled) return;
    repositionScheduled = true;
    requestAnimationFrame(() => {
      repositionScheduled = false;
      if (currentTable && overlayEl?.style.display !== 'none') positionOverlay();
    });
  }

  function positionOverlay() {
    if (!currentTable || !overlayEl) return;
    const rect = currentTable.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      hideOverlay();
      return;
    }
    const top = window.scrollY + Math.max(rect.top, 0) + 4;
    const right = window.scrollX + Math.min(rect.right, window.innerWidth) - 4;
    overlayEl.style.top = `${top}px`;
    overlayEl.style.left = '0px';
    // measure after display to right-align at the table's top-right corner
    const width = overlayEl.offsetWidth;
    overlayEl.style.left = `${Math.max(right - width, window.scrollX + 4)}px`;
  }

  TG.overlay = { showToast, enableHoverOverlay, disableHoverOverlay };
})();
