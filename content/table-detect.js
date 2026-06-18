// Find and describe data tables on the page.
//
// Classic script injected on demand; registers on the shared namespace.
// Depends on TG.tableGrid (lib/table-to-grid.js) — ensure it is injected first.
(() => {
  const TG = (globalThis.__TGX ??= {});

  /**
   * All data tables on the page (native <table>s and ARIA grids), descending
   * through open shadow roots so tables inside web components are included.
   */
  async function findDataTables(doc = document) {
    const { isDataTable, allTables } = TG.tableGrid;
    return allTables(doc).filter(isDataTable);
  }

  /**
   * The nearest data table containing the given element, or null. Crosses
   * shadow boundaries upward so a click on light-DOM content slotted into a
   * web-component grid still resolves to the grid's <table>.
   */
  async function tableForElement(el) {
    const { isDataTable, TABLE_SELECTOR } = TG.tableGrid;
    let node = el instanceof Element ? el : null;
    while (node) {
      const table = node.closest(TABLE_SELECTOR);
      if (table && isDataTable(table)) return table;
      // Climb to the next Element up: past a non-data table, or out of the
      // current shadow root to its host. Never leave `node` as a ShadowRoot
      // (it has no .closest).
      const parent = table ? table.parentNode : node.getRootNode?.();
      node = parent instanceof Element ? parent : parent instanceof ShadowRoot ? parent.host : null;
    }
    return null;
  }

  /** The first data table intersecting the current selection, or null. */
  async function tableForSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
    if (!node) return null;
    // Selection inside one table
    const containing = await tableForElement(node);
    if (containing) return containing;
    // Selection spanning a region: first data table the range intersects
    const tables = await findDataTables();
    return tables.find((t) => range.intersectsNode(t)) ?? null;
  }

  /** Lightweight metadata for the dormant table-list UI (see README). */
  async function describeTables() {
    const { tableToGrid } = TG.tableGrid;
    const tables = await findDataTables();
    return tables.map((table, index) => {
      const { grid, rowCount, colCount, caption } = tableToGrid(table);
      return {
        index,
        caption,
        rowCount,
        colCount,
        previewGrid: grid.slice(0, 3).map((row) => row.slice(0, 4)),
      };
    });
  }

  TG.tableDetect = { findDataTables, tableForElement, tableForSelection, describeTables };
})();
