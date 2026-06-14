// Page-side half of the full-page capture: report metrics, scroll on
// command, hide fixed/sticky chrome on frames after the first, and
// restore everything afterwards.
//
// Classic script injected on demand; registers on the shared namespace.
(() => {
  const TG = (globalThis.__TGX ??= {});

  let saved = null;

  async function prepare() {
    if (saved) await restore(); // a previous capture was interrupted

    const styleEl = document.createElement('style');
    styleEl.textContent = [
      'html { scroll-behavior: auto !important; }',
      '::-webkit-scrollbar { display: none !important; }',
      '*, *::before, *::after {',
      '  animation-play-state: paused !important;',
      '  transition: none !important;',
      '}',
    ].join('\n');
    document.documentElement.append(styleEl);

    // Fixed/sticky elements (headers, cookie bars) repeat on every stitched
    // frame; collect them now so scrollToY can hide them after frame one.
    const pinnedEls = [];
    for (const el of document.body?.querySelectorAll('*') ?? []) {
      const position = getComputedStyle(el).position;
      if (position === 'fixed' || position === 'sticky') {
        pinnedEls.push({ el, visibility: el.style.visibility });
      }
    }

    // The extension's own UI (toasts, hover overlay, region selector) must
    // never appear in the capture; it lives in shadow hosts under <html>.
    const ownUi = [
      ...document.querySelectorAll('text-grab-extension-ui, text-grab-extension-region'),
    ];
    for (const el of ownUi) el.style.display = 'none';

    saved = {
      styleEl,
      pinnedEls,
      ownUi,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pinnedHidden: false,
    };

    const root = document.documentElement;
    return {
      ok: true,
      scrollHeight: Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0),
      scrollWidth: Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
    };
  }

  async function scrollToY(y, x = 0) {
    if (!saved) return { ok: false, error: 'capture not prepared' };

    if (y > 0 && !saved.pinnedHidden) {
      for (const { el } of saved.pinnedEls) el.style.setProperty('visibility', 'hidden', 'important');
      saved.pinnedHidden = true;
    }

    window.scrollTo(x, y);
    // Two frames for layout/paint, then a settle delay for lazy-loaded media.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 150));
    return { ok: true, actualX: window.scrollX, actualY: window.scrollY };
  }

  async function restore() {
    if (!saved) return { ok: true };
    saved.styleEl.remove();
    for (const el of saved.ownUi) el.style.removeProperty('display');
    for (const { el, visibility } of saved.pinnedEls) {
      if (visibility) el.style.visibility = visibility;
      else el.style.removeProperty('visibility');
    }
    window.scrollTo(saved.scrollX, saved.scrollY);
    saved = null;
    return { ok: true };
  }

  TG.captureHelper = { prepare, scrollToY, restore };
})();
