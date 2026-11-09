/**
 * Pure helpers for Deliveroo → Workhorse list updates (Check all times / Won-Lost).
 * Source of truth for unit tests (`npm test`).
 * Keep in sync with the update path inside deliveroo-claims-autofill.user.js
 * (Tampermonkey does not load this file — only the .user.js runs in the browser).
 */
"use strict";

function normalizeSpace(value) {
  return String(value == null ? "" : value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return normalizeSpace(value).toLowerCase();
}

function identityLocation(name) {
  return normalizeSpace(name);
}

function orderCodeFromText(text) {
  const raw = String(text || "");
  // Digits inside dates must not be treated as order numbers (esp. 1–2 digit days).
  const dateDigits = new Set();
  const datePatterns = [
    /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/g,
    /\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g,
  ];
  for (const re of datePatterns) {
    let match;
    while ((match = re.exec(raw))) {
      for (const digit of match[0].match(/\d+/g) || []) dateDigits.add(digit);
    }
  }
  const tokens = raw.match(/\b\d{1,8}\b/g) || [];
  const candidates = tokens.filter(
    (token) => !/^(19|20)\d{2}$/.test(token) && !dateDigits.has(token)
  );
  if (candidates.length) {
    // Prefer longer codes when a blob has several numbers.
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }
  // Pure order cell: allow 1–8 digit codes (including 1–2 digit Deliveroo order #s).
  const only = String(raw).trim();
  if (/^\d{1,8}$/.test(only) && !/^(19|20)\d{2}$/.test(only)) return only;
  return "";
}

function orderKey(value) {
  const code = orderCodeFromText(value);
  if (!code) return "";
  return code.replace(/^0+/, "") || "0";
}

function classifyDisputeStatus(text) {
  const flat = normalizeSpace(text);
  if (!flat) return "";
  // Prefer definitive outcomes first (cards can still mention older "awaiting" text).
  if (/\brejected\b/i.test(flat)) return "rejected";
  if (/\bapproved\b/i.test(flat) && !/\bnot\s+approved\b/i.test(flat)) return "approved";
  if (/\bawaiting\s+review\b/i.test(flat)) return "awaiting";
  return "";
}

function preferDisputeStatus(prev, next) {
  if (!next) return prev || "";
  if (!prev) return next;
  if (prev === next) return prev;
  if ((next === "approved" || next === "rejected") && prev === "awaiting") return next;
  if ((prev === "approved" || prev === "rejected") && next === "awaiting") return prev;
  if (
    (next === "approved" || next === "rejected") &&
    (prev === "approved" || prev === "rejected") &&
    next !== prev
  ) {
    return next;
  }
  return prev;
}

function choiceMatches(current, next) {
  return !!next && normalizeKey(current) === normalizeKey(next);
}

/**
 * Pull Site from "Five Guys - Bath" / similar brand-dash-location text.
 */
function siteLocationFromText(text, resolveLocationName = identityLocation) {
  const value = normalizeSpace(text);
  if (!value) return "";
  const brandSite = value.match(
    /(?:shake\s*shack|jollibee|popeyes|five\s*guys)\s*[–—−-]\s*([A-Za-z0-9][A-Za-z0-9 &'./-]{0,50}?)(?=\s+\d{1,2}\s+[A-Za-z]{3}|\s+\d{4}\b|\s+Approved|\s+Rejected|\s+Awaiting|$)/i
  );
  if (brandSite) return resolveLocationName(normalizeSpace(brandSite[1]));
  const dashed = value.split(/\s*[–—−-]\s*/).map(normalizeSpace).filter(Boolean);
  if (dashed.length >= 2) {
    const maybeBrand = dashed[0];
    if (/^(shake\s*shack|jollibee|popeyes|five\s*guys)$/i.test(maybeBrand)) {
      return resolveLocationName(dashed.slice(1).join(" - "));
    }
    return resolveLocationName(dashed.slice(1).join(" - "));
  }
  return resolveLocationName(value);
}

/**
 * Map Deliveroo approved/rejected → Workhorse Outcome (+ optional Footage Status).
 */
function disputeResolution(status, footageText) {
  if (status !== "approved" && status !== "rejected") return null;
  const footage = normalizeKey(footageText);
  const disputedCorrectly = /disputed correctly/.test(footage);
  const thirdParty = /(3rd|third)\s*party/.test(footage);
  const notAtFault =
    /video evidence confirms restaurant is not at fault/.test(footage) ||
    /video evidence confirms restaurant not at fault/.test(footage);
  if (status === "approved") {
    const update = { outcome: "Won" };
    // Keep existing "Disputed by 3rd party" — do not overwrite with Won without footage.
    if (!disputedCorrectly && !notAtFault && !thirdParty) {
      update.footageStatus = "Won without footage";
    }
    return update;
  }
  const update = { outcome: "Lost" };
  if (!disputedCorrectly && notAtFault) {
    update.footageStatus = "Correct claim rejected by the aggregator";
  }
  return update;
}

/**
 * Location compare for matching only — never a reason to rewrite Workhorse Location.
 * Empty/unreadable Workhorse location does not block updates.
 */
function sameBranch(current, want, resolveLocationName = identityLocation) {
  if (!want) return true;
  if (!normalizeSpace(current)) return true;
  const left = normalizeKey(resolveLocationName(current));
  const right = normalizeKey(resolveLocationName(want));
  if (!left || !right) return true;
  if (left === right) return true;
  // Soft match: "Canary Wharf" vs "Shake Shack Canary Wharf"
  if (left.includes(right) || right.includes(left)) return true;
  // "Five Guys - Bath" vs "Bath"
  const leftLoc = normalizeKey(siteLocationFromText(current, resolveLocationName));
  const rightLoc = normalizeKey(siteLocationFromText(want, resolveLocationName));
  if (
    leftLoc &&
    rightLoc &&
    (leftLoc === rightLoc || leftLoc.includes(rightLoc) || rightLoc.includes(leftLoc))
  ) {
    return true;
  }
  return false;
}

/**
 * True when this Workhorse list row is the Deliveroo order (same site).
 * Location first: conflicting non-empty locations → false.
 */
function rowMatchesDeliveroo(info, current, resolveLocationName = identityLocation) {
  if (!info) return false;
  if (
    info.branch &&
    current.branchKnown &&
    normalizeSpace(current.branch) &&
    !sameBranch(current.branch, info.branch, resolveLocationName)
  ) {
    return false;
  }
  return true;
}

/**
 * Modal Location check before save. Placeholders / empty → allow; clear conflict → skip.
 */
function validateClaimBranch(currentLocation, deliverooBranch, resolveLocationName = identityLocation) {
  if (!deliverooBranch) return { branchMismatch: false };
  const current = normalizeSpace(currentLocation);
  if (!current || /select|choose|pick/i.test(current)) return { branchMismatch: false };
  return { branchMismatch: !sameBranch(current, deliverooBranch, resolveLocationName) };
}

function validateClaimBranchAndTime(
  currentLocation,
  deliverooBranch,
  formTime,
  deliverooTime,
  resolveLocationName = identityLocation
) {
  // Location first — time match does not bypass a location conflict.
  return validateClaimBranch(currentLocation, deliverooBranch, resolveLocationName);
}

/**
 * What differs between Deliveroo batch info and a Workhorse list row snapshot.
 * branchDiff is always false — Location is never rewritten.
 */
function claimNeedsEdit(info, current) {
  const timeDiff = !!(info.time && current.time !== info.time);
  const dateDiff = !!(info.dateRaw && (!current.dateKnown || !sameClaimDate(current.date, info.dateRaw)));
  const status = info.disputeStatus;
  if (status !== "approved" && status !== "rejected") {
    return { timeDiff, statusDiff: false, dateDiff, branchDiff: false };
  }
  if (!current.footageKnown || !current.outcomeKnown) {
    return { timeDiff, statusDiff: true, dateDiff, branchDiff: false };
  }
  const patch = disputeResolution(status, current.footage);
  if (!patch) return { timeDiff, statusDiff: false, dateDiff, branchDiff: false };
  const statusDiff =
    (!!patch.outcome && !choiceMatches(current.outcome, patch.outcome)) ||
    (!!patch.footageStatus && !choiceMatches(current.footage, patch.footageStatus));
  return { timeDiff, statusDiff, dateDiff, branchDiff: false };
}

function sameClaimDate(current, dateRaw) {
  const want = parseClaimDate(dateRaw);
  if (!want.iso) return false;
  const got = parseClaimDate(current);
  return !!got.iso && got.iso === want.iso;
}

function parseClaimDate(raw) {
  const text = normalizeSpace(raw);
  if (!text) return { iso: "", dash: "" };
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { iso: `${iso[1]}-${iso[2]}-${iso[3]}`, dash: `${iso[3]}-${iso[2]}-${iso[1]}` };
  const dmy = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (dmy) {
    const dd = dmy[1].padStart(2, "0");
    const mm = dmy[2].padStart(2, "0");
    return { iso: `${dmy[3]}-${mm}-${dd}`, dash: `${dd}-${mm}-${dmy[3]}` };
  }
  const months = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  const named =
    text.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/) ||
    text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (named) {
    let dd;
    let mon;
    let yyyy;
    if (/^\d/.test(named[1])) {
      dd = named[1].padStart(2, "0");
      mon = months[named[2].slice(0, 3).toLowerCase()];
      yyyy = named[3];
    } else {
      mon = months[named[1].slice(0, 3).toLowerCase()];
      dd = named[2].padStart(2, "0");
      yyyy = named[3];
    }
    if (mon) return { iso: `${yyyy}-${mon}-${dd}`, dash: `${dd}-${mon}-${yyyy}` };
  }
  return { iso: "", dash: "" };
}

/**
 * High-level plan for one Deliveroo row vs one Workhorse claim snapshot.
 * Guarantees updateBranch is never true.
 */
function planClaimUpdate(info, current, resolveLocationName = identityLocation) {
  if (!rowMatchesDeliveroo(info, current, resolveLocationName)) {
    return {
      action: "skip",
      reason: "branch-mismatch",
      updateTime: false,
      updateDate: false,
      updateOutcome: false,
      updateBranch: false,
      patch: null,
    };
  }
  const need = claimNeedsEdit(info, current);
  const patch =
    info.disputeStatus === "approved" || info.disputeStatus === "rejected"
      ? disputeResolution(info.disputeStatus, current.footage || "")
      : null;
  if (!need.timeDiff && !need.statusDiff && !need.dateDiff) {
    return {
      action: "none",
      reason: "already-correct",
      updateTime: false,
      updateDate: false,
      updateOutcome: false,
      updateBranch: false,
      patch,
    };
  }
  return {
    action: "edit",
    reason: "",
    updateTime: need.timeDiff,
    updateDate: need.dateDiff,
    updateOutcome: need.statusDiff,
    updateBranch: false,
    patch: need.statusDiff ? patch : null,
  };
}

/**
 * Pick the best Workhorse row among order-number matches.
 * Location first, then time; never rewrite Location.
 */
function pickClaimRow(rows, info, resolveLocationName = identityLocation) {
  if (!rows || !rows.length) return null;
  let pool = rows;
  if (info.branch) {
    const branchOk = rows.filter((row) => {
      return (
        !row.branchKnown ||
        !normalizeSpace(row.branch) ||
        sameBranch(row.branch, info.branch, resolveLocationName)
      );
    });
    if (!branchOk.length) return null;
    pool = branchOk;
  }
  if (info.time) {
    const timeMatches = pool.filter((row) => row.time === info.time);
    if (timeMatches.length) return timeMatches[0];
  }
  return pool[0];
}

/**
 * Workhorse-first lookup: given a visible claim row, find the matching Deliveroo order.
 * Validate Location first, then order #, then time. Never match order # alone across sites.
 */
function findDeliverooForClaim(deliverooRows, claim, resolveLocationName = identityLocation) {
  if (!claim || !deliverooRows || !deliverooRows.length) return null;
  const key = orderKey(claim.orderNumber || claim.num || "");
  if (!key) return null;
  let pool = deliverooRows.filter((row) => orderKey(row && row.orderNumber) === key);
  if (!pool.length) return null;

  const claimBranch = normalizeSpace(claim.branch || "");
  const deliverooHasBranch = pool.some((row) => normalizeSpace(row.branch));

  if (claimBranch && deliverooHasBranch) {
    const locOk = pool.filter(
      (row) => !row.branch || sameBranch(claimBranch, row.branch, resolveLocationName)
    );
    if (!locOk.length) return null;
    pool = locOk;
  } else if (!claimBranch && deliverooHasBranch && pool.length > 1) {
    return null;
  }

  if (claim.time) {
    const timeMatches = pool.filter((row) => row.time && row.time === claim.time);
    if (timeMatches.length) return timeMatches[0];
  }

  if (pool.length === 1) return pool[0];
  const withOutcome = pool.filter(
    (row) => row.disputeStatus === "approved" || row.disputeStatus === "rejected"
  );
  if (withOutcome.length === 1) return withOutcome[0];
  if (withOutcome.length > 1) return withOutcome[0];
  return pool[0] || null;
}

const api = {
  normalizeSpace,
  normalizeKey,
  orderCodeFromText,
  orderKey,
  classifyDisputeStatus,
  preferDisputeStatus,
  choiceMatches,
  siteLocationFromText,
  disputeResolution,
  sameBranch,
  rowMatchesDeliveroo,
  validateClaimBranch,
  validateClaimBranchAndTime,
  claimNeedsEdit,
  sameClaimDate,
  parseClaimDate,
  planClaimUpdate,
  pickClaimRow,
  findDeliverooForClaim,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof globalThis !== "undefined") {
  globalThis.DeliverooListUpdate = api;
}
