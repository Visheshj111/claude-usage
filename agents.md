# agents.md — Claude Usage Tracker

> Guidance for AI coding assistants (and contributors) working in this repo.

## What this project is

**Claude Usage Tracker** is a Chrome/Firefox extension (Manifest V3) that tracks real-time Claude.ai usage — messages sent, token consumption, rate-limit status, and weekly quotas. It injects a floating widget into claude.ai, provides a toolbar popup, and a full historical dashboard. All data is stored locally in `chrome.storage`; nothing is sent to any external server.

---

## Repo layout

```
src/
  backend/           # Detection pipeline (shared between content script contexts)
  background/        # Service worker (persistent)
  content-script/    # Modules that run on claude.ai pages
  popup/             # Toolbar popup (HTML + CSS + TS)
  options/           # Settings page
  dashboard/         # Full historical dashboard
  inpage/            # CSS injected into claude.ai
  entry-content.ts   # Content script bootstrap
  entry-background.ts# Service worker bootstrap
  entry-injector.ts  # Injected at document_start to patch fetch/XHR
  config.ts          # Shared constants
  remote-config.ts   # Remote feature flags
  refiner.ts         # Shared composer refiner logic
  theme-boot.ts      # Theme init helper
build.mjs            # esbuild build script
manifest.json        # Extension manifest (MV3)
```

---

## Core architecture

### 1. Detection pipeline (`src/backend/`)

The detection pipeline is the heart of the extension. It uses multiple sources to determine usage and merges them using confidence scoring.

| File | Role |
|---|---|
| `tracker.ts` | Pipeline orchestrator — calls detectors in priority order |
| `dom-detector.ts` | Scans DOM for progress bars (`aria-valuenow/max`) and rate-limit banners |
| `network-monitor.ts` | Patches `fetch` and `XMLHttpRequest` to intercept quota headers from `api.anthropic.com` |
| `state-manager.ts` | Central state store — merges detections, persists state, fires change callbacks |
| `usage-parser.ts` | Parses official `/usage` API JSON responses |
| `reset-parser.ts` | Parses `Retry-After` headers into reset timestamps |
| `storage.ts` | Persistence helpers (`chrome.storage.local`) |
| `types.ts` | All shared TypeScript types (`UsageState`, `DetectedUsage`, `NetworkQuota`, etc.) |

**Detection priority / confidence:**

| Source | Confidence | When triggered |
|---|---|---|
| `network` (quota headers) | 0.95 | Every `fetch`/XHR to `api.anthropic.com` |
| `official-ui` (usage API) | 0.90 | Polled every 2 min; fast-retry for 30 s on load |
| `banner` / `dom` | 0.70–0.85 | `MutationObserver` + periodic 15 s scan |
| `estimated` (message count) | 0.30 | Fallback when no other source is available |

`feedDetection()` in `state-manager.ts` enforces a **source-priority** table (`network > official-ui > banner > estimated`) and a **5-second cooldown** to prevent low-confidence readings from thrashing high-confidence state.

### 2. Service worker (`src/background/`)

| File | Role |
|---|---|
| `init.ts` | Sets up message listeners, alarms, icon updates, and state change broadcasting |
| `webrequest.ts` | Intercepts API requests at the network level (`webRequest` permission), stashes quota data per tab, fetches `/usage` on behalf of content scripts |
| `storage.ts` | Stores historical per-day and per-hour usage buckets, session data |
| `settings.ts` | Settings defaults and persistence |
| `icon.ts` | Updates the toolbar badge (color + text) based on usage % |

### 3. Content script (`src/content-script/` + `entry-content.ts`)

Runs on every `https://claude.ai/*` page:

| Module | Role |
|---|---|
| `ui-widget.ts` | Injects and updates the floating in-page usage indicator |
| `message-scanner.ts` | Scans conversation DOM to count messages; fires `UPDATE_USAGE` to background |
| `message-listener.ts` | Listens for `submit` / keydown events to detect user messages |
| `usage-api.ts` | Polls the internal `/usage` API endpoint; updates state + UI |
| `org-id.ts` | Extracts the organisation ID needed for API calls |
| `peak-hours.ts` | Detects Anthropic peak-hour windows and feeds them into state |
| `composer-refiner.ts` | Injects refinement buttons into the Claude message composer |
| `chat-export.ts` | Exports conversations to JSON or plain text |

**`entry-injector.ts`** runs at `document_start` to monkey-patch `fetch`/`XHR` *before* page scripts execute, so quota headers are captured from the very first request.

### 4. Communication

```
Injected script  ──(DOM events)──>  Content script  ──(chrome.runtime.sendMessage)──>  Service worker
                                         ^                                                    |
                                         └──────────────(STATE_UPDATE broadcast)─────────────┘
```

**Key message types** (all sent via `chrome.runtime.sendMessage`):

| Message | Direction | Purpose |
|---|---|---|
| `CONTENT_SCRIPT_READY` | Content → Background | Triggers background to fetch usage and push it to the tab |
| `STATE_UPDATE` | Content ↔ Background | Bidirectional state sync |
| `GET_SETTINGS` / `SAVE_SETTINGS` | Content → Background | Settings CRUD |
| `GET_ALL_DATA` | Popup/Dashboard → Background | Fetch historical data + trigger usage refresh |
| `GET_WEBREQUEST_QUOTA` | Content → Background | Retrieve quota data captured by the `webRequest` interceptor |
| `FORCE_FETCH_USAGE` | Any → Background | Force an immediate `/usage` API fetch |
| `GET_ORG_ID` | Any → Background | Retrieve the stored org ID |
| `RESET_STATE` / `RESET_USAGE` | Any → Background | Clear stored data |

---

## Key data types

All defined in `src/backend/types.ts`:

- **`UsageState`** — the canonical usage snapshot (percent, remaining, reset timestamp, source, confidence, plan tier, weekly usage, rate-limit status, etc.)
- **`DetectedUsage`** — a partial `UsageState` with `confidence` and `source`, fed into `feedDetection()`
- **`NetworkQuota`** — raw quota fields parsed from HTTP response headers
- **`DataSource`** — `"network" | "official-ui" | "banner" | "estimated" | "computed" | "unknown"`

---

## Development rules

### Build & tooling

```bash
npm install          # install deps
npm run build        # esbuild → dist/
npm run watch        # rebuild on save
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run lint:fix     # auto-fix lint
npm run format       # prettier
npm run test         # vitest
npm run check        # typecheck + lint + test + build
```

Tests live in `src/backend/__tests__/`. Use **vitest** — do not introduce Jest or other test runners.

### Adding a new detection source

1. Implement detection logic that produces a `DetectedUsage` object with appropriate `source` and `confidence`.
2. Call `feedDetection(detected)` from `src/backend/state-manager.ts`.
3. Add the new `DataSource` value to the `SOURCE_PRIORITY` map in `state-manager.ts`.
4. Wire it up from `entry-content.ts` or the background service worker as appropriate.

### Modifying state

- Never mutate `UsageState` directly outside of `state-manager.ts`.
- Always call `feedDetection()` to update state — it handles merging, cooldowns, persistence, and change events.
- `getState()` is the read-only accessor.

### Adding a new message type

1. Add the handler to the `switch` block in `src/background/init.ts`.
2. Add a typed wrapper / helper in the relevant caller (content script or popup).
3. Return `true` from the listener if the response is async.

### UI components

- In-page widget: `src/content-script/ui-widget.ts` (plain DOM + CSS injected via `src/inpage/inpage.css`).
- Popup: `src/popup/` — vanilla HTML/CSS/TS, no framework.
- Dashboard: `src/dashboard/` — vanilla HTML/CSS/TS.
- Options: `src/options/` — vanilla HTML/CSS/TS.

Do **not** introduce React, Vue, or any UI framework.

### Extension permissions

Do not add new Chrome extension permissions without a clear justification. The current permission set is intentionally minimal (see `manifest.json` and the Permissions section of `README.md`).

### Privacy constraint

The extension must **never** send user data, messages, or conversation content to any external server. Only communication with `api.anthropic.com` is permitted, and only to read headers from existing requests (not to initiate new ones to third parties).

---

## Common pitfalls

- **Injector timing**: `entry-injector.ts` patches `fetch`/XHR at `document_start`. Any changes to network interception must account for the fact that the injector and the main content script run in separate contexts with no shared variables.
- **Org ID availability**: The org ID is required for `/usage` API calls. It's extracted from the `lastActiveOrg` cookie, a DOM attribute, or a custom DOM event from the watcher. Code that depends on it must handle the case where it hasn't been detected yet.
- **Cooldown in state-manager**: `feedDetection()` has a 5-second cooldown that prevents low-confidence sources from overwriting recent high-confidence state. If a source seems to be silently ignored, check confidence levels and `SOURCE_PRIORITY`.
- **Service worker lifecycle**: The background service worker can be suspended by Chrome. Do not rely on in-memory state in `background/` persisting indefinitely — use `chrome.storage.local` for anything that must survive suspension.
- **SPA navigation**: Claude.ai is a single-page app. Page "navigations" are URL changes without full reloads. `checkUrlChange()` in `message-scanner.ts` polls for URL changes every 1 second and re-initializes the relevant content script state.
