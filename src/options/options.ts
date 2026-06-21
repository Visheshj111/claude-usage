export {};

document.addEventListener('DOMContentLoaded', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const s = settings || {};
  const themeMode = s.themeMode || 'auto';
  applyOptionsTheme(themeMode);

  document.getElementById('limit-messages').value = s.limits?.dailyMessages ?? 45;
  document.getElementById('limit-tokens').value = s.limits?.dailyTokens ?? 90000;
  document.getElementById('reset-period').value = s.resetPeriod || '5h';
  document.getElementById('token-method').value = s.tokenEstimationMethod || 'chars/4';
  document.getElementById('show-notifications').checked = s.showNotifications !== false;
  document.getElementById('theme-mode').value = themeMode;

  document.getElementById('save-btn').addEventListener('click', saveSettings);
  document.getElementById('reset-all-btn').addEventListener('click', resetAllData);
});

function applyOptionsTheme(themeMode) {
  const mode = themeMode || 'auto';
  localStorage.setItem('themeMode', mode);
  const isDark = mode === 'dark' ||
    (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

async function saveSettings() {
  const { settings: existing } = await chrome.storage.local.get('settings');
  const settings = {
    resetPeriod: document.getElementById('reset-period').value,
    tokenEstimationMethod: document.getElementById('token-method').value,
    showNotifications: document.getElementById('show-notifications').checked,
    themeMode: document.getElementById('theme-mode').value,
    limits: {
      dailyMessages: parseInt(document.getElementById('limit-messages').value, 10) || 45,
      dailyTokens: parseInt(document.getElementById('limit-tokens').value, 10) || 90000,
      sessionWindowMs: existing?.limits?.sessionWindowMs ?? (5 * 60 * 60 * 1000),
    },
  };

  localStorage.setItem('themeMode', settings.themeMode);
  applyOptionsTheme(settings.themeMode);
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', data: settings });

  const status = document.getElementById('save-status');
  status.textContent = 'Settings saved!';
  setTimeout(() => { status.textContent = ''; }, 2000);
}

async function resetAllData() {
  if (!confirm('Permanently delete ALL tracked usage data and conversations?')) return;
  if (!confirm('This cannot be undone. Continue?')) return;

  await chrome.runtime.sendMessage({ type: 'RESET_USAGE' });

  const status = document.getElementById('save-status');
  status.textContent = 'All data deleted.';
  setTimeout(() => { status.textContent = ''; }, 3000);
}
