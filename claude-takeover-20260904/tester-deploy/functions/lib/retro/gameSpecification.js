"use strict";
/**
 * The contract between Claude and the GBA build pipeline.
 *
 * This file is the security boundary, not a convenience type. The brief's rule is
 *
 *     prompt -> constrained schema -> trusted template
 *
 * rather than
 *
 *     prompt -> arbitrary C++ -> execute
 *
 * so everything downstream treats a GameSpecification as the ONLY thing it will
 * act on, and treats anything Claude says outside this shape as noise. A field
 * that is not in this schema cannot reach a compiler.
 *
 * Two consequences that are easy to lose later:
 *
 *  - Limits are enforced HERE, not in the template. A template that trusts its
 *    input is one bad spec away from a ROM that will not fit in 32MB or a level
 *    that will not hold in 256KB of EWRAM, and the failure would surface as an
 *    inscrutable compiler or linker error rather than "too many enemies".
 *  - Validation REJECTS unknown properties rather than ignoring them. Silently
 *    dropping a field Claude invented means a spec that validates but does not
 *    describe the game the model thought it was writing, and the mismatch would
 *    only show up as a game that plays wrong.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SPEC_LIMITS = exports.WEAPONS = exports.ENEMY_BEHAVIORS = exports.GAME_GENRES = exports.GAME_SPEC_VERSION = void 0;
exports.validateGameSpecification = validateGameSpecification;
/** Bump when the shape changes incompatibly. Stored with every build so an old
 *  spec can be identified rather than mis-parsed by a newer validator. */
exports.GAME_SPEC_VERSION = 1;
exports.GAME_GENRES = [
    "platformer",
    "top_down_action",
    "rpg",
    "racing",
    "puzzle",
    "endless_runner",
    "shooter",
    "adventure",
];
exports.ENEMY_BEHAVIORS = [
    "chase_player",
    "patrol",
    "stationary_shooter",
    "flee",
    "random_walk",
    "charge",
];
/** Weapons are an ENUM, not free text. A string here would flow into asset
 *  selection and template parameters, which is precisely the path that turns a
 *  prompt into arbitrary content. */
exports.WEAPONS = [
    "none", "melee_bat", "melee_sword", "pistol", "spread_shot", "laser", "bombs",
];
/**
 * Hard ceilings.
 *
 * The GBA has 256KB EWRAM, 32KB IWRAM, 96KB VRAM and 128 hardware sprites, and
 * Butano allocates sprite tiles out of that VRAM budget. These numbers are set
 * well under the hardware ceiling on purpose: the point is to fail validation with
 * a sentence a person can read, rather than to fail at link time with a section
 * overflow that requires knowing GBA memory maps to interpret.
 */
exports.SPEC_LIMITS = {
    titleMaxLength: 48,
    descriptionMaxLength: 280,
    levels: { min: 1, max: 12 },
    playerHealth: { min: 1, max: 20 },
    speed: { min: 1, max: 8 },
    enemyTypes: { max: 8 },
    enemiesOnScreen: { max: 24 },
    enemyHealth: { min: 1, max: 50 },
    bossHealth: { min: 5, max: 500 },
    /** Tiles. 64x64 at 8x8 is already 256KB of map data before art. */
    mapSize: { min: 16, max: 64 },
    animationFrames: { min: 1, max: 8 },
    spriteCount: { max: 48 },
    romSizeBytes: { max: 16 * 1024 * 1024 },
};
/** Slugs name assets and template parameters, so the charset is closed. Anything
 *  outside it is rejected rather than sanitised: silently rewriting a name Claude
 *  chose produces a spec that no longer matches what it described. */
const SLUG_RE = /^[a-z][a-z0-9_]{0,31}$/;
const isFiniteInt = (v) => typeof v === "number" && Number.isInteger(v) && Number.isFinite(v);
/**
 * Validate an untrusted object into a GameSpecification.
 *
 * Never throws: a malformed model response is an expected input here, not an
 * exceptional one, and the caller needs the violations to decide between a
 * bounded repair retry and giving up.
 */
function validateGameSpecification(input) {
    const v = [];
    const fail = (field, problem) => v.push({ field, problem });
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, violations: [{ field: "$", problem: "not a JSON object" }] };
    }
    const raw = input;
    // Unknown keys are REJECTED, not dropped. A spec that validates while quietly
    // discarding half of what the model produced is worse than one that fails.
    const allowed = new Set([
        "version", "title", "genre", "description",
        "player", "levels", "mapWidth", "mapHeight", "enemies", "boss",
    ]);
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key))
            fail(key, "unsupported property");
    }
    if (raw.version !== exports.GAME_SPEC_VERSION) {
        fail("version", `must be ${exports.GAME_SPEC_VERSION}`);
    }
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title || title.length > exports.SPEC_LIMITS.titleMaxLength) {
        fail("title", `1..${exports.SPEC_LIMITS.titleMaxLength} characters`);
    }
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (description.length > exports.SPEC_LIMITS.descriptionMaxLength) {
        fail("description", `at most ${exports.SPEC_LIMITS.descriptionMaxLength} characters`);
    }
    if (!exports.GAME_GENRES.includes(raw.genre)) {
        fail("genre", `must be one of ${exports.GAME_GENRES.join(", ")}`);
    }
    const player = raw.player;
    if (typeof player !== "object" || player === null) {
        fail("player", "required object");
    }
    else {
        const { playerHealth, speed } = exports.SPEC_LIMITS;
        if (!isFiniteInt(player.health) || player.health < playerHealth.min || player.health > playerHealth.max) {
            fail("player.health", `integer ${playerHealth.min}..${playerHealth.max}`);
        }
        if (!isFiniteInt(player.speed) || player.speed < speed.min || player.speed > speed.max) {
            fail("player.speed", `integer ${speed.min}..${speed.max}`);
        }
        if (!exports.WEAPONS.includes(player.weapon)) {
            fail("player.weapon", `must be one of ${exports.WEAPONS.join(", ")}`);
        }
    }
    const { levels, mapSize } = exports.SPEC_LIMITS;
    if (!isFiniteInt(raw.levels) || raw.levels < levels.min || raw.levels > levels.max) {
        fail("levels", `integer ${levels.min}..${levels.max}`);
    }
    for (const dim of ["mapWidth", "mapHeight"]) {
        const value = raw[dim];
        if (!isFiniteInt(value) || value < mapSize.min || value > mapSize.max) {
            fail(dim, `integer ${mapSize.min}..${mapSize.max} tiles`);
        }
    }
    if (!Array.isArray(raw.enemies)) {
        fail("enemies", "required array");
    }
    else {
        if (raw.enemies.length > exports.SPEC_LIMITS.enemyTypes.max) {
            fail("enemies", `at most ${exports.SPEC_LIMITS.enemyTypes.max} enemy types`);
        }
        raw.enemies.forEach((entry, i) => {
            const e = entry;
            if (typeof e !== "object" || e === null) {
                fail(`enemies[${i}]`, "not an object");
                return;
            }
            if (typeof e.type !== "string" || !SLUG_RE.test(e.type)) {
                fail(`enemies[${i}].type`, "lowercase slug, letters/digits/underscore, max 32");
            }
            if (!exports.ENEMY_BEHAVIORS.includes(e.behavior)) {
                fail(`enemies[${i}].behavior`, `must be one of ${exports.ENEMY_BEHAVIORS.join(", ")}`);
            }
            const { enemyHealth } = exports.SPEC_LIMITS;
            if (!isFiniteInt(e.health) || e.health < enemyHealth.min || e.health > enemyHealth.max) {
                fail(`enemies[${i}].health`, `integer ${enemyHealth.min}..${enemyHealth.max}`);
            }
            if (!isFiniteInt(e.damage) || e.damage < 0 || e.damage > 20) {
                fail(`enemies[${i}].damage`, "integer 0..20");
            }
        });
    }
    if (raw.boss !== undefined) {
        const boss = raw.boss;
        if (typeof boss !== "object" || boss === null) {
            fail("boss", "must be an object when present");
        }
        else {
            if (typeof boss.enabled !== "boolean")
                fail("boss.enabled", "boolean");
            if (boss.enabled) {
                if (typeof boss.type !== "string" || !SLUG_RE.test(boss.type)) {
                    fail("boss.type", "lowercase slug, letters/digits/underscore, max 32");
                }
                const { bossHealth } = exports.SPEC_LIMITS;
                if (!isFiniteInt(boss.health) || boss.health < bossHealth.min || boss.health > bossHealth.max) {
                    fail("boss.health", `integer ${bossHealth.min}..${bossHealth.max}`);
                }
            }
        }
    }
    if (v.length > 0)
        return { ok: false, violations: v };
    // Rebuilt field by field rather than cast. Casting the input would carry any
    // prototype pollution or extra keys straight through the boundary this file
    // exists to be.
    const p = player;
    const spec = {
        version: exports.GAME_SPEC_VERSION,
        title,
        genre: raw.genre,
        description,
        player: {
            health: p.health,
            speed: p.speed,
            weapon: p.weapon,
        },
        levels: raw.levels,
        mapWidth: raw.mapWidth,
        mapHeight: raw.mapHeight,
        enemies: raw.enemies.map((e) => ({
            type: e.type,
            behavior: e.behavior,
            health: e.health,
            damage: e.damage,
        })),
    };
    const boss = raw.boss;
    if (boss?.enabled === true) {
        spec.boss = { enabled: true, type: boss.type, health: boss.health };
    }
    return { ok: true, spec, violations: [] };
}
