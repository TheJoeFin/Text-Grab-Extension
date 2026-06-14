// Collect links or images from the current selection (when present) or the
// whole page, as a two-column grid: [text/alt, absolute URL].
//
// Classic script injected on demand; registers on the shared namespace.
(() => {
  const TG = (globalThis.__TGX ??= {});

  function collectLinks() {
    const grid = [];
    const seen = new Set();
    for (const a of scopedElements('a[href]')) {
      const url = a.href;
      if (!url || url.startsWith('javascript:') || seen.has(url)) continue;
      if (a.getAttribute('href')?.startsWith('#')) continue;
      seen.add(url);
      const text = (a.textContent ?? '').replaceAll(/\s+/g, ' ').trim() || a.title || '';
      grid.push([text, url]);
    }
    return grid;
  }

  function collectImages() {
    const grid = [];
    const seen = new Set();
    for (const img of scopedElements('img[src]')) {
      const url = img.currentSrc || img.src;
      if (!url || url.startsWith('data:') || seen.has(url)) continue;
      seen.add(url);
      grid.push([(img.alt ?? '').replaceAll(/\s+/g, ' ').trim(), url]);
    }
    return grid;
  }

  /** Elements matching the selector, limited to the selection when one exists. */
  function scopedElements(selector) {
    const all = [...document.querySelectorAll(selector)];
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return all;
    const ranges = [];
    for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i));
    return all.filter((el) => ranges.some((range) => range.intersectsNode(el)));
  }

  TG.linksImages = { collectLinks, collectImages };
})();
