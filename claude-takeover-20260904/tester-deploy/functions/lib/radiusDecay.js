"use strict";
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
exports.radiusDecay = void 0;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const postEngagementPolicy_1 = require("./postEngagementPolicy");
const radiusHistory_1 = require("./radiusHistory");
if (admin.apps.length === 0)
    admin.initializeApp();
const db = admin.firestore();
/**
 * Radius is a score you defend, not a stat you keep: organic radius halves in
 * ~13.5 days untouched (RADIUS_DECAY_PER_DAY, elapsed-time based so missed
 * runs catch up). Boost never decays here — it is paid product with its own
 * boostExpiresAt. Feed reach labels snapshot at delivery and are unaffected;
 * only the live delivery gate shrinks.
 *
 * The decay clock is `decayedAt`, written ONLY here: a post without one gets
 * a baseline stamp and no decay, so decay accrues purely between server
 * stamps and a pre-decay-era post is never punished retroactively. Clients
 * are locked out of decayedAt in firestore.rules — a client-written clock
 * would let an owner freeze their own decay.
 *
 * Scale note: this pages the whole radius-bearing post set hourly, which is
 * fine at beta scale (hundreds). Past ~50k such posts, shard by decayedAt
 * cursor instead of re-reading everything.
 */
exports.radiusDecay = (0, scheduler_1.onSchedule)({ schedule: "every 60 minutes", region: "us-central1", timeoutSeconds: 300, memory: "256MiB" }, async () => {
    const nowMillis = Date.now();
    const nowTimestamp = firestore_1.Timestamp.fromMillis(nowMillis);
    let decayed = 0;
    let stamped = 0;
    // Two range queries because legacy posts may carry only radius/radiusMeters
    // with no organicRadiusMeters field; the per-post transaction re-reads, so
    // overlap between the two result sets is harmless.
    const [organicSnapshot, legacySnapshot] = await Promise.all([
        db.collection("posts").where("organicRadiusMeters", ">", 0).limit(2_000).get(),
        db.collection("posts").where("radiusMeters", ">", 0).limit(2_000).get(),
    ]);
    const references = new Map();
    for (const doc of [...organicSnapshot.docs, ...legacySnapshot.docs]) {
        references.set(doc.ref.path, doc.ref);
    }
    for (const ref of references.values()) {
        await db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists)
                return;
            const post = snapshot.data() ?? {};
            if (post.decayedAt == null) {
                transaction.update(ref, { decayedAt: nowTimestamp });
                stamped += 1;
                return;
            }
            const next = (0, postEngagementPolicy_1.calculateRadiusDecay)(post, nowMillis);
            if (!next)
                return;
            const before = (0, postEngagementPolicy_1.postRadiusParts)(post, nowMillis);
            transaction.update(ref, {
                organicRadiusMeters: next.organicRadiusMeters,
                radiusMeters: next.radiusMeters,
                radius: next.radiusMeters,
                decayedAt: nowTimestamp,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            // The pop's history: decay is a change like any other and is recorded
            // with it, in the same transaction.
            transaction.create((0, radiusHistory_1.radiusHistoryRef)(ref, postEngagementPolicy_1.radiusHistoryEntryId.decay(nowMillis)), (0, radiusHistory_1.radiusHistoryDocument)((0, postEngagementPolicy_1.buildRadiusHistoryEntry)({
                atMillis: nowMillis,
                cause: "decay",
                writer: "radiusDecay",
                previous: { radiusMeters: before.stored ?? before.total, organicRadiusMeters: before.organic },
                next,
                seedRadiusMeters: before.seed,
                boostedRadiusMeters: before.boost,
            })));
            decayed += 1;
        });
    }
    console.log(`[radiusDecay] ${decayed} decayed, ${stamped} baseline-stamped, ${references.size} candidates`);
});
