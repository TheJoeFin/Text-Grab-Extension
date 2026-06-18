import { getSettings, saveSettings } from '../lib/settings.js';

const checkboxIds = ['flattenCellNewlines', 'ignoreEmptyRowsCols', 'sendToTextGrab'];
const savedEl = document.getElementById('saved');
let savedTimer;

// Briefly flash the "Saved" pill after any change is persisted.
function flashSaved() {
  savedEl.style.visibility = 'visible';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (savedEl.style.visibility = 'hidden'), 1500);
}

// Text Grab is a Windows-only app reached via text-grab://; hide its toggle
// where the handoff can't work.
const { os } = await chrome.runtime.getPlatformInfo();
if (os !== 'win') {
  document.getElementById('sendToTextGrab').closest('label').style.display = 'none';
}

const settings = await getSettings();
for (const id of checkboxIds) {
  const checkbox = document.getElementById(id);
  checkbox.checked = Boolean(settings[id]);
  checkbox.addEventListener('change', async () => {
    await saveSettings({ [id]: checkbox.checked });
    flashSaved();
  });
}

// Table/list copy format (segmented radio group).
for (const radio of document.querySelectorAll('input[name="tableFormat"]')) {
  radio.checked = radio.value === settings.tableFormat;
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    await saveSettings({ tableFormat: radio.value });
    flashSaved();
  });
}
