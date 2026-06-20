// Settings stored in chrome.storage.sync with defaults.
//
// ES module imported by the options page, the PDF viewer, and the service
// worker. It is NOT injected into web pages — the content script defines its
// own thin TG.settings using DEFAULT_SETTINGS relayed via the tg-constants
// message, so this stays the single source of truth for the defaults.

export const DEFAULT_SETTINGS = {
  flattenCellNewlines: false,  // true: <br> in cells becomes a space in TSV; false: quoted multi-line cells
  ignoreEmptyRowsCols: false,  // true: drop all-blank rows and columns from copied tables/lists
  tableFormat: 'spreadsheet',  // copied table/list layout: 'spreadsheet' (Returns & Tab), 'markdown', or 'html'. Overridden to 'spreadsheet' when sending to Text Grab.
  sendToTextGrab: true,        // show "Send to Text Grab" actions
  regionMode: 'table',         // last used select-region mode; defaults to table grab
  regionSendToTextGrab: false, // region Text/Table results: true opens Text Grab, false copies only
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(partial) {
  await chrome.storage.sync.set(partial);
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const updated = {};
    for (const [key, { newValue }] of Object.entries(changes)) updated[key] = newValue;
    callback(updated);
  });
}
