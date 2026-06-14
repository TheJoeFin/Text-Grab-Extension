// Find and describe data tables on the page.
//
// Classic script injected on demand; registers on the shared namespace.
// Depends on TG.tableGrid (lib/table-to-grid.js) — ensure it is injected first.
(() => {
  const TG = (globalThis.__TGX ??= {});

  /** All data tables on the page, in document order. */
  async function findDataTables(doc = document) {
    const { isDataTable } = TG.tableGrid;
    return [...doc.querySelectorAll('table')].filter(isDataTable);
  }

  /** The nearest data table containing the given element, or null. */
  async function tableForElement(el) {
    const { isDataTable } = TG.tableGrid;
    let table = el instanceof Element ? el.closest('table') : null;
    while (table && !isDataTable(table)) {
      table = table.parentElement?.closest('table') ?? null;
    }
    return table;
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
