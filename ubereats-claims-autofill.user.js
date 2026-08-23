// ==UserScript==
// @name         Uber Eats Order → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      1.0.0
// @description  Read Uber Eats Manager orders/issues and fill OpSpot Claims.
// @author       Claims Ops
// @match        https://merchants.ubereats.com/*
// @match        *://merchants.ubereats.com/*
// @match        https://opspot.workhorselive.com/*
// @match        https://opspot.workhorselive.com/sysTable.php*
// @match        *://opspot.workhorselive.com/*
// @match        *://*.workhorselive.com/*
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
    UBER_HOST: "merchants.ubereats.com",
    CLAIMS_FORM_URL: "https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000",
    STORAGE_KEY: "ubereats_claim_payload_v1",
    CLIP_PREFIX: "UCF1:",
    PLATFORM: "Uber Eats",
    VIDEO_SUBMITTED: "No",
    DISPUTE_THRESHOLD_GBP: 2,
    DEBUG: false,
    MODAL_CACHE_MS: 250,

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
      "wrong order": "Incorrect Item",
      "wrong item": "Incorrect Item",
      "poor food quality": "Prepared incorrectly",
      "food quality": "Prepared incorrectly",
      "customization missing": "Missing Item",
      "customization reported missing": "Missing Item",
      "item reported missing": "Missing Item",
      "reported missing": "Missing Item",
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
  const CONTESTED_BODY_RE = /refund\s+contested|appeal submitted|dispute\s+submitted|dispute\s+sent\b|refund\s+appeal/i;

  const pageJQuery = () =>
    (typeof unsafeWindow !== "undefined" && (unsafeWindow.jQuery || unsafeWindow.$)) || window.jQuery || window.$;

  const log = (...args) => {
    if (CONFIG.DEBUG) console.log("[Uber Claims Auto-Fill]", ...args);
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
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
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

  function parseClaimDate(raw) {
    const text = normalizeSpace(raw);
    const months = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    let named = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
    if (named) {
      const day = named[2].padStart(2, "0");
      const month = months[named[1].slice(0, 3).toLowerCase()];
      const year = named[3];
      if (!month) return { raw: text, iso: "", dmy: "", dash: "" };
      return {
        raw: `${named[2]} ${named[1].slice(0, 3)} ${year}`,
        iso: `${year}-${month}-${day}`,
        dmy: `${day}/${month}/${year}`,
        dash: `${day}-${month}-${year}`,
      };
    }
    named = text.match(/(\d{1,2}),?\s+([A-Za-z]{3,9}),?\s+(\d{4})/);
    if (!named) return { raw: text, iso: "", dmy: "", dash: "" };
    const day = named[1].padStart(2, "0");
    const month = months[named[2].slice(0, 3).toLowerCase()];
    if (!month) return { raw: text, iso: "", dmy: "", dash: "" };
    return {
      raw: `${named[1]} ${named[2].slice(0, 3)} ${named[3]}`,
      iso: `${named[3]}-${month}-${day}`,
      dmy: `${day}/${month}/${named[3]}`,
      dash: `${day}-${month}-${named[3]}`,
    };
  }

  const HEADER_WORDS = /^(quantity|qty|price|item|items|name|category|total|refund reason|refund details)$/i;
  const UI_NOISE = /^(refund details|refund reason|partner refund value|order total|date ordered|order submitted|order timeline|dispute this refund|prepared incorrectly|missing|missing item|missing items|incorrect|incorrect item|incorrect items|food safety complaint|category|quantity|qty|price|item|items|name|total|deliveroo|uber eats|partner hub|marketplace fee|net payout|sales \(incl\. gst\)|chargeback amount|customization reported missing|item reported missing|\d+\s+customization(?:s)?\s+missing)$/i;

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

  function pageLinesAll() {
    return ((document.body && document.body.innerText) || "")
      .split(/\n+/)
      .map(normalizeSpace)
      .filter(Boolean);
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

  function canonicalizeReason(reason) {
    const key = normalizeKey(reason);
    if (!key || HEADER_WORDS.test(key)) return "";
    if (
      key === "missing" ||
      key.includes("missing item") ||
      key.includes("item reported missing") ||
      key.includes("reported missing") ||
      (key.includes("customization") && key.includes("missing"))
    ) {
      return "missing items";
    }
    if (key.includes("prepared incorrectly") || key.includes("poor food quality") || key.includes("quality issue")) return "prepared incorrectly";
    if (key.includes("food safety")) return "food safety complaint";
    if (key.includes("wrong order") || key.includes("wrong item") || key.includes("incorrect")) return "incorrect item";
    return key;
  }

  function invalidatePageLines() {
    pageLinesCache = null;
  }

  function pageLines() {
    if (pageLinesCache) return pageLinesCache;
    const root = getExtractionRoot();
    pageLinesCache = ((root && root.innerText) || "")
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

  function isUberEatsPage() {
    return /merchants\.ubereats\.com/i.test(location.host);
  }

  function isUberOrderPage() {
    if (!isUberEatsPage()) return false;
    return /\/manager\/orders\//i.test(location.pathname);
  }

  function invalidateModalCache() {
    cachedModal = null;
    cachedModalAt = 0;
  }

  function isRefundDetailsPage() {
    return isUberOrderPage();
  }

  /* -------------------------------------------------------------------------- */
  /* Visible-UI helpers — match what is on screen, not CSS class names          */
  /* -------------------------------------------------------------------------- */

  function findVisibleLabel(root, label) {
    const wanted = normalizeKey(label);
    let best = null;
    let bestLen = Infinity;
    const nodes = root.querySelectorAll("h1, h2, h3, h4, p, span, div, dt, dd, th, td, label, li, strong, button");
    for (const el of nodes) {
      if (!visible(el)) continue;
      const text = ownText(el) || (el.children.length === 0 ? normalizeSpace(el.textContent) : "");
      if (!text || text.length > 48) continue;
      const key = normalizeKey(text);
      if (key !== wanted && key !== `${wanted}*`) continue;
      if (text.length <= bestLen && !el.closest("thead") && el.tagName !== "TH") {
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
    document.querySelectorAll(".ucf-hit").forEach((el) => el.classList.remove("ucf-hit"));
    for (const hit of hits) {
      if (hit.el) hit.el.classList.add("ucf-hit");
      if (hit.valueEl) hit.valueEl.classList.add("ucf-hit");
    }
  }

  function clearHits() {
    hits.length = 0;
    document.querySelectorAll(".ucf-hit").forEach((el) => el.classList.remove("ucf-hit"));
  }

  /* -------------------------------------------------------------------------- */
  /* Uber Eats Manager — order drawer / timeline / items / adjustments          */
  /* -------------------------------------------------------------------------- */

  function parseBrandLocation(text) {
    const line = normalizeSpace(text);
    const paren = line.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      return { customer: normalizeSpace(paren[1]), location: normalizeSpace(paren[2]) };
    }
    if (line.includes(" - ")) {
      const parts = line.split(" - ").map(normalizeSpace);
      return { customer: parts[0] || "", location: parts.slice(1).join(" - ") || "" };
    }
    return { customer: line, location: "" };
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

    const root = getActiveOrderRoot();
    if (root) {
      const nodes = root.querySelectorAll("h1, h2, h3, h4, p, span, div, strong, button");
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!visible(el)) continue;
        const code = parseOrderHeadingText(normalizeSpace(el.textContent));
        if (code) {
          hits.push({ label: "Order Number", el, valueEl: el, value: code });
          return code;
        }
      }
    }

    const uuid = location.pathname.match(/\/orders\/([a-f0-9-]+)/i);
    if (uuid) {
      const tail = uuid[1].replace(/-/g, "").slice(-5).toUpperCase();
      if (isLikelyOrderCode(tail)) return tail;
    }
    return "";
  }

  function extractBrandAndLocation() {
    const nodes = document.querySelectorAll("h1, h2, h3, h4, p, span, div, strong");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = ownText(el) || normalizeSpace(el.textContent);
      if (!text || text.length > 90) continue;
      if (!/\(.+\)/.test(text)) continue;
      if (/order placed|delivery details|order details|sales \(incl/i.test(text)) continue;
      const parsed = parseBrandLocation(text);
      if (parsed.customer && parsed.location) {
        hits.push({ label: "Customer / Location", el, valueEl: el, value: text });
        return parsed;
      }
    }

    const lines = pageLines();
    for (let i = 0; i < lines.length; i++) {
      if (!/\(.+\)/.test(lines[i])) continue;
      const parsed = parseBrandLocation(lines[i]);
      if (parsed.customer && parsed.location) return parsed;
    }
    return { customer: "", location: "" };
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

  function buildDisputeFieldValues(items, refundReason) {
    const issueItems = (items || []).filter((item) => item && item.name && isValidItemName(item.name));
    const itemNames = [...new Set(issueItems.map((item) => item.name))];
    const reason = canonicalizeReason(refundReason);

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

    const orderNumber = extractOrderNumber();
    if (!orderNumber) errors.push("Order Number");

    const { customer, location: storeLocation } = extractBrandAndLocation();
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

    const outcome = computeOutcome({ disputeAmount, alreadyDisputed, refundReason });
    const disputeFields = buildDisputeFieldValues(items, refundReason);
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
      platform: CONFIG.PLATFORM,
      orderNumber,
      orderValue: orderValue == null ? "" : orderValue.toFixed(2),
      disputeAmount: disputeAmount == null ? "" : disputeAmount.toFixed(2),
      refundReason,
      alreadyDisputed,
      outcome,
      videoSubmitted: CONFIG.VIDEO_SUBMITTED,
      reasonForDispute: CONFIG.reasonForDisputeMap[refundReason] || "",
      footageStatus: computeFootageStatus({ alreadyDisputed, disputeAmount, refundReason }),
      wrongFoodItem: disputeFields.wrongFoodItem,
      preparedIncorrectlyWhy: disputeFields.preparedIncorrectlyWhy,
      reason: disputeFields.reason || "",
      otherReason: disputeFields.otherReason,
      items,
      errors,
    };

    log("Uber payload", payload);
    return payload;
  }

  function isUnderTwoPounds(disputeAmount) {
    return disputeAmount != null && disputeAmount < CONFIG.DISPUTE_THRESHOLD_GBP;
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

  function computeOutcome({ disputeAmount, alreadyDisputed, refundReason }) {
    const { notDisputed, reviewed, awaitingReview, pending } = CONFIG.outcomeOptions;
    const reason = canonicalizeReason(refundReason);

    if (alreadyDisputed) return reviewed;
    if (isUnderTwoPounds(disputeAmount)) return notDisputed;
    if (reason === "missing items" || reason === "food safety complaint") return awaitingReview;
    if (reason === "prepared incorrectly" || reason === "incorrect item") return pending;
    return "";
  }

  function computeFootageStatus({ alreadyDisputed, disputeAmount, refundReason }) {
    const reason = canonicalizeReason(refundReason);
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
      ".modal.show, .modal.in, [role='dialog'], .ew-modal, #ewModalDialog, .modal, form"
    );
    let best = null;
    let bestArea = Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!visible(el) || !el.querySelector("input, select, textarea")) continue;
      const text = el.innerText || "";
      if (!/video submitted/i.test(text) || !/other reason/i.test(text)) continue;
      if (!/save and add new/i.test(text)) continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > 8000 && area < bestArea) {
        best = el;
        bestArea = area;
      }
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
    const btn = document.getElementById("ucf-btn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Fill from Uber Eats";
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
          toast("Run Auto-Fill on the Uber Eats order tab first.", "info", 5000);
        }
      }
    };

    await wait(280);

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
    const pause = fastFillMode ? 80 : 220;
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
      if (!root || !root.querySelector(".select2-container, .select2-selection")) {
        return nativeSelect.value === option.value;
      }
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
      await wait(fastFillMode ? 60 : 120);
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
    if (labelEl) labelEl.classList.add("ucf-hit");

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
    control.classList.add("ucf-hit");

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
    if (!modal) throw new Error("Click the green Add New button, then click Fill from Uber Eats.");

    const fieldPause = options.fast || fastFillMode ? 45 : 140;
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
        await wait(options.fast || fastFillMode ? 150 : 350);
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
      await wait(fieldPause);
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
      .ucf-hit { outline: 2px solid #06c167 !important; outline-offset: 2px; background: rgba(6,193,103,.12) !important; }
      #ucf-btn {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647;
        background: #06c167; color: #062816; border: 0; cursor: pointer;
        border-radius: 999px; padding: 12px 22px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        font: 700 15px/1.2 Segoe UI, system-ui, sans-serif;
      }
      #ucf-btn:hover { background: #05a857; color: #fff; }
      #ucf-btn:disabled { opacity: .65; cursor: wait; }
      #ucf-toast, #ucf-preview {
        position: fixed; top: 64px; right: 18px; z-index: 2147483646;
        max-width: 380px; border-radius: 12px; padding: 12px 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.28);
        font: 13px/1.45 Segoe UI, system-ui, sans-serif;
      }
      #ucf-toast { background: #111827; color: #f9fafb; }
      #ucf-toast.error { background: #7f1d1d; }
      #ucf-toast.success { background: #065f46; }
      #ucf-preview { background: #fff; color: #111827; width: 380px; max-height: 70vh; overflow: auto; }
      #ucf-preview h3 { margin: 0 0 8px; font-size: 14px; }
      #ucf-preview table { width: 100%; border-collapse: collapse; }
      #ucf-preview td { padding: 4px 0; vertical-align: top; }
      #ucf-preview td:first-child { color: #6b7280; width: 44%; padding-right: 8px; }
      #ucf-preview .missing { color: #b91c1c; }
    `);
  }

  function toast(message, kind = "info", ms = 4500) {
    document.getElementById("ucf-toast")?.remove();
    const el = document.createElement("div");
    el.id = "ucf-toast";
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
    document.getElementById("ucf-preview")?.remove();
    const el = document.createElement("div");
    el.id = "ucf-preview";
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

  function injectButton(text, onClick) {
    ensureStyles();
    let btn = document.getElementById("ucf-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "ucf-btn";
      btn.type = "button";
      (document.body || document.documentElement).appendChild(btn);
    }
    if (btn.textContent !== text) btn.textContent = text;
    btn.onclick = onClick;
  }

  function mount() {
    const root = document.body;
    if (!root) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }

    const existing = document.getElementById("ucf-btn");
    if (existing && existing.onclick) return;

    if (isOpSpotPage()) {
      injectButton("Fill from Uber Eats", async () => {
        resetFillGuards();
        const payload = await loadPayload();
        if (!payload) {
          toast("No stored order. Click Extract Order on the Uber Eats tab first, then click here.", "error", 7000);
          return;
        }
        await applyPayloadToClaims(payload, { force: true });
      });
      return;
    }

    if (isUberEatsPage()) {
      injectButton("Extract Order → OpSpot", onExtractClick);
    }
  }

  function boot() {
    ensureStyles();
    if (typeof GM_registerMenuCommand === "function") {
      if (typeof location !== "undefined" && /opspot/i.test(location.host)) {
        GM_registerMenuCommand("Fill from Uber Eats", async () => {
          resetFillGuards();
          const payload = await loadPayload();
          if (!payload) {
            toast("No stored order. Run Extract Order on the Uber Eats tab first.", "error", 7000);
            return;
          }
          await applyPayloadToClaims(payload, { force: true });
        });
      } else {
        GM_registerMenuCommand("Extract Order → OpSpot", onExtractClick);
      }
    }
    const remount = debounce(mount, 800);
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
    new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) {
          if (!document.getElementById("ucf-btn")) remount();
          invalidateModalCache();
          return;
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener(CONFIG.STORAGE_KEY, (_n, _o, value, remote) => {
        if (remote && isOpSpotPage() && value) {
          resetFillGuards();
          applyPayloadToClaims(value, { force: true });
        }
      });
    }
    setupOpSpotSaveHooks();
    mount();
  }

  async function onExtractClick() {
    const btn = document.getElementById("ucf-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Reading screen…";
    }
    try {
      const payload = extractRefundPayload();
      showPreview(payload);
      savePayload(payload);
      if (payload.errors.length) toast(`UI miss: ${payload.errors.join(", ")}`, "error", 7000);
      else toast(`v1.0.0 stored order #${payload.orderNumber}. Click Fill from Uber Eats on OpSpot.`, "success", 7000);
    } catch (err) {
      toast(`Extraction failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Extract Order → OpSpot";
      }
    }
  }

  async function applyPayloadToClaims(payload, options = {}) {
    if (!payload || !payload.orderNumber || claimsFillInFlight) return;
    if (!options.force && lastFilledOrder === payload.orderNumber) return;
    claimsFillInFlight = true;
    const btn = document.getElementById("ucf-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Filling Claims…";
    }
    fastFillMode = Boolean(options.fast);
    try {
      const modal = await waitUntil(() => getClaimsModal(), options.fast ? 5000 : 8000, options.fast ? 50 : 250);
      if (!modal && !getClaimsModal()) {
        await waitUntil(() => getClaimsModal(), 2000, 50);
      }
      const results = await fillClaimsForm(payload, options);
      lastFilledOrder = payload.orderNumber;
      if (!options.fast) showPreview(payload);
      const failed = Object.entries(results)
        .filter(([, r]) => !r.ok)
        .map(([k, r]) => (r.reason ? `${k} (${r.reason})` : k));
      if (failed.length) toast(`Could not fill: ${failed.join(", ")}`, "error", 7000);
      else if (!options.fast) toast(`v1.0.0 filled claim ${payload.orderNumber}.`, "success");
    } catch (err) {
      toast(`Fill failed: ${err.message || err}`, "error");
    } finally {
      fastFillMode = false;
      claimsFillInFlight = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Fill from Uber Eats";
      }
    }
  }

  boot();
})();
