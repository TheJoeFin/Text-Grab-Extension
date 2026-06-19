// Guidance shown when Text Grab is started on a file:// page but the user has
// not granted "Allow access to file URLs". Chrome blocks extensions from
// injecting into / reading local files without it, so every action silently
// no-ops; this page explains the one toggle that fixes it.

// The per-extension details page, where the "Allow access to file URLs" toggle
// lives. Built from this extension's own id so it's always correct.
const settingsUrl = `chrome://extensions/?id=${chrome.runtime.id}`;

const button = document.getElementById('open-settings');
const fallback = document.getElementById('fallback');
const urlCode = document.getElementById('settings-url');

urlCode.textContent = settingsUrl;

button.addEventListener('click', async () => {
  try {
    // Extensions may open chrome:// pages via the tabs API even though a plain
    // link to chrome:// would be blocked.
    await chrome.tabs.create({ url: settingsUrl });
  } catch {
    // Some channels disallow it; reveal the copy-able URL as a manual fallback.
    fallback.hidden = false;
  }
});
