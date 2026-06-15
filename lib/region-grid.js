// Reconstruct a tabular grid from page LAYOUT when there is no real <table>
// element in the region. Many "tables" on the web are CSS grid/flex layouts
// (or stacks of positioned divs); this reads the bounding boxes of the text
// fragments inside the region, groups them into rows by vertical position and
// columns by horizontal position, and emits a string[][] grid that the normal
// TSV / HTML-table serializers can turn into a real table for the clipboard
// and Text Grab.
//
// Classic script injected on demand; registers on the shared namespace.
(() => {
  const TG = (globalThis.__TGX ??= {});

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME']);

  /**
   * @param {{x:number, y:number, width:number, height:number}} region viewport CSS px
   * @returns {{ grid: string[][], rowCount: number, colCount: number } | null}
   *   null when the region holds too little aligned text to look like a table.
   */
  function inferGridInRegion(region) {
    const fragments = collectFragments(region);
    if (fragments.length < 4) return null;

    const rows = groupRows(fragments);
    if (rows.length < 2) return null;

    const columns = computeColumns(rows);
    if (columns.length < 2) return null;

    const grid = rows.map((row) => {
      const cells = Array(columns.length).fill('');
      for (const f of row) {
        const ci = assignColumn(f, columns);
        cells[ci] = cells[ci] ? `${cells[ci]} ${f.text}` : f.text;
      }
      return cells;
    });

    return { grid, rowCount: grid.length, colCount: columns.length };
  }

  // ---- fragment collection ----

  /** One text fragment per visible text node, clipped to the region. */
  function collectFragments(region) {
    const body = document.body;
    if (!body) return [];

    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
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

    const fragments = [];
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      range.selectNodeContents(node);
      // Keep only the visible part of each rect (clipped to scrolling ancestors)
      // so text scrolled out of an overflow container is not reconstructed.
      const rects = [...range.getClientRects()]
        .map((r) => clipToVisible(r, parent))
        .filter((r) => r && (r.width || r.height) && intersects(r, region));
      if (rects.length === 0) continue;

      const text = clipText(node, region, parent);
      if (!text) continue;

      const bound = clampRect(unionRect(rects), region);
      fragments.push({
        text,
        left: bound.left,
        right: bound.right,
        top: bound.top,
        bottom: bound.bottom,
        cx: (bound.left + bound.right) / 2,
        cy: (bound.top + bound.bottom) / 2,
        height: Math.max(1, bound.bottom - bound.top),
      });
    }
    return fragments;
  }

  /** Words of a text node whose rendered, on-screen rects fall inside the region. */
  function clipText(node, region, parent) {
    const text = node.nodeValue;
    const range = document.createRange();
    const kept = [];
    const wordPattern = /\S+/g;
    let match;
    while ((match = wordPattern.exec(text)) !== null) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = clipToVisible(range.getBoundingClientRect(), parent);
      if (rect && intersects(rect, region)) kept.push(match[0]);
    }
    return kept.join(' ');
  }

  // Clip a rect to `parent`'s scrolling ancestors (null when fully clipped away).
  function clipToVisible(rect, parent) {
    return TG.visibility ? TG.visibility.clipToScrollAncestors(rect, parent) : rect;
  }

  // ---- row / column grouping ----

  /**
   * Group fragments into reading-order rows: a fragment joins the previous row
   * when it overlaps it vertically by at least half a line height, otherwise it
   * starts a new row. Each returned row is sorted left-to-right.
   */
  function groupRows(fragments) {
    const sorted = [...fragments].sort((a, b) => a.top - b.top || a.left - b.left);
    const rows = [];
    for (const f of sorted) {
      const row = rows[rows.length - 1];
      if (row && f.top < row.bottom - Math.min(f.height, row.minHeight) * 0.5) {
        row.frags.push(f);
        row.bottom = Math.max(row.bottom, f.bottom);
        row.minHeight = Math.min(row.minHeight, f.height);
      } else {
        rows.push({ frags: [f], bottom: f.bottom, minHeight: f.height });
      }
    }
    return rows.map((r) => r.frags.sort((a, b) => a.left - b.left));
  }

  /**
   * Derive column bands from the row with the most fragments — the most
   * "columnar" row makes the most reliable template. Other rows' fragments are
   * snapped onto these bands by horizontal overlap (see assignColumn).
   */
  function computeColumns(rows) {
    let template = rows[0];
    for (const row of rows) if (row.length > template.length) template = row;
    if (template.length < 2) return [];
    return template.map((f) => ({ left: f.left, right: f.right, center: f.cx }));
  }

  /** Pick the column a fragment belongs to: most horizontal overlap, else nearest center. */
  function assignColumn(f, columns) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const overlap = Math.min(f.right, c.right) - Math.max(f.left, c.left);
      // Positive overlap wins by amount; otherwise the least-distant center wins.
      const score = overlap >= 0 ? overlap : -Math.abs(f.cx - c.center);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  // ---- geometry helpers ----

  function intersects(rect, region) {
    if (rect.width === 0 && rect.height === 0) return false;
    return (
      rect.left < region.x + region.width &&
      rect.right > region.x &&
      rect.top < region.y + region.height &&
      rect.bottom > region.y
    );
  }

  function unionRect(rects) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    return { left, top, right, bottom };
  }

  function clampRect(rect, region) {
    return {
      left: Math.max(rect.left, region.x),
      top: Math.max(rect.top, region.y),
      right: Math.min(rect.right, region.x + region.width),
      bottom: Math.min(rect.bottom, region.y + region.height),
    };
  }

  TG.regionGrid = { inferGridInRegion };
})();
