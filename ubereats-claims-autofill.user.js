// ==UserScript==
// @name         Uber Eats Order → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      2.2.3
// @description  Read Uber Eats Manager orders/issues and fill OpSpot Claims (preset-driven Workhorse fills).
// @author       Claims Ops
// @match        https://merchants.ubereats.com/*
// @match        *://merchants.ubereats.com/*
// @match        https://opspot.workhorselive.com/*
// @match        https://opspot.workhorselive.com/sysTable.php*
// @match        *://opspot.workhorselive.com/*
// @match        *://*.workhorselive.com/*
// @require      https://raw.githubusercontent.com/nachtalia/automation/main/claims-presets.js?v=2.2.3
// @require      https://raw.githubusercontent.com/nachtalia/automation/main/claims-core.js?v=2.2.3
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
 *   Uber Eats: https://merchants.ubereats.com/manager/orders/...
 *   OpSpot:    https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000#
 *
 * You must be logged in on both. The login screens have no order data.
 * Presets/core load from GitHub via @require (raw.githubusercontent.com).
 */

(function () {
  "use strict";

  const root = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (!root.ClaimsCore || !root.ClaimsPresets) {
    console.error("[Uber Claims] Load claims-presets.js and claims-core.js via @require (check network / Tampermonkey @require).");
    return;
  }
  const core = root.ClaimsCore.create("ubereats");
  const {
    normalizeSpace, normalizeKey, visible, ownText, debounce,
    parseMoney, parseClaimDate,
    isOpSpotPage,
    canonicalizeReason, normalizeCustomerName,
    buildDisputeFieldValues, enrichPayload,
    savePayload, loadPayload, toast, showPreview, ensureStyles, injectButton, ensureButtonBar,
    applyPayloadToClaims, setupOpSpotSaveHooks, resetFillGuards,
    clearHits, highlightHits, hits, platform, version,
  } = core;

  const normalizeLocationName =
    typeof core.normalizeLocationName === "function"
      ? core.normalizeLocationName
      : (name) => normalizeSpace(name);

  const uiPrefix = platform.uiPrefix || "ucf";
  const btnId = `${uiPrefix}-btn`;
  const workhorse = core.workhorse;

  let pageLinesCache = null;

  const HEADER_WORDS = /^(quantity|qty|price|item|items|name|category|total|refund reason|refund details)$/i;
  const UI_NOISE = /^(refund details|refund reason|partner refund value|order total|date ordered|order submitted|order timeline|dispute this refund|prepared incorrectly|missing|missing item|missing items|incorrect|incorrect item|incorrect items|food safety complaint|category|quantity|qty|price|item|items|name|total|deliveroo|uber eats|partner hub|marketplace fee|net payout|sales \(incl\. gst\)|chargeback amount|customization reported missing|item reported missing|\d+\s+customization(?:s)?\s+missing)$/i;
  const REASON_ROW_RE = /^(missing|missing item|missing items|prepared incorrectly|incorrect item|incorrect items|incorrect|food safety complaint)$/i;
  const CONTESTED_BODY_RE = /refund\s+contested|appeal submitted|dispute\s+submitted|dispute\s+sent\b|refund\s+appeal/i;

  const ISSUE_ITEM_MISSING_RE = /^item\s+reported\s+missing$/i;
  const ISSUE_CUSTOMIZATION_MISSING_RE = /^customization\s+reported\s+missing$/i;
  const ISSUE_N_CUSTOMIZATIONS_RE = /^\d+\s+customization(?:s)?\s+missing$/i;
  const ITEM_COMPONENT_RE = /^(burger|regular sides|regular drinks|toppings|side|drink|choose your)/i;
  const INVALID_ORDER_CODES = new Set([
    "DETAILS", "ORDER", "SALES", "TOTAL", "PAYOUT", "CUSTOM", "ITEMS", "REFUND",
    "DISPUTE", "CHARGE", "AMOUNT", "DELIVERY", "BURGER", "STATUS", "REVIEW",
    "SUBMIT", "CANCEL", "CLOSED", "ACTIVE", "SEARCH", "FILTER", "REPORT",
  ]);
  const MONTH_ABBR = /(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)$/i;

  /** Uber Manager often shows 12h clock; core extractTime is 24h-only. */
  function extractTime(text) {
    const ampm = String(text || "").match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
    if (ampm) {
      let h = Number.parseInt(ampm[1], 10);
      const m = ampm[2];
      if (/pm/i.test(ampm[3]) && h < 12) h += 12;
      if (/am/i.test(ampm[3]) && h === 12) h = 0;
      return `${String(h).padStart(2, "0")}:${m}`;
    }
    const m = String(text || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
  }

  function isValidItemName(name) {
    const text = normalizeSpace(name);
    if (!text || text.length < 2 || text.length > 80) return false;
    const key = normalizeKey(text);
    if (HEADER_WORDS.test(key) || UI_NOISE.test(key)) return false;
    if (/^£/.test(text) || /^\d+(\.\d{2})?$/.test(text)) return false;
    if (/^order\s*#/i.test(text)) return false;
    if (/^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(text)) return false;
    return true;
  }

  function invalidatePageLines() {
    pageLinesCache = null;
  }

  function pageLinesAll() {
    return ((document.body && document.body.innerText) || "")
      .split(/\n+/)
      .map(normalizeSpace)
      .filter(Boolean);
  }

  function pageLines() {
    if (pageLinesCache) return pageLinesCache;
    const extractionRoot = getExtractionRoot();
    pageLinesCache = ((extractionRoot && extractionRoot.innerText) || "")
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

  function isUberEatsPage() {
    return /merchants\.ubereats\.com/i.test(location.host);
  }

  function isUberOrderPage() {
    if (!isUberEatsPage()) return false;
    return /\/manager\/orders\//i.test(location.pathname);
  }

  function normalizeOrderCodeToken(token) {
    let code = String(token || "").toUpperCase().replace(/[,.]$/, "");
    if (MONTH_ABBR.test(code)) code = code.replace(MONTH_ABBR, "");
    if (isLikelyOrderCode(code)) return code;
    const compact = code.match(/^([A-Z]{1,3}\d{2,5}|\d[A-Z0-9]{2,5})/);
    if (compact && isLikelyOrderCode(compact[1])) return compact[1].toUpperCase();
    return "";
  }

  function isLikelyOrderCode(code) {
    const text = String(code || "").toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(text)) return false;
    if (!/[A-Z]/.test(text) || !/\d/.test(text)) return false;
    if (/^(19|20)\d{2}$/.test(text)) return false;
    if (MONTH_ABBR.test(text)) return false;
    if (INVALID_ORDER_CODES.has(text)) return false;
    return true;
  }

  function findOrderNumberInText(text) {
    const normalized = normalizeSpace(text);
    if (!normalized) return "";
    const withLabel = normalized.match(/\border\s+#?\s*([A-Z0-9]{4,8})\b/i);
    if (withLabel) {
      const code = normalizeOrderCodeToken(withLabel[1]);
      if (code) return code;
    }
    const tokens = normalized.match(/\b[A-Z0-9]{4,6}\b/gi) || [];
    for (let i = 0; i < tokens.length; i++) {
      const code = normalizeOrderCodeToken(tokens[i]);
      if (code) return code;
    }
    return "";
  }

  function looksLikeAddress(text) {
    const value = normalizeSpace(text);
    if (!value || value.length < 8) return false;
    if (/,/.test(value)) return true;
    return /\b(road|street|st\.?|ave\.?|avenue|drive|dr\.?|rd\.?|lane|way|boulevard|blvd\.?|place|plaza|highway|hwy)\b/i.test(value);
  }

  function stripOuterParens(text) {
    const value = normalizeSpace(text);
    const m = value.match(/^\((.+)\)$/);
    return m ? normalizeSpace(m[1]) : value;
  }

  function parseBrandLocation(text) {
    const line = normalizeSpace(text);

    // Burger King (East Tamaki) (68 East Tamaki Road, Papatoetoe, Auckland)
    const dual = line.match(/^(.+?\([^)]+\))\s*\((.+)\)\s*$/);
    if (dual && looksLikeAddress(dual[2])) {
      return { customer: normalizeSpace(dual[1]), location: normalizeSpace(dual[2]) };
    }

    // Legacy: Brand (Store area) when the paren is not a street address
    const paren = line.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      const inside = normalizeSpace(paren[2]);
      if (looksLikeAddress(inside)) {
        return { customer: normalizeSpace(paren[1]), location: inside };
      }
      return { customer: line, location: "" };
    }

    if (line.includes(" - ")) {
      const parts = line.split(" - ").map(normalizeSpace);
      return { customer: parts[0] || "", location: parts.slice(1).join(" - ") || "" };
    }
    return { customer: line, location: "" };
  }

  function extractBrandAndLocation() {
    const extractionRoot = getExtractionRoot();
    const dateRe = /[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2},?\s+[A-Za-z]{3,9},?\s+\d{4}/;

    const tryPair = (customerText, locationText, el) => {
      const customer = normalizeSpace(customerText);
      let storeLocation = stripOuterParens(locationText);
      if (!customer || customer.length > 90) return null;
      if (/order placed|delivery details|order details|sales \(incl/i.test(customer)) return null;
      if (!storeLocation || !looksLikeAddress(storeLocation)) return null;
      hits.push({
        label: "Customer / Location",
        el: el || null,
        valueEl: el || null,
        value: `${customer} | ${storeLocation}`,
      });
      return { customer, location: storeLocation };
    };

    // DOM: find the date under the order heading, then customer below it and address beside it
    const nodes = extractionRoot.querySelectorAll("h1, h2, h3, h4, p, span, div, strong");
    for (let i = 0; i < nodes.length; i++) {
      const dateEl = nodes[i];
      if (!visible(dateEl)) continue;
      const dateText = ownText(dateEl) || normalizeSpace(dateEl.textContent);
      if (!dateText || dateText.length > 40 || !dateRe.test(dateText)) continue;

      const parent = dateEl.parentElement;
      const siblings = parent ? [...parent.children] : [];
      const dateIdx = siblings.indexOf(dateEl);
      const after = dateIdx >= 0 ? siblings.slice(dateIdx + 1, dateIdx + 6) : [];

      for (let s = 0; s < after.length; s++) {
        const block = after[s];
        if (!visible(block)) continue;
        const blockText = normalizeSpace(block.innerText || block.textContent);
        const dual = parseBrandLocation(blockText);
        if (dual.customer && dual.location) {
          hits.push({ label: "Customer / Location", el: block, valueEl: block, value: blockText });
          return dual;
        }

        const kids = [...block.querySelectorAll("span, div, p, strong, a")].filter(visible);
        for (let a = 0; a < kids.length; a++) {
          for (let b = a + 1; b < Math.min(kids.length, a + 4); b++) {
            const left = ownText(kids[a]) || normalizeSpace(kids[a].textContent);
            const right = ownText(kids[b]) || normalizeSpace(kids[b].textContent);
            const paired = tryPair(left, right, block);
            if (paired) return paired;
          }
        }

        const next = after[s + 1];
        if (next && visible(next)) {
          const left = ownText(block) || normalizeSpace(block.textContent);
          const right = ownText(next) || normalizeSpace(next.textContent);
          const paired = tryPair(left, right, block);
          if (paired) return paired;
        }
      }
    }

    // Lines: date, then customer, then address (or both on one line)
    const lines = pageLines();
    for (let i = 0; i < lines.length - 1; i++) {
      if (!dateRe.test(lines[i]) || lines[i].length > 40) continue;

      const combined = parseBrandLocation(lines[i + 1]);
      if (combined.customer && combined.location) return combined;

      const paired = tryPair(lines[i + 1], lines[i + 2] || "");
      if (paired) return paired;
    }

    // Fallback: Brand (Store area) only when no street address is present
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = ownText(el) || normalizeSpace(el.textContent);
      if (!text || text.length > 90) continue;
      if (!/\(.+\)/.test(text)) continue;
      if (/order placed|delivery details|order details|sales \(incl/i.test(text)) continue;
      if (looksLikeAddress(text)) continue;
      const paren = text.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (paren && !looksLikeAddress(paren[2])) {
        hits.push({ label: "Customer / Location", el, valueEl: el, value: text });
        return { customer: text, location: normalizeSpace(paren[2]) };
      }
    }

    return { customer: "", location: "" };
  }

  function parseOrderHeadingText(text) {
    const normalized = normalizeSpace(text);
    if (normalized.length > 32) return "";
    const exact = normalized.match(/^Order\s+#?\s*([A-Z0-9]{4,6})$/i);
    if (exact) return normalizeOrderCodeToken(exact[1]);
    const prefix = normalized.match(/^Order\s+#?\s*(\S+)/i);
    if (prefix) return normalizeOrderCodeToken(prefix[1]);
    return "";
  }

  function panelFromHeadingEl(headingEl) {
    let node = headingEl;
    let best = headingEl;
    for (let depth = 0; depth < 14 && node; depth++) {
      if (node === document.body || node === document.documentElement) break;
      const block = normalizeSpace(node.innerText || "");
      if (/order placed by customer/i.test(block) && /order details|delivery details|sales \(incl/i.test(block)) {
        best = node;
      }
      node = node.parentElement;
    }
    return best;
  }

  function findActiveOrderHeading() {
    const nodes = document.querySelectorAll("h1, h2, h3, h4, p, span, div, strong, button");
    let best = null;
    let bestScore = -1;

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;

      let code = parseOrderHeadingText(normalizeSpace(el.textContent));
      if (!code) {
        const own = ownText(el);
        if (own) code = normalizeOrderCodeToken(own);
        if (code) {
          const prev = el.previousElementSibling;
          const parentText = el.parentElement ? normalizeSpace(el.parentElement.textContent) : "";
          const nearOrderLabel =
            (prev && /^order$/i.test(normalizeSpace(prev.textContent))) ||
            /^order\s+#?\s*$/i.test(parentText.replace(own, "").trim());
          if (!nearOrderLabel) code = "";
        }
      }
      if (!code) continue;

      const headingText = normalizeSpace(el.textContent);
      const rect = el.getBoundingClientRect();
      let score = rect.left + rect.top + Math.max(0, 120 - headingText.length);
      let panel = el;
      let node = el.parentElement;
      for (let depth = 0; depth < 14 && node; depth++) {
        const block = node.innerText || "";
        if (/order placed by customer/i.test(block)) score += 200;
        if (/order details|delivery details/i.test(block)) score += 80;
        if (/item reported missing|customization reported missing/i.test(block)) score += 40;
        if (/sales \(incl|chargeback amount/i.test(block)) score += 30;
        if (/order placed by customer/i.test(block) && /order details|sales \(incl/i.test(block)) {
          panel = node;
        }
        node = node.parentElement;
      }

      if (score > bestScore) {
        bestScore = score;
        best = { code, el, panel: panelFromHeadingEl(el) || panel };
      }
    }
    return best;
  }

  function getActiveOrderRoot() {
    const heading = findActiveOrderHeading();
    if (heading && heading.panel) {
      let best = heading.panel;
      const text = normalizeSpace(best.innerText || "").toLowerCase();
      if (!/sales \(incl/i.test(text) && !/chargeback amount/i.test(text)) {
        let node = best.parentElement;
        for (let depth = 0; depth < 6 && node; depth++) {
          if (node === document.body || node === document.documentElement) break;
          const parentText = normalizeSpace(node.innerText || "").toLowerCase();
          if (/sales \(incl/i.test(parentText) || /chargeback amount/i.test(parentText)) {
            best = node;
            break;
          }
          node = node.parentElement;
        }
      }
      return best;
    }

    const markers = [
      "order placed by customer",
      "order details",
      "delivery details",
      "sales (incl. gst)",
      "chargeback amount",
    ];
    const candidates = [];

    const addCandidate = (el) => {
      if (!el || el === document.body || el === document.documentElement) return;
      if (!visible(el)) return;
      candidates.push(el);
    };

    const nodes = document.querySelectorAll("h1, h2, h3, h4, p, span, div, section, aside, [role='dialog']");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = normalizeSpace(el.textContent).toLowerCase();
      if (!markers.some((marker) => text.includes(marker))) continue;
      let node = el;
      let bestNode = el;
      for (let depth = 0; depth < 12 && node; depth++) {
        const block = normalizeSpace(node.innerText || "").toLowerCase();
        if (block.includes("order placed") && (block.includes("sales") || block.includes("order details"))) {
          bestNode = node;
        }
        node = node.parentElement;
      }
      addCandidate(bestNode);
    }

    let best = null;
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      const text = normalizeSpace(el.innerText || "").toLowerCase();
      const orderCodes = text.match(/\border\s+#?\s*[a-z0-9]{4,8}\b/gi) || [];
      if (orderCodes.length > 2) continue;

      let score = 0;
      if (/order placed by customer/i.test(text)) score += 50;
      if (/order details/i.test(text)) score += 30;
      if (/sales \(incl/i.test(text)) score += 20;
      if (/chargeback amount/i.test(text)) score += 15;
      if (/\border\s+#?\s*[a-z0-9]{4,8}\b/i.test(text)) score += 40;
      if (area > 10000 && area < window.innerWidth * window.innerHeight * 0.95) score += 10;
      if (rect.left > window.innerWidth * 0.25) score += 15;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (best) {
      const text = normalizeSpace(best.innerText || "").toLowerCase();
      if (!/sales \(incl/i.test(text) && !/chargeback amount/i.test(text)) {
        let node = best.parentElement;
        for (let depth = 0; depth < 6 && node; depth++) {
          if (node === document.body || node === document.documentElement) break;
          const parentText = normalizeSpace(node.innerText || "").toLowerCase();
          if (/sales \(incl/i.test(parentText) || /chargeback amount/i.test(parentText)) {
            best = node;
            break;
          }
          node = node.parentElement;
        }
      }
    }
    return best;
  }

  function getExtractionRoot() {
    const heading = findActiveOrderHeading();
    if (heading && heading.panel) return heading.panel;
    return getActiveOrderRoot() || document.body;
  }

  function extractOrderNumber() {
    const heading = findActiveOrderHeading();
    if (heading && heading.code) {
      hits.push({ label: "Order Number", el: heading.el, valueEl: heading.el, value: heading.code });
      return heading.code;
    }

    const orderRoot = getActiveOrderRoot();
    if (orderRoot) {
      const nodes = orderRoot.querySelectorAll("h1, h2, h3, h4, p, span, div, strong, button");
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!visible(el)) continue;
        const code = parseOrderHeadingText(normalizeSpace(el.textContent));
        if (code) {
          hits.push({ label: "Order Number", el, valueEl: el, value: code });
          return code;
        }
      }
      const fromPanel = findOrderNumberInText(orderRoot.innerText || "");
      if (fromPanel) return fromPanel;
    }

    const uuid = location.pathname.match(/\/orders\/([a-f0-9-]+)/i);
    if (uuid) {
      const tail = uuid[1].replace(/-/g, "").slice(-5).toUpperCase();
      if (isLikelyOrderCode(tail)) return tail;
    }
    return findOrderNumberInText((document.body && document.body.innerText) || "");
  }

  function extractClaimDateRaw() {
    const monthDate = (document.body.innerText || "").match(
      /([A-Za-z]{3,9})\s+\d{1,2},?\s+\d{4}|\d{1,2},?\s+[A-Za-z]{3,9},?\s+\d{4}/
    );
    if (monthDate) return monthDate[0];
    const lines = pageLines();
    return lines.find((line) => /[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(line)) || "";
  }

  function extractOrderPlacedTime() {
    const lines = pageLines();
    for (let i = 0; i < lines.length; i++) {
      if (!/order placed by customer/i.test(lines[i])) continue;
      const time = extractTime(lines[i]) || extractTime(lines[i - 1] || "") || extractTime(lines[i + 1] || "");
      if (time) {
        hits.push({ label: "Order Time", el: null, valueEl: null, value: time });
        return time;
      }
    }
    return extractTime(document.body.innerText);
  }

  function readLabeledMoneyFromLines(lines, labels) {
    const lineKey = (line) =>
      normalizeKey(line)
        .replace(/\s*dispute\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();

    for (const label of labels) {
      const wanted = normalizeKey(label);
      for (let i = 0; i < lines.length - 1; i++) {
        const key = lineKey(lines[i]);
        if (key !== wanted && !key.startsWith(wanted)) continue;
        const amount = parseMoney(lines[i + 1]) ?? parseMoney(lines[i]);
        if (amount != null) return amount;
      }
      const inline = lines.find((line) => {
        const key = lineKey(line);
        return key === wanted || key.startsWith(wanted) || normalizeKey(line).includes(wanted);
      });
      if (inline) {
        const amount = parseMoney(inline);
        if (amount != null) return amount;
      }
    }
    return null;
  }

  function readLabeledMoney(labels) {
    const fromPanel = readLabeledMoneyFromLines(pageLines(), labels);
    if (fromPanel != null) return fromPanel;
    return readLabeledMoneyFromLines(pageLinesAll(), labels);
  }

  function extractDisputeAmount() {
    const scanLines = (lines) => {
      for (let i = 0; i < lines.length; i++) {
        if (!/chargeback\s*amount/i.test(lines[i])) continue;
        const amount = parseMoney(lines[i + 1]) ?? parseMoney(lines[i]);
        if (amount != null) return Math.abs(amount);
      }
      for (const line of lines) {
        if (!/chargeback\s*amount|refund|adjustment|issue payout/i.test(line)) continue;
        const amount = parseMoney(line);
        if (amount != null) return Math.abs(amount);
      }
      return null;
    };

    const fromPanel = scanLines(pageLines());
    if (fromPanel != null) return fromPanel;
    const fromBody = scanLines(pageLinesAll());
    if (fromBody != null) return fromBody;

    const chargeback = readLabeledMoney([
      "Chargeback Amount (incl. GST) Dispute",
      "Chargeback Amount (incl. GST)Dispute",
      "Chargeback Amount (incl. GST)",
      "Chargeback Amount (incl GST)",
      "Chargeback Amount",
      "Chargeback amount",
    ]);
    if (chargeback != null) return Math.abs(chargeback);

    const refund = readLabeledMoney([
      "Refund amount",
      "Customer refund",
      "Refund total",
      "Adjustment amount",
      "Issue refund",
      "Refund issued",
    ]);
    if (refund != null) return Math.abs(refund);
    return null;
  }

  function isIssueMarkerLine(line) {
    return (
      ISSUE_ITEM_MISSING_RE.test(line) ||
      ISSUE_CUSTOMIZATION_MISSING_RE.test(line) ||
      ISSUE_N_CUSTOMIZATIONS_RE.test(line)
    );
  }

  function isComponentLine(line) {
    const text = normalizeSpace(line);
    if (!text) return true;
    if (ITEM_COMPONENT_RE.test(text)) return true;
    if (/^\d+\s+\S/.test(text) && !/(?:NZ\$|\$|£|€)\s*\d/.test(text)) return true;
    return false;
  }

  function parsePricedItemName(line) {
    const priceMatch = line.match(/^(.+?)\s+(?:NZ\$|\$|£|€)\s*(\d+(?:\.\d{2})?)$/);
    if (!priceMatch) return "";
    const name = normalizeSpace(priceMatch[1]);
    return isValidItemName(name) ? name : "";
  }

  function findIssueItemNameBefore(lines, fromIndex, kind) {
    for (let i = fromIndex - 1; i >= Math.max(0, fromIndex - 20); i--) {
      const line = lines[i];
      if (isIssueMarkerLine(line)) break;
      if (isComponentLine(line)) continue;

      const pricedName = parsePricedItemName(line);
      if (pricedName) {
        if (kind === "item") return pricedName;
        if (kind === "customization" && /value meal|meal|combo|regular/i.test(pricedName)) return pricedName;
      }

      if (/(?:NZ\$|\$|£|€)\s*\d/.test(line) && i > 0) {
        const prev = normalizeSpace(lines[i - 1]);
        if (isValidItemName(prev)) {
          if (kind === "item") return prev;
          if (kind === "customization" && /value meal|meal|combo|regular/i.test(prev)) return prev;
        }
      }

      const name = normalizeSpace(line);
      if (!isValidItemName(name)) continue;

      if (kind === "customization") {
        if (/value meal|meal|combo|regular/i.test(name)) return name;
        const next = lines[i + 1] || "";
        if (!/(?:NZ\$|\$|£|€)\s*\d/.test(next) && !ISSUE_CUSTOMIZATION_MISSING_RE.test(next)) return name;
        continue;
      }

      const hasPriceNearby = [lines[i + 1], lines[i + 2]].some((near) => near && /(?:NZ\$|\$|£|€)\s*\d/.test(near));
      if (hasPriceNearby || pricedName) return name;
    }
    return "";
  }

  function scanIssueItems(lines, reasonFromPage) {
    const issueItems = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (ISSUE_ITEM_MISSING_RE.test(line)) {
        const name = findIssueItemNameBefore(lines, i, "item");
        if (name) {
          issueItems.push({
            name,
            issue: "item reported missing",
            reason: canonicalizeReason("item reported missing"),
          });
        }
        continue;
      }
      if (ISSUE_CUSTOMIZATION_MISSING_RE.test(line)) {
        const name = findIssueItemNameBefore(lines, i, "customization");
        if (name) {
          issueItems.push({
            name,
            issue: "customization reported missing",
            reason: canonicalizeReason("customization reported missing"),
          });
        }
      }
    }
    return uniqueBy(issueItems, (item) => normalizeKey(item.name)).map((item) => ({
      ...item,
      reason: item.reason || (reasonFromPage ? canonicalizeReason(reasonFromPage) : ""),
    }));
  }

  function extractIssueItems() {
    const reasonFromPage = extractRefundReasonRaw();
    const fromPanel = scanIssueItems(pageLines(), reasonFromPage);
    if (fromPanel.length) return fromPanel;
    return scanIssueItems(pageLinesAll(), reasonFromPage);
  }

  function extractOrderItems() {
    const issueItems = extractIssueItems();
    if (issueItems.length) return issueItems;

    const lines = pageLines();
    const reasonFromPage = extractRefundReasonRaw();
    const items = [];

    for (let i = 0; i < lines.length; i++) {
      const priceMatch = lines[i].match(/^(.+?)\s+(?:NZ\$|\$|£|€)\s*(\d+(?:\.\d{2})?)$/);
      if (!priceMatch) continue;
      const name = normalizeSpace(priceMatch[1]);
      if (!isValidItemName(name)) continue;
      if (/^(sales|marketplace fee|net payout|subtotal|total|tax|gst)/i.test(name)) continue;
      items.push({
        name,
        reason: reasonFromPage ? canonicalizeReason(reasonFromPage) : "",
      });
    }

    return uniqueBy(items, (item) => normalizeKey(item.name));
  }

  function extractRefundReasonRaw() {
    const lines = pageLines();
    const body = getExtractionRoot().innerText || "";
    if (/item\s+reported\s+missing/i.test(body)) return "Item reported missing";
    if (/customization(?:s)?\s+(?:reported\s+)?missing/i.test(body)) {
      return "Customization reported missing";
    }
    const issuePatterns = [
      /^item\s+reported\s+missing$/i,
      /customization(?:s)?\s+(?:reported\s+)?missing/i,
      /^\d+\s+customization/i,
      /^missing item/i,
      /^missing items/i,
      /^wrong order/i,
      /^wrong item/i,
      /^poor food quality/i,
      /^food quality/i,
      /^food safety/i,
      /^incorrect item/i,
      /^prepared incorrectly/i,
    ];
    for (const line of lines) {
      if (issuePatterns.some((re) => re.test(line))) return line;
    }
    for (let i = 0; i < lines.length; i++) {
      if (/issue type|refund reason|customer feedback|complaint reason/i.test(lines[i]) && lines[i + 1]) {
        return lines[i + 1];
      }
    }
    return "";
  }

  function itemsMatchingReason(items, refundReason) {
    const wanted = canonicalizeReason(refundReason);
    const matched = (items || []).filter(
      (item) => item && item.name && isValidItemName(item.name) && canonicalizeReason(item.reason) === wanted
    );
    if (matched.length) return matched;
    return (items || []).filter((item) => item && item.name && isValidItemName(item.name));
  }

  function detectAlreadyDisputed() {
    const bodyText = (document.body && document.body.innerText) || "";
    if (CONTESTED_BODY_RE.test(bodyText)) return true;

    const nodes = document.querySelectorAll("span, div, p, li, strong, button");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = normalizeSpace(el.textContent);
      if (!text || text.length > 60) continue;
      if (/dispute this refund/i.test(text)) continue;
      if (/^disputed$/i.test(text) || /^refund\s+contested$/i.test(text) || /dispute\s+sent/i.test(text) || /appeal submitted/i.test(text)) return true;
    }
    return false;
  }

  function extractRefundPayload() {
    clearHits();
    invalidatePageLines();
    const errors = [];

    const orderNumber = extractOrderNumber();
    if (!orderNumber) errors.push("Order Number");

    const { customer: rawCustomer, location: storeLocationRaw } = extractBrandAndLocation();
    const customer = normalizeCustomerName(rawCustomer);
    const storeLocation = normalizeLocationName(storeLocationRaw);
    if (!customer) errors.push("Customer");
    if (!storeLocation) errors.push("Location");

    const dateRaw = extractClaimDateRaw();
    const claimDate = parseClaimDate(dateRaw);
    if (!claimDate.iso) errors.push("Order date");

    let orderTime = extractOrderPlacedTime();
    if (!orderTime) errors.push("Order placed time");

    const orderValue =
      readLabeledMoney(["Sales (incl. GST)", "Sales (incl GST)", "Subtotal", "Order total"]) ||
      readLabeledMoney(["Net payout"]);
    if (orderValue == null) errors.push("Sales total");

    const disputeAmount = extractDisputeAmount();

    const items = extractOrderItems();
    const reasonRaw = extractRefundReasonRaw();
    const itemReason = (items.find((item) => item && item.reason) || {}).reason || "";
    const refundReason = canonicalizeReason(reasonRaw) || itemReason || "";

    const alreadyDisputed = detectAlreadyDisputed();
    highlightHits();

    const matchedItems = itemsMatchingReason(items, refundReason);
    const disputeFields = buildDisputeFieldValues(matchedItems, refundReason, customer, storeLocation);

    const payload = enrichPayload({
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
      videoSubmitted: workhorse.videoSubmitted || "No",
      wrongFoodItem: disputeFields.wrongFoodItem,
      preparedIncorrectlyWhy: disputeFields.preparedIncorrectlyWhy,
      reason: disputeFields.reason || "",
      otherReason: disputeFields.otherReason,
      items,
      errors,
    });

    return payload;
  }

  function mount() {
    const body = document.body;
    if (!body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }

    ensureButtonBar();

    const existing = document.getElementById(btnId);
    if (existing && existing.onclick) return;

    if (isOpSpotPage()) {
      injectButton(btnId, platform.buttonFill || "Fill from Uber Eats", async () => {
        resetFillGuards();
        const payload = await loadPayload();
        if (!payload) {
          toast(`No stored order. Click ${platform.buttonExtract || "Extract Order → OpSpot"} on the Uber Eats tab first, then click here.`, "error", 7000);
          return;
        }
        await applyPayloadToClaims(payload, { force: true });
      });
      return;
    }

    if (isUberEatsPage()) {
      injectButton(btnId, platform.buttonExtract || "Extract Order → OpSpot", onExtractClick);
    }
  }

  function boot() {
    ensureStyles();
    if (typeof GM_registerMenuCommand === "function") {
      if (typeof location !== "undefined" && /opspot/i.test(location.host)) {
        GM_registerMenuCommand(platform.buttonFill || "Fill from Uber Eats", async () => {
          resetFillGuards();
          const payload = await loadPayload();
          if (!payload) {
            toast("No stored order. Run Extract Order on the Uber Eats tab first.", "error", 7000);
            return;
          }
          await applyPayloadToClaims(payload, { force: true });
        });
      } else {
        GM_registerMenuCommand(platform.buttonExtract || "Extract Order → OpSpot", onExtractClick);
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
        if (!document.getElementById(btnId)) remount();
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener(platform.storageKey, (_n, _o, value, remote) => {
        if (remote && isOpSpotPage() && value) {
          resetFillGuards();
          applyPayloadToClaims(value, { force: true });
        }
      });
    }
    setupOpSpotSaveHooks({
      onNeedNextExtractMessage: "Run Extract Order on the Uber Eats order tab first.",
    });
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
      else toast(`v${version || "2.0.0"} stored order #${payload.orderNumber}. Click ${platform.buttonFill || "Fill from Uber Eats"} on OpSpot.`, "success", 7000);
    } catch (err) {
      toast(`Extraction failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonExtract || "Extract Order → OpSpot";
      }
    }
  }

  boot();
})();
