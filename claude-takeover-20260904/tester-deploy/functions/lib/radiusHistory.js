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
exports.radiusHistoryOnPostCreated = void 0;
exports.radiusHistoryRef = radiusHistoryRef;
exports.radiusHistoryDocument = radiusHistoryDocument;
exports.creationHistoryEntry = creationHistoryEntry;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const firestore_2 = require("firebase-functions/v2/firestore");
const postEngagementPolicy_1 = require("./postEngagementPolicy");
if (admin.apps.length === 0)
    admin.initializeApp();
/**
 * A pop has a history: posts/{postId}/radiusHistory holds one entry per change
 * to its reach, from the moment it was posted to now. Every server writer that
 * moves a radius appends its own entry in the same transaction or batch
 * (recordPostEngagement, radiusDecay, the boost and publish endpoints, the
 * synthetic runner); this module holds the shared plumbing and the ONE entry
 * no writer can add atomically — the first point of a post a client created.
 *
 * Clients cannot write the subcollection (firestore.rules: read public like the
 * post, write never), so the creation point of an RN/iOS/Android post lands
 * here, seconds after the post, stamped with the post's own createdAtMillis.
 * That is the honest first point: the clock is the post's, and nothing can
 * engage with a post before it exists.
 */
function radiusHistoryRef(postRef, entryId) {
    return postRef.collection(postEngagementPolicy_1.RADIUS_HISTORY_COLLECTION).doc(entryId);
}
/** The stored form: the pure entry plus a server Timestamp for ordering and TTL. */
function radiusHistoryDocument(entry) {
    return { ...entry, at: firestore_1.Timestamp.fromMillis(entry.atMillis) };
}
function createdAtMillisOf(post, fallbackMillis) {
    const declared = Number(post.createdAtMillis);
    if (Number.isFinite(declared) && declared > 0)
        return declared;
    const stamp = post.createdAt;
    const millis = typeof stamp?.toMillis === "function" ? Number(stamp.toMillis()) : NaN;
    return Number.isFinite(millis) && millis > 0 ? millis : fallbackMillis;
}
/** The first point of a post as its document declares it. */
function creationHistoryEntry(post, fallbackMillis, writer) {
    const atMillis = createdAtMillisOf(post, fallbackMillis);
    const parts = (0, postEngagementPolicy_1.postRadiusParts)(post, atMillis);
    return (0, postEngagementPolicy_1.buildRadiusHistoryEntry)({
        atMillis,
        cause: "create",
        writer,
        previous: null,
        next: { radiusMeters: parts.total, organicRadiusMeters: parts.organic },
        seedRadiusMeters: parts.seed,
        boostedRadiusMeters: parts.boost,
    });
}
exports.radiusHistoryOnPostCreated = (0, firestore_2.onDocumentCreated)({ document: "posts/{postId}", region: "us-central1" }, async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const post = snapshot.data() ?? {};
    const eventMillis = Date.parse(event.time);
    const entry = creationHistoryEntry(post, Number.isFinite(eventMillis) ? eventMillis : Date.now(), "radiusHistoryOnPostCreated");
    try {
        await radiusHistoryRef(snapshot.ref, postEngagementPolicy_1.radiusHistoryEntryId.create()).create(radiusHistoryDocument(entry));
    }
    catch (error) {
        // A server writer that created the post in a batch already wrote its
        // own 'create' point, and at-least-once delivery can run this twice:
        // both are the same document, so an existing one is the finished state.
        if (error.code !== 6)
            throw error;
    }
});
