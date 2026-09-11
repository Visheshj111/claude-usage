import { DEFAULT_SETTINGS } from '../background/settings';

interface RefinerKeyResponse {
  success?: boolean;
  configured?: boolean;
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

document.addEventListener('DOMContentLoaded', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const s = (settings || {}) as Record<string, unknown>;
  const themeMode = typeof s.themeMode === 'string' ? s.themeMode : 'auto';
  applyOptionsTheme(themeMode);

  byId<HTMLSelectElement>('reset-period').value =
    typeof s.resetPeriod === 'string' ? s.resetPeriod : DEFAULT_SETTINGS.resetPeriod;
  byId<HTMLSelectElement>('token-method').value =
    typeof s.tokenEstimationMethod === 'string' ? s.tokenEstimationMethod : DEFAULT_SETTINGS.tokenEstimationMethod;
  byId<HTMLInputElement>('show-notifications').checked = s.showNotifications !== false;
  byId<HTMLInputElement>('show-inpage-widget').checked = s.showInPageWidget !== false;
  byId<HTMLInputElement>('refiner-enabled').checked = s.refinerEnabled !== false;
  byId<HTMLSelectElement>('theme-mode').value = themeMode;

  byId<HTMLButtonElement>('save-btn').addEventListener('click', () => { void saveSettings(); });
  byId<HTMLButtonElement>('save-refiner-key').addEventListener('click', () => { void saveRefinerApiKey(); });
  byId<HTMLButtonElement>('clear-refiner-key').addEventListener('click', () => { void clearRefinerApiKey(); });
  byId<HTMLButtonElement>('reset-all-btn').addEventListener('click', () => { void resetAllData(); });

  await refreshRefinerKeyStatus();
});

function applyOptionsTheme(themeMode: string): void {
  const mode = themeMode || 'auto';
  localStorage.setItem('themeMode', mode);
  const isDark = mode === 'dark' ||
    (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

function setKeyStatus(message: string): void {
  byId<HTMLElement>('refiner-key-status').textContent = message;
}

async function refreshRefinerKeyStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_REFINER_STATUS' }) as RefinerKeyResponse | undefined;
    setKeyStatus(response?.configured
      ? 'API key is ready for this browser session.'
      : 'No API key saved for this browser session.');
  } catch {
    setKeyStatus('Could not check API key status. Reload this page and try again.');
  }
}

async function saveRefinerApiKey(): Promise<void> {
  const input = byId<HTMLInputElement>('refiner-api-key');
  const button = byId<HTMLButtonElement>('save-refiner-key');
  const apiKey = input.value.trim();
  if (!apiKey) {
    setKeyStatus('Paste an Anthropic API key before saving it.');
    input.focus();
    return;
  }

  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_REFINER_API_KEY', apiKey }) as RefinerKeyResponse | undefined;
    input.value = '';
    setKeyStatus(response?.success && response.configured
      ? 'API key is ready for this browser session.'
      : 'Could not save the API key. Try again.');
  } catch {
    setKeyStatus('Could not save the API key. Reload this page and try again.');
  } finally {
    button.disabled = false;
  }
}

async function clearRefinerApiKey(): Promise<void> {
  const button = byId<HTMLButtonElement>('clear-refiner-key');
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_REFINER_API_KEY' }) as RefinerKeyResponse | undefined;
    byId<HTMLInputElement>('refiner-api-key').value = '';
    setKeyStatus(response?.success
      ? 'API key cleared for this browser session.'
      : 'Could not clear the API key. Try again.');
  } catch {
    setKeyStatus('Could not clear the API key. Reload this page and try again.');
  } finally {
    button.disabled = false;
  }
}

async function saveSettings(): Promise<void> {
  const { settings: existing } = await chrome.storage.local.get('settings');
  const existingSettings = (existing || {}) as { limits?: typeof DEFAULT_SETTINGS.limits };
  const settings = {
    resetPeriod: byId<HTMLSelectElement>('reset-period').value,
    tokenEstimationMethod: byId<HTMLSelectElement>('token-method').value,
    showNotifications: byId<HTMLInputElement>('show-notifications').checked,
    showInPageWidget: byId<HTMLInputElement>('show-inpage-widget').checked,
    refinerEnabled: byId<HTMLInputElement>('refiner-enabled').checked,
    themeMode: byId<HTMLSelectElement>('theme-mode').value,
    limits: existingSettings.limits || DEFAULT_SETTINGS.limits,
  };

  localStorage.setItem('themeMode', settings.themeMode);
  applyOptionsTheme(settings.themeMode);
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', data: settings });

  const status = byId<HTMLElement>('save-status');
  status.textContent = 'Settings saved!';
  setTimeout(() => { if (status) status.textContent = ''; }, 2_000);
}

async function resetAllData(): Promise<void> {
  if (!confirm('Permanently delete ALL tracked usage data and conversations?')) return;
  if (!confirm('This cannot be undone. Continue?')) return;

  await chrome.runtime.sendMessage({ type: 'RESET_USAGE' });

  const status = byId<HTMLElement>('save-status');
  status.textContent = 'All data deleted.';
  setTimeout(() => { if (status) status.textContent = ''; }, 3_000);
}
