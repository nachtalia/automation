// ==UserScript==
// @name         Deliveroo Refund → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      2.0.0
// @description  Read Deliveroo Partner Hub refunds, preset-driven Workhorse fills on OpSpot, and copy rows into the matching Google Sheet tab.
// @author       Claims Ops
// @match        https://partner-hub.deliveroo.com/*
// @match        https://partner-hub.deliveroo.com/orders/refunds/*
// @match        *://partner-hub.deliveroo.com/*
// @match        *://*.partner-hub.deliveroo.com/*
// @match        *://restaurant-hub.deliveroo.com/*
// @match        *://*.deliveroo.com/*
// @match        *://*.deliveroo.co.uk/*
// @match        https://opspot.workhorselive.com/*
// @match        https://opspot.workhorselive.com/sysTable.php*
// @match        *://opspot.workhorselive.com/*
// @match        *://*.workhorselive.com/*
// @match        https://docs.google.com/spreadsheets/*
// @match        *://docs.google.com/spreadsheets/*
// @require      https://raw.githubusercontent.com/nachtalia/automation/main/claims-presets.js
// @require      https://raw.githubusercontent.com/nachtalia/automation/main/claims-core.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

/**
 * Pages
 *   Deliveroo: https://partner-hub.deliveroo.com/orders/refunds/...
 *   OpSpot:    https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000#
 *   Sheets:    https://docs.google.com/spreadsheets/d/... (Refund_Dispute_Log_2)
 *
 * You must be logged in on both. The login screens have no order data.
 * Presets/core load from GitHub via @require (raw.githubusercontent.com).
 */

(function () {
  "use strict";

  const root = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (!root.ClaimsCore || !root.ClaimsPresets) {
    console.error("[Deliveroo Claims] Load claims-presets.js and claims-core.js via @require (check network / Tampermonkey @require).");
    return;
  }
  const core = root.ClaimsCore.create("deliveroo");
  const {
    normalizeSpace, normalizeKey, compactKey, visible, ownText, wait, waitUntil, debounce,
    parseMoney, extractTime, parseClaimDate, safeClick, findVisibleLabel,
    isOpSpotPage, isGoogleSheetsPage,
    canonicalizeReason, normalizeCustomerName, computeOutcome, computeFootageStatus,
    buildDisputeFieldValues, mapReasonForDispute,
    savePayload, loadPayload, toast, showPreview, ensureStyles, injectButton, ensureButtonBar,
    applyPayloadToClaims, setupOpSpotSaveHooks, resetFillGuards,
    buildSheetTransfer, saveSheetTransfer, loadSheetTransfer, activateGoogleSheetTab,
    focusSheetPasteCell, copyTextToClipboard,
    clearHits, highlightHits, hits, hitClass, platform, version,
  } = core;

  const uiPrefix = platform.uiPrefix || "dcf";
  const btnId = `${uiPrefix}-btn`;
  const sheetBtnId = `${uiPrefix}-sheet-btn`;
  const workhorse = core.workhorse;

  let pageLinesCache = null;

  const HEADER_WORDS = /^(quantity|qty|price|item|items|name|category|total|refund reason|refund details)$/i;
  const UI_NOISE = /^(refund details|refund reason|partner refund value|order total|date ordered|order submitted|order timeline|dispute this refund|prepared incorrectly|missing|missing item|missing items|incomplete|incomplete item|incomplete items|incorrect|incorrect item|incorrect items|food safety complaint|category|quantity|qty|price|item|items|name|total|deliveroo|partner hub)$/i;
  const REASON_ROW_RE = /^(missing|missing item|missing items|incomplete|incomplete item|incomplete items|prepared incorrectly|incorrect item|incorrect items|incorrect|food safety complaint)$/i;
  const CONTESTED_BODY_RE = /refund\s+contested|refund\s+dispute\s+was\s+successfully\s+submitted|dispute\s+sent\b|partner refund value[\s\S]{0,80}\bdisputed\b/i;
  const MENU_CATEGORIES = /^(drinks?|burgers?|sandwiches?|sides?|desserts?|fries|wings|box meals?|milkshakes?|saucin['’]? wings|world famous sandwiches|starters?|mains?|kids?|combos?|meals?|snacks?|sauces?)$/i;

  function isMoneyText(text) {
    const value = normalizeSpace(text);
    if (!value) return false;
    if (/^(?:NZ\$|A\$|US\$|€|£|\$)\s*\d/.test(value)) return true;
    if (/^\d+[.,]\d{2}$/.test(value)) return true;
    if (/^-?\s*(?:NZ\$|A\$|US\$|€|£|\$)\s*\d/.test(value)) return true;
    return false;
  }

  function firstItemNameLine(text) {
    const line = normalizeSpace(String(text || "").split(/\n/)[0]);
    return line.replace(/\s+(?:NZ\$|A\$|US\$|€|£|\$)\s*\d.*$/, "").trim();
  }

  function isCategoryName(name) {
    return MENU_CATEGORIES.test(normalizeKey(firstItemNameLine(name)));
  }

  function isValidItemName(name) {
    const text = firstItemNameLine(name);
    if (!text || text.length < 2 || text.length > 80) return false;
    const key = normalizeKey(text);
    if (HEADER_WORDS.test(key) || UI_NOISE.test(key)) return false;
    if (isMoneyText(text)) return false;
    if (isCategoryName(text)) return false;
    if (/^order\s*#/i.test(text)) return false;
    if (/^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(text)) return false;
    return true;
  }

  function invalidatePageLines() {
    pageLinesCache = null;
  }

  function pageLines() {
    if (pageLinesCache) return pageLinesCache;
    pageLinesCache = ((document.body && document.body.innerText) || "")
      .split(/\n+/)
      .map(normalizeSpace)
      .filter(Boolean);
    return pageLinesCache;
  }

  function valuesAfterLabel(label) {
    const lines = pageLines();
    const wanted = normalizeKey(label);
    const values = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (normalizeKey(lines[i]) === wanted) values.push(lines[i + 1]);
    }
    return values.filter((v) => v && !HEADER_WORDS.test(v));
  }

  function uniqueBy(items, keyFn) {
    const seen = new Set();
    return items.filter((item) => {
      const key = keyFn(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function isDeliverooHub() {
    return /partner-hub\.deliveroo\.com|restaurant-hub\.deliveroo\.com|deliveroo\.(com|co\.uk)/i.test(location.host);
  }

  function isRefundDetailsPage() {
    if (isOpSpotPage()) return false;
    if (!isDeliverooHub()) return false;
    if (/\/orders\/refunds\//i.test(location.pathname)) return true;
    const text = document.body ? document.body.innerText : "";
    return /date ordered/i.test(text) && /partner refund value/i.test(text);
  }

  function findOrderHeading(orderNumber) {
    const selectors = ["h1", "h2", "h3", "h4", "strong", "p", "span"];
    let best = null;
    let bestLen = Infinity;
    for (let s = 0; s < selectors.length; s++) {
      const nodes = document.getElementsByTagName(selectors[s]);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!visible(el)) continue;
        const text = ownText(el) || normalizeSpace(el.textContent);
        if (text.length < 8 || text.length > 36) continue;
        if (!/^order\s*#\s*\d+$/i.test(text)) continue;
        if (orderNumber && !text.includes(orderNumber)) continue;
        if (text.length < bestLen) {
          best = el;
          bestLen = text.length;
        }
      }
      if (best && s < 4) return best;
    }
    return best;
  }

  function extractOrderNumber() {
    const heading = findOrderHeading();
    const text = heading ? heading.textContent : (pageLines()[0] ? pageLines().join("\n") : document.body.innerText);
    const match = String(text).match(/order\s*#\s*(\d+)/i);
    if (heading) hits.push({ label: "Order Number", el: heading, valueEl: heading, value: match && match[1] });
    return match ? match[1] : "";
  }

  function splitBrandLocation(line) {
    const text = normalizeSpace(line);
    const parts = text.split(/\s*[–—−-]\s*/).map(normalizeSpace).filter(Boolean);
    if (parts.length < 2) return { customer: "", location: "" };
    return {
      customer: parts[0] || "",
      location: parts.slice(1).join(" - ") || "",
    };
  }

  function looksLikeBrandLocation(text) {
    return /\s+[–—−-]\s+/.test(normalizeSpace(text));
  }

  function extractBrandAndLocation(orderNumber) {
    const heading = findOrderHeading(orderNumber);

    const tryLine = (el) => {
      if (!el || !visible(el)) return null;
      const text = ownText(el) || (el.childElementCount === 0 ? normalizeSpace(el.textContent) : "");
      if (!text || text.length > 80 || /order\s*#/i.test(text)) return null;
      if (!looksLikeBrandLocation(text)) return null;
      const parsed = splitBrandLocation(text);
      if (!parsed.customer || !parsed.location) return null;
      hits.push({ label: "Customer / Location", el, valueEl: el, value: text });
      return parsed;
    };

    if (heading) {
      const nearby = [];
      let sib = heading.nextElementSibling;
      while (sib && nearby.length < 8) {
        nearby.push(sib);
        sib = sib.nextElementSibling;
      }
      if (heading.parentElement) {
        let uncle = heading.parentElement.nextElementSibling;
        let n = 0;
        while (uncle && n < 5) {
          nearby.push(uncle);
          uncle = uncle.nextElementSibling;
          n += 1;
        }
      }

      for (const block of nearby) {
        const direct = tryLine(block);
        if (direct) return direct;
        for (const kid of block.querySelectorAll("h1, h2, h3, h4, p, span, div, strong")) {
          const parsed = tryLine(kid);
          if (parsed) return parsed;
        }
      }
    }

    const lines = pageLines();
    const idx = lines.findIndex(
      (line) => orderNumber && /^order\s*#\s*\d+$/i.test(line) && line.includes(orderNumber)
    );
    if (idx >= 0 && lines[idx + 1] && looksLikeBrandLocation(lines[idx + 1])) {
      return splitBrandLocation(lines[idx + 1]);
    }
    return { customer: "", location: "" };
  }

  function extractOrderSubmittedTime() {
    const stage = findVisibleLabel(document.body, "Order submitted");
    if (!stage) return "";
    hits.push({ label: "Order submitted", el: stage, valueEl: null, value: "" });

    const prev = stage.previousElementSibling;
    if (prev && extractTime(prev.innerText)) {
      const time = extractTime(prev.innerText);
      hits.push({ label: "Order Time", el: prev, valueEl: prev, value: time });
      return time;
    }

    const row = stage.closest("li, tr, article, section, div") || stage.parentElement;
    const time = extractTime(row && row.innerText);
    if (time) hits.push({ label: "Order Time", el: row, valueEl: row, value: time });
    return time;
  }

  function extractRefundedItems() {
    const items = [];

    const pushItem = (name, reasonText, el, reasonEl) => {
      const itemName = firstItemNameLine(name);
      const reason = canonicalizeReason(reasonText);
      if (!reason || !isValidItemName(itemName)) return;
      items.push({ name: itemName, reason });
      hits.push({ label: "Refunded item", el: el || null, valueEl: reasonEl || null, value: itemName });
    };

    for (const table of document.querySelectorAll("table")) {
      const rows = table.rows;
      if (!rows || !rows.length) continue;
      const headerCells = rows[0].cells;
      if (!headerCells || !headerCells.length) continue;
      const headers = [];
      for (let i = 0; i < headerCells.length; i++) headers.push(normalizeKey(headerCells[i].innerText));
      const reasonIdx = headers.findIndex((h) => /refund reason/.test(h));
      if (reasonIdx < 0) continue;
      const nameIdx = headers.findIndex((h) => /item\s*name|product|description|^item$|^name$/.test(h));

      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r].cells;
        if (!cells || !cells.length) continue;
        const reasonText = normalizeSpace((cells[reasonIdx] && cells[reasonIdx].innerText) || "");
        if (!REASON_ROW_RE.test(reasonText)) continue;
        let itemName = nameIdx >= 0 ? (cells[nameIdx] && cells[nameIdx].innerText) || "" : "";
        if (!isValidItemName(itemName)) {
          for (let c = 0; c < cells.length; c++) {
            if (c === reasonIdx) continue;
            const candidate = firstItemNameLine((cells[c] && cells[c].innerText) || "");
            if (isValidItemName(candidate) && !isCategoryName(candidate)) {
              itemName = candidate;
              break;
            }
          }
        }
        pushItem(itemName, reasonText, rows[r], cells[reasonIdx]);
      }
      if (items.length) return uniqueBy(items, (item) => `${normalizeKey(item.name)}|${item.reason}`);
    }

    const reasonNodes = document.querySelectorAll("td, th, span, div, p, li, strong");
    for (let i = 0; i < reasonNodes.length; i++) {
      const el = reasonNodes[i];
      if (!visible(el)) continue;
      const reasonText = ownText(el) || (el.children.length === 0 ? normalizeSpace(el.textContent) : "");
      if (!REASON_ROW_RE.test(reasonText)) continue;
      const row = el.closest("tr, [role='row'], li, article") || el.parentElement;
      if (!row) continue;
      const chunks = [...row.querySelectorAll("td, th, span, div, p, strong")]
        .map((node) => firstItemNameLine(ownText(node) || node.textContent))
        .filter((text) => text && isValidItemName(text) && !REASON_ROW_RE.test(text) && !isCategoryName(text));
      const bestName = chunks.sort((a, b) => b.length - a.length)[0];
      if (bestName) pushItem(bestName, reasonText, row, el);
    }
    if (items.length) return uniqueBy(items, (item) => `${normalizeKey(item.name)}|${item.reason}`);

    const lines = pageLines();
    for (let i = 0; i < lines.length; i++) {
      if (!REASON_ROW_RE.test(lines[i])) continue;
      if (/^(missing items|incomplete items)$/i.test(lines[i]) && /^refund reason$/i.test(lines[i - 1] || "")) continue;

      let name = "";
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const candidate = firstItemNameLine(lines[j]);
        if (isMoneyText(candidate) || /^\d+$/.test(candidate)) continue;
        if (/^(quantity|qty|price|refund reason|refund details|item|item name|category)$/i.test(candidate)) continue;
        if (isCategoryName(candidate)) continue;
        if (REASON_ROW_RE.test(candidate)) continue;
        if (isValidItemName(candidate)) {
          name = candidate;
          break;
        }
      }
      if (name) pushItem(name, lines[i]);
    }

    return uniqueBy(items, (item) => `${normalizeKey(item.name)}|${item.reason}`);
  }

  function itemsMatchingReason(items, refundReason) {
    const withReason = (items || []).filter((item) => item && item.name && isValidItemName(item.name) && item.reason);
    const wanted = canonicalizeReason(refundReason);
    const matched = withReason.filter((item) => canonicalizeReason(item.reason) === wanted);
    if (matched.length) return matched;
    return withReason;
  }

  function detectAlreadyDisputed(lines) {
    const bodyText = Array.isArray(lines) ? lines.join("\n") : ((document.body && document.body.innerText) || "");
    return CONTESTED_BODY_RE.test(bodyText);
  }

  function extractRefundPayload() {
    clearHits();
    invalidatePageLines();
    const errors = [];
    const lines = pageLines();

    const orderNumber = extractOrderNumber();
    if (!orderNumber) errors.push("Order Number");

    const { customer: rawCustomer, location: storeLocation } = extractBrandAndLocation(orderNumber);
    const customer = normalizeCustomerName(rawCustomer);
    if (!customer) errors.push("Customer");
    if (!storeLocation) errors.push("Location");

    const dateRaw = valuesAfterLabel("Date ordered")[0] || "";
    const claimDate = parseClaimDate(dateRaw);
    if (!claimDate.iso) errors.push("Date ordered");

    let orderTime = extractTime(dateRaw);
    if (!orderTime) orderTime = extractOrderSubmittedTime();
    if (!orderTime) errors.push("Order submitted");

    const orderValue = parseMoney(valuesAfterLabel("Order total")[0] || "");
    if (orderValue == null) errors.push("Order total");

    const disputeAmount = parseMoney(valuesAfterLabel("Partner refund value")[0] || "");
    if (disputeAmount == null) errors.push("Partner refund value");

    const items = extractRefundedItems();
    const reasonValues = valuesAfterLabel("Refund reason");
    const reasonRaw = [...reasonValues].reverse().find((v) => canonicalizeReason(v)) || "";
    const itemReason = (items.find((item) => item && item.reason) || {}).reason || "";
    let refundReason = canonicalizeReason(reasonRaw) || itemReason || "";
    if (!refundReason) {
      const fromPage = lines.find((line) => REASON_ROW_RE.test(line) && canonicalizeReason(line));
      refundReason = canonicalizeReason(fromPage || "") || "";
    }
    if (!refundReason) errors.push("Refund reason");

    const alreadyDisputed = detectAlreadyDisputed(lines);
    highlightHits();

    const ruleCtx = {
      disputeAmount,
      alreadyDisputed,
      refundReason,
      customer,
      location: storeLocation,
    };
    const matchedItems = itemsMatchingReason(items, refundReason);
    const disputeFields = buildDisputeFieldValues(matchedItems, refundReason, customer, storeLocation);
    const payload = {
      extractedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
      claimDate: claimDate.raw,
      claimDateISO: claimDate.iso,
      claimDateDMY: claimDate.dmy,
      claimDateDash: claimDate.dash,
      orderTime,
      customer,
      location: storeLocation,
      platform: platform.platform,
      orderNumber,
      orderValue: orderValue == null ? "" : orderValue.toFixed(2),
      disputeAmount: disputeAmount == null ? "" : disputeAmount.toFixed(2),
      refundReason,
      alreadyDisputed,
      outcome: computeOutcome(ruleCtx),
      videoSubmitted: workhorse.videoSubmitted || "No",
      reasonForDispute: mapReasonForDispute(refundReason),
      footageStatus: computeFootageStatus(ruleCtx),
      wrongFoodItem: disputeFields.wrongFoodItem,
      preparedIncorrectlyWhy: disputeFields.preparedIncorrectlyWhy,
      reason: disputeFields.reason || "",
      otherReason: disputeFields.otherReason,
      items,
      errors,
    };

    return payload;
  }

  function mount() {
    const body = document.body;
    if (!body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }

    ensureButtonBar();

    if (isGoogleSheetsPage()) {
      const existing = document.getElementById(sheetBtnId);
      if (existing && existing.onclick) return;
      injectButton(sheetBtnId, platform.buttonSheetPaste || "Paste Deliveroo → Sheet Tab", onPasteSheetClick);
      return;
    }

    const existing = document.getElementById(btnId);
    const sheetExisting = document.getElementById(sheetBtnId);
    if (existing && existing.onclick && (!isDeliverooHub() || (sheetExisting && sheetExisting.onclick))) return;

    if (isOpSpotPage()) {
      injectButton(btnId, platform.buttonFill || "Fill from Deliveroo", async () => {
        resetFillGuards();
        const payload = await loadPayload();
        if (!payload) {
          toast(`No stored order. Click ${platform.buttonExtract || "Auto-Fill & Dispute"} on the refund tab first, then click here.`, "error", 7000);
          return;
        }
        await applyPayloadToClaims(payload, { force: true });
      });
      return;
    }

    if (isDeliverooHub()) {
      injectButton(btnId, platform.buttonExtract || "Auto-Fill & Dispute", onExtractClick);
      if (platform.buttonSheetCopy) {
        injectButton(sheetBtnId, platform.buttonSheetCopy, onCopySheetClick);
      }
    }
  }

  function boot() {
    ensureStyles();
    if (typeof GM_registerMenuCommand === "function") {
      if (isGoogleSheetsPage()) {
        GM_registerMenuCommand(platform.buttonSheetPaste || "Paste Deliveroo → Sheet Tab", onPasteSheetClick);
      } else if (typeof location !== "undefined" && /opspot/i.test(location.host)) {
        GM_registerMenuCommand(platform.buttonFill || "Fill from Deliveroo", async () => {
          resetFillGuards();
          const payload = await loadPayload();
          if (!payload) {
            toast("No stored order. Run Auto-Fill on the refund tab first.", "error", 7000);
            return;
          }
          await applyPayloadToClaims(payload, { force: true });
        });
      } else {
        GM_registerMenuCommand(platform.buttonExtract || "Auto-Fill & Dispute", onExtractClick);
        if (platform.buttonSheetCopy) {
          GM_registerMenuCommand(platform.buttonSheetCopy, onCopySheetClick);
        }
      }
    }
    const remount = debounce(mount, 400);
    let observerQueued = false;
    const wrap = (fn) =>
      function patched() {
        const ret = fn.apply(this, arguments);
        remount();
        return ret;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", remount);
    window.addEventListener("load", mount);
    new MutationObserver(() => {
      if (observerQueued) return;
      observerQueued = true;
      requestAnimationFrame(() => {
        observerQueued = false;
        if (isGoogleSheetsPage()) {
          if (!document.getElementById(sheetBtnId)) remount();
        } else if (!document.getElementById(btnId) || (isDeliverooHub() && platform.buttonSheetCopy && !document.getElementById(sheetBtnId))) {
          remount();
        }
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener(platform.storageKey, (_n, _o, value, remote) => {
        if (remote && isOpSpotPage() && value) {
          resetFillGuards();
          applyPayloadToClaims(value, { force: true });
        }
      });
      if (platform.sheetStorageKey) {
        GM_addValueChangeListener(platform.sheetStorageKey, (_n, _o, value, remote) => {
          if (remote && isGoogleSheetsPage() && value && value.row) {
            toast(`Ready for tab "${value.tab || "?"}": click ${platform.buttonSheetPaste || "Paste"}`, "info", 7000);
          }
        });
      }
    }
    setupOpSpotSaveHooks();
    mount();
  }

  async function onExtractClick() {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Reading screen…";
    }
    try {
      const payload = extractRefundPayload();
      showPreview(payload);
      savePayload(payload);
      if (payload.errors.length) toast(`UI miss: ${payload.errors.join(", ")}`, "error", 7000);
      else toast(`v${version || "2.0.0"} stored order #${payload.orderNumber}. Click ${platform.buttonFill || "Fill from Deliveroo"} on OpSpot.`, "success", 7000);
    } catch (err) {
      toast(`Extraction failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonExtract || "Auto-Fill & Dispute";
      }
    }
  }

  async function onCopySheetClick() {
    const btn = document.getElementById(sheetBtnId);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Copying…";
    }
    try {
      const payload = extractRefundPayload();
      showPreview(payload);
      savePayload(payload);
      const transfer = buildSheetTransfer(payload);
      saveSheetTransfer(transfer);
      const ok = copyTextToClipboard(transfer.row);
      if (!ok) throw new Error("Clipboard blocked");
      const tabLabel = transfer.tab || "matching tab";
      if (payload.errors.length) {
        toast(`Copied for "${tabLabel}" with missing fields: ${payload.errors.join(", ")}. Open the sheet and click Paste.`, "error", 9000);
      } else {
        toast(`Copied #${payload.orderNumber} → tab "${tabLabel}". Open Google Sheet and click ${platform.buttonSheetPaste || "Paste"}.`, "success", 9000);
      }
    } catch (err) {
      toast(`Sheet copy failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonSheetCopy || "Copy for Google Sheet";
      }
    }
  }

  async function onPasteSheetClick() {
    const btn = document.getElementById(sheetBtnId);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Switching tab…";
    }
    try {
      const transfer = await loadSheetTransfer();
      if (!transfer || !transfer.row) {
        toast(`No copied Deliveroo row. Click ${platform.buttonSheetCopy || "Copy for Google Sheet"} on the refund page first.`, "error", 8000);
        return;
      }

      copyTextToClipboard(transfer.row);

      if (transfer.tab) {
        const switched = await activateGoogleSheetTab(transfer.tab);
        if (!switched.ok) {
          toast(`${switched.reason}. Row is on clipboard — select the "${transfer.tab}" tab and paste.`, "error", 9000);
          return;
        }
      }

      focusSheetPasteCell();
      toast(
        `On "${transfer.tab || "current"}" tab for #${transfer.orderNumber || "?"}. Click the next empty row and press Ctrl+V.`,
        "success",
        9000
      );
    } catch (err) {
      toast(`Sheet paste failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonSheetPaste || "Paste Deliveroo → Sheet Tab";
      }
    }
  }

  boot();
})();
