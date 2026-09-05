"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * The one check that needs a real key: does Claude actually design a creature
 * roster that survives the validator?
 *
 * Run it in a shell where ANTHROPIC_API_KEY is set. It prints the game it
 * designed and never prints the key.
 */
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const retroGameGenerationService_1 = require("../retroGameGenerationService");
const creatureCollectorSpec_1 = require("../creatureCollectorSpec");
/** --save <path> writes the spec so the builder can turn it into a ROM. */
const saveFlag = process.argv.indexOf("--save");
const savePath = saveFlag >= 0 ? process.argv[saveFlag + 1] : null;
const argv = saveFlag >= 0 ? process.argv.filter((_, i) => i !== saveFlag && i !== saveFlag + 1) : process.argv;
const IDEA = argv.slice(2).join(" ") ||
    "a rainy seaside town where the creatures live in tide pools and old fishing boats";
/**
 * Env var first, then a key file outside the repo. The file is what makes this
 * survive a new terminal tab — an `export` only lives in the shell that ran it.
 * It sits in ~/.config rather than in the project so it cannot be committed by
 * accident, which is the same reason the Anthropic CLI keeps credentials there.
 */
const KEY_FILE = (0, node_path_1.join)((0, node_os_1.homedir)(), ".config", "anthropic", "poplur-key");
/** An env var that is obviously a copied placeholder, not a key. Worth
 *  detecting because it otherwise silently shadows a perfectly good stored
 *  key and reports the failure as if the stored key were bad. */
function isPlaceholder(value) {
    return value.includes("...") || value.includes("<") || value.length < 30;
}
function resolveKey() {
    const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
    if (fromEnv && !isPlaceholder(fromEnv))
        return fromEnv;
    if (fromEnv) {
        console.error(`Ignoring ANTHROPIC_API_KEY in this shell — it is a placeholder, not a key.`);
        console.error(`Falling back to ${KEY_FILE}. Run 'unset ANTHROPIC_API_KEY' to silence this.\n`);
    }
    try {
        const fromFile = (0, node_fs_1.readFileSync)(KEY_FILE, "utf8").trim();
        if (fromFile)
            return fromFile;
    }
    catch {
        // Absent or unreadable is the normal case, not an error worth printing.
    }
    return null;
}
/**
 * Describe the key without revealing it. A 401 is nearly always a paste
 * accident — a truncated key, or quotes captured along with it — and the shape
 * shows that immediately, where the key's value would only be a hazard.
 */
function describeKey(raw, source) {
    const notes = [];
    notes.push(`source: ${source}`);
    notes.push(`length: ${raw.length} characters (an Anthropic key is typically ~108)`);
    notes.push(`starts with: ${JSON.stringify(raw.slice(0, 11))}`);
    if (!raw.startsWith("sk-ant-")) {
        notes.push("PROBLEM: does not start with sk-ant- — this is not an Anthropic API key.");
        if (raw.startsWith("sk-"))
            notes.push("  It looks like a key for a different service.");
        if (/^['"]/.test(raw))
            notes.push("  It starts with a quote — the quotes were captured as part of the value.");
    }
    if (/['"`]/.test(raw))
        notes.push("PROBLEM: contains a quote character.");
    if (/\s/.test(raw))
        notes.push("PROBLEM: contains whitespace or a line break.");
    if (raw.startsWith("sk-ant-") && raw.length < 90) {
        notes.push("PROBLEM: too short — the key was very likely truncated on paste.");
    }
    return notes;
}
const key = resolveKey();
if (!key) {
    console.error("No API key found. Either export it in this shell:");
    console.error("  export ANTHROPIC_API_KEY='sk-ant-...'");
    console.error("or save it once so every shell can find it:");
    console.error(`  mkdir -p ~/.config/anthropic && printf '%s' 'sk-ant-...' > ${KEY_FILE} && chmod 600 ${KEY_FILE}`);
    process.exit(2);
}
const started = Date.now();
console.log(`Designing: "${IDEA}"\nThis takes a minute or two at high effort.\n`);
(0, retroGameGenerationService_1.generateCreatureCollectorSpecification)(IDEA, "local-check", key)
    .then(({ spec, attempts, usage }) => {
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`=== ${spec.title} ===`);
    console.log(spec.description);
    console.log(`Rival ${spec.rivalName} · Champion ${spec.championName} · party of ${spec.partySize}\n`);
    console.log(`Starters: ${spec.starters
        .map((s) => {
        const c = spec.creatures.find((x) => x.species === s);
        return `${c.displayName} (${c.type})`;
    })
        .join(", ")}\n`);
    console.log(`Creatures (${spec.creatures.length}):`);
    for (const c of spec.creatures) {
        const evo = c.evolvesInto
            ? ` → ${spec.creatures.find((x) => x.species === c.evolvesInto)?.displayName} at ${c.evolveLevel}`
            : "";
        console.log(`  ${c.displayName.padEnd(16)} ${c.type.padEnd(6)} ${c.rarity.padEnd(10)}` +
            ` hp${c.baseHp} atk${c.baseAttack} def${c.baseDefense} spd${c.baseSpeed}${evo}`);
    }
    console.log(`\nZones (${spec.zones.length}):`);
    for (const z of spec.zones) {
        const names = z.encounters.map((e) => spec.creatures.find((x) => x.species === e)?.displayName);
        console.log(`  ${z.displayName.padEnd(18)} Lv${z.levelMin}-${z.levelMax}  ${names.join(", ")}`);
    }
    console.log(`\nMoves (${spec.moves.length}): ${spec.moves.map((m) => m.displayName).join(", ")}`);
    // Design quality the validator does not judge: does the roster actually use
    // the type chart, or is it eight creatures of one element?
    const used = new Set(spec.creatures.map((c) => c.type));
    console.log(`\nType coverage: ${used.size}/${creatureCollectorSpec_1.CREATURE_TYPES.length} types used`);
    const starterTypes = new Set(spec.starters.map((s) => spec.creatures.find((x) => x.species === s).type));
    console.log(`Starters cover ${starterTypes.size}/3 different types` +
        (starterTypes.size === 3 ? " ✓" : " — the first choice matters less than it should"));
    void creatureCollectorSpec_1.TYPE_CHART;
    if (savePath) {
        (0, node_fs_1.writeFileSync)(savePath, JSON.stringify(spec, null, 2));
        console.log(`\nSpec written to ${savePath} — feed it to gba-builder.`);
    }
    console.log(`\nValidated on attempt ${attempts} in ${secs}s.`);
    console.log(`Tokens: ${usage.inputTokens} in, ${usage.outputTokens} out` +
        ` (~$${((usage.inputTokens * 5 + usage.outputTokens * 25) / 1_000_000).toFixed(3)} at list price)`);
})
    .catch((error) => {
    console.error(`\nFAILED: ${error.message}`);
    if (error.detail)
        console.error(`API said: ${error.detail}`);
    if (error.code === "designer_misconfigured") {
        const source = process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY in this shell" : KEY_FILE;
        console.error("\nThe key that was used, described without revealing it:");
        for (const note of describeKey(key, source))
            console.error(`  ${note}`);
        console.error("\nIf the shape looks right, the key is valid-looking but rejected:");
        console.error("  - it was revoked or belongs to a deleted workspace");
        console.error("  - the account has no credit");
        console.error("  Check it at https://console.anthropic.com/settings/keys");
    }
    if (error.violations?.length) {
        console.error("The validator rejected the design:");
        for (const v of error.violations)
            console.error(`  ${v.field}: ${v.problem}`);
    }
    process.exit(1);
});
