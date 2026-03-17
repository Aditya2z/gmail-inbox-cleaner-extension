"use strict";

const btnStart  = document.getElementById("btnStart");
const btnStop   = document.getElementById("btnStop");
const dot       = document.getElementById("dot");
const statusTxt = document.getElementById("statusText");
const progress  = document.getElementById("progress");
const progLabel = document.getElementById("progLabel");

function setStatus(state, msg) {
  dot.className = "dot " + state;
  statusTxt.textContent = msg;
  const running = state === "running";
  progress.classList.toggle("on", running);
  btnStart.disabled = running;
  btnStop.disabled  = !running;
  if (!running) progLabel.textContent = "";
}

// Receive live updates from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== "gmail-mark-read") return;
  switch (msg.type) {
    case "PROGRESS": setStatus("running", msg.text); progLabel.textContent = msg.text; break;
    case "DONE":     setStatus("done",    "✅ " + msg.text); break;
    case "STOPPED":  setStatus("stopped", "⏹ Stopped by user."); break;
    case "ERROR":    setStatus("error",   "❌ " + msg.text); break;
    case "WARN":     setStatus("warn",    "⚠️ " + msg.text); break;
  }
});

async function getGmailTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith("https://mail.google.com") ? tab : null;
}

async function ensureScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch { /* already injected */ }
}

btnStart.addEventListener("click", async () => {
  const tab = await getGmailTab();
  if (!tab) { setStatus("warn", "Please open Gmail first."); return; }

  setStatus("running", "Starting…");
  await ensureScript(tab.id);
  await new Promise(r => setTimeout(r, 300));

  try {
    await chrome.tabs.sendMessage(tab.id, { source: "gmail-mark-read-popup", type: "START" });
  } catch {
    setStatus("error", "Could not reach Gmail. Reload Gmail and try again.");
  }
});

btnStop.addEventListener("click", async () => {
  const tab = await getGmailTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { source: "gmail-mark-read-popup", type: "STOP" });
  } catch { /* ignore */ }
  setStatus("stopped", "⏹ Stop requested…");
});

// Initial state
(async () => {
  const tab = await getGmailTab();
  setStatus(tab ? "ready" : "idle", tab ? "Ready. Click Start." : "Open Gmail first.");
})();
