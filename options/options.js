import { getSettings, saveSettings } from '../lib/settings.js';

const checkboxIds = ['flattenCellNewlines', 'sendToTextGrab'];
const savedEl = document.getElementById('saved');
let savedTimer;

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
    savedEl.style.visibility = 'visible';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (savedEl.style.visibility = 'hidden'), 1500);
  });
}
