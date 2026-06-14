// Message type constants shared by the service worker, content scripts, and
// extension pages (options, PDF viewer). Every message is { type, ...payload }.

export const MSG = {
  // SW -> content script
  COPY_TABLE_AT_CONTEXT: 'copy-table-at-context',
  START_REGION_SELECT: 'start-region-select',
  COPY_SELECTION_CLEAN: 'copy-selection-clean',
  COPY_SELECTION_MARKDOWN: 'copy-selection-markdown',
  COPY_LINKS: 'copy-links',
  COPY_IMAGES: 'copy-images',
  SHOW_TOAST: 'show-toast',
  CAPTURE_PREPARE: 'capture-prepare',
  CAPTURE_SCROLL_TO: 'capture-scroll-to',
  CAPTURE_RESTORE: 'capture-restore',

  // dormant table-list handlers -> content script (no current caller; see README)
  LIST_TABLES: 'list-tables',
  COPY_TABLE_BY_INDEX: 'copy-table-by-index',
  HIGHLIGHT_TABLE: 'highlight-table',

  // content script / extension pages -> SW
  LAUNCH_TEXT_GRAB: 'launch-text-grab',
  START_FULL_PAGE_CAPTURE: 'start-full-page-capture',
  REGION_SCREENSHOT: 'region-screenshot',
  REGION_SCREENSHOT_TALL: 'region-screenshot-tall',

  // PDF viewer handoff: the content script hands the PDF bytes to the SW, which
  // opens our pdf.js viewer (viewer/viewer.html) and serves the bytes back to it.
  OPEN_PDF_VIEWER: 'open-pdf-viewer',
  GET_PDF_BYTES: 'get-pdf-bytes',
};

// Select-region capture modes
export const REGION_MODE = {
  SCREENSHOT: 'screenshot',
  TEXT: 'text',
  TABLE: 'table',
};

// Table copy output formats
export const FORMAT = {
  SPREADSHEET: 'spreadsheet', // text/html table + text/plain TSV
  MARKDOWN: 'markdown',
};

// text-grab:// protocol commands (data travels via clipboard; URI is the command channel)
export const TEXT_GRAB_URI = {
  PASTE_SPREADSHEET: 'text-grab://paste-spreadsheet',
  EDIT_TEXT: 'text-grab://edit-text',
  GRAB_FRAME: 'text-grab://grab-frame',
  GRAB_TEXT: 'text-grab://grab-text',
  FULLSCREEN: 'text-grab://fullscreen',
  QUICK_LOOKUP: 'text-grab://quick-lookup',
  SETTINGS: 'text-grab://settings',
};
