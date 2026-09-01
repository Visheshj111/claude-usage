import { feedDetection, setApiConnected, setApiError } from '../backend/state-manager';
import { isUsableOrgId, rememberContentOrgId, resolveOrgId, sendRuntimeMessage, fetchPlanInfo } from './org-id';
import { POLLING } from '../config';
import { parseUsagePayload } from '../backend/usage-parser';
let _onUIUpdate: (() => void) | null = null;
const _postCompletionTimers = new Set<ReturnType<typeof setTimeout>>();

export function setOnUIUpdate(cb: () => void): void {
  _onUIUpdate = cb;
}

let usageFetchPromise: Promise<boolean> | null = null;

export async function fetchUsageFromAPI(explicitOrgId?: string | null, force = false): Promise<boolean> {
  if (usageFetchPromise && !force) return usageFetchPromise;
  const promise = fetchUsageFromAPIInner(explicitOrgId);
  usageFetchPromise = promise;
  try {
    return await promise;
  } finally {
    if (usageFetchPromise === promise) usageFetchPromise = null;
  }
}

async function fetchUsageFromAPIInner(explicitOrgId?: string | null): Promise<boolean> {
  const candidateOrgId = explicitOrgId ?? await resolveOrgId();
  const orgId = isUsableOrgId(candidateOrgId) ? candidateOrgId : null;
  if (!orgId) return false;
  rememberContentOrgId(orgId);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const latestHeaders = getLatestApiHeaders();
    for (const [k, v] of Object.entries(latestHeaders)) {
      headers[k] = v;
    }

    const response = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      credentials: "include",
      headers,
    });
    if (!response.ok && response.status !== 403 && response.status !== 429) {
      setApiError(response.status);
      return false;
    }

    let data: Record<string, unknown> | null = null;
    try {
      data = await response.json();
    } catch {
      // JSON parse failed
    }

    if (!data) {
      if (!response.ok) setApiError(response.status);
      else setApiConnected(false);
      return false;
    }

    const detected = parseUsagePayload(data, orgId);
    if (!detected) {
      if (!response.ok) setApiError(response.status);
      else setApiConnected(false);
      return false;
    }

    setApiConnected(true);
    feedDetection(detected);
    return true;
  } catch {
    setApiConnected(false);
    return false;
  }
}

export async function refreshUsageAndUI(force = false, explicitOrgId?: string | null): Promise<boolean> {
  const orgId = explicitOrgId ?? await resolveOrgId();
  const fetched = await fetchUsageFromAPI(orgId, force);
  if (!fetched && force) {
    await sendRuntimeMessage({ type: "FORCE_FETCH_USAGE", orgId });
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  _onUIUpdate?.();
  return fetched;
}


export function handleBgUsagePush(data: Record<string, unknown>, orgId: string): void {
  if (!isUsableOrgId(orgId)) return;
  const detected = parseUsagePayload(data, orgId);
  if (!detected) return;

  setApiConnected(true);
  rememberContentOrgId(orgId);
  feedDetection(detected);
  fetchPlanInfo(orgId);
  _onUIUpdate?.();
}

export function schedulePostCompletionUsageRefresh(orgId: string | null): void {
  if (orgId) notifyOrgIdFromWatcher(orgId);
  // Cancel any pending timers from a previous completion
  for (const t of _postCompletionTimers) clearTimeout(t);
  _postCompletionTimers.clear();

  void refreshUsageAndUI(true, orgId);
  for (const delay of POLLING.postCompletionRetries) {
    const t = setTimeout(() => {
      _postCompletionTimers.delete(t);
      void refreshUsageAndUI(true, orgId);
    }, delay);
    _postCompletionTimers.add(t);
  }
}
