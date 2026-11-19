import { DEFAULT_SETTINGS } from '../background/settings';
import {
  detectRefinerProvider,
  isRefinerProvider,
  REFINER_PROVIDERS,
  RefinerConfigError,
  refinerHostPermission,
  resolveRefinerConfig,
  type RefinerConfig,
} from '../refiner';

let savedRefinerConfig: RefinerConfig | undefined;
let providerChosenManually = false;

interface RefinerKeyResponse {
  success?: boolean;
  configured?: boolean;
  config?: RefinerConfig;
  error?: string;
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

  byId<HTMLButtonElement>('save-btn').addEventListener('click', () => {
    void saveSettings();
  });
  byId<HTMLButtonElement>('save-refiner-key').addEventListener('click', () => {
    void saveRefinerApiKey();
  });
  byId<HTMLButtonElement>('clear-refiner-key').addEventListener('click', () => {
    void clearRefinerApiKey();
  });
  byId<HTMLButtonElement>('reset-all-btn').addEventListener('click', () => {
    void resetAllData();
  });

  byId<HTMLInputElement>('refiner-api-key').addEventListener('input', () => {
    if (!providerChosenManually) {
      const select = byId<HTMLSelectElement>('refiner-provider');
      const detected = detectRefinerProvider(byId<HTMLInputElement>('refiner-api-key').value);
      if (select.value !== (detected || '')) {
        select.value = detected || '';
        syncRefinerProvider(true);
      }
    }
    setKeyStatus('Confirm the service above, then click Save key.');
  });
  byId<HTMLSelectElement>('refiner-provider').addEventListener('change', () => {
    providerChosenManually = !!byId<HTMLSelectElement>('refiner-provider').value;
    syncRefinerProvider(true);
    setKeyStatus('Click Save key to apply this service.');
  });
  byId<HTMLInputElement>('refiner-model').addEventListener('input', () => syncRefinerProvider(false));
  await refreshRefinerKeyStatus();
});

function applyOptionsTheme(themeMode: string): void {
  const mode = themeMode || 'auto';
  localStorage.setItem('themeMode', mode);
  const isDark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

function setKeyStatus(message: string): void {
  byId<HTMLElement>('refiner-key-status').textContent = message;
}

function syncRefinerProvider(resetModel: boolean): void {
  const provider = byId<HTMLSelectElement>('refiner-provider').value;
  const preset = isRefinerProvider(provider) ? REFINER_PROVIDERS[provider] : undefined;
  const model = byId<HTMLInputElement>('refiner-model');
  if (resetModel) {
    model.value = '';
    byId<HTMLInputElement>('refiner-base-url').value = '';
  }
  model.placeholder = preset?.model || 'Model name from your service';
  byId<HTMLElement>('refiner-custom-url').hidden = provider !== 'custom';
  if (resetModel) byId<HTMLDetailsElement>('refiner-advanced').open = provider === 'custom';
  byId<HTMLElement>('refiner-advanced-label').textContent =
    provider === 'custom' ? 'Advanced — required for other services' : 'Advanced (optional)';
  const customModel = model.value.trim() && model.value.trim() !== preset?.model;
  const destination = preset?.baseUrl ? `Drafts go to ${new URL(preset.baseUrl).hostname}. ` : '';
  byId<HTMLElement>('refiner-provider-note').textContent = preset
    ? destination +
      (customModel && provider !== 'custom'
        ? 'Using your chosen model. Its pricing, availability, and limits apply.'
        : preset.note)
    : 'Choose the service where you created the key.';
}

function showSavedRefiner(config: RefinerConfig): void {
  savedRefinerConfig = config;
  byId<HTMLSelectElement>('refiner-provider').value = config.provider;
  byId<HTMLInputElement>('refiner-model').value =
    config.model === REFINER_PROVIDERS[config.provider].model ? '' : config.model;
  byId<HTMLInputElement>('refiner-base-url').value = config.provider === 'custom' ? config.baseUrl : '';
  byId<HTMLInputElement>('refiner-api-key').placeholder = 'Key saved — paste here to replace it';
  syncRefinerProvider(false);
  if (config.provider === 'custom') byId<HTMLDetailsElement>('refiner-advanced').open = true;
}

async function refreshRefinerKeyStatus(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'GET_REFINER_STATUS' })) as
      RefinerKeyResponse | undefined;
    if (response?.configured && response.config) showSavedRefiner(resolveRefinerConfig('', response.config));
    setKeyStatus(
      response?.configured
        ? 'Key saved for this session. Open Claude.ai and click ✦ Refine.'
        : 'No key saved yet. Paste one above to get started.',
    );
  } catch {
    setKeyStatus('Could not check the saved setup. Paste your key and save again.');
  } finally {
    byId<HTMLFieldSetElement>('refiner-setup').disabled = false;
  }
}

async function saveRefinerApiKey(): Promise<void> {
  const input = byId<HTMLInputElement>('refiner-api-key');
  const setup = byId<HTMLFieldSetElement>('refiner-setup');
  const apiKey = input.value.trim();
  if (!apiKey && !savedRefinerConfig) {
    setKeyStatus('Paste an API key before saving.');
    input.focus();
    return;
  }

  try {
    const provider = byId<HTMLSelectElement>('refiner-provider').value;
    const config = resolveRefinerConfig(apiKey, {
      provider,
      model: byId<HTMLInputElement>('refiner-model').value,
      ...(provider === 'custom' ? { baseUrl: byId<HTMLInputElement>('refiner-base-url').value } : {}),
    });
    if (
      !apiKey &&
      (config.provider !== savedRefinerConfig?.provider || config.baseUrl !== savedRefinerConfig?.baseUrl)
    ) {
      throw new RefinerConfigError('Paste a key for the new service or API address before saving.');
    }
    setup.disabled = true;
    // Keep this as the first asynchronous call so Chrome retains the user gesture.
    const granted = await chrome.permissions.request({ origins: [refinerHostPermission(config)] });
    if (!granted) {
      setKeyStatus('Permission was not granted. Click Save key and allow access to use this service.');
      return;
    }
    const response = (await chrome.runtime.sendMessage({ type: 'SAVE_REFINER_API_KEY', apiKey, config })) as
      RefinerKeyResponse | undefined;
    if (response?.success && response.configured && response.config) {
      input.value = '';
      showSavedRefiner(response.config);
      setKeyStatus('Key saved for this session. Open Claude.ai and click ✦ Refine.');
    } else {
      setKeyStatus(response?.error || 'Could not save the key. Try again.');
    }
  } catch (error) {
    setKeyStatus(
      error instanceof RefinerConfigError
        ? error.message
        : 'Could not save the key. Reload extension settings and try again.',
    );
  } finally {
    setup.disabled = false;
  }
}

async function clearRefinerApiKey(): Promise<void> {
  const setup = byId<HTMLFieldSetElement>('refiner-setup');
  setup.disabled = true;
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'CLEAR_REFINER_API_KEY' })) as
      RefinerKeyResponse | undefined;
    if (response?.success) {
      savedRefinerConfig = undefined;
      providerChosenManually = false;
      byId<HTMLInputElement>('refiner-api-key').value = '';
      byId<HTMLInputElement>('refiner-api-key').placeholder = 'Paste your key here';
      byId<HTMLSelectElement>('refiner-provider').value = '';
      syncRefinerProvider(true);
    }
    setKeyStatus(
      response?.success ? 'API key cleared for this browser session.' : 'Could not clear the API key. Try again.',
    );
  } catch {
    setKeyStatus('Could not clear the API key. Reload this page and try again.');
  } finally {
    setup.disabled = false;
  }
}

async function saveSettings(): Promise<void> {
  const button = byId<HTMLButtonElement>('save-btn');
  const status = byId<HTMLElement>('save-status');
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = 'Saving preferences…';
  try {
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

    const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', data: settings });
    if (!response?.success) throw new Error('Settings not saved');
    applyOptionsTheme(settings.themeMode);
    status.textContent = 'Settings saved. You’re all set.';
  } catch {
    status.textContent = 'Could not save preferences. Your changes are still here—try again.';
  } finally {
    button.disabled = false;
  }
}

async function resetAllData(): Promise<void> {
  if (!confirm('Permanently delete ALL tracked usage data and conversations?')) return;
  if (!confirm('This cannot be undone. Continue?')) return;

  const button = byId<HTMLButtonElement>('reset-all-btn');
  const status = byId<HTMLElement>('save-status');
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'RESET_USAGE' });
    if (!response?.success) throw new Error('Deletion failed');
    status.textContent = 'Local usage history deleted.';
  } catch {
    status.textContent = 'Could not delete local history. Try again.';
  } finally {
    button.disabled = false;
  }
}
