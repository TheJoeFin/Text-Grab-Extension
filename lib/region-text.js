// Extract readable text from the HTML elements that intersect a viewport
// rectangle: walk visible text nodes, keep the ones whose rendered rects
// intersect the region, and join them with line breaks at block boundaries.
//
// Classic script injected on demand; registers on the shared namespace.
(() => {
  const TG = (globalThis.__TGX ??= {});

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME']);
  const BLOCK_DISPLAYS = new Set([
    'block', 'flex', 'grid', 'list-item', 'table', 'table-row', 'table-cell',
    'table-caption', 'flow-root',
  ]);

  /**
   * @param {{x:number, y:number, width:number, height:number}} region viewport CSS px
   * @returns {string}
   */
  function extractTextInRegion(region) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('text-grab-extension-ui, text-grab-extension-region')) {
          return NodeFilter.FILTER_REJECT;
        }
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const lines = [];
    let currentBlock = null;
    let currentParts = [];

    const flush = () => {
      const line = currentParts.join(' ').replaceAll(/\s+/g, ' ').trim();
      if (line) lines.push(line);
      currentParts = [];
    };

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      if (!rects.some((r) => intersects(r, region))) continue;

      const block = blockAncestor(node.parentElement);
      if (block !== currentBlock) {
        flush();
        currentBlock = block;
      }

      // Keep only the characters whose rects fall inside the region when the
      // node straddles the boundary; whole-node fast path otherwise.
      if (rects.every((r) => intersects(r, region))) {
        currentParts.push(node.nodeValue);
      } else {
        currentParts.push(clipTextNode(node, region));
      }
    }
    flush();

    return lines.join('\n').replaceAll(/\n{3,}/g, '\n\n').trim();
  }

  /** Per-word clipping for text nodes that cross the region boundary. */
  function clipTextNode(node, region) {
    const text = node.nodeValue;
    const range = document.createRange();
    const kept = [];
    // Split on whitespace, measuring each word's rect.
    const wordPattern = /\S+/g;
    let match;
    while ((match = wordPattern.exec(text)) !== null) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = range.getBoundingClientRect();
      if (intersects(rect, region)) kept.push(match[0]);
    }
    return kept.join(' ');
  }

  function intersects(rect, region) {
    if (rect.width === 0 && rect.height === 0) return false;
    return (
      rect.left < region.x + region.width &&
      rect.right > region.x &&
      rect.top < region.y + region.height &&
      rect.bottom > region.y
    );
  }

  function blockAncestor(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const display = getComputedStyle(node).display;
      if (BLOCK_DISPLAYS.has(display)) return node;
    }
    return document.body;
  }

  TG.regionText = { extractTextInRegion };
})();
