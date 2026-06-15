// Find "repeated structures" on a page — lists of issues, feeds of articles,
// card grids — and turn the one the user picks into a grid the normal TSV /
// HTML-table / Markdown serializers can copy, exactly like a real <table>.
//
// Two tiers, most reliable first:
//   1. Semantic / ARIA — <ul>/<ol>/<dl>, role=list/feed, role=table/grid/
//      treegrid. Unambiguous markup; high precision.
//   2. Structural mining — any parent whose children form a contiguous run of
//      structurally similar siblings (the classic "data record extraction"
//      problem). Catches JS-built div soup that carries no semantic hints.
//
// This powers Select-region → Table mode: when the dragged region covers a
// repeating structure instead of a real <table>, region-select tints the
// records it will capture (pickRecordSetInRegion) and content.js copies them
// clipped to the region as a table (recordSetToGrid), reusing the same grid →
// clipboard pipeline real tables use. Detection scans the whole document, so
// region-select runs it once per selection and reuses the result per frame;
// the region picking is cheap geometry. The engine stays pure (no UI, no
// clipboard) so both the live tint and the final copy share one source.
//
// Classic script injected on demand; registers on the shared namespace.
(() => {
  const TG = (globalThis.__TGX ??= {});

  /** Tuning knobs. Every field is surfaced in the inspector. */
  const DEFAULTS = {
    minItems: 3,          // fewest repeated items for a run to qualify
    strictness: 0.6,      // 0..1 sibling-similarity needed to stay in one run
    profileDepth: 3,      // how deep the structural fingerprint looks
    maxColumns: 12,       // cap on synthesized columns (keeps the busiest)
    includeLinkUrls: false, // add a "Link" column with each record's main href
    headerMode: 'auto',   // 'auto' synthesizes a header row; 'none' omits it
    excludeColumns: null, // Set<string> of column keys to drop
    excludeRows: null,    // Set<number> of item indices to drop
    renames: null,        // Map<string,string> column key -> custom label
  };

  // Never records, never fields.
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'HR',
    'SOURCE', 'META', 'LINK', 'SVG', 'PATH', 'IFRAME',
  ]);

  let seq = 0;

  // ---------------------------------------------------------------------------
  // Public entry points
  // ---------------------------------------------------------------------------

  /**
   * All record sets worth offering, best first.
   * @param {Element} [root]
   * @param {Partial<typeof DEFAULTS>} [options]
   * @returns {RecordSet[]}
   */
  function detectRecordSets(root = document.body, options = {}) {
    const opt = { ...DEFAULTS, ...options };
    if (!root) return [];
    const candidates = [...semanticSets(root, opt), ...structuralSets(root, opt)];
    for (const set of candidates) set.score = scoreSet(set);
    // Cap how many outlines we paint so a busy page stays legible.
    return dedupe(candidates).sort((a, b) => b.score - a.score).slice(0, 15);
  }

  /**
   * Pick the record set that best fills a region and the subset of its records
   * that the region touches — for Table-mode region capture, where the user
   * drags a rectangle over a list instead of a real <table>. Geometry only
   * (cheap), so callers can run it per animation frame against a set list they
   * detected once. The region is in viewport CSS px.
   * @param {RecordSet[]} sets  result of detectRecordSets (detected once, reused)
   * @param {{x:number,y:number,width:number,height:number}} region
   * @returns {{ set: RecordSet, items: Element[] } | null}
   */
  function pickRecordSetInRegion(sets, region) {
    let best = null;
    let bestItems = null;
    let bestArea = 0;
    for (const set of sets) {
      // Use each record's VISIBLE rect (clipped to scrolling ancestors), so a
      // list item scrolled out of an overflow:auto container is not picked just
      // because its off-screen geometric box lands under the region.
      const items = set.items.filter((el) => regionOverlap(visibleItemRect(el), region) > 0);
      if (items.length < 2) continue; // need at least two records to be a table
      let area = 0;
      for (const el of items) area += regionOverlap(visibleItemRect(el), region);
      if (area > bestArea) {
        bestArea = area;
        best = set;
        bestItems = items;
      }
    }
    return best ? { set: best, items: bestItems } : null;
  }

  /**
   * Slice one record set into a rectangular grid plus the provenance the
   * inspector needs to highlight what each cell came from.
   * @param {RecordSet} set
   * @param {Partial<typeof DEFAULTS>} [options]
   * @returns {{ grid: string[][], rowCount: number, colCount: number,
   *   caption: string, columns: Column[], rowElements: Element[],
   *   cellElements: (Element|null)[][] }}
   */
  function recordSetToGrid(set, options = {}) {
    const opt = { ...DEFAULTS, ...options };
    const result = set.kind === 'aria-grid'
      ? gridFromAriaGrid(set, opt)
      : gridFromRecords(set, opt);
    result.caption = captionFor(set.container);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Tier 1 — semantic / ARIA
  // ---------------------------------------------------------------------------

  function semanticSets(root, opt) {
    const sets = [];
    const add = (container, items, kind) => {
      const visible = items.filter(isVisible);
      if (visible.length >= opt.minItems) sets.push(makeSet(container, visible, kind));
    };

    for (const list of queryWithRoot(root, 'ul, ol')) {
      add(list, directChildren(list, (c) => c.tagName === 'LI'), 'list');
    }
    for (const list of queryWithRoot(root, '[role="list"]')) {
      add(list, ownedByRole(list, 'listitem', '[role="list"]'), 'aria-list');
    }
    for (const feed of queryWithRoot(root, '[role="feed"]')) {
      add(feed, ownedByRole(feed, 'article', '[role="feed"]'), 'aria-feed');
    }
    // ARIA tables/grids are tables that just aren't <table>; rows are the items.
    for (const grid of queryWithRoot(root, '[role="table"], [role="grid"], [role="treegrid"]')) {
      const rows = [...grid.querySelectorAll('[role="row"]')].filter(
        (r) => isVisible(r) && nearestRole(r, ROLE_GRID_SELECTOR) === grid
      );
      if (rows.length >= 2) sets.push(makeSet(grid, rows, 'aria-grid'));
    }
    return sets;
  }

  const ROLE_GRID_SELECTOR = '[role="table"],[role="grid"],[role="treegrid"]';

  function ownedByRole(container, role, ownerSelector) {
    return [...container.querySelectorAll(`[role="${role}"]`)].filter(
      (el) => el.closest(ownerSelector) === container
    );
  }

  // ---------------------------------------------------------------------------
  // Tier 2 — structural repetition mining
  // ---------------------------------------------------------------------------

  /**
   * For every element on the page, look at its direct children and find maximal
   * CONTIGUOUS runs of structurally similar siblings. Contiguity is what rejects
   * "header + N rows + footer" — the header and footer fall out of the run as
   * soon as their fingerprint diverges, leaving the homogeneous middle.
   */
  function structuralSets(root, opt) {
    const sets = [];
    for (const parent of [root, ...root.querySelectorAll('*')]) {
      if (SKIP_TAGS.has(parent.tagName)) continue;
      const kids = directChildren(parent, (c) => !SKIP_TAGS.has(c.tagName) && isVisible(c));
      if (kids.length < opt.minItems) continue;

      const profiles = kids.map((k) => profile(k, opt.profileDepth));
      let runStart = 0;
      for (let i = 1; i <= kids.length; i++) {
        const sim = i < kids.length ? similarity(profiles[i - 1], profiles[i]) : -1;
        if (sim < opt.strictness) {
          const run = kids.slice(runStart, i);
          // Require real internal structure. A run of leaf siblings (nav links,
          // inline tag chips, plain <li>text</li>) matches trivially because two
          // empty profiles score 1 — but those are either noise or already
          // caught by the semantic tier, so only keep runs whose items have
          // their own element children.
          const structured = run.filter(hasElementChildren).length;
          if (run.length >= opt.minItems && structured >= run.length / 2) {
            sets.push(makeSet(parent, run, 'structural'));
          }
          runStart = i;
        }
      }
    }
    return sets;
  }

  /**
   * A bag of descendant tag names (depth-limited) describing an element's shape.
   * Two records of the same kind produce near-identical bags even when their
   * text and optional fields differ.
   */
  function profile(el, depth) {
    const counts = new Map();
    (function walk(node, d) {
      for (const child of node.children) {
        if (SKIP_TAGS.has(child.tagName)) continue;
        counts.set(child.tagName, (counts.get(child.tagName) ?? 0) + 1);
        if (d > 1) walk(child, d - 1);
      }
    })(el, depth);
    return counts;
  }

  /** Cosine similarity of two tag bags. Two empty bags (leaf items) score 1. */
  function similarity(a, b) {
    if (a.size === 0 && b.size === 0) return 1;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [, v] of a) na += v * v;
    for (const [k, v] of b) {
      nb += v * v;
      const av = a.get(k);
      if (av) dot += av * v;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / Math.sqrt(na * nb);
  }

  // ---------------------------------------------------------------------------
  // Scoring & dedupe
  // ---------------------------------------------------------------------------

  /** Confidence 0..1 that a set is a real, copy-worthy list of records. */
  function scoreSet(set) {
    const n = set.items.length;
    const countFactor = Math.min(n / 8, 1);                 // more items, more sure
    const visualFactor = verticalStackScore(set.items);     // stacked & aligned?
    const richnessFactor = Math.min(avgFieldCount(set.items) / 3, 1);
    const kindBoost = set.kind === 'structural' ? 0 : 0.15; // semantic markup is trusted
    const raw = 0.4 * countFactor + 0.3 * visualFactor + 0.3 * richnessFactor + kindBoost;
    return Math.max(0, Math.min(1, raw));
  }

  /** Fraction of items that are left-aligned and vertically stacked (no overlap). */
  function verticalStackScore(items) {
    const rects = items.map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height);
    if (rects.length < 2) return 0;
    const lefts = rects.map((r) => r.left).sort((a, b) => a - b);
    const medianLeft = lefts[Math.floor(lefts.length / 2)];
    let aligned = 0;
    let stacked = 0;
    for (let i = 0; i < rects.length; i++) {
      if (Math.abs(rects[i].left - medianLeft) <= 12) aligned++;
      if (i > 0 && rects[i].top >= rects[i - 1].top - 2) stacked++;
    }
    return 0.5 * (aligned / rects.length) + 0.5 * (stacked / (rects.length - 1));
  }

  function avgFieldCount(items) {
    const sample = items.slice(0, 6);
    // fieldsByKey returns a Map of column-key -> fields; its size is the number
    // of distinct columns the record contributes, which is the richness signal.
    const total = sample.reduce((sum, el) => sum + fieldsByKey(el).size, 0);
    return total / sample.length;
  }

  /**
   * Drop redundant candidates. Sorted by score, greedily keep a set unless its
   * container sits INSIDE an already-kept set's record (nested inner repeats —
   * usually noise like a row of stat chips) or duplicates a kept container.
   */
  function dedupe(sets) {
    const ranked = [...sets].sort((a, b) => b.score - a.score);
    const kept = [];
    for (const set of ranked) {
      const redundant = kept.some(
        (k) =>
          k.container === set.container ||
          k.items.some((item) => item.contains(set.container)) ||
          set.items.some((item) => item.contains(k.container))
      );
      if (!redundant) kept.push(set);
    }
    return kept;
  }

  // ---------------------------------------------------------------------------
  // Records -> grid (field extraction + column alignment)
  // ---------------------------------------------------------------------------

  /**
   * Align records into columns by each field's tag-path within its record.
   * Fields sharing a path become one column; a missing field is an empty cell,
   * so ragged records (an issue with no label chip, say) still line up.
   */
  function gridFromRecords(set, opt) {
    const exclude = opt.excludeColumns ?? new Set();
    const excludeRows = opt.excludeRows ?? new Set();
    const renames = opt.renames ?? new Map();

    const items = set.items.filter((_, i) => !excludeRows.has(i));
    const perItem = items.map((item) => fieldsByKey(item));

    // Column order: by median first-appearance index across records, the busiest
    // kept when capped. (frequency breaks ties so rare optional fields drop first.)
    const stats = new Map(); // key -> { order: number[], count, sample }
    perItem.forEach((fields) => {
      [...fields.keys()].forEach((key, idx) => {
        const s = stats.get(key) ?? { order: [], count: 0, sample: fields.get(key)[0].el };
        s.order.push(idx);
        s.count++;
        stats.set(key, s);
      });
    });

    let keys = [...stats.keys()].filter((k) => !exclude.has(k));
    keys.sort((a, b) => median(stats.get(a).order) - median(stats.get(b).order));
    if (keys.length > opt.maxColumns) {
      const byFreq = [...keys].sort((a, b) => stats.get(b).count - stats.get(a).count);
      const keepSet = new Set(byFreq.slice(0, opt.maxColumns));
      keys = keys.filter((k) => keepSet.has(k));
    }

    const columns = keys.map((key) => ({
      key,
      label: renames.get(key) ?? labelForColumn(key, stats.get(key).sample),
    }));
    if (opt.includeLinkUrls) columns.push({ key: '__link__', label: 'Link' });

    const body = [];
    const cellEls = [];
    perItem.forEach((fields, rowIdx) => {
      const row = [];
      const els = [];
      for (const { key } of columns) {
        if (key === '__link__') {
          row.push(primaryHref(items[rowIdx]) ?? '');
          els.push(null);
          continue;
        }
        const found = fields.get(key);
        row.push(found ? found.map((f) => f.text).filter(Boolean).join(', ') : '');
        els.push(found ? found[0].el : null);
      }
      body.push(row);
      cellEls.push(els);
    });

    let grid = body;
    let header = null;
    if (opt.headerMode !== 'none' && columns.length > 0) {
      header = columns.map((c) => c.label);
      grid = [header, ...body];
    }

    return {
      grid,
      rowCount: grid.length,
      colCount: columns.length,
      columns,
      rowElements: items,
      cellElements: header ? [columns.map(() => null), ...cellEls] : cellEls,
    };
  }

  /**
   * Map an element to its fields, keyed by tag-path. A "field" is a leaf value:
   * an element with no element children (its text), a <time>, or an <img> alt.
   * Multiple fields can share a key (e.g. a row of label chips); the caller
   * joins them. Items that are pure text (e.g. <li>plain</li>) yield one field.
   * @returns {Map<string, {text:string, href:string|null, el:Element}[]>}
   */
  function fieldsByKey(item) {
    const out = new Map();
    const push = (key, field) => {
      const list = out.get(key) ?? [];
      list.push(field);
      out.set(key, list);
    };

    (function walk(node, path) {
      const elementChildren = [...node.children].filter(
        (c) => !SKIP_TAGS.has(c.tagName) && isVisible(c)
      );
      if (elementChildren.length === 0) {
        const text = textOf(node);
        if (text) push(path.join('/') || node.tagName.toLowerCase(), {
          text,
          href: node.closest('a')?.getAttribute('href') ?? null,
          el: node,
        });
        return;
      }
      for (const child of elementChildren) {
        if (child.tagName === 'IMG') {
          const alt = child.getAttribute('alt')?.trim();
          if (alt) push([...path, pathSeg(child)].join('/'), { text: alt, href: null, el: child });
          continue;
        }
        walk(child, [...path, pathSeg(child)]);
      }
    })(item, []);

    return out;
  }

  /**
   * A stable per-record identity for one element, used to align fields across
   * records into columns. Prefers the first class — it's the same on the same
   * slot of every record (even hashed CSS-module classes are stable within a
   * page) and survives OPTIONAL fields, where a positional index would slip.
   * Falls back to tag + nth-of-type only when there is no class to go on.
   */
  function pathSeg(el) {
    const tag = el.tagName.toLowerCase();
    const cls = el.classList[0];
    if (cls) return `${tag}.${cls}`;
    let n = 1;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === el.tagName) n++;
    }
    return `${tag}:${n}`;
  }

  /** A friendly column name from semantic cues, falling back to the path tail. */
  function labelForColumn(key, sampleEl) {
    if (!sampleEl) return prettyKey(key);
    const tag = sampleEl.tagName;
    const inHeading = sampleEl.closest('h1, h2, h3, h4, h5, h6, [role="heading"]');
    if (inHeading) return 'Title';
    if (tag === 'TIME' || sampleEl.closest('time')) return 'Date';
    if (tag === 'IMG' || key.endsWith('/img')) return 'Image';
    if (sampleEl.closest('a')) return 'Name';
    return prettyKey(key);
  }

  function prettyKey(key) {
    const tail = key.split('/').filter(Boolean).pop() ?? key;
    // Drop the tag prefix ("div.headline" -> "headline", "span:2" -> "span").
    const name = tail.includes('.') ? tail.slice(tail.indexOf('.') + 1) : tail.split(':')[0];
    const clean = name.replace(/[-_.]+/g, ' ').trim();
    return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Field';
  }

  /** The most prominent link in a record: the one with the most text. */
  function primaryHref(item) {
    let best = null;
    let bestLen = -1;
    for (const a of item.querySelectorAll('a[href]')) {
      if (!isVisible(a)) continue;
      const len = (a.textContent ?? '').trim().length;
      if (len > bestLen) {
        bestLen = len;
        best = a;
      }
    }
    if (!best && item.matches?.('a[href]')) best = item;
    return best ? absoluteHref(best.getAttribute('href')) : null;
  }

  function absoluteHref(href) {
    if (!href) return null;
    try {
      return new URL(href, document.baseURI).href;
    } catch {
      return href;
    }
  }

  // ---------------------------------------------------------------------------
  // ARIA grid -> grid (role-driven, no field guessing needed)
  // ---------------------------------------------------------------------------

  function gridFromAriaGrid(set, opt) {
    const excludeRows = opt.excludeRows ?? new Set();
    const rows = set.items.filter((_, i) => !excludeRows.has(i));
    const grid = [];
    const cellElements = [];
    for (const row of rows) {
      const cells = [...row.querySelectorAll(
        '[role="gridcell"],[role="cell"],[role="columnheader"],[role="rowheader"]'
      )].filter((c) => c.closest('[role="row"]') === row && isVisible(c));
      grid.push(cells.map((c) => textOf(c)));
      cellElements.push(cells);
    }
    const colCount = grid.reduce((m, r) => Math.max(m, r.length), 0);
    for (const row of grid) while (row.length < colCount) row.push('');
    for (const els of cellElements) while (els.length < colCount) els.push(null);
    return {
      grid,
      rowCount: grid.length,
      colCount,
      columns: Array.from({ length: colCount }, (_, i) => ({ key: `c${i}`, label: `Column ${i + 1}` })),
      rowElements: rows,
      cellElements,
    };
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  function makeSet(container, items, kind) {
    return { id: ++seq, container, items, kind, signature: container.tagName, score: 0 };
  }

  function queryWithRoot(root, selector) {
    const list = [...root.querySelectorAll(selector)];
    if (root.matches?.(selector)) list.unshift(root);
    return list.filter(isVisible);
  }

  function directChildren(parent, predicate) {
    return [...parent.children].filter(predicate);
  }

  function hasElementChildren(el) {
    return [...el.children].some((c) => !SKIP_TAGS.has(c.tagName));
  }

  function nearestRole(el, selector) {
    return el.closest(selector);
  }

  /** Collapsed text of an element, hidden descendants dropped. */
  function textOf(node) {
    if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').replaceAll(/\s+/g, ' ').trim();
    const raw = node.textContent ?? '';
    return raw.replaceAll(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function captionFor(container) {
    const aria = container.getAttribute('aria-label')?.trim();
    if (aria) return aria;
    const labelledBy = container.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => container.ownerDocument.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      if (text) return text;
    }
    // Nearest heading above the container.
    let node = container;
    for (let hops = 0; node && hops < 4; hops++) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) return textOf(sib);
        const h = sib.querySelector?.('h1, h2, h3, h4, h5, h6');
        if (h && isVisible(h)) return textOf(h);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // Empty rect used when an item is scrolled/clipped entirely out of view.
  const EMPTY_RECT = { left: 0, top: 0, right: 0, bottom: 0 };

  /** An item's on-screen rect, clipped to scrolling ancestors (empty if hidden). */
  function visibleItemRect(el) {
    // When the visibility helper is present, a null result means "clipped out of
    // view" — honor it as empty rather than falling back to the raw box.
    if (TG.visibility) return TG.visibility.visibleRect(el) ?? EMPTY_RECT;
    return el.getBoundingClientRect();
  }

  /** Overlap area (px²) between a rect and a viewport region rect. */
  function regionOverlap(r, region) {
    const ox = Math.min(r.right, region.x + region.width) - Math.max(r.left, region.x);
    const oy = Math.min(r.bottom, region.y + region.height) - Math.max(r.top, region.y);
    return Math.max(0, ox) * Math.max(0, oy);
  }

  TG.repeatDetect = { detectRecordSets, pickRecordSetInRegion, recordSetToGrid, DEFAULTS };

  /**
   * @typedef {{ id:number, container:Element, items:Element[], kind:string,
   *   signature:string, score:number }} RecordSet
   * @typedef {{ key:string, label:string }} Column
   */
})();
