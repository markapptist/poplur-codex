"use strict";
/**
 * generateRetroGame — the callable a player's "make me a game" hits.
 *
 * It designs and stores a specification; it does not build a ROM. Firebase
 * Functions cannot build a .gba (Butano needs devkitARM and a POSIX toolchain,
 * and this is a short-lived Node sandbox), so the build doc written here is the
 * work order the builder job picks up. A caller polls the build doc.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRetroGame = void 0;
const admin = __importStar(require("firebase-admin"));
const firebase_functions_1 = require("firebase-functions");
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const creatureCollectorSpec_1 = require("./creatureCollectorSpec");
const retroGameGenerationService_1 = require("./retroGameGenerationService");
const anthropicApiKey = (0, params_1.defineSecret)("ANTHROPIC_API_KEY");
const protectedRegion = "us-central1";
/** A design takes real thinking and real money; one at a time, and not many. */
const COOLDOWN_MS = 20_000;
const DAILY_LIMIT = 20;
/** Map a generation failure onto the callable error the app can act on. */
function toHttpsError(error) {
    switch (error.code) {
        case "prompt_rejected":
            return new https_1.HttpsError("invalid-argument", error.message);
        case "spec_invalid":
            return new https_1.HttpsError("failed-precondition", error.message);
        case "model_unavailable":
            return new https_1.HttpsError("unavailable", error.message);
        case "designer_misconfigured":
            // Ours to fix, not the player's to retry.
            return new https_1.HttpsError("internal", "The game designer is not set up correctly.");
    }
}
exports.generateRetroGame = (0, https_1.onCall)({
    region: protectedRegion,
    enforceAppCheck: true,
    secrets: [anthropicApiKey],
    // Two streamed designs at up to 180s each, plus Firestore.
    timeoutSeconds: 540,
    memory: "512MiB",
}, async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Sign in to make a game.");
    const prompt = typeof request.data?.prompt === "string" ? request.data.prompt.trim() : "";
    if (!prompt) {
        throw new https_1.HttpsError("invalid-argument", "Describe the game you want.");
    }
    if (prompt.length > retroGameGenerationService_1.PROMPT_MAX_LENGTH) {
        throw new https_1.HttpsError("invalid-argument", `Keep the idea under ${retroGameGenerationService_1.PROMPT_MAX_LENGTH} characters.`);
    }
    // Resolved here, not at module scope: index.ts re-exports this module before
    // it calls initializeApp(), and re-exports are hoisted.
    const db = admin.firestore();
    // Cooldown and daily cap in one transaction, so two concurrent calls cannot
    // both read "under the limit" and both proceed.
    const rateRef = db.collection("retroGameRate").doc(uid);
    await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(rateRef);
        const data = snapshot.data();
        const lastAt = data?.lastAt;
        const now = Date.now();
        if (lastAt && now - lastAt.toMillis() < COOLDOWN_MS) {
            throw new https_1.HttpsError("resource-exhausted", "Let this game finish designing before starting another.");
        }
        const today = new Date(now).toISOString().slice(0, 10);
        const count = data?.day === today ? (data?.count ?? 0) : 0;
        if (count >= DAILY_LIMIT) {
            throw new https_1.HttpsError("resource-exhausted", "That's every game for today. Try again tomorrow.");
        }
        transaction.set(rateRef, { lastAt: firestore_1.FieldValue.serverTimestamp(), day: today, count: count + 1 }, { merge: true });
    });
    const apiKey = anthropicApiKey.value() || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new https_1.HttpsError("internal", "The game designer is not configured.");
    }
    let result;
    try {
        result = await (0, retroGameGenerationService_1.generateCreatureCollectorSpecification)(prompt, uid, apiKey);
    }
    catch (error) {
        if (error instanceof retroGameGenerationService_1.GenerationError) {
            firebase_functions_1.logger.warn("retro game generation failed", {
                uid, code: error.code, detail: error.detail, violations: error.violations,
            });
            throw toHttpsError(error);
        }
        throw error;
    }
    // The spec and the build are separate docs on purpose: the spec is the
    // reviewable artefact and never changes, while the build doc churns through
    // statuses and can be retried against the same spec.
    const buildRef = db.collection("retroGameBuilds").doc();
    await buildRef.set({
        uid,
        prompt,
        spec: result.spec,
        template: "creature_collector",
        specVersion: creatureCollectorSpec_1.CREATURE_SPEC_VERSION,
        status: "queued",
        createdAt: firestore_1.FieldValue.serverTimestamp(),
        attempts: result.attempts,
        usage: result.usage,
    });
    firebase_functions_1.logger.info("retro game designed", {
        uid,
        buildId: buildRef.id,
        creatures: result.spec.creatures.length,
        attempts: result.attempts,
        outputTokens: result.usage.outputTokens,
    });
    return { buildId: buildRef.id, spec: result.spec, status: "queued" };
});
