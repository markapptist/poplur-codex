#!/usr/bin/env node
// Which SwiftUI screens can the shipping app actually REACH?
//
// Phase 3 replaced the native HomeView with a WebView, and everything that
// hung off HomeView went dark with it. Three capabilities have now been built
// into that dead tree and shipped unreachable — ML detection, the AR filters,
// and the Add to Apple Wallet button — because "is this screen web or native?"
// was a question nobody could answer without reading the whole app.
//
// This answers it. It walks references from the LIVE roots and reports every
// View that nothing live can get to. A view in that list is a view whose
// buttons no user will ever press.
//
//   node .codex/check-orphaned-screens.mjs            # summary
//   node .codex/check-orphaned-screens.mjs --all      # every orphan
//   node .codex/check-orphaned-screens.mjs ProfileView  # is THIS one reachable?
//
// Read the output as "check these", not "53 bugs". Most orphans are native
// screens the web twins deliberately superseded — feed, profile, games all
// have web equivalents, and their native originals going dark is the plan
// working. The ones that matter are orphans with NO web equivalent, where a
// capability simply left the product: AppSettingsView is the standing example
// (it carried sign-out, and nothing web replaced it).
//
// Validation, because a checker nobody trusts is worse than none: this
// independently reports ProfileView, RadiusStoreView and AppSettingsView as
// orphaned — the first two are where the Wallet button was wrongly built, and
// the third was already known — while PostLoginHomeSurface and
// WebHomeCameraLayer come back reachable.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/matrix/Developer/Poplur2025-iOS/Poplur2025";

/**
 * Where the shipping app actually starts. PoplurWebHome.isEnabled defaults to
 * TRUE, so PostLoginHomeSurface is the post-login root and HomeView is only the
 * flag-reversible fallback — which is exactly why its subtree is dark.
 */
const LIVE_ROOTS = [
  "Poplur2025App",
  "PostLoginHomeSurface",
  "PostLoginHomeWebView",
  "PostLoginLoadingWebView",
  "PreloginWebView",
  "WebHomeCameraLayer",
  "ContentView",
];

/** Reachable only through the flag-off fallback. */
const DEAD_ROOTS = ["HomeView"];

const files = readdirSync(ROOT).filter(f => f.endsWith(".swift"));
const source = new Map();
for (const f of files) source.set(f, readFileSync(join(ROOT, f), "utf8"));

// Every View-ish type and the file that declares it.
const declaredIn = new Map();
const DECL = /\bstruct\s+([A-Z][A-Za-z0-9_]*)\s*:\s*[^{]*\b(View|UIViewRepresentable|UIViewControllerRepresentable)\b/g;
for (const [file, text] of source) {
  for (const m of text.matchAll(DECL)) {
    if (!declaredIn.has(m[1])) declaredIn.set(m[1], file);
  }
}

const names = [...declaredIn.keys()];

/**
 * The SOURCE RANGE of each view, so references are counted per VIEW rather
 * than per file.
 *
 * File granularity is not good enough here, and this script proved it on
 * itself: ProfileView and RadiusStoreView both live in ProfileView.swift
 * alongside views the live path does reach, so a file-level walk called them
 * REACHABLE — the precise opposite of the truth, and the exact mistake that
 * put an Add to Apple Wallet button somewhere nobody could tap it.
 *
 * Extends over `extension X { … }` too, since a body is often split out.
 */
function bodyRanges(file) {
  const text = source.get(file) ?? "";
  const ranges = new Map();
  const DECLS = /\b(?:struct|extension)\s+([A-Z][A-Za-z0-9_]*)\b/g;
  for (const m of text.matchAll(DECLS)) {
    const open = text.indexOf("{", m.index);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
    }
    const slice = text.slice(open, Math.min(i + 1, text.length));
    ranges.set(m[1], (ranges.get(m[1]) ?? "") + slice);
  }
  return ranges;
}

const bodyOf = new Map();
for (const file of source.keys()) {
  for (const [name, body] of bodyRanges(file)) {
    if (!declaredIn.has(name)) continue;
    bodyOf.set(name, (bodyOf.get(name) ?? "") + body);
  }
}

/** Which declared views does THIS view construct inside its own body? */
const refCache = new Map();
function referencesFrom(name) {
  if (refCache.has(name)) return refCache.get(name);
  const body = bodyOf.get(name) ?? "";
  const out = new Set();
  for (const other of names) {
    if (other === name) continue;
    if (new RegExp(`\\b${other}\\s*[(<.]`).test(body)) out.add(other);
  }
  refCache.set(name, out);
  return out;
}

/**
 * Walk view-to-view from the roots.
 *
 * `blocked` is the whole point: the app entry declares BOTH the web surface
 * and HomeView (two halves of one if/else), so without treating HomeView as a
 * wall the live walk marches into the dead subtree and nothing looks orphaned.
 * Not hypothetical — that is what this reported on its first run.
 */
function reachableFrom(roots, blocked = new Set()) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop();
    if (!name || seen.has(name) || blocked.has(name)) continue;
    seen.add(name);
    for (const next of referencesFrom(name)) {
      if (!seen.has(next) && !blocked.has(next)) queue.push(next);
    }
  }
  return seen;
}

const live = reachableFrom(LIVE_ROOTS, new Set(DEAD_ROOTS));
for (const r of LIVE_ROOTS) live.add(r);
const viaDead = reachableFrom(DEAD_ROOTS);
for (const r of DEAD_ROOTS) viaDead.add(r);

/** Orphaned = reachable ONLY through the flag-off native home. */
const orphaned = [...viaDead].filter(n => !live.has(n)).sort();
/** Unreferenced = nothing reaches it at all (often previews and helpers). */
const unreachable = names.filter(n => !live.has(n) && !viaDead.has(n)).sort();

/** Does this view carry controls a person could press? Dead UI is the danger. */
function interactive(name) {
  const body = bodyOf.get(name) ?? "";
  return /\bButton\s*[({]|onTapGesture|PKAddPassButton|\.onSubmit|TextField\(/.test(body);
}

const argv = process.argv.slice(2);
const query = argv.find(a => !a.startsWith("-"));
if (query) {
  const where = declaredIn.get(query);
  if (!where) {
    console.log(`${query}: not a View declared under Poplur2025/`);
    process.exit(2);
  }
  const verdict = live.has(query)
    ? "REACHABLE from the shipping (web-home) path"
    : viaDead.has(query)
      ? "ORPHANED — only reachable through HomeView, which the web home replaced"
      : "UNREFERENCED — nothing constructs it";
  console.log(`${query}  (${where})\n  ${verdict}`);
  process.exit(live.has(query) ? 0 : 1);
}

const showAll = argv.includes("--all");
console.log(`Views declared: ${names.length}`);
console.log(`Reachable from the shipping path: ${live.size}`);
console.log(`ORPHANED behind the web home: ${orphaned.length}`);
console.log(`Never referenced at all: ${unreachable.length}\n`);

const dangerous = orphaned.filter(interactive);
console.log(`Orphaned AND carrying controls (dead UI — ${dangerous.length}):`);
for (const n of (showAll ? dangerous : dangerous.slice(0, 25))) {
  console.log(`  ${n}  (${declaredIn.get(n)})`);
}
if (!showAll && dangerous.length > 25) console.log(`  … ${dangerous.length - 25} more (--all)`);

process.exit(dangerous.length ? 1 : 0);
