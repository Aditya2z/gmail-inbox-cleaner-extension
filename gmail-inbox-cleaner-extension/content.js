// ─────────────────────────────────────────────────────────────
// content.js  –  Gmail Mark All As Read  (Manifest V3)
// Uses exact selectors confirmed from the live Gmail DOM.
// ─────────────────────────────────────────────────────────────

// Double-injection guard
if (window.__gmrLoaded) {
  console.log("[GmailMarkRead] Already loaded.");
} else {
  window.__gmrLoaded = true;
  window.__gmrStop   = false;   // flipped to true when user clicks Stop
  initMarkRead();
}

function initMarkRead() {
  "use strict";

  const DELAY = {
    // Keep a consistent buffer between steps (requested).
    BUFFER: 100,
    // Polling cadence for "wait until condition is true".
    POLL: 250,
    // Upper bound so we never wait forever (not used as "execution timer").
    MAX_POLLS: 16, // 16 × 250ms = 4s max wait per condition
  };

  // ── Helpers ─────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const buffer = () => sleep(DELAY.BUFFER);

  function log(...a) { console.log("[GmailMarkRead]", ...a); }

  function post(type, text) {
    try { chrome.runtime.sendMessage({ source: "gmail-mark-read", type, text }); }
    catch { /* popup closed */ }
    log(`[${type}]`, text);
  }

  /** Returns true if the user has clicked Stop. */
  function stopped() {
    if (window.__gmrStop) { log("Stop flag detected."); return true; }
    return false;
  }

  function safeClick(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
    el.click();
  }

  function anyRowSelected() {
    // Gmail selection state varies by experiment; keep this broad.
    return !!document.querySelector('tr.zA[aria-checked="true"], tr.zA.x7, tr.zA.PE');
  }

  function findMarkAsReadButtonVisible() {
    // Returns the visible Mark-as-Read button if present, else null.
    const byTooltip = document.querySelector('[data-tooltip="Mark as read"]');
    if (byTooltip && byTooltip.offsetParent !== null) return byTooltip;

    const byLabel = document.querySelector('[aria-label="Mark as read"]');
    if (byLabel && byLabel.offsetParent !== null) return byLabel;

    const candidates = [...document.querySelectorAll('div[role="button"][act="1"]')];
    return candidates.find((e) => e.offsetParent !== null) || null;
  }

  async function waitForSelection() {
    // Fast polling wait (keeps the flow synchronous without MutationObserver overhead).
    for (let i = 0; i < DELAY.MAX_POLLS; i++) {
      if (anyRowSelected()) return true;
      await sleep(DELAY.POLL);
    }
    return false;
  }

  /** Poll fn() until truthy, up to MAX_POLLS times. */
  async function poll(fn) {
    for (let i = 0; i < DELAY.MAX_POLLS; i++) {
      const v = fn();
      if (v) return v;
      await sleep(DELAY.POLL);
    }
    return null;
  }

  // ── SELECT ALL ───────────────────────────────────────────────
  // The checkbox is:  <div class="T-Jo-auh" role="presentation">
  // The actual click target is the ::after pseudo-element on that div —
  // clicking the div itself is sufficient for the ::after to register.

  async function selectAll() {
    // Wait for the checkbox container to appear
    const cb = await poll(() => document.querySelector('div.T-Jo-auh[role="presentation"]'));

    if (!cb) {
      log("Select-All div not found.");
      return false;
    }

    log("Found Select-All div:", cb.className);
    // Click and then wait for any selection to appear. Retry once if needed.
    safeClick(cb);
    await buffer();

    let selected = await waitForSelection();
    if (!selected) {
      // Sometimes Gmail enables the toolbar action without updating our selection markers.
      // Only retry Select-All if the Mark-as-Read action is still not available.
      const btn = findMarkAsReadButtonVisible();
      if (btn) {
        log("Selection markers not detected, but Mark-as-Read is visible — proceeding without retry.");
        return true;
      }

      log("No selection detected and Mark-as-Read not visible — retrying Select-All once.");
      safeClick(cb);
      await buffer();
      selected = await waitForSelection();
    }

    log("Any row selected after Select-All:", selected);
    return selected;
  }

  // ── MARK AS READ ─────────────────────────────────────────────
  // Exact confirmed button from live DOM:
  //   <div data-tooltip="Mark as read" aria-label="Mark as read" act="1" ...>
  // NOTE: act="1" in the toolbar (not act="568" which is in the dropdown).

  async function markAsRead() {
    // Enforce sequence: don't proceed until selection OR the toolbar action is available.
    // This avoids slow/false-negative selection detection while still keeping ordering correct.
    let ready = anyRowSelected() || !!findMarkAsReadButtonVisible();
    if (!ready) {
      for (let i = 0; i < DELAY.MAX_POLLS; i++) {
        if (anyRowSelected() || !!findMarkAsReadButtonVisible()) { ready = true; break; }
        await sleep(DELAY.POLL);
      }
    }
    if (!ready) {
      log("Selection not detected and Mark-as-Read not available — skipping click.");
      return false;
    }

    // Wait for the button to appear (it only shows after rows are selected)
    const btn = await poll(() => {
      return findMarkAsReadButtonVisible();
    });

    if (!btn) {
      log("Mark-as-Read button not found or not visible.");
      return false;
    }

    log("Found Mark-as-Read button:", btn.getAttribute("data-tooltip") || btn.className);
    safeClick(btn);
    await buffer();
    return true;
  }

  // ── PAGE NAVIGATION ──────────────────────────────────────────

  function getRangeText() {
    // Gmail typically shows a range like "1–50 of 2,345" in the toolbar.
    // This changes reliably on paging even when rows are virtualized/reused.
    const candidates = [
      // Most specific: the "Show more messages" range button contains span.Dj
      'div[role="button"][aria-label*="Show more messages"] span.Dj',
      // Common toolbar container class (can vary, but tends to include the range)
      "div.amH span.Dj",
      // Broad fallback
      "span.Dj",
      'div[role="main"] span[aria-label*="of"]',
      'div[role="main"] *[aria-label*="of"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      const txt = el?.textContent?.trim();
      if (txt && txt.length <= 40) return txt;
    }
    return "";
  }

  function rowSnapshot() {
    const rows = [...document.querySelectorAll("tr.zA")];
    const firstRowKey =
      rows[0]?.id ||
      rows[0]?.getAttribute("data-legacy-thread-id") ||
      rows[0]?.querySelector("span")?.textContent?.trim()?.slice(0, 60) ||
      "";
    const lastRowKey =
      rows.at(-1)?.id ||
      rows.at(-1)?.getAttribute("data-legacy-thread-id") ||
      rows.at(-1)?.querySelector("span")?.textContent?.trim()?.slice(0, 60) ||
      "";

    // Include range text so we can detect page changes even if DOM nodes are reused.
    return `${getRangeText()}|n=${rows.length}|f=${firstRowKey}|l=${lastRowKey}`;
  }

  async function waitForRangeChange(beforeRange) {
    // Primary "page changed" detector: range text changes (e.g., "1–50 of …" → "51–100 of …").
    // This is synchronous in the sense that we only proceed once the condition is met.
    for (let i = 0; i < DELAY.MAX_POLLS; i++) {
      const now = getRangeText();
      if (now && now !== beforeRange) return true;
      await sleep(DELAY.POLL);
    }
    return false;
  }

  async function waitForPageReady(beforeRange) {
    // Wait for rows and (ideally) range text change.
    await poll(() => document.querySelector("tr.zA"));
    if (!beforeRange) return true;
    const changed = await waitForRangeChange(beforeRange);
    if (changed) return true;
    // Fallback: if range text is missing or unchanged, use snapshot change.
    const beforeSnap = rowSnapshot();
    for (let i = 0; i < Math.max(10, Math.floor(DELAY.MAX_POLLS / 3)); i++) {
      const now = rowSnapshot();
      if (now && now !== beforeSnap) return true;
      await sleep(DELAY.POLL);
    }
    return false;
  }

  async function goOlder() {
    const OLDER = [
      'div[data-tooltip="Older"]',
      'div[aria-label="Older"]',
      'div.T-I[act="19"]',
      'div[act="19"]',
    ];

    let btn = null;
    for (const s of OLDER) {
      const el = document.querySelector(s);
      if (el) { btn = el; log("Older btn:", s); break; }
    }

    // Broad scan fallback
    if (!btn) {
      btn = [...document.querySelectorAll("div.T-I, button")].find(el => {
        const t = (el.getAttribute("data-tooltip") || el.getAttribute("aria-label") || "").toLowerCase();
        return t === "older";
      }) || null;
    }

    if (!btn) { log("Older button not found."); return false; }

    const disabled =
      btn.getAttribute("aria-disabled") === "true" ||
      btn.classList.contains("T-I-JO")            ||
      btn.hasAttribute("disabled");

    if (disabled) { log("Older button disabled."); return false; }

    const beforeRange = getRangeText();
    safeClick(btn);
    log("Clicked Older — waiting for range/page to change…");
    await buffer();

    const ready = await waitForPageReady(beforeRange);
    if (ready) { log("Page changed ✓"); await buffer(); return true; }
    log("Page change not detected (range/snapshot).");
    return false;
  }

  // ── MAIN LOOP ────────────────────────────────────────────────

  async function run() {
    log("═══ Starting ═══");
    post("PROGRESS", "Starting…");
    await sleep(800);

    let page = 1;
    let totalMarked = 0;
    let missStreak = 0;       // consecutive pages where Mark-as-Read btn was absent
    const MAX_MISSES = 3;     // stop after 3 pages in a row with no button
    let lastRange = "";       // used to ensure we only act after paging completes

    while (true) {

      // ── Stop check ─────────────────────────────────────────
      if (stopped()) {
        post("STOPPED", "Stopped by user.");
        return;
      }

      log(`\n── Page ${page} ──`);
      post("PROGRESS", `Page ${page}: waiting for page change…`);

      // Synchronous gating: do not act until page is ready (range changed vs previous).
      await waitForPageReady(lastRange);
      lastRange = getRangeText() || lastRange;
      await buffer();

      post("PROGRESS", `Page ${page}: selecting all…`);

      // ── Step 1: Select All ──────────────────────────────────
      const selected = await selectAll();

      if (stopped()) { post("STOPPED", "Stopped by user."); return; }

      if (!selected) {
        post("ERROR", `Page ${page}: could not click Select-All. Check console.`);
        return;
      }

      // ── Step 2: Mark as Read ────────────────────────────────
      post("PROGRESS", `Page ${page}: looking for Mark as Read button…`);
      await buffer();
      const marked = await markAsRead();

      if (stopped()) { post("STOPPED", "Stopped by user."); return; }

      if (!marked) {
        missStreak++;
        log(`Mark-as-Read button not found on page ${page}. Miss streak: ${missStreak}`);
        post("PROGRESS", `Page ${page}: button not found (${missStreak}/${MAX_MISSES} misses) — next page…`);

        if (missStreak >= MAX_MISSES) {
          log("Reached 3 consecutive misses — stopping.");
          post("DONE", `Finished. ${totalMarked} email(s) marked across ${page} page(s).`);
          return;
        }

        // Button not found — move to next page anyway
        const advanced = await goOlder();
        if (!advanced) {
          post("DONE", `Last page reached. ${totalMarked} email(s) marked.`);
          return;
        }
        lastRange = getRangeText() || lastRange;
        page++;
        continue;
      }

      // Button was found and clicked — reset miss streak
      missStreak = 0;
      totalMarked += document.querySelectorAll("tr.zA").length; // approximate
      post("PROGRESS", `Page ${page} done — ~${totalMarked} marked so far.`);

      // ── Step 3: Move to next page ───────────────────────────
      if (stopped()) { post("STOPPED", "Stopped by user."); return; }

      post("PROGRESS", `Moving to page ${page + 1}…`);
      await buffer();
      const advanced = await goOlder();

      if (!advanced) {
        post("DONE", `Last page reached. ~${totalMarked} email(s) marked across ${page} page(s).`);
        return;
      }

      lastRange = getRangeText() || lastRange;
      page++;
    }
  }

  // ── Message listener ─────────────────────────────────────────

  let running = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== "gmail-mark-read-popup") return;

    if (msg.type === "START") {
      if (running) { post("WARN", "Already running."); sendResponse({ ok: false }); return; }
      window.__gmrStop = false;
      running = true;
      sendResponse({ ok: true });
      run().finally(() => { running = false; });
    }

    if (msg.type === "STOP") {
      window.__gmrStop = true;
      sendResponse({ ok: true });
    }
  });

  log("Content script ready.");
}
