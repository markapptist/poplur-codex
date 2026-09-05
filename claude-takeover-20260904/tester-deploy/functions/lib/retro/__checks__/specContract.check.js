"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Does a response shaped exactly as SPEC_SCHEMA demands survive the validator?
// A drift between the two is the one bug that would only ever show up in
// production, after paying for a model call.
const gameSpecification_1 = require("../gameSpecification");
let failed = 0;
const check = (name, ok, detail = "") => {
    if (!ok)
        failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
// Exactly what Claude returns under the schema: no version (the service adds it),
// boss always present, enums from the closed lists.
const claudeShaped = {
    title: "Tide Wreck",
    genre: "top_down_action",
    description: "Scavenge a flooded pier while crabs defend the wreck.",
    player: { health: 6, speed: 3, weapon: "melee_bat" },
    levels: 4,
    mapWidth: 48,
    mapHeight: 32,
    enemies: [
        { type: "rust_beetle", behavior: "chase_player", health: 4, damage: 2 },
        { type: "pier_gull", behavior: "patrol", health: 2, damage: 1 },
    ],
    boss: { enabled: true, type: "harbor_king", health: 90 },
};
const r = (0, gameSpecification_1.validateGameSpecification)({ ...claudeShaped, version: gameSpecification_1.GAME_SPEC_VERSION });
check("a schema-shaped design validates", r.ok, r.violations.map(v => `${v.field}: ${v.problem}`).join("; "));
check("the validated spec keeps the boss", r.spec?.boss?.type === "harbor_king");
// A bossless game: schema still requires the object, so enabled:false must pass.
const bossless = (0, gameSpecification_1.validateGameSpecification)({
    ...claudeShaped, version: gameSpecification_1.GAME_SPEC_VERSION,
    boss: { enabled: false, type: "unused", health: 1 }, // health below the min on purpose
});
check("enabled:false ignores boss health/type", bossless.ok, bossless.violations.map(v => v.field).join(","));
check("a disabled boss is dropped from the spec", bossless.spec?.boss === undefined);
// The schema hard-codes enum lists; if the validator's lists ever move, the
// schema silently starts allowing values the validator rejects.
const schemaSrc = require("fs").readFileSync(__dirname + "/../retroGameGenerationService.ts", "utf8");
for (const [label, list] of [["genre", gameSpecification_1.GAME_GENRES], ["behavior", gameSpecification_1.ENEMY_BEHAVIORS], ["weapon", gameSpecification_1.WEAPONS]]) {
    const spread = `[...${label === "genre" ? "GAME_GENRES" : label === "behavior" ? "ENEMY_BEHAVIORS" : "WEAPONS"}]`;
    check(`${label} enum is taken from the validator, not retyped`, schemaSrc.includes(spread));
    void list;
}
// The validator must still be the thing catching out-of-range numbers, because
// structured outputs cannot express them.
const outOfRange = (0, gameSpecification_1.validateGameSpecification)({
    ...claudeShaped, version: gameSpecification_1.GAME_SPEC_VERSION, levels: 99, mapWidth: 512,
});
check("out-of-range numbers are caught by the validator", !outOfRange.ok, outOfRange.violations.map(v => v.field).join(","));
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed ? 1 : 0);
