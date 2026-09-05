"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// The validator's job is to reject a design that would compile into a template
// that indexes past the end of an array. These are those designs.
const creatureCollectorSpec_1 = require("../creatureCollectorSpec");
let failed = 0;
const check = (name, ok, detail = "") => {
    if (!ok)
        failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const move = (id, type, power = 40) => ({ id, displayName: id.replace(/_/g, " "), type, power, accuracy: 95, effect: "none" });
const beast = (species, moves, evolvesInto = "", evolveLevel = 0) => ({
    species, displayName: species.replace(/_/g, " "), type: "ember",
    baseHp: 40, baseAttack: 40, baseDefense: 40, baseSpeed: 40,
    moves, rarity: "common", catchRate: 45, evolvesInto, evolveLevel,
});
const base = () => ({
    version: creatureCollectorSpec_1.CREATURE_SPEC_VERSION,
    title: "Cinder Isles",
    description: "Tame the creatures of a volcanic archipelago.",
    rivalName: "Wren", championName: "Ardo", partySize: 6,
    starters: ["ashpup", "reedling", "flintbug"],
    moves: [move("scratch", "beast"), move("ember_spit", "ember"), move("tide_slap", "tide"), move("gust", "gale")],
    creatures: [
        beast("ashpup", ["scratch", "ember_spit"], "ashhound", 16),
        beast("ashhound", ["ember_spit"]),
        beast("reedling", ["tide_slap"]),
        beast("flintbug", ["scratch"]),
        beast("dune_moth", ["gust"]),
        beast("cavefish", ["tide_slap"]),
    ],
    zones: [
        { id: "ember_shore", displayName: "Ember Shore", encounters: ["flintbug", "dune_moth"], levelMin: 3, levelMax: 7 },
        { id: "tide_caves", displayName: "Tide Caves", encounters: ["cavefish", "reedling"], levelMin: 8, levelMax: 14 },
    ],
});
const ok = (0, creatureCollectorSpec_1.validateCreatureCollectorSpec)(base());
check("a coherent creature game validates", ok.ok, ok.violations.map(v => `${v.field}: ${v.problem}`).join("; "));
check("the spec keeps every creature", ok.spec?.creatures.length === 6);
const reject = (name, mutate, expectField) => {
    const s = base();
    mutate(s);
    const r = (0, creatureCollectorSpec_1.validateCreatureCollectorSpec)(s);
    const hit = r.violations.some(v => v.field.includes(expectField));
    check(name, !r.ok && hit, r.ok ? "accepted it" : r.violations.map(v => v.field).join(","));
};
reject("a move nobody defined is caught", s => { s.creatures[0].moves = ["thunder_kick"]; }, "moves");
reject("a zone spawning an unknown species is caught", s => { s.zones[0].encounters = ["ghostfish"]; }, "encounters");
reject("evolving into an unknown species is caught", s => { s.creatures[0].evolvesInto = "ashdragon"; }, "evolvesInto");
reject("an evolution loop is caught", s => {
    s.creatures[0].evolvesInto = "ashhound";
    s.creatures[1].evolvesInto = "ashpup";
    s.creatures[1].evolveLevel = 20;
}, "evolvesInto");
reject("a creature nothing can obtain is caught", s => { s.creatures.push(beast("void_wyrm", ["scratch"])); }, "void_wyrm");
reject("a starter that is not a real species is caught", s => { s.starters[0] = "mystery_mon"; }, "starters");
reject("duplicate starters are caught", s => { s.starters = ["ashpup", "ashpup", "reedling"]; }, "starters");
reject("a duplicate species id is caught", s => { s.creatures.push(beast("ashpup", ["scratch"])); }, "species");
reject("a do-nothing move is caught", s => { s.moves.push({ ...move("stare", "shade", 0), effect: "none" }); }, "moves");
reject("levelMin above levelMax is caught", s => { s.zones[0].levelMin = 20; }, "levelMin");
reject("an out-of-range stat is caught", s => { s.creatures[0].baseAttack = 999; }, "baseAttack");
// The type chart is hand-written, so it should actually be a fair cycle.
let chartOk = true;
for (const t of creatureCollectorSpec_1.CREATURE_TYPES) {
    const e = creatureCollectorSpec_1.TYPE_CHART[t];
    if (e.strongAgainst.length !== 2 || e.weakAgainst.length !== 2)
        chartOk = false;
    if (e.strongAgainst.includes(t) || e.weakAgainst.includes(t))
        chartOk = false;
}
check("every type beats two and loses to two, never itself", chartOk);
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed ? 1 : 0);
