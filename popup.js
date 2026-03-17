// ─────────────────────────────────────────────────────────────
// popup.js  –  Gmail Mark All As Read  (Manifest V3)
//
// Responsibilities:
//   • Validate that the active tab is Gmail
//   • Send a START message to the content script
//   • Listen for progress / status messages from the content script
//   • Update the popup UI accordingly
// ─────────────────────────────────────────────────────────────

"use strict";

// ── DOM refs ──────────────────────────────────────────────────
const btn           = document.getElementById("markRead");
const statusDot     = document.getElementById("statusDot");
const statusText    = document.getElementById("statusText");
const progressWrap  = document.getElementById("progressWrap");
const progressFill  = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");

// ── Status helper ─────────────────────────────────────────────
/**
 * Updates the status indicator in the popup.
 * @param {"idle"|"ready"|"running"|"done"|"error"|"warn"} state
 * @param {string} message  – human-readable message
 * @param {number} [pct]    – optional progress percentage (0-100)
 */
function setStatus(state, message, pct = null) {
  // Map states to dot CSS classes
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = message;

  // Show / hide progress bar
  if (state === "running") {
    progressWrap.classList.add("visible");
    if (pct !== null) {
      progressFill.style.width = `${pct}%`;
      progressLabel.textContent = `${Math.round(pct)}% complete`;
    } else {
      progressFill.style.width = "100%"; // indeterminate shimmer
      progressLabel.textContent = "Processing…";
    }
  } else {
    progressWrap.classList.remove("visible");
  }
}

// ── Validate active tab is Gmail ──────────────────────────────
async function getGmailTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith("https://mail.google.com")) {
    return null;
  }
  return tab;
}

// ── Inject content script if not already present ─────────────
// (needed when the user pins the popup before navigating to Gmail)
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch {
    // Script is already injected — safe to ignore the error.
  }
}

// ── Listen for messages from the content script ───────────────
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== "gmail-mark-read") return;

  switch (message.type) {
    case "PROGRESS":
      setStatus("running", message.text, message.pct ?? null);
      break;

    case "DONE":
      setStatus("done", `✅ ${message.text}`);
      btn.disabled = false;
      btn.querySelector(".btn-icon").textContent = "✅";
      break;

    case "ERROR":
      setStatus("error", `❌ ${message.text}`);
      btn.disabled = false;
      btn.querySelector(".btn-icon").textContent = "✅";
      break;

    case "WARN":
      setStatus("warn", `⚠️ ${message.text}`);
      btn.disabled = false;
      break;
  }
});

// ── Button click handler ──────────────────────────────────────
btn.addEventListener("click", async () => {
  const tab = await getGmailTab();

  if (!tab) {
    setStatus("warn", "Please open Gmail first, then try again.");
    return;
  }

  // Disable button to prevent double-clicks
  btn.disabled = true;
  btn.querySelector(".btn-icon").textContent = "⏳";
  setStatus("running", "Starting… selecting all emails.");

  // Make sure our content script is loaded in the tab
  await ensureContentScript(tab.id);

  // Small delay to let the script initialise if freshly injected
  await new Promise((r) => setTimeout(r, 300));

  // Send the start command to the content script
  try {
    await chrome.tabs.sendMessage(tab.id, {
      source: "gmail-mark-read-popup",
      type: "START",
    });
  } catch (err) {
    setStatus("error", "Could not reach Gmail page. Please reload Gmail and try again.");
    btn.disabled = false;
    btn.querySelector(".btn-icon").textContent = "✅";
    console.error("[Popup] sendMessage error:", err);
  }
});

// ── Initial state check ───────────────────────────────────────
(async () => {
  const tab = await getGmailTab();
  if (tab) {
    setStatus("ready", "Ready! Click the button to start.");
    statusDot.classList.add("ready");
  } else {
    setStatus("idle", "Open Gmail and click the button below.");
  }
})();
