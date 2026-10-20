/**
 * Pure helpers for Deliveroo → Workhorse list updates (Check all times / Won-Lost).
 * Used by unit tests; keep in sync with deliveroo-claims-autofill.user.js update path.
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
  const tokens = String(text || "").match(/\b\d{3,8}\b/g) || [];
  return tokens.find((token) => !/^(19|20)\d{2}$/.test(token)) || "";
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
  if ((next === "approved" || next === "rejected") && (prev === "approved" || prev === "rejected") && next !== prev) {
    return next;
  }
  return prev;
}

function choiceMatches(current, next) {
  return !!next && normalizeKey(current) === normalizeKey(next);
}

/**
 * Map Deliveroo approved/rejected → Workhorse Outcome (+ optional Footage Status).
 */
function disputeResolution(status, footageText) {
  if (status !== "approved" && status !== "rejected") return null;
  const footage = normalizeKey(footageText);
  const disputedCorrectly = /disputed correctly/.test(footage);
  const notAtFault =
    /video evidence confirms restaurant is not at fault/.test(footage) ||
    /video evidence confirms restaurant not at fault/.test(footage);
  if (status === "approved") {
    const update = { outcome: "Won" };
    if (!disputedCorrectly && !notAtFault) update.footageStatus = "Won without footage";
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
  return left.includes(right) || right.includes(left);
}

/**
 * True when this Workhorse list row is the Deliveroo order (same site).
 * Conflicting non-empty locations → false (duplicate order # on another branch).
 */
function rowMatchesDeliveroo(info, current, resolveLocationName = identityLocation) {
  if (!info) return false;
  // Same order # + same time → this claim (duplicate order #s across sites usually differ by time).
  if (info.time && current.time && current.time === info.time) return true;
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

function validateClaimBranchAndTime(currentLocation, deliverooBranch, formTime, deliverooTime, resolveLocationName = identityLocation) {
  if (deliverooTime && formTime && formTime === deliverooTime) return { branchMismatch: false };
  return validateClaimBranch(currentLocation, deliverooBranch, resolveLocationName);
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
  const named = text.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/) || text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
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
 * Prefer exact time, then branch; never rewrite Location.
 */
function pickClaimRow(rows, info, resolveLocationName = identityLocation) {
  if (!rows || !rows.length) return null;
  if (info.time) {
    const timeMatches = rows.filter((row) => row.time === info.time);
    if (timeMatches.length === 1) return timeMatches[0];
    if (timeMatches.length > 1) {
      const branchOk = timeMatches.filter((row) => {
        return (
          !info.branch ||
          !row.branchKnown ||
          !normalizeSpace(row.branch) ||
          sameBranch(row.branch, info.branch, resolveLocationName)
        );
      });
      return branchOk[0] || timeMatches[0];
    }
  }
  const branchOk = rows.filter((row) => rowMatchesDeliveroo(info, row, resolveLocationName));
  if (info.branch && !branchOk.length) return null;
  return (branchOk.length ? branchOk : rows)[0];
}

/**
 * Workhorse-first lookup: given a visible claim row, find the matching Deliveroo order.
 * Prefer order # + time, then branch. Used so we only update claims already on screen.
 */
function findDeliverooForClaim(deliverooRows, claim, resolveLocationName = identityLocation) {
  if (!claim || !deliverooRows || !deliverooRows.length) return null;
  const key = orderKey(claim.orderNumber || claim.num || "");
  if (!key) return null;
  const candidates = deliverooRows.filter((row) => orderKey(row && row.orderNumber) === key);
  if (!candidates.length) return null;

  if (claim.time) {
    const timeMatches = candidates.filter((row) => row.time && row.time === claim.time);
    if (timeMatches.length === 1) return timeMatches[0];
    if (timeMatches.length > 1) {
      const branchOk = timeMatches.filter(
        (row) =>
          !row.branch ||
          !claim.branch ||
          sameBranch(claim.branch, row.branch, resolveLocationName)
      );
      return branchOk[0] || timeMatches[0];
    }
  }

  if (claim.branch) {
    const branchOk = candidates.filter(
      (row) => !row.branch || sameBranch(claim.branch, row.branch, resolveLocationName)
    );
    if (branchOk.length === 1) return branchOk[0];
    if (branchOk.length > 1) {
      if (claim.time) {
        const timeOk = branchOk.find((row) => row.time === claim.time);
        if (timeOk) return timeOk;
      }
      const withOutcome = branchOk.filter(
        (row) => row.disputeStatus === "approved" || row.disputeStatus === "rejected"
      );
      if (withOutcome.length === 1) return withOutcome[0];
      return branchOk[0];
    }
  }

  if (candidates.length === 1) return candidates[0];
  const withOutcome = candidates.filter(
    (row) => row.disputeStatus === "approved" || row.disputeStatus === "rejected"
  );
  if (withOutcome.length === 1) return withOutcome[0];
  return null; // ambiguous duplicate order # — do not guess
}

module.exports = {
  normalizeSpace,
  normalizeKey,
  orderCodeFromText,
  orderKey,
  classifyDisputeStatus,
  preferDisputeStatus,
  choiceMatches,
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
