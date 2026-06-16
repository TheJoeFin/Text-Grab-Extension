// In-page toast notifications. Everything lives in a closed shadow root so
// page styles cannot leak in.
//
// Classic script injected on demand; registers on the shared namespace.
// The shadow-root CSS is inlined here (rather than fetched) so it works on
// pages whose Content-Security-Policy would block fetching extension files.
(() => {
  const TG = (globalThis.__TGX ??= {});

  // Text Grab palette: Teal #308E98, DarkTeal #18474C
  const OVERLAY_CSS = `
:host {
  all: initial;
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

  TG.overlay = { showToast };
})();
