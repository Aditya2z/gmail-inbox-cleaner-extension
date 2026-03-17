# Gmail Mark All As Read — Chrome Extension

> A **Manifest V3** Chrome extension that automatically marks every unread Gmail
> email as read across **all pages** of your inbox — with a single click.

---

## 📁 Folder Structure

```
gmail-mark-read-extension/
├── manifest.json   — Extension configuration (MV3)
├── popup.html      — Popup UI (button + status display)
├── popup.js        — Popup logic & messaging
├── content.js      — Gmail automation engine
└── README.md       — This file
```

---

## 🚀 Installation (Load Unpacked)

1. **Download / clone** this folder to your computer.

2. Open **Google Chrome** and navigate to:
   ```
   chrome://extensions
   ```

3. Enable **Developer mode** (toggle in the top-right corner).

4. Click **"Load unpacked"**.

5. Select the `gmail-mark-read-extension/` folder.

6. The extension icon will appear in your Chrome toolbar.  
   *(Pin it via the puzzle-piece icon for easy access.)*

---

## 🖱️ How to Use

1. Open **[Gmail](https://mail.google.com)** in your browser.
2. Click the **extension icon** in the toolbar.
3. Click **"Mark All As Read"**.
4. Watch the status bar — it will update as each page is processed.
5. Keep the Gmail tab open and visible until the process completes.

> **Tip:** For very large inboxes (1000+ emails), the process may take a minute
> or two. The popup shows live progress.

---

## ⚙️ How It Works (Technical)

### Architecture

```
popup.html / popup.js
       │
       │  chrome.tabs.sendMessage({ type: "START" })
       ▼
  content.js  (injected into mail.google.com)
       │
       ├─ selectAllOnPage()     → clicks Select-All checkbox
       ├─ markSelectedAsRead()  → opens "More" menu → "Mark as read"
       ├─ hasUnreadEmails()     → checks for bold (unread) rows
       └─ goToNextPage()        → clicks the "Older" pagination arrow
             │
             └─ loops until no unread emails remain
       │
       │  chrome.runtime.sendMessage({ type: "PROGRESS" | "DONE" | "ERROR" })
       ▼
  popup.js  → updates UI status bar
```

### Gmail DOM Selectors Explained

Gmail uses **obfuscated, unstable CSS class names** that change frequently.
This extension uses **semantic / attribute selectors** that are tied to
Gmail's accessibility structure and are much more resilient to updates:

| Element | Selector Used | Why It's Stable |
|---|---|---|
| Select-All checkbox | `div.T-Jo-auh[role="checkbox"]` | `role` attribute is part of ARIA spec |
| "More" toolbar button | `div[data-tooltip="More"]` | `data-tooltip` is authored content |
| "Mark as read" menu item | `[role="menuitem"]` + text match | Role + inner text content |
| Unread email row | `tr.zA.zE` | `.zA` = email row, `.zE` = unread state |
| Older-page button | `div[data-tooltip="Older"]` | Pagination tooltip is stable |

> **Note:** Gmail regularly A/B tests its UI. If the extension stops working,
> open DevTools → Elements, inspect the relevant button, and update the selector
> constant at the top of `content.js`.

### Timing & Delays

Gmail's UI is **heavily dynamic** — clicking a checkbox doesn't immediately
reveal the toolbar options. The extension uses configurable delays to
avoid race conditions:

```js
// In content.js — top of file
const CONFIG = {
  STEP_DELAY:    900,   // ms between actions (increase if Gmail is slow)
  NAV_DELAY:    2200,   // ms to wait after page navigation
  DOM_SETTLE:    800,   // ms for DOM to stabilize on load
  MAX_RETRIES:     6,   // retry attempts per selector lookup
  RETRY_INTERVAL: 600,  // ms between retries
};
```

Increase `STEP_DELAY` and `NAV_DELAY` if you're on a slow connection.

### Retry Logic

`waitForElement(selector, retries)` polls the DOM every `RETRY_INTERVAL`ms
up to `MAX_RETRIES` times before giving up. This handles Gmail loading
toolbar controls asynchronously after checkbox selection.

If "Mark as read" is not found on the first attempt, the script waits an
extra `STEP_DELAY * 2` ms and retries once more before reporting an error.

### Loop Termination Conditions

The main loop stops when **any** of the following is true:

- Two consecutive pages have zero unread emails.
- The "Older" pagination button is absent or disabled (last page reached).
- A critical DOM element cannot be found after all retries.

---

## 🔒 Permissions Explained

| Permission | Why It's Needed |
|---|---|
| `activeTab` | Read the URL of the current tab to verify it's Gmail |
| `scripting` | Inject `content.js` into the Gmail tab programmatically |
| `host_permissions: https://mail.google.com/*` | Allow content script execution on Gmail |

This extension requests **no network permissions**, **no storage**, and
does **not transmit any data** anywhere.

---

## 🛠️ Troubleshooting

| Symptom | Fix |
|---|---|
| Button does nothing | Make sure you have Gmail open as the active tab |
| "Could not select emails" | Gmail may have updated its UI — check selector in `content.js` |
| Emails still unread after running | Run the extension again (large inboxes may need multiple passes) |
| Extension doesn't appear | Reload via `chrome://extensions` → click the refresh icon |
| "Could not reach Gmail page" | Reload Gmail and try again |

---

## 🧩 Compatibility

- ✅ Chrome 100+ (Manifest V3)
- ✅ Gmail Standard View
- ❌ Gmail "Inbox" / Priority Inbox tabs (run from "All Mail" for best results)
- ❌ Multiple Gmail accounts in the same window (use separate Chrome profiles)

---

## 📝 Changelog

### v1.0.0
- Initial release
- Multi-page inbox support
- Live progress updates in popup
- Retry logic with configurable delays
- Semantic DOM selectors for Gmail stability
