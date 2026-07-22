<img width="327" height="598" alt="image" src="https://github.com/user-attachments/assets/c710deb4-28eb-4bb2-a23e-edf66a8129f1" />
<img width="388" height="160" alt="image" src="https://github.com/user-attachments/assets/c1ad356d-1c15-438a-9b8e-b0a4de5f0024" />
<img width="327" height="598" alt="image" src="https://github.com/user-attachments/assets/a7466d3a-e2dc-4f01-a6ee-d92994cec7ac" />


# Claude Usage Tracker

A Chrome extension that tracks your [Claude.ai](https://claude.ai) usage in real time — messages sent, conversations held, token consumption, and rate-limit status. Detects usage through multiple channels (network interception, DOM observation, and estimation) and displays the information in an unobtrusive in-page widget, a popup, and a full dashboard.

Not affiliated with Anthropic.

## Features

- **Real-time usage tracking** — monitor message count, usage percentage, and remaining messages across your Claude sessions.
- **Multi-source detection pipeline** — combines network quota headers, DOM progress bars and banners, and fallback estimation for reliable data.
- **In-page widget** — floating indicator on claude.ai showing current usage, rate-limit status, and reset countdown.
- **Popup dashboard** — quick summary of usage stats from the toolbar icon.
- **Full dashboard** — detailed historical usage data and trends.
- **Chat export** — export individual conversations or bulk export your chat history.
- **Rate-limit alerts** — desktop notifications when you approach or hit a rate limit, with a live countdown to reset.
- **Composer refinements** — inline message refinement tools within the Claude composer.
- **Peak hours detection** — identifies high-usage periods and displays them in the dashboard.
- **SPA navigation support** — automatically detects page transitions on Claude.ai (a single-page application) and re-scans for usage data.
- **Theme-aware UI** — respects system and extension-level theme preferences.
- **Settings & options** — configurable in-page widget visibility, theme mode, and usage limits.

## Installation

### From the Chrome Web Store

[Click Here](https://chromewebstore.google.com/detail/claude-usage-tracker-stat/lhmabonbcohkgnifkjhknalkekeeigko?authuser=7&hl=en-GB)

### Manual install (unpacked extension)

1. **Clone or download** this repository.
2. **Build the extension**:
   ```bash
   npm install
   npm run build
   ```
3. Open **chrome://extensions** in Chrome.
4. Enable **Developer mode** (toggle in the top right).
5. Click **Load unpacked** and select the project root directory (the `dist/` folder is written alongside `manifest.json` at the root).
6. Navigate to [claude.ai](https://claude.ai) — the usage widget should appear in the bottom-right corner.

## Build

```bash
npm install
npm run build
```

Uses [esbuild](https://esbuild.github.io/) via `build.mjs`. Output is written to `dist/`.

## Development

```bash
# Start in watch mode (re-build on file changes)
npm run watch

# Type-check
npm run typecheck

# Lint
npm run lint

# Fix lint errors
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Full check (typecheck + lint + test + build)
npm run check
```

## Project Structure

```
├── src/
│   ├── backend/               # Detection pipeline (core engine)
│   │   ├── dom-detector.ts    # Scans DOM for usage bars/banners
│   │   ├── network-monitor.ts # Intercepts fetch/XHR for quota headers
│   │   ├── state-manager.ts   # Central state store with confidence scoring
│   │   ├── tracker.ts         # Detection orchestrator / pipeline runner
│   │   ├── reset-parser.ts    # Parses retry-after headers into timestamps
│   │   ├── usage-parser.ts    # Parses official usage API responses
│   │   ├── storage.ts         # Persistence layer (chrome.storage)
│   │   └── types.ts           # Shared type definitions
│   │
│   ├── background/            # Service worker (persistent background)
│   │   ├── webrequest.ts      # WebRequest quota interception at the network level
│   │   ├── settings.ts        # Settings management & defaults
│   │   ├── storage.ts         # Background-side storage helpers
│   │   ├── icon.ts            # Badge icon updates
│   │   ├── init.ts            # Service worker initialization
│   │   └── types.ts           # Background-specific types
│   │
│   ├── content-script/        # Runs on claude.ai pages
│   │   ├── ui-widget.ts       # In-page floating widget (DOM injection & updates)
│   │   ├── message-scanner.ts # Scans conversation message DOM
│   │   ├── message-listener.ts# Listens for user message events
│   │   ├── chat-export.ts     # Export chat to JSON/text
│   │   ├── composer-refiner.ts# Inline refinement buttons in the composer
│   │   ├── usage-api.ts       # Official usage API polling
│   │   ├── org-id.ts          # Organization ID detection
│   │   ├── peak-hours.ts      # Peak usage time tracking
│   │   └── state.ts           # Content-script tracking state
│   │
│   ├── popup/                 # Toolbar popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.ts
│   │
│   ├── options/               # Options / settings page
│   │   ├── options.html
│   │   ├── options.css
│   │   └── options.ts
│   │
│   ├── dashboard/             # Full usage dashboard
│   │   ├── dashboard.html
│   │   ├── dashboard.css
│   │   └── dashboard.ts
│   │
│   ├── inpage/                # Injected page-level resources
│   │   └── inpage.css         # Styles injected into claude.ai
│   │
│   ├── entry-content.ts       # Content script entry point
│   ├── entry-background.ts    # Background service worker entry
│   ├── entry-injector.ts      # Script injector (runs at document_start)
│   ├── config.ts              # Shared configuration
│   ├── remote-config.ts       # Remote configuration fetching
│   ├── refiner.ts             # Shared refiner logic
│   └── theme-boot.ts          # Theme initialization
│
├── dist/                      # Build output (gitignored)
├── build.mjs                  # esbuild build script
├── manifest.json              # Chrome extension manifest (V3)
├── package.json
├── tsconfig.json
└── eslint.config.js
```

## Architecture

### State management

Usage data flows through a centralized state manager (`src/backend/state-manager.ts`). Every detection source feeds into it via `feedDetection()`. Each detection carries a `confidence` score (0–1) and a `source` label (`"network"`, `"dom"`, `"banner"`, `"official-ui"`, or `"estimated"`). The state manager merges incoming data, preferring higher-confidence sources and preserving existing values when a lower-confidence update is received.

### Detection pipeline

The tracker (`src/backend/tracker.ts`) orchestrates detection in priority order:

1. **Network interception** — intercepts `fetch()` and `XMLHttpRequest` calls to `api.anthropic.com` and reads rate-limit / quota headers (`X-Shape-RateLimit-Remaining`, `X-Shape-RateLimit-Reset`, etc.). Highest confidence (0.95).
2. **DOM detection** — scans claude.ai pages for progress bars, `aria-valuenow`/`aria-valuemax` attributes, and rate-limit banners. Moderate confidence (0.7–0.85).
3. **Official usage API** — polls the internal usage API endpoint for plan-level quota data. High confidence (0.9).
4. **Estimation fallback** — counts messages in the DOM and divides by a known plan limit. Lowest confidence (0.3), used only when no other source provides data.

A `MutationObserver` triggers re-detection on DOM changes, and a periodic interval (every 15 seconds) ensures stale states are cleared.

### Communication

- **Content script ↔ Background**: Chrome runtime messages (`STATE_UPDATE`, `GET_SETTINGS`, `CONTENT_SCRIPT_READY`, `GET_WEBREQUEST_QUOTA`).
- **Injected script ↔ Content script**: Custom DOM events for org ID and completion notifications.
- **Cross-context**: The injector script (`entry-injector.ts`) runs at `document_start` to patch `fetch`/`XHR` before page scripts execute, then the main content script initializes at `document_idle`.

## Permissions

| Permission | Reason |
|-----------|--------|
| `storage` | Persist usage data, settings, and local state across sessions. |
| `notifications` | Show desktop notifications when rate limits are reached. |
| `alarms` | Schedule periodic background checks and countdown updates. |
| `activeTab` | Access the current tab when the popup is opened. |
| `cookies` | Read authentication cookies to verify logged-in status on claude.ai. |
| `webRequest` | Intercept network requests to `api.anthropic.com` for quota header detection. |
| `https://claude.ai/*` | Run content scripts and access the Claude.ai page. |
| `https://api.anthropic.com/*` | Intercept API requests for usage quota headers. |

## Privacy

All data is processed and stored **locally** in your browser's `chrome.storage`. No usage data, messages, or personal information is sent to any external server. The extension only communicates with `api.anthropic.com` to read quota headers from existing requests (it does not initiate its own network requests to Anthropic).

## Chrome Web Store

[Link to Chrome Web Store](https://chromewebstore.google.com/detail/claude-usage-tracker-stat/lhmabonbcohkgnifkjhknalkekeeigko?authuser=7&hl=en-GB)

## License

[MIT](LICENSE)
