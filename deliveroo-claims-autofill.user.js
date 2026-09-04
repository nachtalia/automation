// ==UserScript==
// @name         Deliveroo Refund → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      2.2.0
// @description  Read Deliveroo refunds, map fields/conditions (incl. location aliases) to Workhorse, fill OpSpot, copy Sheets.
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
    canonicalizeReason, normalizeCustomerName, normalizeLocationName, computeOutcome, computeFootageStatus,
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
  const mapBtnId = `${uiPrefix}-map-btn`;
  const mapPanelId = `${uiPrefix}-map-panel`;
  const FIELD_MAP_KEY = "deliveroo_user_field_map_v1";
  const CONDITIONS_KEY = "deliveroo_user_conditions_v1";
  const workhorse = core.workhorse;

  /** Workhorse fields you can point at Deliveroo page text */
  const MAPPABLE_FIELDS = [
    { key: "orderNumber", label: "Order Number", kind: "orderNumber" },
    { key: "customer", label: "Customer", kind: "text" },
    { key: "location", label: "Location", kind: "text" },
    { key: "claimDate", label: "Claim Date", kind: "date" },
    { key: "orderTime", label: "Order Time", kind: "time" },
    { key: "orderValue", label: "Order Value", kind: "money" },
    { key: "disputeAmount", label: "Dispute Amount", kind: "money" },
    { key: "refundReason", label: "Refund Reason → Reason for Dispute", kind: "reason" },
    { key: "otherReason", label: "Other reason (item text)", kind: "text" },
  ];

  let pageLinesCache = null;
  let mapPickKey = null;
  let mapPickHandler = null;
  let userFieldMapCache = null;
  let userConditionsCache = null;
  let mapPanelPos = { top: 64, left: 18 };
  let mapPanelTab = "fields";

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

  /* -------------------------------------------------------------------------- */
  /* Click-to-map: pick Deliveroo page text → Workhorse field                   */
  /* -------------------------------------------------------------------------- */

  function loadUserFieldMap() {
    if (userFieldMapCache) return userFieldMapCache;
    let map = {};
    try {
      map = (typeof GM_getValue === "function" && GM_getValue(FIELD_MAP_KEY, null)) || {};
    } catch {
      map = {};
    }
    if (!map || typeof map !== "object") map = {};
    userFieldMapCache = map;
    return map;
  }

  function saveUserFieldMap(map) {
    userFieldMapCache = map || {};
    try {
      if (typeof GM_setValue === "function") GM_setValue(FIELD_MAP_KEY, userFieldMapCache);
    } catch (err) {
      toast(`Could not save field map: ${err.message || err}`, "error");
    }
    try {
      if (typeof GM !== "undefined" && GM.setValue) GM.setValue(FIELD_MAP_KEY, userFieldMapCache);
    } catch {
      /* ignore */
    }
  }

  function clearUserFieldMap() {
    saveUserFieldMap({});
    toast("Cleared all custom field maps. Defaults will be used.", "success", 4000);
    renderMapPanel();
  }

  function defaultUserConditions() {
    return { locationAliases: [], customerAliases: [], reasonMap: {} };
  }

  function loadUserConditions() {
    if (userConditionsCache) return userConditionsCache;
    let data = null;
    try {
      data = typeof GM_getValue === "function" ? GM_getValue(CONDITIONS_KEY, null) : null;
    } catch {
      data = null;
    }
    userConditionsCache = {
      ...defaultUserConditions(),
      ...(data && typeof data === "object" ? data : {}),
      locationAliases: Array.isArray(data && data.locationAliases) ? data.locationAliases : [],
      customerAliases: Array.isArray(data && data.customerAliases) ? data.customerAliases : [],
      reasonMap: data && data.reasonMap && typeof data.reasonMap === "object" ? data.reasonMap : {},
    };
    return userConditionsCache;
  }

  function saveUserConditions(data) {
    userConditionsCache = {
      ...defaultUserConditions(),
      ...(data || {}),
      locationAliases: Array.isArray(data && data.locationAliases) ? data.locationAliases : [],
      customerAliases: Array.isArray(data && data.customerAliases) ? data.customerAliases : [],
      reasonMap: data && data.reasonMap && typeof data.reasonMap === "object" ? data.reasonMap : {},
    };
    try {
      if (typeof GM_setValue === "function") GM_setValue(CONDITIONS_KEY, userConditionsCache);
    } catch (err) {
      toast(`Could not save conditions: ${err.message || err}`, "error");
    }
    try {
      if (typeof GM !== "undefined" && GM.setValue) GM.setValue(CONDITIONS_KEY, userConditionsCache);
    } catch {
      /* ignore */
    }
  }

  function matchAliasList(text, aliases) {
    const value = normalizeSpace(text);
    if (!value || !Array.isArray(aliases)) return "";
    for (const rule of aliases) {
      if (!rule || !rule.match || !rule.value) continue;
      try {
        if (new RegExp(String(rule.match), "i").test(value)) return normalizeSpace(rule.value);
      } catch {
        if (normalizeKey(value) === normalizeKey(rule.match)) return normalizeSpace(rule.value);
      }
      if (normalizeKey(value) === normalizeKey(rule.match)) return normalizeSpace(rule.value);
    }
    return "";
  }

  function resolveCustomerName(name) {
    const preset = normalizeCustomerName(name);
    return matchAliasList(preset, loadUserConditions().customerAliases) ||
      matchAliasList(name, loadUserConditions().customerAliases) ||
      preset;
  }

  function resolveLocationName(name) {
    const preset = normalizeLocationName(name);
    return matchAliasList(preset, loadUserConditions().locationAliases) ||
      matchAliasList(name, loadUserConditions().locationAliases) ||
      preset;
  }

  function resolveReasonForDispute(refundReason) {
    const canonical = canonicalizeReason(refundReason) || normalizeKey(refundReason);
    const userMap = loadUserConditions().reasonMap || {};
    const keys = [normalizeKey(refundReason), canonical, normalizeKey(canonical)].filter(Boolean);
    for (const key of keys) {
      if (userMap[key]) return userMap[key];
    }
    return mapReasonForDispute(canonical);
  }

  function describeBuiltInConditions() {
    const threshold = workhorse.disputeThresholdGbp || 2;
    const five = platform.fiveGuysNotDisputedMaxEur;
    const lines = [
      `Under £${threshold} dispute amount → Outcome: Not disputed; Footage: irrelevant`,
      "Already contested / disputed → Outcome: Reviewed; Footage: Disputed by 3rd party",
    ];
    if (five != null) {
      lines.push(`Five Guys and dispute < €${five} → Outcome: Not disputed; Footage: irrelevant`);
    }
    lines.push(
      "Missing / Incomplete / food safety → Outcome: Awaiting review (if not contested / under threshold)",
      "Prepared incorrectly / Incorrect item → Outcome: Pending",
      "Incomplete items → Reason for Dispute: Missing Item",
      "Food safety complaint → Reason for Dispute: Other + Reason field",
      "Video Submitted always: No",
      "Platform always: Deliveroo"
    );
    (platform.reasonMap && Object.keys(platform.reasonMap).length
      ? Object.entries(platform.reasonMap).slice(0, 12)
      : []
    ).forEach(([from, to]) => lines.push(`Reason “${from}” → “${to}”`));
    (platform.locationAliases || []).forEach((a) => {
      if (a && a.match && a.value) lines.push(`Location preset: /${a.match}/ → “${a.value}”`);
    });
    (platform.customerAliases || []).forEach((a) => {
      if (a && a.match && a.value) lines.push(`Customer preset: /${a.match}/ → “${a.value}”`);
    });
    return lines;
  }

  function ensureMapStyles() {
    const styleId = `${uiPrefix}-map-style-v3`;
    if (document.getElementById(styleId)) return;
    document.getElementById(`${uiPrefix}-map-style`)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #${mapBtnId} {
        background: #134e4a; color: #ecfdf5; border: 0; cursor: pointer;
        border-radius: 999px; padding: 12px 22px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        font: 700 15px/1.2 Segoe UI, system-ui, sans-serif;
      }
      #${mapBtnId}:hover { background: #111827; color: #fff; }
      #${mapPanelId} {
        position: fixed; top: 64px; left: 18px; z-index: 2147483646;
        width: 400px; max-height: 75vh; overflow: auto;
        background: #0f172a; color: #f8fafc; border-radius: 12px;
        padding: 0 14px 14px; box-shadow: 0 12px 40px rgba(0,0,0,.4);
        font: 13px/1.4 Segoe UI, system-ui, sans-serif;
      }
      #${mapPanelId} .dcf-map-drag {
        display: flex; align-items: center; gap: 8px;
        margin: 0 -14px 10px; padding: 12px 14px 8px;
        cursor: grab; user-select: none;
        border-bottom: 1px solid #1e293b;
        background: #0f172a;
        position: sticky; top: 0; z-index: 1;
      }
      #${mapPanelId} .dcf-map-drag:active { cursor: grabbing; }
      #${mapPanelId} .dcf-map-drag-grip {
        color: #64748b; letter-spacing: 2px; font-size: 14px; line-height: 1;
      }
      #${mapPanelId} .dcf-map-drag h3 { margin: 0; font-size: 15px; flex: 1; }
      #${mapPanelId} .dcf-map-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
      #${mapPanelId} .dcf-map-tabs button {
        flex: 1; border: 0; border-radius: 8px; padding: 8px; cursor: pointer;
        background: #1e293b; color: #cbd5e1; font-weight: 600;
      }
      #${mapPanelId} .dcf-map-tabs button.active { background: #00ccbc; color: #06221f; }
      #${mapPanelId} p { margin: 0 0 10px; color: #94a3b8; font-size: 12px; }
      #${mapPanelId} .dcf-map-row {
        display: flex; flex-direction: column; gap: 4px;
        padding: 8px 0; border-top: 1px solid #1e293b;
      }
      #${mapPanelId} .dcf-map-row-top { display: flex; gap: 8px; align-items: center; }
      #${mapPanelId} .dcf-map-row button, #${mapPanelId} .dcf-cond-add {
        border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer;
        background: #00ccbc; color: #06221f; font-weight: 700; font-size: 12px;
      }
      #${mapPanelId} .dcf-map-row button.armed { background: #fbbf24; color: #111; }
      #${mapPanelId} .dcf-map-meta { color: #94a3b8; font-size: 11px; word-break: break-word; }
      #${mapPanelId} .dcf-map-actions { display: flex; gap: 8px; margin-top: 12px; }
      #${mapPanelId} .dcf-map-actions button {
        flex: 1; border: 0; border-radius: 8px; padding: 8px; cursor: pointer;
        background: #334155; color: #fff; font-weight: 600;
      }
      #${mapPanelId} .dcf-cond-section { margin-top: 12px; padding-top: 8px; border-top: 1px solid #1e293b; }
      #${mapPanelId} .dcf-cond-section h4 { margin: 0 0 8px; font-size: 13px; color: #e2e8f0; }
      #${mapPanelId} .dcf-cond-form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; margin-bottom: 8px; }
      #${mapPanelId} .dcf-cond-form input {
        border: 1px solid #334155; border-radius: 6px; padding: 6px 8px;
        background: #1e293b; color: #f8fafc; font-size: 12px;
      }
      #${mapPanelId} .dcf-cond-item {
        display: flex; gap: 8px; align-items: center; padding: 4px 0;
        font-size: 12px; color: #cbd5e1;
      }
      #${mapPanelId} .dcf-cond-item button {
        border: 0; border-radius: 6px; padding: 4px 8px; cursor: pointer;
        background: #7f1d1d; color: #fff; font-size: 11px;
      }
      #${mapPanelId} .dcf-cond-builtin {
        margin: 0; padding-left: 16px; color: #94a3b8; font-size: 11px;
      }
      #${mapPanelId} .dcf-cond-builtin li { margin: 3px 0; }
      body.dcf-map-picking, body.dcf-map-picking * { cursor: crosshair !important; }
      .dcf-map-flash { outline: 3px solid #fbbf24 !important; outline-offset: 2px; }
    `;
    document.documentElement.appendChild(style);
  }

  function stopMapPick() {
    if (mapPickHandler) {
      document.removeEventListener("click", mapPickHandler, true);
      mapPickHandler = null;
    }
    mapPickKey = null;
    document.body && document.body.classList.remove("dcf-map-picking");
  }

  function inferMappingFromElement(el) {
    if (!el || el.closest(`#${mapPanelId}, #${uiPrefix}-btn-bar`)) return null;
    let node = el;
    if (node.nodeType === 3) node = node.parentElement;
    while (node && node !== document.body && normalizeSpace(node.innerText || "").length > 120) {
      node = node.parentElement;
    }
    if (!node || node === document.body) return null;

    const value = normalizeSpace((ownText(node) || node.innerText || "").split("\n")[0]);
    if (!value || value.length > 100) return null;

    node.classList.add("dcf-map-flash");
    setTimeout(() => node.classList.remove("dcf-map-flash"), 1200);

    if (/^order\s*#\s*\d+$/i.test(value)) {
      return { type: "orderNumber", sampleValue: value };
    }
    if (looksLikeBrandLocation(value)) {
      return { type: "brandLocationLine", sampleValue: value };
    }

    const lines = pageLines();
    let label = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === value || lines[i].includes(value)) {
        if (i > 0) label = lines[i - 1];
        break;
      }
    }

    const prev = node.previousElementSibling;
    if (prev) {
      const prevText = normalizeSpace((ownText(prev) || prev.innerText || "").split("\n")[0]);
      if (prevText && prevText.length < 48 && prevText !== value) label = prevText;
    }

    if (label && !HEADER_WORDS.test(label) && label.length < 60) {
      return { type: "afterLabel", label, sampleValue: value };
    }

    return { type: "afterLabel", label: value, sampleValue: value, clickedLabel: true };
  }

  function readMappedRaw(mapping) {
    if (!mapping || !mapping.type) return "";
    if (mapping.type === "orderNumber") {
      const n = extractOrderNumber();
      return n ? `Order #${n}` : "";
    }
    if (mapping.type === "brandLocationLine") {
      const orderNumber = extractOrderNumber();
      const brand = extractBrandAndLocation(orderNumber);
      if (brand.customer && brand.location) return `${brand.customer} - ${brand.location}`;
      const lines = pageLines();
      const hit = lines.find((line) => looksLikeBrandLocation(line));
      return hit || mapping.sampleValue || "";
    }
    if (mapping.type === "afterLabel" && mapping.label) {
      if (mapping.clickedLabel) {
        const vals = valuesAfterLabel(mapping.label);
        return vals[0] || mapping.sampleValue || "";
      }
      const vals = valuesAfterLabel(mapping.label);
      return vals.length ? vals[vals.length - 1] : mapping.sampleValue || "";
    }
    return mapping.sampleValue || "";
  }

  function applyUserMapsToExtraction(base) {
    const map = loadUserFieldMap();
    const out = { ...base };
    const fieldMeta = Object.fromEntries(MAPPABLE_FIELDS.map((f) => [f.key, f]));

    for (const [key, mapping] of Object.entries(map)) {
      const meta = fieldMeta[key];
      if (!meta || !mapping) continue;
      const raw = readMappedRaw(mapping);
      if (!raw) continue;

      if (key === "orderNumber") {
        const m = String(raw).match(/(\d{3,})/);
        if (m) out.orderNumber = m[1];
      } else if (key === "customer") {
        if (mapping.type === "brandLocationLine") {
          const parsed = splitBrandLocation(raw);
          if (parsed.customer) out.customer = resolveCustomerName(parsed.customer);
          if (parsed.location && !map.location) out.location = resolveLocationName(parsed.location);
        } else {
          out.customer = resolveCustomerName(raw);
        }
      } else if (key === "location") {
        if (mapping.type === "brandLocationLine") {
          const parsed = splitBrandLocation(raw);
          if (parsed.location) out.location = resolveLocationName(parsed.location);
          if (parsed.customer && !map.customer) out.customer = resolveCustomerName(parsed.customer);
        } else {
          out.location = resolveLocationName(raw);
        }
      } else if (key === "claimDate") {
        const claimDate = parseClaimDate(raw);
        out.claimDate = claimDate.raw || raw;
        out.claimDateISO = claimDate.iso;
        out.claimDateDMY = claimDate.dmy;
        out.claimDateDash = claimDate.dash;
        if (!map.orderTime) {
          const t = extractTime(raw);
          if (t) out.orderTime = t;
        }
      } else if (key === "orderTime") {
        out.orderTime = extractTime(raw) || raw;
      } else if (key === "orderValue") {
        const n = parseMoney(raw);
        if (n != null) out.orderValue = n.toFixed(2);
      } else if (key === "disputeAmount") {
        const n = parseMoney(raw);
        if (n != null) out.disputeAmount = n.toFixed(2);
      } else if (key === "refundReason") {
        out.refundReason = canonicalizeReason(raw) || raw;
        out.reasonForDispute = resolveReasonForDispute(out.refundReason);
      } else if (key === "otherReason") {
        out.otherReason = raw;
        if (!out.wrongFoodItem) out.wrongFoodItem = String(raw).split("\n")[0];
      }
    }

    out.customer = resolveCustomerName(out.customer);
    out.location = resolveLocationName(out.location);
    out.reasonForDispute = resolveReasonForDispute(out.refundReason);
    const amount = parseMoney(out.disputeAmount);
    const ruleCtx = {
      disputeAmount: amount,
      alreadyDisputed: out.alreadyDisputed,
      refundReason: out.refundReason,
      customer: out.customer,
      location: out.location,
    };
    out.outcome = computeOutcome(ruleCtx);
    out.footageStatus = computeFootageStatus(ruleCtx);
    return out;
  }

  function startMapPick(fieldKey) {
    stopMapPick();
    mapPickKey = fieldKey;
    document.body.classList.add("dcf-map-picking");
    toast(`Click the Deliveroo value for "${MAPPABLE_FIELDS.find((f) => f.key === fieldKey)?.label || fieldKey}"`, "info", 6000);
    renderMapPanel();

    mapPickHandler = (event) => {
      if (event.target.closest(`#${mapPanelId}, #${uiPrefix}-btn-bar`)) return;
      event.preventDefault();
      event.stopPropagation();
      const mapping = inferMappingFromElement(event.target);
      stopMapPick();
      if (!mapping) {
        toast("Could not read that click. Try a clearer label or value.", "error");
        renderMapPanel();
        return;
      }
      const map = { ...loadUserFieldMap(), [fieldKey]: mapping };
      saveUserFieldMap(map);
      const desc = mapping.type === "afterLabel"
        ? `label "${mapping.label}" → ${mapping.sampleValue}`
        : `${mapping.type}: ${mapping.sampleValue}`;
      toast(`Mapped ${fieldKey}: ${desc}`, "success", 5000);
      renderMapPanel();
    };
    document.addEventListener("click", mapPickHandler, true);
  }

  function mappingSummary(mapping) {
    if (!mapping) return "Default (auto)";
    if (mapping.type === "afterLabel") {
      return mapping.clickedLabel
        ? `After label “${mapping.label}”`
        : `“${mapping.label}” → ${mapping.sampleValue || "?"}`;
    }
    if (mapping.type === "orderNumber") return `Order # from heading (${mapping.sampleValue || ""})`;
    if (mapping.type === "brandLocationLine") return `Brand – location line (${mapping.sampleValue || ""})`;
    return mapping.type;
  }

  function clampMapPanelPosition(left, top, panel) {
    const width = panel.offsetWidth || 360;
    const height = Math.min(panel.offsetHeight || 200, window.innerHeight);
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - Math.min(height, 120) - 8);
    return {
      left: Math.min(maxLeft, Math.max(8, left)),
      top: Math.min(maxTop, Math.max(8, top)),
    };
  }

  function applyMapPanelPosition(panel) {
    if (!panel) return;
    const pos = clampMapPanelPosition(mapPanelPos.left, mapPanelPos.top, panel);
    mapPanelPos = pos;
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
  }

  function enableMapPanelDrag(panel) {
    if (!panel || panel.dataset.dragBound === "1") return;
    panel.dataset.dragBound = "1";
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onMove = (event) => {
      if (!dragging) return;
      const next = clampMapPanelPosition(
        originLeft + (event.clientX - startX),
        originTop + (event.clientY - startY),
        panel
      );
      mapPanelPos = next;
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
    };

    panel.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest(".dcf-map-drag");
      if (!handle || event.target.closest("button")) return;
      if (event.button != null && event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = panel.offsetLeft;
      originTop = panel.offsetTop;
      event.preventDefault();
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
    });
  }

  function escapeAttr(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function renderAliasList(kind, aliases) {
    if (!aliases.length) return `<div class="dcf-map-meta">None yet — add Deliveroo text → Workhorse value below.</div>`;
    return aliases
      .map(
        (rule, index) => `<div class="dcf-cond-item">
        <span style="flex:1"><code>${escapeAttr(rule.match)}</code> → <strong>${escapeAttr(rule.value)}</strong></span>
        <button type="button" data-cond-del="${kind}" data-cond-index="${index}">Remove</button>
      </div>`
      )
      .join("");
  }

  function renderReasonOverrides(reasonMap) {
    const entries = Object.entries(reasonMap || {});
    if (!entries.length) return `<div class="dcf-map-meta">None yet — map a Deliveroo refund reason to a Workhorse Reason for Dispute.</div>`;
    return entries
      .map(
        ([from, to]) => `<div class="dcf-cond-item">
        <span style="flex:1"><code>${escapeAttr(from)}</code> → <strong>${escapeAttr(to)}</strong></span>
        <button type="button" data-cond-del-reason="${escapeAttr(from)}">Remove</button>
      </div>`
      )
      .join("");
  }

  function renderMapPanel() {
    ensureMapStyles();
    let panel = document.getElementById(mapPanelId);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = mapPanelId;
      document.body.appendChild(panel);
      enableMapPanelDrag(panel);
    }
    applyMapPanelPosition(panel);

    const map = loadUserFieldMap();
    const conditions = loadUserConditions();
    const fieldRows = MAPPABLE_FIELDS.map((field) => {
      const mapping = map[field.key];
      const armed = mapPickKey === field.key;
      return `<div class="dcf-map-row">
        <div class="dcf-map-row-top">
          <strong style="flex:1">${field.label}</strong>
          <button type="button" data-map-key="${field.key}" class="${armed ? "armed" : ""}">${armed ? "Click page…" : "Select on page"}</button>
        </div>
        <div class="dcf-map-meta">${mappingSummary(mapping)}</div>
      </div>`;
    }).join("");

    const builtin = describeBuiltInConditions()
      .map((line) => `<li>${escapeAttr(line)}</li>`)
      .join("");

    const fieldsBody = `
      <p>Pick a field, then click the matching text on the refund page. Saved in this browser.</p>
      ${fieldRows}
      <div class="dcf-map-actions">
        <button type="button" data-map-action="clear">Clear maps</button>
        <button type="button" data-map-action="close">Close</button>
      </div>
    `;

    const conditionsBody = `
      <p>When Deliveroo names differ from Workhorse, add aliases. Regex allowed in the “from” box (e.g. <code>victoria.*</code>).</p>

      <div class="dcf-cond-section">
        <h4>Location aliases (Deliveroo → Workhorse)</h4>
        ${renderAliasList("locationAliases", conditions.locationAliases)}
        <div class="dcf-cond-form">
          <input data-cond-from="locationAliases" placeholder="Deliveroo location" />
          <input data-cond-to="locationAliases" placeholder="Workhorse location" />
          <button type="button" class="dcf-cond-add" data-cond-add="locationAliases">Add</button>
        </div>
      </div>

      <div class="dcf-cond-section">
        <h4>Customer aliases</h4>
        ${renderAliasList("customerAliases", conditions.customerAliases)}
        <div class="dcf-cond-form">
          <input data-cond-from="customerAliases" placeholder="Deliveroo customer" />
          <input data-cond-to="customerAliases" placeholder="Workhorse customer" />
          <button type="button" class="dcf-cond-add" data-cond-add="customerAliases">Add</button>
        </div>
      </div>

      <div class="dcf-cond-section">
        <h4>Reason overrides</h4>
        ${renderReasonOverrides(conditions.reasonMap)}
        <div class="dcf-cond-form">
          <input data-reason-from placeholder="Deliveroo reason" />
          <input data-reason-to placeholder="Workhorse reason" />
          <button type="button" class="dcf-cond-add" data-cond-add-reason>Add</button>
        </div>
      </div>

      <div class="dcf-cond-section">
        <h4>Built-in conditions (from presets)</h4>
        <ul class="dcf-cond-builtin">${builtin}</ul>
      </div>

      <div class="dcf-map-actions">
        <button type="button" data-map-action="clear-conditions">Clear my conditions</button>
        <button type="button" data-map-action="close">Close</button>
      </div>
    `;

    panel.innerHTML = `
      <div class="dcf-map-drag" title="Drag to move">
        <span class="dcf-map-drag-grip" aria-hidden="true">⋮⋮</span>
        <h3>Map &amp; conditions</h3>
      </div>
      <div class="dcf-map-tabs">
        <button type="button" data-map-tab="fields" class="${mapPanelTab === "fields" ? "active" : ""}">Field maps</button>
        <button type="button" data-map-tab="conditions" class="${mapPanelTab === "conditions" ? "active" : ""}">Conditions</button>
      </div>
      ${mapPanelTab === "conditions" ? conditionsBody : fieldsBody}
    `;

    panel.querySelectorAll("[data-map-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        mapPanelTab = btn.getAttribute("data-map-tab") || "fields";
        renderMapPanel();
      });
    });
    panel.querySelectorAll("[data-map-key]").forEach((btn) => {
      btn.addEventListener("click", () => startMapPick(btn.getAttribute("data-map-key")));
    });
    panel.querySelector('[data-map-action="clear"]')?.addEventListener("click", clearUserFieldMap);
    panel.querySelector('[data-map-action="clear-conditions"]')?.addEventListener("click", () => {
      saveUserConditions(defaultUserConditions());
      toast("Cleared your custom conditions.", "success", 3500);
      renderMapPanel();
    });
    panel.querySelector('[data-map-action="close"]')?.addEventListener("click", () => {
      stopMapPick();
      panel.remove();
    });

    panel.querySelectorAll("[data-cond-add]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-cond-add");
        const from = panel.querySelector(`[data-cond-from="${kind}"]`)?.value;
        const to = panel.querySelector(`[data-cond-to="${kind}"]`)?.value;
        if (!normalizeSpace(from) || !normalizeSpace(to)) {
          toast("Enter both Deliveroo and Workhorse values.", "error");
          return;
        }
        const next = loadUserConditions();
        next[kind] = [...(next[kind] || []), { match: normalizeSpace(from), value: normalizeSpace(to) }];
        saveUserConditions(next);
        toast(`Added ${kind === "locationAliases" ? "location" : "customer"} alias.`, "success", 3000);
        renderMapPanel();
      });
    });

    panel.querySelector("[data-cond-add-reason]")?.addEventListener("click", () => {
      const from = panel.querySelector("[data-reason-from]")?.value;
      const to = panel.querySelector("[data-reason-to]")?.value;
      if (!normalizeSpace(from) || !normalizeSpace(to)) {
        toast("Enter both Deliveroo and Workhorse reasons.", "error");
        return;
      }
      const next = loadUserConditions();
      next.reasonMap = { ...(next.reasonMap || {}), [normalizeKey(from)]: normalizeSpace(to) };
      saveUserConditions(next);
      toast("Added reason override.", "success", 3000);
      renderMapPanel();
    });

    panel.querySelectorAll("[data-cond-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-cond-del");
        const index = Number(btn.getAttribute("data-cond-index"));
        const next = loadUserConditions();
        next[kind] = (next[kind] || []).filter((_, i) => i !== index);
        saveUserConditions(next);
        renderMapPanel();
      });
    });

    panel.querySelectorAll("[data-cond-del-reason]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-cond-del-reason");
        const next = loadUserConditions();
        const reasonMap = { ...(next.reasonMap || {}) };
        delete reasonMap[key];
        next.reasonMap = reasonMap;
        saveUserConditions(next);
        renderMapPanel();
      });
    });
  }

  function toggleMapPanel() {
    ensureMapStyles();
    const existing = document.getElementById(mapPanelId);
    if (existing) {
      stopMapPick();
      existing.remove();
      return;
    }
    renderMapPanel();
  }

  function extractRefundPayload() {
    clearHits();
    invalidatePageLines();
    const errors = [];
    const lines = pageLines();

    let orderNumber = extractOrderNumber();
    let { customer: rawCustomer, location: storeLocation } = extractBrandAndLocation(orderNumber);
    let customer = resolveCustomerName(rawCustomer);
    storeLocation = resolveLocationName(storeLocation);

    let dateRaw = valuesAfterLabel("Date ordered")[0] || "";
    let claimDate = parseClaimDate(dateRaw);

    let orderTime = extractTime(dateRaw);
    if (!orderTime) orderTime = extractOrderSubmittedTime();

    let orderValue = parseMoney(valuesAfterLabel("Order total")[0] || "");
    let disputeAmount = parseMoney(valuesAfterLabel("Partner refund value")[0] || "");

    const items = extractRefundedItems();
    const reasonValues = valuesAfterLabel("Refund reason");
    const reasonRaw = [...reasonValues].reverse().find((v) => canonicalizeReason(v)) || "";
    const itemReason = (items.find((item) => item && item.reason) || {}).reason || "";
    let refundReason = canonicalizeReason(reasonRaw) || itemReason || "";
    if (!refundReason) {
      const fromPage = lines.find((line) => REASON_ROW_RE.test(line) && canonicalizeReason(line));
      refundReason = canonicalizeReason(fromPage || "") || "";
    }

    const alreadyDisputed = detectAlreadyDisputed(lines);
    highlightHits();

    const matchedItems = itemsMatchingReason(items, refundReason);
    const disputeFields = buildDisputeFieldValues(matchedItems, refundReason, customer, storeLocation);

    let payload = {
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
      outcome: "",
      videoSubmitted: workhorse.videoSubmitted || "No",
      reasonForDispute: resolveReasonForDispute(refundReason),
      footageStatus: "",
      wrongFoodItem: disputeFields.wrongFoodItem,
      preparedIncorrectlyWhy: disputeFields.preparedIncorrectlyWhy,
      reason: disputeFields.reason || "",
      otherReason: disputeFields.otherReason,
      items,
      errors,
      fieldMapApplied: Object.keys(loadUserFieldMap()).length > 0,
    };

    payload = applyUserMapsToExtraction(payload);

    if (!payload.orderNumber) errors.push("Order Number");
    if (!payload.customer) errors.push("Customer");
    if (!payload.location) errors.push("Location");
    if (!payload.claimDateISO) errors.push("Date ordered");
    if (!payload.orderTime) errors.push("Order submitted");
    if (!payload.orderValue) errors.push("Order total");
    if (!payload.disputeAmount) errors.push("Partner refund value");
    if (!payload.refundReason) errors.push("Refund reason");
    payload.errors = errors;

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
    const mapExisting = document.getElementById(mapBtnId);
    if (
      existing &&
      existing.onclick &&
      (!isDeliverooHub() ||
        ((sheetExisting && sheetExisting.onclick) && mapExisting && mapExisting.onclick))
    ) {
      return;
    }

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
      ensureMapStyles();
      injectButton(btnId, platform.buttonExtract || "Auto-Fill & Dispute", onExtractClick);
      if (platform.buttonSheetCopy) {
        injectButton(sheetBtnId, platform.buttonSheetCopy, onCopySheetClick);
      }
      injectButton(mapBtnId, "Map & conditions", toggleMapPanel);
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
        GM_registerMenuCommand("Map & conditions", toggleMapPanel);
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
        } else if (!document.getElementById(btnId) || (isDeliverooHub() && (!document.getElementById(mapBtnId) || (platform.buttonSheetCopy && !document.getElementById(sheetBtnId))))) {
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
      else {
        const mapped = payload.fieldMapApplied ? " (custom maps)" : "";
        toast(`v2.2.0 stored order #${payload.orderNumber}${mapped}. Click ${platform.buttonFill || "Fill from Deliveroo"} on OpSpot.`, "success", 7000);
      }
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
