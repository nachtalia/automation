/**
 * Build self-contained Tampermonkey userscripts (no GitHub @require).
 * Usage: node build-static.js
 *
 * Keeps claims-presets.js + claims-core.js as the editable sources,
 * then inlines them into both .user.js files.
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const BEGIN = "/* ==== BEGIN INLINED SHARED (from claims-presets.js + claims-core.js) ==== */";
const END = "/* ==== END INLINED SHARED ==== */";

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function stripRequireLines(headerBlock) {
  return headerBlock
    .split(/\r?\n/)
    .filter((line) => !/^\/\/\s*@require\b/.test(line))
    .join("\n");
}

function bumpVersion(headerBlock, version) {
  return headerBlock.replace(/^(\/\/\s*@version\s+).+$/m, `$1${version}`);
}

function extractPlatformBody(fileText) {
  let body = fileText;
  const endInline = body.indexOf(END);
  if (endInline !== -1) {
    body = body.slice(endInline + END.length).replace(/^\r?\n+/, "");
  } else {
    const metaEnd = body.indexOf("// ==/UserScript==");
    if (metaEnd === -1) throw new Error("Missing // ==/UserScript==");
    body = body.slice(metaEnd + "// ==/UserScript==".length).replace(/^\r?\n+/, "");
  }
  return body;
}

function extractHeader(fileText) {
  const metaEnd = fileText.indexOf("// ==/UserScript==");
  if (metaEnd === -1) throw new Error("Missing // ==/UserScript==");
  return fileText.slice(0, metaEnd + "// ==/UserScript==".length);
}

function updateDocComment(body, note) {
  return body
    .replace(
      /\*[^\S\r\n]*Presets\/core load from GitHub via @require \(raw\.githubusercontent\.com\)\./,
      `* ${note}`
    )
    .replace(
      /\*[^\S\r\n]*Self-contained: presets \+ core are inlined below[^\r\n]*/,
      `* ${note}`
    )
    .replace(
      /Load claims-presets\.js and claims-core\.js via @require \(check network \/ Tampermonkey @require\)\./g,
      "Shared claims-presets/core failed to load (re-run node build-static.js and re-paste this userscript)."
    );
}

function buildOne(userFile, version) {
  const raw = read(userFile);
  let header = stripRequireLines(extractHeader(raw));
  header = bumpVersion(header, version);
  let body = extractPlatformBody(raw);
  body = updateDocComment(
    body,
    "Self-contained: presets + core are inlined below (run `node build-static.js` after editing shared files)."
  );

  const presets = read("claims-presets.js").replace(
    /Loaded via Tampermonkey @require by both platform userscripts\./,
    "Inlined into platform userscripts by build-static.js."
  );
  const core = read("claims-core.js").replace(
    /Not a userscript\. Load via Tampermonkey @require after claims-presets\.js\./,
    "Inlined into platform userscripts by build-static.js (after claims-presets)."
  );

  const out = [
    header,
    "",
    BEGIN,
    presets.trimEnd(),
    "",
    core.trimEnd(),
    END,
    "",
    body.replace(/^\uFEFF/, "").trimStart(),
  ].join("\n");

  fs.writeFileSync(path.join(root, userFile), out.replace(/\n/g, "\r\n").includes("\r") ? out : out);
  // normalize to LF
  fs.writeFileSync(path.join(root, userFile), out.replace(/\r\n/g, "\n"));
  console.log(`Built ${userFile} (v${version})`);
}

const VERSION = "2.3.7";
buildOne("deliveroo-claims-autofill.user.js", VERSION);
buildOne("ubereats-claims-autofill.user.js", VERSION);
console.log("Done. Paste the .user.js files into Tampermonkey (no @require needed).");
