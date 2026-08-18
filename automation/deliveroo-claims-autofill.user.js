// ==UserScript==
// @name         Deliveroo Refund → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      1.5.3
// @description  Read Deliveroo Partner Hub refunds and fill OpSpot Claims.
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
  const hits = [];

  const CONFIG = {
    DELIVEROO_HOST: "partner-hub.deliveroo.com",
    CLAIMS_FORM_URL: "https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000",
    STORAGE_KEY: "deliveroo_claim_payload_v1",
    CLIP_PREFIX: "DCF1:",
    PLATFORM: "Deliveroo",
    VIDEO_SUBMITTED: "No",
    DISPUTE_THRESHOLD_GBP: 2,
    DEBUG: true,

    outcomeOptions: {
      notDisputed: "Not disputed",
      reviewed: "Reviewed",
      awaitingReview: "Awaiting review",
      pending: "Pending",
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
    },

    /* Exact labels as shown on the OpSpot Claims modal */
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
      footageStatus: "Footage Status",
      otherReason: "Other reason",
      wrongFoodItem: "Wrong, Missing or Incorrect Food Item",
    },
  };

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

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function ownText(el) {
    return normalizeSpace(
      [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.nodeValue)
        .join(" ")
    );
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
    const named = text.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
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

  const HEADER_WORDS = /^(quantity|qty|price|item|items|name|category|total|refund reason)$/i;

  function canonicalizeReason(reason) {
    const key = normalizeKey(reason);
    if (!key || HEADER_WORDS.test(key)) return "";
    if (key === "missing" || key.includes("missing item")) return "missing items";
    if (key.includes("prepared incorrectly")) return "prepared incorrectly";
    if (key.includes("incorrect")) return "incorrect item";
    return key;
  }

  function pageLines() {
    return ((document.body && document.body.innerText) || "")
      .split(/\n+/)
      .map(normalizeSpace)
      .filter(Boolean);
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

  function isOpSpotPage() {
    return /opspot\.workhorselive\.com/i.test(location.host);
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
    document.querySelectorAll(".dcf-hit").forEach((el) => el.classList.remove("dcf-hit"));
    for (const hit of hits) {
      if (hit.el) hit.el.classList.add("dcf-hit");
      if (hit.valueEl) hit.valueEl.classList.add("dcf-hit");
    }
  }

  function clearHits() {
    hits.length = 0;
    document.querySelectorAll(".dcf-hit").forEach((el) => el.classList.remove("dcf-hit"));
  }

  /* -------------------------------------------------------------------------- */
  /* Deliveroo — header / refund card / timeline / order table                  */
  /* -------------------------------------------------------------------------- */

  function findOrderHeading(orderNumber) {
    const nodes = [...document.querySelectorAll("h1, h2, h3, h4, p, span, div, strong")];
    let best = null;
    let bestLen = Infinity;
    for (const el of nodes) {
      if (!visible(el)) continue;
      const text = normalizeSpace(el.textContent);
      if (text.length < 8 || text.length > 36) continue;
      if (!/^order\s*#\s*\d+$/i.test(text)) continue;
      if (orderNumber && !text.includes(orderNumber)) continue;
      if (text.length < bestLen) {
        best = el;
        bestLen = text.length;
      }
    }
    return best;
  }

  function extractOrderNumber() {
    const heading = findOrderHeading();
    const text = heading ? heading.textContent : document.body.innerText;
    const match = String(text).match(/order\s*#\s*(\d+)/i);
    if (heading) hits.push({ label: "Order Number", el: heading, valueEl: heading, value: match && match[1] });
    return match ? match[1] : "";
  }

  function splitBrandLocation(line) {
    const parts = normalizeSpace(line).split(" - ").map(normalizeSpace);
    return {
      customer: parts[0] || "",
      location: parts.slice(1).join(" - ") || "",
    };
  }

  function extractBrandAndLocation(orderNumber) {
    const heading = findOrderHeading(orderNumber);

    const tryLine = (el) => {
      if (!el || !visible(el)) return null;
      const text = ownText(el) || (el.childElementCount === 0 ? normalizeSpace(el.textContent) : "");
      if (!text || text.length > 80 || /order\s*#/i.test(text)) return null;
      if (!text.includes(" - ")) return null;
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
    if (idx >= 0 && lines[idx + 1] && lines[idx + 1].includes(" - ")) {
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
    const reasonRe = /^(missing|missing item|missing items|prepared incorrectly|incorrect item|incorrect items|incorrect)$/i;

    for (const table of document.querySelectorAll("table")) {
      const rows = [...table.querySelectorAll("tr")];
      if (!rows.length) continue;
      const headers = [...rows[0].querySelectorAll("th, td")].map((el) => normalizeKey(el.innerText));
      const reasonIdx = headers.findIndex((h) => /refund reason/.test(h));
      if (reasonIdx < 0) continue;
      const nameIdx = headers.findIndex((h) => /^(item|item name|name|product|description)$/.test(h));
      const catIdx = headers.findIndex((h) => /category/.test(h));

      for (const row of rows.slice(1)) {
        const cells = [...row.querySelectorAll("td")];
        if (!cells.length) continue;
        const reasonText = normalizeSpace((cells[reasonIdx] && cells[reasonIdx].innerText) || "");
        if (!reasonRe.test(reasonText)) continue;
        const itemName = nameIdx >= 0 ? normalizeSpace((cells[nameIdx] && cells[nameIdx].innerText) || "") : "";
        const catName = catIdx >= 0 ? normalizeSpace((cells[catIdx] && cells[catIdx].innerText) || "") : "";
        const name = itemName || catName;
        if (!name) continue;
        items.push({ name, reason: canonicalizeReason(reasonText) });
        hits.push({ label: "Refunded item", el: row, valueEl: cells[reasonIdx], value: name });
      }
    }

    if (items.length) {
      const seen = new Set();
      return items.filter((item) => {
        const key = `${normalizeKey(item.name)}|${item.reason}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    const lines = pageLines();
    for (let i = 0; i < lines.length; i++) {
      if (!reasonRe.test(lines[i])) continue;
      if (/^missing items$/i.test(lines[i]) && /^refund reason$/i.test(lines[i - 1] || "")) continue;
      const nearby = lines.slice(Math.max(0, i - 6), Math.min(lines.length, i + 5));
      if (!nearby.some((line) => /£\d|\d+\.\d{2}/.test(line))) continue;

      let name = "";
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        if (/^£/.test(lines[j]) || /£\d/.test(lines[j]) || /^\d+$/.test(lines[j])) continue;
        if (/^(quantity|qty|price|refund reason|item|item name|category)$/i.test(lines[j])) continue;
        if (reasonRe.test(lines[j])) continue;
        if (lines[j].length > 1 && lines[j].length < 70) {
          name = lines[j];
          break;
        }
      }
      if (name) items.push({ name, reason: canonicalizeReason(lines[i]) });
    }

    const seen = new Set();
    return items.filter((item) => {
      const key = `${normalizeKey(item.name)}|${item.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function primaryRefundedItemName(items, refundReason) {
    const wanted = canonicalizeReason(refundReason);
    if (!items || !items.length) return "";
    const exact = items.find((item) => canonicalizeReason(item && item.reason) === wanted && item && item.name);
    if (exact) return exact.name;
    const firstNamed = items.find((item) => item && item.name);
    return firstNamed ? firstNamed.name : "";
  }

  function extractRefundPayload() {
    clearHits();
    const errors = [];
    const root = document.body;

    const orderNumber = extractOrderNumber();
    if (!orderNumber) errors.push("Order Number");

    const { customer, location } = extractBrandAndLocation(orderNumber);
    if (!customer) errors.push("Customer");
    if (!location) errors.push("Location");

    const dateHit = readUiValue(root, "Date ordered");
    const dateRaw = valuesAfterLabel("Date ordered")[0] || dateHit.value;
    const claimDate = parseClaimDate(dateRaw);
    if (!claimDate.iso) errors.push("Date ordered");

    let orderTime = extractOrderSubmittedTime();
    if (!orderTime) orderTime = extractTime(dateRaw);
    if (!orderTime) errors.push("Order submitted");

    const totalHit = readUiValue(root, "Order total");
    const orderValue = parseMoney(valuesAfterLabel("Order total")[0] || totalHit.value);
    if (orderValue == null) errors.push("Order total");

    const refundHit = readUiValue(root, "Partner refund value");
    const disputeRaw = valuesAfterLabel("Partner refund value")[0] || refundHit.value;
    const disputeAmount = parseMoney(disputeRaw);
    if (disputeAmount == null) errors.push("Partner refund value");

    const bodyText = (document.body && document.body.innerText) || "";
    const alreadyDisputed = /partner refund value[\s\S]{0,80}\bdisputed\b/i.test(bodyText) ||
      Boolean(
        [...document.querySelectorAll("span, div, p")].find((el) => {
          if (!visible(el) || normalizeSpace(el.textContent).length > 18) return false;
          if (/dispute this refund/i.test(el.textContent)) return false;
          return /^disputed$/i.test(normalizeSpace(el.textContent));
        })
      );

    const items = extractRefundedItems();
    const reasonValues = valuesAfterLabel("Refund reason");
    const reasonRaw = [...reasonValues].reverse().find((v) => canonicalizeReason(v)) || "";
    const refundReason = canonicalizeReason(reasonRaw) || (items[0] && items[0].reason) || "";
    if (!refundReason) errors.push("Refund reason");

    highlightHits();

    const outcome = computeOutcome({ disputeAmount, alreadyDisputed, refundReason });
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
      footageStatus: computeFootageStatus({ alreadyDisputed, disputeAmount, refundReason }),
      wrongFoodItem: primaryRefundedItemName(items, refundReason),
      otherReason: [...new Set(items.map((i) => i.name))].join("\n"),
      items,
      errors,
    };

    log("UI payload", payload);
    return payload;
  }

  function isUnderTwoPounds(disputeAmount) {
    return disputeAmount != null && disputeAmount < CONFIG.DISPUTE_THRESHOLD_GBP;
  }

  function computeOutcome({ disputeAmount, alreadyDisputed, refundReason }) {
    const { notDisputed, reviewed, awaitingReview, pending } = CONFIG.outcomeOptions;
    const reason = canonicalizeReason(refundReason);

    if (isUnderTwoPounds(disputeAmount)) return notDisputed;
    if (reason === "missing items") return awaitingReview;
    if (reason === "prepared incorrectly" || reason === "incorrect item") return pending;
    if (alreadyDisputed) return reviewed;
    return "";
  }

  function computeFootageStatus({ alreadyDisputed, disputeAmount, refundReason }) {
    const reason = canonicalizeReason(refundReason);
    if (isUnderTwoPounds(disputeAmount)) return CONFIG.footageStatusOptions.irrelevant;
    if (alreadyDisputed) return CONFIG.footageStatusOptions.disputedByThirdParty;
    if (reason === "missing items" || reason === "prepared incorrectly" || reason === "incorrect item") {
      return CONFIG.footageStatusOptions.irrelevant;
    }
    return "";
  }

  /* -------------------------------------------------------------------------- */
  /* OpSpot — fill only the visible Claims modal                                */
  /* -------------------------------------------------------------------------- */

  function getClaimsModal() {
    const unique = [/video submitted/i, /other reason/i];
    const blocks = [
      ...document.querySelectorAll(".modal.show, .modal.in, [role='dialog'], form, .popup, .ew-modal, #ewModalDialog, .modal, div"),
    ].filter(visible);

    let best = null;
    let bestArea = Infinity;
    for (const el of blocks) {
      if (!el.querySelector("input, select, textarea")) continue;
      const text = el.innerText || "";
      if (!unique.every((re) => re.test(text))) continue;
      const hasSave =
        /save and add new/i.test(text) ||
        [...el.querySelectorAll("button, input, a")].some((b) =>
          /save and add new/i.test(normalizeSpace(b.textContent || b.value || ""))
        );
      if (!hasSave) continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > 8000 && area < bestArea) {
        best = el;
        bestArea = area;
      }
    }

    if (best) return best;

    const saveAdd = [...document.querySelectorAll("button, input, a")].find((el) => {
      return visible(el) && /save and add new/i.test(normalizeSpace(el.textContent || el.value || ""));
    });
    let node = saveAdd && saveAdd.parentElement;
    while (node) {
      const text = node.innerText || "";
      if (/video submitted/i.test(text) && /claim date/i.test(text) && node.querySelector("input, select, textarea")) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
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
    const modal = getClaimsModal();
    const cancel = findClaimsCancelButton(modal);
    if (cancel) safeClick(cancel);
    else {
      const dismiss = document.querySelector(".modal.show .close, .modal.in .close, [data-dismiss='modal']");
      if (dismiss) safeClick(dismiss);
    }

    await waitUntil(() => !getClaimsModal(), 2500, 40);

    const addBtn = findPageAddNewButton();
    if (addBtn) safeClick(addBtn);

    return waitUntil(() => getClaimsModal(), 3500, 40);
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
    if (!isOpSpotPage()) return;
    document.addEventListener(
      "click",
      (event) => {
        const el = event.target.closest("button, input[type='button'], input[type='submit'], a");
        if (!el || !isSaveButton(el)) return;

        closeOpenDropdowns();
        const modal = getClaimsModal();
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

  function compactKey(value) {
    return normalizeKey(value).replace(/[^a-z0-9]/g, "");
  }

  function captionMatches(el, label) {
    const wanted = compactKey(label);
    if (!wanted) return false;
    return compactKey(captionText(el)) === wanted;
  }

  function fieldCaptionCount(el) {
    const text = normalizeKey(el.innerText || "");
    const labels = [
      "claim date", "order time", "customer", "location", "platform", "order number",
      "order value", "dispute amount", "outcome", "video submitted", "reason for dispute",
      "footage status", "other reason", "wrong, missing or incorrect food item", "agent",
      "won revenue", "lost revenue",
    ];
    return labels.filter((name) => text.includes(name)).length;
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

  async function fillLabeledField(modal, label, value, extras = {}) {
    if (value == null || value === "") return { ok: false, reason: "empty" };
    let found = controlAfterLabel(modal, label) || matchFormField(collectFormFields(modal), [label, `${label}*`]) || fieldRow(modal, label);

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
    if (getClaimsModal()) return getClaimsModal();

    if (saveInProgress || pendingAutoFillAfterSave) {
      return waitUntil(() => getClaimsModal(), 8000, 50);
    }

    const addBtn = findPageAddNewButton();
    if (addBtn) {
      addBtn.click();
      toast("Opening Add New…", "info", 2000);
    }

    const start = Date.now();
    while (Date.now() - start < 10000) {
      const modal = getClaimsModal();
      if (modal) return modal;
      await wait(250);
    }
    return getClaimsModal();
  }

  async function fillClaimsForm(payload, options = {}) {
    const modal = await ensureClaimsModal();
    if (!modal) throw new Error("Click the green Add New button, then click Fill from Deliveroo.");

    const fieldPause = options.fast || fastFillMode ? 45 : 140;
    const L = CONFIG.opspotLabels;
    const results = {};
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
      [L.wrongFoodItem, payload.wrongFoodItem || payload.otherReason],
      [L.otherReason, payload.otherReason],
    ];

    for (const [label, value, extras] of jobs) {
      try {
        results[label] = await fillLabeledField(modal, label, value, extras || {});
      } catch (err) {
        log("Field fill error", label, err);
        results[label] = { ok: false, reason: String(err && err.message ? err.message : err) };
      }
      if ((!results[label] || !results[label].ok) && /wrong, missing/i.test(label)) {
        const tries = [
          ...((payload.items || []).map((item) => item && item.name)),
          String(payload.otherReason || "").split("\n")[0],
          payload.otherReason,
        ].filter((v, i, arr) => v && arr.indexOf(v) === i);
        for (const alt of tries) {
          if (alt === value) continue;
          results[label] = await fillLabeledField(modal, label, alt);
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
    GM_addStyle(`
      .dcf-hit { outline: 2px solid #00ccbc !important; outline-offset: 2px; background: rgba(0,204,188,.12) !important; }
      #dcf-btn {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647;
        background: #00ccbc; color: #06221f; border: 0; cursor: pointer;
        border-radius: 999px; padding: 12px 22px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        font: 700 15px/1.2 Segoe UI, system-ui, sans-serif;
      }
      #dcf-btn:hover { background: #111827; color: #fff; }
      #dcf-btn:hover { background: #00ccbc; color: #06221f; }
      #dcf-btn:disabled { opacity: .65; cursor: wait; }
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
      ["Footage Status", payload.footageStatus],
      ["Wrong, Missing or Incorrect Food Item", (payload.items && payload.items[0] && payload.items[0].name) || ""],
      ["Other reason", payload.otherReason],
      ["Disputed badge", payload.alreadyDisputed ? "Yes" : "No"],
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
    let btn = document.getElementById("dcf-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "dcf-btn";
      btn.type = "button";
      (document.body || document.documentElement).appendChild(btn);
    }
    btn.textContent = text;
    btn.onclick = onClick;
  }

  function mount() {
    const root = document.body;
    if (!root) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }

    if (isOpSpotPage()) {
      injectButton("Fill from Deliveroo", async () => {
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
      injectButton("Auto-Fill & Dispute", onExtractClick);
    }
  }

  function boot() {
    ensureStyles();
    if (typeof GM_registerMenuCommand === "function") {
      if (typeof location !== "undefined" && /opspot/i.test(location.host)) {
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
      }
    }
    const wrap = (fn) =>
      function patched() {
        const ret = fn.apply(this, arguments);
        debounce(mount, 300)();
        return ret;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", debounce(mount, 300));
    window.addEventListener("load", mount);
    new MutationObserver(debounce(mount, 400)).observe(document.documentElement, { childList: true, subtree: true });
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
      else toast(`v1.5.3 stored order #${payload.orderNumber}. Click Fill from Deliveroo on OpSpot.`, "success", 7000);
    } catch (err) {
      toast(`Extraction failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Auto-Fill & Dispute";
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
      else if (!options.fast) toast(`v1.5.3 filled claim ${payload.orderNumber}.`, "success");
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
