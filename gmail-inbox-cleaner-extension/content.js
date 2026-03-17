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
    BUFFER: 500,
    // Polling cadence for "wait until condition is true".
    POLL: 250,
    // Upper bound so we never wait forever (not used as "execution timer").
    MAX_POLLS: 60, // 60 × 250ms = 15s max wait per condition
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

  function getThreadListRoot() {
    // Observe a tight subtree if possible (table/tbody that contains tr.zA),
    // otherwise fall back to the main container.
    const row = document.querySelector("tr.zA");
    return row?.closest("tbody") || row?.closest("table") || document.querySelector('div[role="main"]') || document.body;
  }

  function getRangeNode() {
    // Prefer the canonical toolbar range element (span.Dj).
    return (
      document.querySelector('div[role="button"][aria-label*="Show more messages"] span.Dj') ||
      document.querySelector("div.amH span.Dj") ||
      document.querySelector("span.Dj") ||
      null
    );
  }

  async function waitUntil(predicate, { timeoutMs, observe = [] } = {}) {
    // Event-driven wait: resolve when predicate becomes true, triggered by DOM mutations.
    // Includes a timeout so we never hang forever.
    const deadline = Date.now() + (timeoutMs ?? 15000);

    if (predicate()) return true;

    const nodes = observe.filter(Boolean);
    if (nodes.length === 0) nodes.push(document.body);

    return await new Promise((resolve) => {
      let done = false;

      const finish = (ok) => {
        if (done) return;
        done = true;
        try { obs.disconnect(); } catch { /* ignore */ }
        try { clearTimeout(timer); } catch { /* ignore */ }
        resolve(ok);
      };

      const onTick = () => {
        if (done) return;
        if (predicate()) return finish(true);
        if (Date.now() > deadline) return finish(false);
      };

      const obs = new MutationObserver(() => onTick());
      for (const n of nodes) {
        try {
          obs.observe(n, { subtree: true, childList: true, characterData: true, attributes: true });
        } catch {
          // Some nodes may be invalid to observe; ignore.
        }
      }

      const timer = setTimeout(() => finish(predicate()), Math.max(0, deadline - Date.now()));

      // In case the relevant node changes without a mutation on our observed roots,
      // do a lightweight periodic check as a backstop.
      (async () => {
        while (!done) {
          await sleep(DELAY.POLL);
          onTick();
        }
      })();
    });
  }

  function anyRowSelected() {
    // Gmail selection state varies by experiment; keep this broad.
    return !!document.querySelector('tr.zA[aria-checked="true"], tr.zA.x7, tr.zA.PE');
  }

  async function waitForSelection() {
    // Prefer event-driven waiting; fall back to polling inside waitUntil backstop.
    return await waitUntil(anyRowSelected, {
      timeoutMs: DELAY.MAX_POLLS * DELAY.POLL,
      observe: [getThreadListRoot()],
    });
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
      log("No selection detected after Select-All click — retrying once.");
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
    // Enforce sequence: don't look for the button until Gmail shows rows selected.
    const ok = await waitForSelection();
    if (!ok) {
      log("Selection not detected — not searching for Mark-as-Read yet.");
      return false;
    }

    // Wait for the button to appear (it only shows after rows are selected)
    const btn = await poll(() => {
      // Match by data-tooltip (most reliable)
      const el = document.querySelector('[data-tooltip="Mark as read"]');
      if (el && el.offsetParent !== null) return el;

      // Fallback: aria-label
      const el2 = document.querySelector('[aria-label="Mark as read"]');
      if (el2 && el2.offsetParent !== null) return el2;

      // Fallback: act="1" inside the main toolbar (not in a dropdown)
      const candidates = [...document.querySelectorAll('div[role="button"][act="1"]')];
      return candidates.find(e => e.offsetParent !== null) || null;
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
    const pred = () => {
      const now = getRangeText();
      return !!(now && now !== beforeRange);
    };

    const ok = await waitUntil(pred, {
      timeoutMs: DELAY.MAX_POLLS * DELAY.POLL,
      observe: [getRangeNode(), getThreadListRoot()],
    });

    // If the range node was replaced during navigation, re-check once.
    if (ok) return true;
    return pred();
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
