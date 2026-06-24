export {};

document.addEventListener('DOMContentLoaded', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const s: any = settings || {};
  const themeMode = s.themeMode || 'auto';
  applyOptionsTheme(themeMode);

  (document.getElementById('limit-messages') as HTMLInputElement).value = s.limits?.dailyMessages ?? 45;
  (document.getElementById('limit-tokens') as HTMLInputElement).value = s.limits?.dailyTokens ?? 90000;
  (document.getElementById('reset-period') as HTMLSelectElement).value = s.resetPeriod || '5h';
  (document.getElementById('token-method') as HTMLSelectElement).value = s.tokenEstimationMethod || 'chars/4';
  (document.getElementById('show-notifications') as HTMLInputElement).checked = s.showNotifications !== false;
  (document.getElementById('refiner-enabled') as HTMLInputElement).checked = s.refinerEnabled === true;
  (document.getElementById('anthropic-api-key') as HTMLInputElement).value = s.anthropicApiKey || '';
  (document.getElementById('theme-mode') as HTMLSelectElement).value = themeMode;

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
  const existingSettings: any = existing || {};
  const settings = {
    resetPeriod: (document.getElementById('reset-period') as HTMLSelectElement).value,
    tokenEstimationMethod: (document.getElementById('token-method') as HTMLSelectElement).value,
    showNotifications: (document.getElementById('show-notifications') as HTMLInputElement).checked,
    refinerEnabled: (document.getElementById('refiner-enabled') as HTMLInputElement).checked,
    anthropicApiKey: (document.getElementById('anthropic-api-key') as HTMLInputElement).value,
    themeMode: (document.getElementById('theme-mode') as HTMLSelectElement).value,
    limits: {
      dailyMessages: parseInt((document.getElementById('limit-messages') as HTMLInputElement).value, 10) || 45,
      dailyTokens: parseInt((document.getElementById('limit-tokens') as HTMLInputElement).value, 10) || 90000,
      sessionWindowMs: existingSettings.limits?.sessionWindowMs ?? (5 * 60 * 60 * 1000),
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
