// Selection -> Markdown via vendored Turndown (+ GFM plugin for tables
// and strikethrough). The vendor files are classic scripts that register
// TG.TurndownService / TG.turndownPluginGfm; ensure they are injected first.
//
// Classic script injected on demand; registers on the shared namespace.
(() => {
  const TG = (globalThis.__TGX ??= {});

  let service;
  function getTurndown() {
    if (!service) {
      service = new TG.TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
      });
      service.use(TG.turndownPluginGfm.gfm);
      service.remove(['script', 'style', 'noscript', 'template']);
    }
    return service;
  }

  function selectionToMarkdown() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';

    const container = document.createElement('div');
    for (let i = 0; i < selection.rangeCount; i++) {
      container.append(selection.getRangeAt(i).cloneContents());
    }
    // Make relative links/images absolute before conversion.
    for (const a of container.querySelectorAll('a[href]')) {
      a.setAttribute('href', new URL(a.getAttribute('href'), document.baseURI).href);
    }
    for (const img of container.querySelectorAll('img[src]')) {
      img.setAttribute('src', new URL(img.getAttribute('src'), document.baseURI).href);
    }

    return getTurndown().turndown(container.innerHTML).trim();
  }

  TG.markdown = { selectionToMarkdown };
})();
