// ==UserScript==
// @name         Deliveroo Refund → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      1.8.1
// @description  Read Deliveroo Partner Hub refunds, fill OpSpot Claims, and copy rows into the matching Google Sheet tab.
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
 */

(function () {
  "use strict";

  let claimsFillInFlight = false;
  let lastFilledOrder = "";
  let saveInProgress = false;
  let pendingAutoFillAfterSave = false;
  let fastFillMode = false;
  let cachedModal = null;
  let cachedModalAt = 0;
  let pageLinesCache = null;
  let stylesInjected = false;
  let saveHooksInstalled = false;
  const hits = [];

  const CONFIG = {
    DELIVEROO_HOST: "partner-hub.deliveroo.com",
    CLAIMS_FORM_URL: "https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000",
    STORAGE_KEY: "deliveroo_claim_payload_v1",
    SHEET_STORAGE_KEY: "deliveroo_sheet_row_v1",
    CLIP_PREFIX: "DCF1:",
    PLATFORM: "Deliveroo",
    VIDEO_SUBMITTED: "No",
    DISPUTE_THRESHOLD_GBP: 2,
    FIVE_GUYS_NOT_DISPUTED_MAX_EUR: 5,
    customerAliases: [
      { match: /popeyes.*louisiana|louisiana.*popeyes/i, value: "Popeyes France" },
    ],
    DEBUG: false,
    MODAL_CACHE_MS: 800,
    FAST_FILL: true,

    branchSheetTabs: [
      { match: /shake\s*shack/i, tab: "Shake Shack" },
      { match: /jollibee/i, tab: "Jollibee UK" },
      { match: /popeyes/i, tab: "Popeyes" },
    ],
    defaultSheetTab: "",
    sheetColumns: [
      "Date",
      "Location",
      "# Order Number",
      "Refund Reason",
      "With Video?",
      "Footage Status",
      "Comments",
    ],

    outcomeOptions: {
      notDisputed: "Not disputed",
      reviewed: "Reviewed",
      awaitingReview: "Awaiting review",
      pending: "Pending",
      disputedByThirdParty: "Disputed by 3rd party",
    },
    footageStatusOptions: {
      disputedByThirdParty: "Disputed by 3rd party",
      irrelevant: "Footage status irrelevant for this claim",
    },
    reasonForDisputeMap: {
      missing: "Missing Item",
      "missing item": "Missing Item",
      "missing items": "Missing Item",
      "prepared incorrectly": "Prepared incorrectly",
      incorrect: "Incorrect Item",
      "incorrect item": "Incorrect Item",
      "incorrect items": "Incorrect Item",
      "food safety complaint": "Other",
    },
    reasonForDisputeOtherOption: "Other",
    foodSafetyComplaintLabel: "Food safety complaint",

    opspotLabels: {
      claimDate: "Claim Date",
      orderTime: "Order Time",
      customer: "Customer",
      location: "Location",
      platform: "Platform",
      orderNumber: "Order Number",
      orderValue: "Order Value",
      disputeAmount: "Dispute Amount",
      outcome: "Outcome",
      videoSubmitted: "Video Submitted",
      reasonForDispute: "Reason for Dispute",
      reason: "Reason",
      footageStatus: "Footage Status",
      otherReason: "Other reason",
      wrongFoodItem: "Wrong, Missing or Incorrect Food Item",
      preparedIncorrectlyWhy: "Why was the Item Prepared Incorrectly?",
    },
    preparedIncorrectlyOthersOption: "Others",
  };

  const FIELD_CAPTIONS = [
    "claim date", "order time", "customer", "location", "platform", "order number",
    "order value", "dispute amount", "outcome", "video submitted", "reason for dispute",
    "footage status", "other reason", "wrong, missing or incorrect food item",
    "why was the item prepared incorrectly", "agent", "won revenue", "lost revenue",
  ];

  const REASON_ROW_RE = /^(missing|missing item|missing items|prepared incorrectly|incorrect item|incorrect items|incorrect|food safety complaint)$/i;
  const CONTESTED_BODY_RE = /refund\s+contested|refund\s+dispute\s+was\s+successfully\s+submitted|dispute\s+sent\b|partner refund value[\s\S]{0,80}\bdisputed\b/i;

  const pageJQuery = () =>
    (typeof unsafeWindow !== "undefined" && (unsafeWindow.jQuery || unsafeWindow.$)) || window.jQuery || window.$;

  const log = (...args) => {
    if (CONFIG.DEBUG) console.log("[Claims Auto-Fill]", ...args);
  };

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitUntil(testFn, timeoutMs = 3000, stepMs = 50) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = testFn();
      if (value) return value;
      await wait(stepMs);
    }
    return null;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function normalizeSpace(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeKey(value) {
    return normalizeSpace(value)
      .toLowerCase()
      .replace(/\s*\*+\s*$/g, "")
      .replace(/\*+$/g, "")
      .trim();
  }

  function compactKey(value) {
    return normalizeKey(value).replace(/[^a-z0-9]/g, "");
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    return el.offsetWidth > 0 || el.offsetHeight > 0;
  }

  function ownText(el) {
    let out = "";
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
    }
    return normalizeSpace(out);
  }

  function parseMoney(value) {
    const cleaned = String(value || "").replace(/[^\d.,-]/g, "").replace(/,/g, "");
    if (!cleaned) return null;
    const num = Number.parseFloat(cleaned);
    return Number.isFinite(num) ? num : null;
  }

  function extractTime(text) {
    const m = String(text || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
  }

  function parseClaimDate(raw) {
    const text = normalizeSpace(raw);
    const months = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const pack = (day, monthName, year) => {
      const month = months[String(monthName || "").slice(0, 3).toLowerCase()];
      if (!month) return { raw: text, iso: "", dmy: "", dash: "" };
      const d = String(day).padStart(2, "0");
      return {
        raw: `${Number.parseInt(day, 10)} ${String(monthName).slice(0, 3)} ${year}`,
        iso: `${year}-${month}-${d}`,
        dmy: `${d}/${month}/${year}`,
        dash: `${d}-${month}-${year}`,
      };
    };
    let named = text.match(/(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})/);
    if (named) return pack(named[1], named[2], named[3]);
    named = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
    if (named) return pack(named[2], named[1], named[3]);
    named = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (named) {
      const day = named[1].padStart(2, "0");
      const month = named[2].padStart(2, "0");
      const year = named[3];
      return { raw: text, iso: `${year}-${month}-${day}`, dmy: `${day}/${month}/${year}`, dash: `${day}-${month}-${year}` };
    }
    return { raw: text, iso: "", dmy: "", dash: "" };
  }

  const HEADER_WORDS = /^(quantity|qty|price|item|items|name|category|total|refund reason|refund details)$/i;
  const UI_NOISE = /^(refund details|refund reason|partner refund value|order total|date ordered|order submitted|order timeline|dispute this refund|prepared incorrectly|missing|missing item|missing items|incorrect|incorrect item|incorrect items|food safety complaint|category|quantity|qty|price|item|items|name|total|deliveroo|partner hub)$/i;

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

  const MENU_CATEGORIES = /^(drinks?|burgers?|sandwiches?|sides?|desserts?|fries|wings|box meals?|milkshakes?|saucin['’]? wings|world famous sandwiches|starters?|mains?|kids?|combos?|meals?|snacks?|sauces?)$/i;

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

  function canonicalizeReason(reason) {
    const key = normalizeKey(reason);
    if (!key || HEADER_WORDS.test(key)) return "";
    if (key === "missing" || key.includes("missing item")) return "missing items";
    if (key.includes("prepared incorrectly")) return "prepared incorrectly";
    if (key.includes("food safety")) return "food safety complaint";
    if (key.includes("incorrect")) return "incorrect item";
    return key;
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

  function isOpSpotPage() {
    return /opspot\.workhorselive\.com/i.test(location.host);
  }

  function isDeliverooHub() {
    return /partner-hub\.deliveroo\.com|restaurant-hub\.deliveroo\.com|deliveroo\.(com|co\.uk)/i.test(location.host);
  }

  function isGoogleSheetsPage() {
    return /docs\.google\.com/i.test(location.host) && /\/spreadsheets\//i.test(location.pathname);
  }

  function invalidateModalCache() {
    cachedModal = null;
    cachedModalAt = 0;
  }

  function isRefundDetailsPage() {
    if (isOpSpotPage()) return false;
    if (!isDeliverooHub()) return false;
    if (/\/orders\/refunds\//i.test(location.pathname)) return true;
    const text = document.body ? document.body.innerText : "";
    return /date ordered/i.test(text) && /partner refund value/i.test(text);
  }

  /* -------------------------------------------------------------------------- */
  /* Visible-UI helpers — match what is on screen, not CSS class names          */
  /* -------------------------------------------------------------------------- */

  function findVisibleLabel(root, label) {
    const wanted = normalizeKey(label);
    let best = null;
    let bestLen = Infinity;
    const nodes = root.querySelectorAll("label, dt, th, td, strong, b, p, span, h1, h2, h3, h4, legend, li");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = ownText(el) || (el.children.length === 0 ? normalizeSpace(el.textContent) : "");
      if (!text || text.length > 48) continue;
      const key = normalizeKey(text);
      if (key !== wanted && key !== `${wanted}*`) continue;
      if (text.length <= bestLen && el.tagName !== "TH") {
        best = el;
        bestLen = text.length;
      }
    }
    return best;
  }

  function valueNodeBeside(labelEl) {
    if (!labelEl) return null;
    if (labelEl.nextElementSibling && visible(labelEl.nextElementSibling)) return labelEl.nextElementSibling;

    const parent = labelEl.parentElement;
    if (parent) {
      const kids = [...parent.children].filter(visible);
      const idx = kids.indexOf(labelEl);
      if (idx >= 0 && kids[idx + 1]) return kids[idx + 1];
      if (kids.length === 2 && kids[0].contains(labelEl)) return kids[1];
    }

    const wrap = labelEl.closest("dt, th, td, label, p, span, div");
    if (wrap && wrap !== labelEl) {
      if (wrap.tagName === "DT" && wrap.nextElementSibling) return wrap.nextElementSibling;
      if ((wrap.tagName === "TH" || wrap.tagName === "TD") && wrap.nextElementSibling) return wrap.nextElementSibling;
      const grandKids = wrap.parentElement ? [...wrap.parentElement.children].filter(visible) : [];
      const gIdx = grandKids.indexOf(wrap);
      if (gIdx >= 0 && grandKids[gIdx + 1]) return grandKids[gIdx + 1];
    }
    return null;
  }

  function readUiValue(root, label) {
    const el = findVisibleLabel(root, label);
    if (!el) return { label, el: null, valueEl: null, value: "" };
    const valueEl = valueNodeBeside(el);
    let value = "";
    if (valueEl) {
      value = normalizeSpace(valueEl.innerText || valueEl.textContent);
    } else if (el.parentElement) {
      value = normalizeSpace((el.parentElement.innerText || "").replace(el.innerText, ""));
    }
    if (normalizeKey(value) === normalizeKey(label)) value = "";
    const hit = { label, el, valueEl, value };
    hits.push(hit);
    return hit;
  }

  function highlightHits() {
    for (const hit of hits) {
      if (hit.el) hit.el.classList.add("dcf-hit");
      if (hit.valueEl) hit.valueEl.classList.add("dcf-hit");
    }
  }

  function clearHits() {
    for (const hit of hits) {
      if (hit.el) hit.el.classList.remove("dcf-hit");
      if (hit.valueEl) hit.valueEl.classList.remove("dcf-hit");
    }
    hits.length = 0;
  }

  /* -------------------------------------------------------------------------- */
  /* Deliveroo — header / refund card / timeline / order table                  */
  /* -------------------------------------------------------------------------- */

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
      if (/^missing items$/i.test(lines[i]) && /^refund reason$/i.test(lines[i - 1] || "")) continue;

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

  function buildDisputeFieldValues(items, refundReason) {
    const reason = canonicalizeReason(refundReason);
    const matchedItems = itemsMatchingReason(items, refundReason);
    const itemNames = [...new Set(matchedItems.map((item) => item.name))];

    if (reason === "prepared incorrectly") {
      return {
        wrongFoodItem: "",
        preparedIncorrectlyWhy: CONFIG.preparedIncorrectlyOthersOption,
        reason: "",
        otherReason: itemNames.join("\n"),
      };
    }

    if (reason === "food safety complaint") {
      return {
        wrongFoodItem: "",
        preparedIncorrectlyWhy: "",
        reason: CONFIG.foodSafetyComplaintLabel,
        otherReason: itemNames.join("\n"),
      };
    }

    return {
      wrongFoodItem: itemNames[0] || "",
      preparedIncorrectlyWhy: "",
      reason: "",
      otherReason: itemNames.join("\n"),
    };
  }

  function extractRefundPayload() {
    clearHits();
    invalidatePageLines();
    const errors = [];
    const lines = pageLines();

    const orderNumber = extractOrderNumber();
    if (!orderNumber) errors.push("Order Number");

    const { customer: rawCustomer, location } = extractBrandAndLocation(orderNumber);
    const customer = normalizeCustomerName(rawCustomer);
    if (!customer) errors.push("Customer");
    if (!location) errors.push("Location");

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
    const refundReason = canonicalizeReason(reasonRaw) || itemReason || "";
    if (!refundReason) errors.push("Refund reason");

    const alreadyDisputed = detectAlreadyDisputed(lines);
    highlightHits();

    const outcome = computeOutcome({ disputeAmount, alreadyDisputed, refundReason, customer, location });
    const disputeFields = buildDisputeFieldValues(items, refundReason);
    const payload = {
      extractedAt: new Date().toISOString(),
      sourceUrl: location.href,
      claimDate: claimDate.raw,
      claimDateISO: claimDate.iso,
      claimDateDMY: claimDate.dmy,
      claimDateDash: claimDate.dash,
      orderTime,
      customer,
      location,
      platform: CONFIG.PLATFORM,
      orderNumber,
      orderValue: orderValue == null ? "" : orderValue.toFixed(2),
      disputeAmount: disputeAmount == null ? "" : disputeAmount.toFixed(2),
      refundReason,
      alreadyDisputed,
      outcome,
      videoSubmitted: CONFIG.VIDEO_SUBMITTED,
      reasonForDispute: CONFIG.reasonForDisputeMap[refundReason] || "",
      footageStatus: computeFootageStatus({ alreadyDisputed, disputeAmount, refundReason, customer, location }),
      wrongFoodItem: disputeFields.wrongFoodItem,
      preparedIncorrectlyWhy: disputeFields.preparedIncorrectlyWhy,
      reason: disputeFields.reason || "",
      otherReason: disputeFields.otherReason,
      items,
      errors,
    };

    log("UI payload", payload);
    return payload;
  }

  function normalizeCustomerName(name) {
    const text = normalizeSpace(name);
    if (!text) return "";
    for (const rule of CONFIG.customerAliases || []) {
      if (rule.match.test(text)) return rule.value;
    }
    return text;
  }

  function isFiveGuys(customer, storeLocation) {
    return /five\s*guys/i.test([customer, storeLocation].filter(Boolean).join(" "));
  }

  function isFiveGuysUnderFiveEuros({ customer, location: storeLocation, disputeAmount }) {
    return isFiveGuys(customer, storeLocation) && disputeAmount != null && disputeAmount < CONFIG.FIVE_GUYS_NOT_DISPUTED_MAX_EUR;
  }

  function isUnderTwoPounds(disputeAmount) {
    return disputeAmount != null && disputeAmount < CONFIG.DISPUTE_THRESHOLD_GBP;
  }

  function detectAlreadyDisputed(lines) {
    const bodyText = Array.isArray(lines) ? lines.join("\n") : ((document.body && document.body.innerText) || "");
    return CONTESTED_BODY_RE.test(bodyText);
  }

  function computeOutcome({ disputeAmount, alreadyDisputed, refundReason, customer, location: storeLocation }) {
    const { notDisputed, reviewed, awaitingReview, pending } = CONFIG.outcomeOptions;
    const reason = canonicalizeReason(refundReason);

    if (isFiveGuysUnderFiveEuros({ customer, location: storeLocation, disputeAmount })) return notDisputed;
    if (alreadyDisputed) return reviewed;
    if (isUnderTwoPounds(disputeAmount)) return notDisputed;
    if (reason === "missing items" || reason === "food safety complaint") return awaitingReview;
    if (reason === "prepared incorrectly" || reason === "incorrect item") return pending;
    return "";
  }

  function computeFootageStatus({ alreadyDisputed, disputeAmount, refundReason, customer, location: storeLocation }) {
    const reason = canonicalizeReason(refundReason);
    if (isFiveGuysUnderFiveEuros({ customer, location: storeLocation, disputeAmount })) {
      return CONFIG.footageStatusOptions.irrelevant;
    }
    if (alreadyDisputed) return CONFIG.footageStatusOptions.disputedByThirdParty;
    if (isUnderTwoPounds(disputeAmount)) return CONFIG.footageStatusOptions.irrelevant;
    if (
      reason === "missing items" ||
      reason === "prepared incorrectly" ||
      reason === "incorrect item" ||
      reason === "food safety complaint"
    ) {
      return CONFIG.footageStatusOptions.irrelevant;
    }
    return "";
  }

  /* -------------------------------------------------------------------------- */
  /* OpSpot — fill only the visible Claims modal                                */
  /* -------------------------------------------------------------------------- */

  function getClaimsModal(force = false) {
    const now = Date.now();
    if (
      !force &&
      cachedModal &&
      now - cachedModalAt < CONFIG.MODAL_CACHE_MS &&
      document.contains(cachedModal) &&
      visible(cachedModal)
    ) {
      return cachedModal;
    }

    const candidates = document.querySelectorAll(
      ".modal.show, .modal.in, [role='dialog'], .ew-modal, #ewModalDialog"
    );
    let best = null;
    let bestArea = Infinity;

    const consider = (el) => {
      if (!el || !visible(el) || !el.querySelector("input, select, textarea")) return;
      const text = el.innerText || "";
      if (!/video submitted/i.test(text) || !/other reason/i.test(text)) return;
      if (!/save and add new/i.test(text)) return;
      const area = el.offsetWidth * el.offsetHeight;
      if (area > 8000 && area < bestArea) {
        best = el;
        bestArea = area;
      }
    };

    for (let i = 0; i < candidates.length; i++) consider(candidates[i]);

    if (!best) {
      const forms = document.getElementsByTagName("form");
      for (let i = 0; i < forms.length; i++) consider(forms[i]);
    }

    if (!best) {
      const buttons = document.querySelectorAll("button, input, a");
      for (let i = 0; i < buttons.length; i++) {
        const el = buttons[i];
        if (!visible(el) || !/save and add new/i.test(normalizeSpace(el.textContent || el.value || ""))) continue;
        let node = el.parentElement;
        while (node) {
          const text = node.innerText || "";
          if (/video submitted/i.test(text) && /claim date/i.test(text) && node.querySelector("input, select, textarea")) {
            best = node;
            break;
          }
          node = node.parentElement;
        }
        if (best) break;
      }
    }

    cachedModal = best;
    cachedModalAt = now;
    return best;
  }

  function resetFillGuards() {
    lastFilledOrder = "";
    claimsFillInFlight = false;
    const btn = document.getElementById("dcf-btn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Fill from Deliveroo";
    }
  }

  function closeOpenDropdowns() {
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } catch {
      /* ignore */
    }
    const $ = pageJQuery();
    if ($) {
      try {
        $(".select2-hidden-accessible").each(function () {
          try {
            $(this).select2("close");
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
    }
    const search = document.querySelector(".select2-search__field");
    if (search && search.blur) search.blur();
  }

  function findClaimsCancelButton(modal) {
    if (!modal) return null;
    return [...modal.querySelectorAll("button, input, a")].find((el) => {
      if (!visible(el)) return false;
      const text = normalizeSpace(el.textContent || el.value || "");
      return /^cancel$/i.test(text);
    });
  }

  function findPageAddNewButton() {
    return [...document.querySelectorAll("a, button, input[type='button'], input[type='submit']")].find((el) => {
      if (!visible(el)) return false;
      const text = normalizeSpace(el.textContent || el.value || el.getAttribute("title") || "");
      if (/save/i.test(text)) return false;
      return /\badd new\b/i.test(text);
    });
  }

  async function reopenClaimsModal() {
    closeOpenDropdowns();
    invalidateModalCache();
    const modal = getClaimsModal(true);
    const cancel = findClaimsCancelButton(modal);
    if (cancel) safeClick(cancel);
    else {
      const dismiss = document.querySelector(".modal.show .close, .modal.in .close, [data-dismiss='modal']");
      if (dismiss) safeClick(dismiss);
    }

    await waitUntil(() => !getClaimsModal(true), 2500, 40);

    const addBtn = findPageAddNewButton();
    if (addBtn) safeClick(addBtn);

    invalidateModalCache();
    return waitUntil(() => getClaimsModal(true), 3500, 40);
  }

  function getModalOrderNumber(modal) {
    if (!modal) return "";
    const found =
      controlAfterLabel(modal, CONFIG.opspotLabels.orderNumber) || controlByFieldName(modal, "Order Number");
    const control = found && (found.control || controlForField(found.labelEl, found.row));
    return control ? normalizeSpace(control.value) : "";
  }

  function isClaimsFormEmpty(modal) {
    if (!modal) return false;
    const orderNo = getModalOrderNumber(modal);
    if (orderNo) return false;
    const dateFound = controlAfterLabel(modal, CONFIG.opspotLabels.claimDate);
    const dateControl = dateFound && (dateFound.control || controlForField(dateFound.labelEl, dateFound.row));
    if (dateControl && normalizeSpace(dateControl.value)) return false;
    return true;
  }

  function isSaveButton(el) {
    if (!el || !visible(el)) return false;
    const text = normalizeSpace(el.textContent || el.value || el.getAttribute("title") || "");
    return /^save$/i.test(text) || /save\s+and\s+add\s+new/i.test(text);
  }

  async function waitForFreshClaimsForm(savedOrderNumber) {
    pendingAutoFillAfterSave = true;

    const isFreshModal = (modal) => {
      if (!modal) return false;
      if (isClaimsFormEmpty(modal)) return true;
      const current = getModalOrderNumber(modal);
      return current && savedOrderNumber && current !== savedOrderNumber;
    };

    const finishFresh = async () => {
      saveInProgress = false;
      pendingAutoFillAfterSave = false;
      resetFillGuards();
      const payload = await loadPayload();
      if (payload && payload.orderNumber && payload.orderNumber !== savedOrderNumber) {
        await applyPayloadToClaims(payload, { force: true, fast: true });
        toast(`Ready — filled order ${payload.orderNumber}.`, "success", 3000);
      } else {
        toast("Ready for next order.", "success", 2500);
        if (payload && payload.orderNumber === savedOrderNumber) {
          toast("Run Auto-Fill on the next Deliveroo refund first.", "info", 5000);
        }
      }
    };

    await wait(80);

    if (isFreshModal(getClaimsModal())) {
      await finishFresh();
      return;
    }

    toast("Opening next claim…", "info", 1500);
    await reopenClaimsModal();

    if (isFreshModal(getClaimsModal())) {
      await finishFresh();
      return;
    }

    await reopenClaimsModal();
    if (isFreshModal(getClaimsModal())) {
      await finishFresh();
      return;
    }

    saveInProgress = false;
    pendingAutoFillAfterSave = false;
    resetFillGuards();
    toast("Could not reset form. Click Cancel, then Add New.", "error", 6000);
  }

  function setupOpSpotSaveHooks() {
    if (!isOpSpotPage() || saveHooksInstalled) return;
    saveHooksInstalled = true;
    document.addEventListener(
      "click",
      (event) => {
        const el = event.target.closest("button, input[type='button'], input[type='submit'], a");
        if (!el || !isSaveButton(el)) return;

        closeOpenDropdowns();
        invalidateModalCache();
        const modal = getClaimsModal(true);
        const savedOrderNumber = getModalOrderNumber(modal);
        const saveAndAddNew = /save\s+and\s+add\s+new/i.test(
          normalizeSpace(el.textContent || el.value || "")
        );

        resetFillGuards();
        saveInProgress = true;

        if (saveAndAddNew) {
          setTimeout(() => waitForFreshClaimsForm(savedOrderNumber), 300);
        } else {
          setTimeout(() => {
            saveInProgress = false;
          }, 3000);
        }
      },
      true
    );
  }

  function labelNearControl(control) {
    if (control.labels && control.labels[0]) return normalizeKey(control.labels[0].innerText);
    const aria = control.getAttribute("aria-label");
    if (aria) return normalizeKey(aria);

    const td = control.closest("td");
    if (td && td.previousElementSibling) {
      const prev = normalizeKey(td.previousElementSibling.innerText);
      if (prev && prev.length < 60) return prev;
    }

    const wrap = control.closest("tr, .form-group, .mb-3, .ew-row, li") || control.parentElement;
    if (wrap) {
      const lab = [...wrap.querySelectorAll("label, .control-label, .col-form-label, td, span, div")].find((el) => {
        if (el.contains(control)) return false;
        const t = normalizeKey(el.innerText);
        return t && t.length < 50 && t.length > 2;
      });
      if (lab) return normalizeKey(lab.innerText);
    }

    return normalizeKey((control.name || control.id || "").replace(/^x_/i, "").replace(/[_-]+/g, " "));
  }

  function collectFormFields(modal) {
    const fields = [];
    const controls = [...modal.querySelectorAll("input, select, textarea")].filter((el) => {
      if (el.type === "hidden" || el.type === "submit" || el.type === "button") return false;
      if (el.disabled) return false;
      return true;
    });
    for (const control of controls) {
      const label = labelNearControl(control);
      if (!label) continue;
      fields.push({
        label,
        row: control.closest("tr, .form-group, .mb-3, .ew-row, div") || control.parentElement,
        control,
        labelEl: (control.labels && control.labels[0]) || null,
      });
    }
    return fields;
  }

  function matchFormField(fields, names) {
    const wanted = names.map(normalizeKey);
    return (
      fields.find((f) => wanted.some((w) => f.label === w)) ||
      fields.find((f) => wanted.some((w) => f.label.startsWith(`${w} `) || f.label.startsWith(`${w}*`))) ||
      fields.find((f) => wanted.some((w) => f.label.includes(w) && w.length > 8))
    );
  }

  function captionText(el) {
    const own = ownText(el).replace(/\s*\*+\s*$/g, "");
    if (own && own.length < 80) return normalizeKey(own);
    const first = normalizeKey((el.innerText || "").split("\n")[0] || "");
    if (first && first.length < 80) return first;
    return "";
  }

  function captionMatches(el, label) {
    const wanted = compactKey(label);
    if (!wanted) return false;
    return compactKey(captionText(el)) === wanted;
  }

  function fieldCaptionCount(el) {
    const text = normalizeKey(el.innerText || "");
    let count = 0;
    for (let i = 0; i < FIELD_CAPTIONS.length; i++) {
      if (text.includes(FIELD_CAPTIONS[i])) count += 1;
    }
    return count;
  }

  function isFillableControl(el) {
    if (!el || el.disabled) return false;
    if (el.type === "hidden" || el.type === "submit" || el.type === "button" || el.type === "file" || el.type === "reset") return false;
    if (el.tagName === "SELECT") return true;
    if (el.classList && el.classList.contains("select2-hidden-accessible")) return true;
    return visible(el);
  }

  function controlCell(el) {
    return (
      (el && el.closest(".ew-cell, .ew-ctrl, .form-group, .mb-3, .col-sm-10, .col-sm-8, td, li")) ||
      (el && el.parentElement)
    );
  }

  function controlNearCaption(modal, cap) {
    const inner = [...cap.querySelectorAll("input, select, textarea")].find(isFillableControl);
    if (inner) return inner;

    if (cap.getAttribute && cap.getAttribute("for")) {
      try {
        const byId = document.getElementById(cap.getAttribute("for"));
        if (byId && modal.contains(byId) && isFillableControl(byId)) return byId;
      } catch {
        /* ignore */
      }
    }
    if (cap.control && isFillableControl(cap.control)) return cap.control;

    let sib = cap.nextElementSibling;
    while (sib) {
      if (sib.matches && sib.matches("input, select, textarea") && isFillableControl(sib)) return sib;
      const nested = sib.querySelector && [...sib.querySelectorAll("input, select, textarea")].find(isFillableControl);
      if (nested) return nested;
      sib = sib.nextElementSibling;
    }

    const td = cap.closest("td, th");
    if (td && td.nextElementSibling) {
      const inNext = [...td.nextElementSibling.querySelectorAll("input, select, textarea")].find(isFillableControl);
      if (inNext) return inNext;
    }

    const group = cap.closest(".form-group, .mb-3, .ew-cell, .ew-ctrl, li") || cap.parentElement;
    if (group && fieldCaptionCount(group) <= 1) {
      const inGroup = [...group.querySelectorAll("input, select, textarea")].find(isFillableControl);
      if (inGroup) return inGroup;
    }

    const lr = cap.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;
    for (const el of modal.querySelectorAll("input, select, textarea")) {
      if (!isFillableControl(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && el.tagName !== "SELECT") continue;
      const midY = (lr.top + lr.bottom) / 2;
      const sameRow = r.top < midY + 16 && r.bottom > midY - 16;
      const below = r.top >= lr.top - 2 && r.top <= lr.bottom + 56;
      const toRight = r.left >= lr.left - 4;
      if (!(sameRow || below) || !toRight) continue;
      if (sameRow && r.right < lr.left) continue;
      const dx = Math.max(0, r.left - lr.right);
      const dy = Math.max(0, r.top - lr.bottom);
      const score = sameRow ? dx : dy + 40;
      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return bestScore < 280 ? best : null;
  }

  function controlByFieldName(modal, label) {
    const wanted = compactKey(label);
    if (wanted.length < 5) return null;
    const aliases = {
      ordernumber: ["ordernumber", "orderno", "orderid", "ordernum"],
      ordervalue: ["ordervalue", "ordertotal", "orderval"],
      disputeamount: ["disputeamount", "refundvalue", "refundamount"],
      footagestatus: ["footagestatus", "footage"],
      wrongmissingorincorrectfooditem: ["fooditem", "wrongmissing", "incorrectfood", "missingitem"],
      whywastheitempreparedincorrectly: ["preparedincorrectly", "whywas", "preparedwhy", "itemprepared"],
    };
    const keys = aliases[wanted] || [wanted];
    return [...modal.querySelectorAll("input, select, textarea")].find((el) => {
      if (!isFillableControl(el)) return false;
      if (!modal.contains(el)) return false;
      const raw = `${el.name || ""} ${el.id || ""} ${el.getAttribute("data-field") || ""} ${el.getAttribute("data-name") || ""}`;
      const key = compactKey(raw);
      return keys.some((alias) => key.includes(alias));
    });
  }

  function controlAfterLabel(modal, label) {
    const wanted = normalizeKey(label);
    const nodes = [...modal.querySelectorAll("label, .ew-label, .col-form-label, td, th, span, div, p, strong, b, legend, li")];
    const matches = nodes.filter((el) => {
      if (el.closest("thead")) return false;
      if (!visible(el) && el.tagName !== "LABEL") return false;
      if (!captionMatches(el, label)) return false;
      return fieldCaptionCount(el) <= 1;
    });
    matches.sort((a, b) => {
      const tagScore = (el) => (el.tagName === "LABEL" || el.classList.contains("ew-label") ? 0 : 1);
      const area = (el) => {
        const r = el.getBoundingClientRect();
        return Math.max(1, r.width * r.height);
      };
      return tagScore(a) - tagScore(b) || area(a) - area(b);
    });

    for (const labelEl of matches) {
      const control = controlNearCaption(modal, labelEl);
      if (!control) continue;
      return {
        label: wanted,
        labelEl,
        row: controlCell(control) || labelEl,
        control,
      };
    }

    const named = controlByFieldName(modal, label);
    if (named) {
      return {
        label: wanted,
        labelEl: null,
        row: controlCell(named),
        control: named,
      };
    }
    return null;
  }

  function controlsIn(row) {
    return [...row.querySelectorAll("input:not([type='hidden']), select, textarea")];
  }

  function fieldRow(modal, label) {
    const labelEl = findVisibleLabel(modal, label) || findVisibleLabel(modal, `${label}*`);
    if (!labelEl) return null;

    const candidates = [
      labelEl.closest("tr"),
      labelEl.closest(".form-group, .mb-3, .ew-row, .ew-cell"),
      labelEl.parentElement,
      labelEl.closest(".row"),
    ].filter(Boolean);

    for (const row of candidates) {
      const tooWide = (row.innerText.match(/Claim Date|Customer|Location|Platform|Outcome|Footage Status/gi) || []).length > 3;
      if (tooWide) continue;
      if (row.querySelector("select, input, textarea, .select2-container, .select2")) {
        return { labelEl, row };
      }
    }
    return { labelEl, row: labelEl.parentElement };
  }

  function controlForField(labelEl, row) {
    const forId = labelEl.getAttribute && labelEl.getAttribute("for");
    if (forId) {
      try {
        const byId = document.getElementById(forId);
        if (byId) return byId;
      } catch {
        /* ignore */
      }
    }
    if (labelEl.control) return labelEl.control;

    const roots = [labelEl.nextElementSibling, row, labelEl.parentElement].filter(Boolean);
    for (const root of roots) {
      const select = root.querySelector("select");
      if (select) return select;
    }
    for (const root of roots) {
      const area = root.querySelector("textarea");
      if (area) return area;
    }
    for (const root of roots) {
      const input = [...root.querySelectorAll("input:not([type='hidden'])")].find(visible);
      if (input) return input;
    }
    return null;
  }

  function dispatch(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setInputValue(el, value) {
    const text = String(value);
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
    try {
      el.setAttribute("value", text);
    } catch {
      /* ignore */
    }
    dispatch(el);
    const $ = pageJQuery();
    if ($) {
      try {
        $(el).val(text).trigger("input").trigger("change").trigger("blur");
      } catch {
        /* ignore */
      }
    }
    if (el.value !== text) {
      try {
        el.select();
        document.execCommand("insertText", false, text);
      } catch {
        el.value = text;
        dispatch(el);
      }
    }
  }

  function bestOption(select, value) {
    const wanted = normalizeKey(value);
    const compact = compactKey(value);
    let best = null;
    let score = 0;
    for (const opt of select.options) {
      const t = normalizeKey(opt.textContent);
      const v = normalizeKey(opt.value);
      const tc = compactKey(opt.textContent);
      let s = 0;
      if (!t || /^(select|-|please select)$/i.test(t)) continue;
      if (t === wanted || v === wanted || tc === compact) s = 100;
      else if (t.startsWith(wanted) || wanted.startsWith(t)) s = 80;
      else if (t.includes(wanted) || wanted.includes(t)) s = 55;
      else if (wanted.split(/\s+/).every((w) => w.length > 3 && t.includes(w))) s = 50;
      else if (/irrelevant/.test(wanted) && /irrelevant/.test(t)) s = 90;
      else if (/(3rd|third)\s*party/.test(wanted) && /(3rd|third)\s*party/.test(t)) s = 90;
      if (s > score) {
        best = opt;
        score = s;
      }
    }
    return score >= 45 ? best : null;
  }

  function safeClick(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    } catch {
      /* Tampermonkey sandbox cannot always build MouseEvent */
    }
    try {
      el.click();
    } catch {
      /* ignore */
    }
  }

  function clickMatchingMenuItem(value) {
    const wanted = normalizeKey(value);
    const options = [...document.querySelectorAll(
      ".select2-results__option, .dropdown-item, [role='option'], .select2-result-label, li"
    )].filter((el) => visible(el) && normalizeSpace(el.textContent).length < 120);

    const match = options.find((el) => {
      const t = normalizeKey(el.textContent);
      if (t === wanted) return true;
      if (t.includes(wanted) || wanted.includes(t)) return true;
      return false;
    });
    if (!match) return false;
    safeClick(match);
    return true;
  }

  async function fillSelect(select, value, row) {
    const pause = fastFillMode || CONFIG.FAST_FILL ? 25 : 80;
    const nativeSelect = select && select.tagName === "SELECT" ? select : (row && row.querySelector("select"));
    const option = nativeSelect ? bestOption(nativeSelect, value) : null;
    const $ = pageJQuery();
    const root = controlCell(nativeSelect || select) || row;

    if (nativeSelect && option) {
      nativeSelect.value = option.value;
      nativeSelect.dispatchEvent(new Event("input", { bubbles: true }));
      nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      if ($) {
        try {
          $(nativeSelect).val(String(option.value)).trigger("change").trigger("select2:select");
        } catch {
          /* ignore */
        }
      }
      const rendered = root && root.querySelector(".select2-selection__rendered");
      if (rendered && option.textContent) rendered.textContent = normalizeSpace(option.textContent);
      if (nativeSelect.value === option.value) return true;
    }

    const box =
      (root && root.querySelector(".select2-selection, .select2-container, .dropdown-toggle")) ||
      (nativeSelect && nativeSelect.parentElement && nativeSelect.parentElement.querySelector(".select2-selection, .select2-container")) ||
      nativeSelect ||
      select;
    if (box) {
      safeClick(box);
      await wait(pause);
    }

    const searchTerms = [value];
    if (/irrelevant/i.test(String(value))) searchTerms.unshift("irrelevant");
    if (/(3rd|third)\s*party/i.test(String(value))) searchTerms.unshift("3rd party");
    const firstWord = String(value).trim().split(/\s+/)[0];
    if (firstWord && firstWord.length > 3 && !searchTerms.includes(firstWord)) searchTerms.push(firstWord);

    const search = document.querySelector(".select2-search__field, .dropdown-menu input, input[type='search']");
    for (const term of searchTerms) {
      if (search) {
        search.focus();
        setInputValue(search, term);
        search.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
        await wait(pause);
      }
      if (await clickMatchingMenuItem(term)) return true;
    }

    if (search) {
      search.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await wait(pause);
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return Boolean(nativeSelect && option && nativeSelect.value === option.value);
  }

  function fillYesNo(row, value) {
    const wanted = normalizeKey(value);
    const radio = [...row.querySelectorAll("input[type='radio']")].find((el) => {
      const lab = el.closest("label") || (el.id && row.querySelector(`label[for='${el.id}']`));
      return normalizeKey((lab && lab.textContent) || el.value) === wanted;
    });
    if (radio) {
      radio.click();
      radio.checked = true;
      dispatch(radio);
      return true;
    }
    const btn = [...row.querySelectorAll("button, label, span, a, div")].find((el) => {
      return visible(el) && normalizeKey(el.textContent) === wanted && normalizeSpace(el.textContent).length <= 4;
    });
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  async function fillLabeledField(modal, label, value, extras = {}, fieldIndex = null) {
    if (value == null || value === "") return { ok: false, reason: "empty" };
    const fields = fieldIndex || collectFormFields(modal);
    let found = controlAfterLabel(modal, label) || matchFormField(fields, [label, `${label}*`]) || fieldRow(modal, label);

    if (!found || !found.control) {
      const named = controlByFieldName(modal, label);
      if (named) {
        found = {
          label: normalizeKey(label),
          row: controlCell(named),
          control: named,
          labelEl: found && found.labelEl,
        };
      }
    }
    if (!found) return { ok: false, reason: "label not on screen" };

    const row = found.row;
    const labelEl = found.labelEl;
    if (labelEl) labelEl.classList.add("dcf-hit");

    if (/video submitted/i.test(label)) return { ok: fillYesNo(row, value), method: "yes-no" };

    let control = found.control || controlForField(labelEl, row);
    if (/order number|order value|dispute amount/i.test(label) && control && control.tagName === "SELECT") {
      control = controlByFieldName(modal, label) || control;
    }
    if (!control) {
      const box = row && row.querySelector(".select2-selection, .select2-container");
      if (box) {
        const ok = await fillSelect(row.querySelector("select") || box, value, row);
        return { ok, method: "select2-only" };
      }
      return { ok: false, reason: "no control next to label" };
    }
    control.classList.add("dcf-hit");

    if (control.tagName === "SELECT") return { ok: await fillSelect(control, value, controlCell(control) || row), method: "select" };
    if (control.type === "date") {
      setInputValue(control, extras.iso || value);
      return { ok: true, method: "date" };
    }
    if (control.type === "time") {
      setInputValue(control, extractTime(value));
      return { ok: true, method: "time" };
    }
    if (control.type === "radio") return { ok: fillYesNo(row, value), method: "radio" };

    const written = extras.dmy && /date/i.test(label) ? extras.dmy : value;
    setInputValue(control, written);
    const $ = pageJQuery();
    if ($ && $(control).data("datepicker")) {
      try {
        $(control).datepicker("update", written);
      } catch {
        /* ignore */
      }
    }
    const stuck = String(control.value || "").replace(/,/g, "") === String(written).replace(/,/g, "") ||
      String(control.value || "").includes(String(written));
    return { ok: stuck || Boolean(control.value), method: "input", reason: stuck ? "" : "value did not stick" };
  }

  async function ensureClaimsModal() {
    invalidateModalCache();
    if (getClaimsModal(true)) return getClaimsModal(true);

    if (saveInProgress || pendingAutoFillAfterSave) {
      return waitUntil(() => getClaimsModal(true), 8000, 50);
    }

    const addBtn = findPageAddNewButton();
    if (addBtn) {
      addBtn.click();
      toast("Opening Add New…", "info", 2000);
    }

    return waitUntil(() => getClaimsModal(true), 10000, 100);
  }

  async function fillClaimsForm(payload, options = {}) {
    const modal = await ensureClaimsModal();
    if (!modal) throw new Error("Click the green Add New button, then click Fill from Deliveroo.");

    const fieldPause = 0;
    const L = CONFIG.opspotLabels;
    const results = {};
    const fieldIndex = collectFormFields(modal);
    const jobs = [
      [L.claimDate, payload.claimDateDash || payload.claimDateDMY, { iso: payload.claimDateISO, dmy: payload.claimDateDash || payload.claimDateDMY }],
      [L.orderTime, payload.orderTime],
      [L.customer, payload.customer],
      [L.location, payload.location],
      [L.platform, payload.platform],
      [L.orderNumber, payload.orderNumber],
      [L.orderValue, payload.orderValue],
      [L.disputeAmount, payload.disputeAmount],
      [L.outcome, payload.outcome],
      [L.videoSubmitted, payload.videoSubmitted],
      [L.reasonForDispute, payload.reasonForDispute],
      [L.footageStatus, payload.footageStatus],
    ];

    if (payload.preparedIncorrectlyWhy) {
      jobs.push([L.preparedIncorrectlyWhy, payload.preparedIncorrectlyWhy]);
    } else if (payload.wrongFoodItem) {
      jobs.push([L.wrongFoodItem, payload.wrongFoodItem]);
    }

    if (payload.reason) {
      jobs.push([L.reason, payload.reason]);
    }

    jobs.push([L.otherReason, payload.otherReason]);

    for (const [label, value, extras] of jobs) {
      try {
        if (label === L.reason) {
          await waitUntil(() => controlAfterLabel(modal, L.reason), options.fast || fastFillMode ? 1500 : 2500, 50);
        }
        results[label] = await fillLabeledField(modal, label, value, extras || {}, fieldIndex);
      } catch (err) {
        log("Field fill error", label, err);
        results[label] = { ok: false, reason: String(err && err.message ? err.message : err) };
      }
      if (label === L.reasonForDispute && (payload.preparedIncorrectlyWhy || payload.reason || /other/i.test(String(payload.reasonForDispute || "")))) {
        await wait(options.fast || fastFillMode || CONFIG.FAST_FILL ? 60 : 150);
      }
      if ((!results[label] || !results[label].ok) && label === L.reasonForDispute && /other/i.test(String(value || ""))) {
        for (const alt of ["Other", "Others", "other", "others"]) {
          if (alt === value) continue;
          results[label] = await fillLabeledField(modal, label, alt, {}, fieldIndex);
          if (results[label].ok) break;
        }
      }
      if ((!results[label] || !results[label].ok) && /prepared incorrectly/i.test(label)) {
        for (const alt of ["Others", "Other", "others", "other"]) {
          if (alt === value) continue;
          results[label] = await fillLabeledField(modal, label, alt, {}, fieldIndex);
          if (results[label].ok) break;
        }
      }
      if ((!results[label] || !results[label].ok) && /wrong, missing/i.test(label)) {
        const tries = [
          ...((payload.items || []).map((item) => item && item.name)),
          String(payload.otherReason || "").split("\n")[0],
          payload.otherReason,
        ].filter((v, i, arr) => v && arr.indexOf(v) === i);
        for (const alt of tries) {
          if (alt === value) continue;
          results[label] = await fillLabeledField(modal, label, alt, {}, fieldIndex);
          if (results[label].ok) break;
        }
      }
      if (results[label] && /select/i.test(results[label].method || "") && fieldPause) {
        await wait(fieldPause);
      }
    }
    log("Fill results", results);
    return results;
  }

  /* -------------------------------------------------------------------------- */
  /* UI chrome                                                                  */
  /* -------------------------------------------------------------------------- */

  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    GM_addStyle(`
      .dcf-hit { outline: 2px solid #00ccbc !important; outline-offset: 2px; background: rgba(0,204,188,.12) !important; }
      #dcf-btn-bar {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; display: flex; gap: 8px; align-items: center;
      }
      #dcf-btn, #dcf-sheet-btn {
        background: #00ccbc; color: #06221f; border: 0; cursor: pointer;
        border-radius: 999px; padding: 12px 22px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        font: 700 15px/1.2 Segoe UI, system-ui, sans-serif;
      }
      #dcf-sheet-btn { background: #0f766e; color: #ecfdf5; }
      #dcf-btn:hover, #dcf-sheet-btn:hover { background: #111827; color: #fff; }
      #dcf-btn:disabled, #dcf-sheet-btn:disabled { opacity: .65; cursor: wait; }
      #dcf-toast, #dcf-preview {
        position: fixed; top: 64px; right: 18px; z-index: 2147483646;
        max-width: 380px; border-radius: 12px; padding: 12px 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.28);
        font: 13px/1.45 Segoe UI, system-ui, sans-serif;
      }
      #dcf-toast { background: #111827; color: #f9fafb; }
      #dcf-toast.error { background: #7f1d1d; }
      #dcf-toast.success { background: #065f46; }
      #dcf-preview { background: #fff; color: #111827; width: 380px; max-height: 70vh; overflow: auto; }
      #dcf-preview h3 { margin: 0 0 8px; font-size: 14px; }
      #dcf-preview table { width: 100%; border-collapse: collapse; }
      #dcf-preview td { padding: 4px 0; vertical-align: top; }
      #dcf-preview td:first-child { color: #6b7280; width: 44%; padding-right: 8px; }
      #dcf-preview .missing { color: #b91c1c; }
    `);
  }

  function toast(message, kind = "info", ms = 4500) {
    document.getElementById("dcf-toast")?.remove();
    const el = document.createElement("div");
    el.id = "dcf-toast";
    el.className = kind;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function showPreview(payload) {
    document.getElementById("dcf-preview")?.remove();
    const el = document.createElement("div");
    el.id = "dcf-preview";
    const rows = [
      ["Claim Date", payload.claimDate],
      ["Order Time", payload.orderTime],
      ["Customer", payload.customer],
      ["Location", payload.location],
      ["Platform", payload.platform],
      ["Order Number", payload.orderNumber],
      ["Order Value", payload.orderValue],
      ["Dispute Amount", payload.disputeAmount],
      ["Outcome", payload.outcome],
      ["Video Submitted", payload.videoSubmitted],
      ["Reason for Dispute", payload.reasonForDispute],
      ["Reason", payload.reason],
      ["Footage Status", payload.footageStatus],
      ["Why was the Item Prepared Incorrectly?", payload.preparedIncorrectlyWhy],
      ["Wrong, Missing or Incorrect Food Item", payload.wrongFoodItem],
      ["Other reason", payload.otherReason],
      ["Contested / Disputed", payload.alreadyDisputed ? "Yes" : "No"],
    ]
      .map(([k, v]) => `<tr><td>${k}</td><td class="${v ? "" : "missing"}">${escapeHtml(v || "NOT FOUND")}</td></tr>`)
      .join("");
    el.innerHTML = `<h3>Read from screen</h3><table>${rows}</table>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 12000);
  }

  function resolveSheetTab(payload) {
    const haystack = [payload.customer, payload.location, payload.brand]
      .filter(Boolean)
      .join(" ");
    for (const rule of CONFIG.branchSheetTabs || []) {
      if (rule.match.test(haystack)) return rule.tab;
    }
    return CONFIG.defaultSheetTab || "";
  }

  function toDayMonthYear(payload) {
    if (payload.claimDateDash && /^\d{2}-\d{2}-\d{4}$/.test(payload.claimDateDash)) {
      return payload.claimDateDash;
    }
    const parsed = parseClaimDate(payload.claimDateDash || payload.claimDateDMY || payload.claimDate || "");
    return parsed.dash || "";
  }

  function sheetCell(value) {
    const text = String(value == null ? "" : value).replace(/\r\n/g, " ").replace(/\t/g, " ").trim();
    if (/["\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function buildGoogleSheetRow(payload) {
    const date = toDayMonthYear(payload);
    const location = payload.location || "";
    const orderNumber = payload.orderNumber || "";
    const refundReason = payload.reasonForDispute || "";
    const withVideo = payload.videoSubmitted || CONFIG.VIDEO_SUBMITTED || "No";
    const footageStatus = payload.footageStatus || "";

    const row = {
      Date: date ? `'${date}` : "",
      Location: location,
      "# Order Number": orderNumber,
      "Refund Reason": refundReason,
      "With Video?": withVideo,
      "Footage Status": footageStatus,
      Comments: "",
    };

    return CONFIG.sheetColumns.map((header) => sheetCell(row[header])).join("\t");
  }

  function buildSheetTransfer(payload) {
    return {
      extractedAt: new Date().toISOString(),
      tab: resolveSheetTab(payload),
      row: buildGoogleSheetRow(payload),
      orderNumber: payload.orderNumber || "",
      customer: payload.customer || "",
      location: payload.location || "",
      payload,
    };
  }

  function saveSheetTransfer(transfer) {
    try {
      GM_setValue(CONFIG.SHEET_STORAGE_KEY, transfer);
    } catch (err) {
      log("sheet GM_setValue failed", err);
    }
    try {
      if (typeof GM !== "undefined" && GM.setValue) GM.setValue(CONFIG.SHEET_STORAGE_KEY, transfer);
    } catch (err) {
      log("sheet GM.setValue failed", err);
    }
  }

  async function loadSheetTransfer() {
    let transfer = null;
    try {
      transfer = GM_getValue(CONFIG.SHEET_STORAGE_KEY, null);
    } catch (err) {
      log("sheet GM_getValue failed", err);
    }
    if (transfer && transfer.row) return transfer;
    try {
      if (typeof GM !== "undefined" && GM.getValue) transfer = await GM.getValue(CONFIG.SHEET_STORAGE_KEY, null);
    } catch (err) {
      log("sheet GM.getValue failed", err);
    }
    return transfer && transfer.row ? transfer : null;
  }

  function findGoogleSheetTabButton(tabName) {
    if (!tabName) return null;
    const wanted = normalizeKey(tabName);
    const nodes = [
      ...document.querySelectorAll(".docs-sheet-tab, .docs-sheet-tab-name, [role='tab'], .docs-sheet-container .docs-sheet-tab-caption"),
    ];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const text = normalizeSpace(el.textContent || el.getAttribute("aria-label") || "");
      if (!text) continue;
      const key = normalizeKey(text);
      if (key === wanted || key.includes(wanted) || wanted.includes(key)) {
        return el.closest(".docs-sheet-tab") || el;
      }
    }
    return null;
  }

  async function activateGoogleSheetTab(tabName) {
    if (!tabName) return { ok: false, reason: "No branch tab matched" };
    const tabBtn = await waitUntil(() => findGoogleSheetTabButton(tabName), 4000, 100);
    if (!tabBtn) return { ok: false, reason: `Tab "${tabName}" not found` };
    safeClick(tabBtn);
    await wait(120);
    return { ok: true, reason: "" };
  }

  function focusSheetPasteCell() {
    const canvas = document.querySelector(".grid-container, .waffle, .docs-texteventtarget-iframe, .cell-input");
    if (canvas) safeClick(canvas);
    const editable = document.querySelector(".cell-input, [contenteditable='true'], .grid-container");
    if (editable && editable.focus) editable.focus();
  }

  function copyTextToClipboard(text) {
    try {
      GM_setClipboard(text);
      return true;
    } catch (err) {
      log("GM_setClipboard failed", err);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      log("navigator clipboard failed", err);
    }
    return false;
  }

  function savePayload(payload) {
    try {
      GM_setValue(CONFIG.STORAGE_KEY, payload);
    } catch (err) {
      log("GM_setValue failed", err);
    }
    try {
      if (typeof GM !== "undefined" && GM.setValue) GM.setValue(CONFIG.STORAGE_KEY, payload);
    } catch (err) {
      log("GM.setValue failed", err);
    }
    try {
      GM_setClipboard(CONFIG.CLIP_PREFIX + JSON.stringify(payload));
    } catch (err) {
      log("clipboard failed", err);
    }
  }

  async function loadPayload() {
    let payload = null;
    try {
      payload = GM_getValue(CONFIG.STORAGE_KEY, null);
    } catch (err) {
      log("GM_getValue failed", err);
    }
    if (payload && payload.orderNumber) return payload;
    try {
      if (typeof GM !== "undefined" && GM.getValue) payload = await GM.getValue(CONFIG.STORAGE_KEY, null);
    } catch (err) {
      log("GM.getValue failed", err);
    }
    if (payload && payload.orderNumber) return payload;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return null;
      if (text.startsWith(CONFIG.CLIP_PREFIX)) return JSON.parse(text.slice(CONFIG.CLIP_PREFIX.length));
      if (text.trim().startsWith("{")) {
        const parsed = JSON.parse(text);
        if (parsed.orderNumber) return parsed;
      }
    } catch (err) {
      log("clipboard read failed", err);
    }
    return null;
  }

  function ensureButtonBar() {
    ensureStyles();
    let bar = document.getElementById("dcf-btn-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "dcf-btn-bar";
      (document.body || document.documentElement).appendChild(bar);
    }
    return bar;
  }

  function injectButton(id, text, onClick) {
    const bar = ensureButtonBar();
    let btn = document.getElementById(id);
    if (!btn) {
      btn = document.createElement("button");
      btn.id = id;
      btn.type = "button";
      bar.appendChild(btn);
    }
    if (btn.textContent !== text) btn.textContent = text;
    btn.onclick = onClick;
    return btn;
  }

  function mount() {
    const root = document.body;
    if (!root) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }

    if (isGoogleSheetsPage()) {
      const existing = document.getElementById("dcf-sheet-btn");
      if (existing && existing.onclick) return;
      injectButton("dcf-sheet-btn", "Paste Deliveroo → Sheet Tab", onPasteSheetClick);
      return;
    }

    const existing = document.getElementById("dcf-btn");
    const sheetExisting = document.getElementById("dcf-sheet-btn");
    if (existing && existing.onclick && (!isDeliverooHub() || (sheetExisting && sheetExisting.onclick))) return;

    if (isOpSpotPage()) {
      injectButton("dcf-btn", "Fill from Deliveroo", async () => {
        resetFillGuards();
        const payload = await loadPayload();
        if (!payload) {
          toast("No stored order. Click Auto-Fill & Dispute on the refund tab first, then click here.", "error", 7000);
          return;
        }
        await applyPayloadToClaims(payload, { force: true });
      });
      return;
    }

    if (isDeliverooHub()) {
      injectButton("dcf-btn", "Auto-Fill & Dispute", onExtractClick);
      injectButton("dcf-sheet-btn", "Copy for Google Sheet", onCopySheetClick);
    }
  }

  function boot() {
    ensureStyles();
    if (typeof GM_registerMenuCommand === "function") {
      if (isGoogleSheetsPage()) {
        GM_registerMenuCommand("Paste Deliveroo → Sheet Tab", onPasteSheetClick);
      } else if (typeof location !== "undefined" && /opspot/i.test(location.host)) {
        GM_registerMenuCommand("Fill from Deliveroo", async () => {
          resetFillGuards();
          const payload = await loadPayload();
          if (!payload) {
            toast("No stored order. Run Auto-Fill on the refund tab first.", "error", 7000);
            return;
          }
          await applyPayloadToClaims(payload, { force: true });
        });
      } else {
        GM_registerMenuCommand("Auto-Fill & Dispute", onExtractClick);
        GM_registerMenuCommand("Copy for Google Sheet", onCopySheetClick);
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
          if (!document.getElementById("dcf-sheet-btn")) remount();
        } else if (!document.getElementById("dcf-btn") || (isDeliverooHub() && !document.getElementById("dcf-sheet-btn"))) {
          remount();
        }
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener(CONFIG.STORAGE_KEY, (_n, _o, value, remote) => {
        if (remote && isOpSpotPage() && value) {
          resetFillGuards();
          applyPayloadToClaims(value, { force: true });
        }
      });
      GM_addValueChangeListener(CONFIG.SHEET_STORAGE_KEY, (_n, _o, value, remote) => {
        if (remote && isGoogleSheetsPage() && value && value.row) {
          toast(`Ready for tab "${value.tab || "?"}": click Paste Deliveroo → Sheet Tab`, "info", 7000);
        }
      });
    }
    setupOpSpotSaveHooks();
    mount();
  }

  async function onExtractClick() {
    const btn = document.getElementById("dcf-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Reading screen…";
    }
    try {
      const payload = extractRefundPayload();
      showPreview(payload);
      savePayload(payload);
      if (payload.errors.length) toast(`UI miss: ${payload.errors.join(", ")}`, "error", 7000);
      else toast(`v1.8.1 stored order #${payload.orderNumber}. Click Fill from Deliveroo on OpSpot.`, "success", 7000);
    } catch (err) {
      toast(`Extraction failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Auto-Fill & Dispute";
      }
    }
  }

  async function onCopySheetClick() {
    const btn = document.getElementById("dcf-sheet-btn");
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
        toast(`Copied #${payload.orderNumber} → tab "${tabLabel}". Open Google Sheet and click Paste Deliveroo → Sheet Tab.`, "success", 9000);
      }
    } catch (err) {
      toast(`Sheet copy failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Copy for Google Sheet";
      }
    }
  }

  async function onPasteSheetClick() {
    const btn = document.getElementById("dcf-sheet-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Switching tab…";
    }
    try {
      const transfer = await loadSheetTransfer();
      if (!transfer || !transfer.row) {
        toast("No copied Deliveroo row. Click Copy for Google Sheet on the refund page first.", "error", 8000);
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
        btn.textContent = "Paste Deliveroo → Sheet Tab";
      }
    }
  }

  async function applyPayloadToClaims(payload, options = {}) {
    if (!payload || !payload.orderNumber || claimsFillInFlight) return;
    if (!options.force && lastFilledOrder === payload.orderNumber) return;
    claimsFillInFlight = true;
    const btn = document.getElementById("dcf-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Filling Claims…";
    }
    fastFillMode = options.fast !== false && CONFIG.FAST_FILL !== false;
    try {
      const modal = await waitUntil(() => getClaimsModal(), 5000, 40);
      if (!modal && !getClaimsModal()) {
        await waitUntil(() => getClaimsModal(), 1500, 40);
      }
      const results = await fillClaimsForm(payload, { ...options, fast: true });
      lastFilledOrder = payload.orderNumber;
      showPreview(payload);
      const failed = Object.entries(results)
        .filter(([, r]) => !r.ok)
        .map(([k, r]) => (r.reason ? `${k} (${r.reason})` : k));
      if (failed.length) toast(`Could not fill: ${failed.join(", ")}`, "error", 7000);
      else toast(`v1.8.1 filled claim ${payload.orderNumber}.`, "success");
    } catch (err) {
      toast(`Fill failed: ${err.message || err}`, "error");
    } finally {
      fastFillMode = false;
      claimsFillInFlight = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Fill from Deliveroo";
      }
    }
  }

  boot();
})();
