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
exports.recordPostEngagement = void 0;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const postEngagementPolicy_1 = require("./postEngagementPolicy");
const radiusHistory_1 = require("./radiusHistory");
if (admin.apps.length === 0)
    admin.initializeApp();
const db = admin.firestore();
const region = "us-central1";
function boundedText(value, maximum) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : "";
}
function postOwnerUid(post) {
    return boundedText(post.ownerId ?? post.userID ?? post.userId, 128);
}
function publishedPost(post) {
    const audience = boundedText(post.audience, 24).toLowerCase();
    const status = boundedText(post.visibilityStatus ?? post.status, 24).toLowerCase();
    return (!audience || audience === "public")
        && (!status || status === "published" || status === "live");
}
function actorHandle(user) {
    const value = boundedText(user.username ?? user.handle ?? user.displayName, 40);
    if (!value)
        return "";
    return value.startsWith("@") ? value : `@${value}`;
}
function storedResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const result = value;
    if (typeof result.postId !== "string" || typeof result.eventId !== "string"
        || typeof result.kind !== "string" || typeof result.applied !== "boolean"
        || typeof result.radiusDeltaMeters !== "number" || !result.counters)
        return null;
    return result;
}
/**
 * The only client write path for post reach/counters. Authentication supplies
 * the actor; the transaction supplies the post owner, deltas, counters and
 * timestamps. Retrying the same event id returns the stored result without a
 * second increment.
 */
exports.recordPostEngagement = (0, https_1.onCall)({ region, timeoutSeconds: 15, memory: "256MiB" }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Sign in to react to a post.");
    let input;
    try {
        input = (0, postEngagementPolicy_1.parsePostEngagementInput)(request.data);
    }
    catch (error) {
        if (error instanceof postEngagementPolicy_1.PostEngagementValidationError) {
            throw new https_1.HttpsError("invalid-argument", error.message);
        }
        throw error;
    }
    const postRef = db.collection("posts").doc(input.postId);
    const eventRef = postRef.collection("engagements")
        .doc((0, postEngagementPolicy_1.postEngagementDocumentId)(uid, input.eventId));
    const actorStateRef = postRef.collection("engagementActors")
        .doc((0, postEngagementPolicy_1.postEngagementActorStateId)(uid));
    const actorRef = db.collection("users").doc(uid);
    const nowMillis = Date.now();
    return db.runTransaction(async (transaction) => {
        const eventSnapshot = await transaction.get(eventRef);
        if (eventSnapshot.exists) {
            const event = eventSnapshot.data() ?? {};
            if (event.actorUid !== uid || event.clientEventId !== input.eventId || event.kind !== input.kind) {
                throw new https_1.HttpsError("already-exists", "That engagement id belongs to another action.");
            }
            const result = storedResult(event.result);
            if (!result)
                throw new https_1.HttpsError("data-loss", "The stored engagement result is invalid.");
            return { ...result, duplicate: true };
        }
        const postSnapshot = await transaction.get(postRef);
        if (!postSnapshot.exists)
            throw new https_1.HttpsError("not-found", "Post not found.");
        const post = postSnapshot.data() ?? {};
        const ownerUid = postOwnerUid(post);
        if (!ownerUid || !publishedPost(post)) {
            throw new https_1.HttpsError("failed-precondition", "This post is not available for engagement.");
        }
        // A block has to reach the engagement path, and only this function can
        // carry it there. firestore.rules gates dmThreads, messages and calls,
        // but engagement runs THROUGH this callable with admin credentials, so
        // rules never see it — without this check a blocked person still lights
        // up your phone by liking or commenting, and every radius they move is
        // still theirs to move.
        //
        // Symmetric, matching the rules: either direction closes the channel.
        // Read inside the transaction, never from anything the caller sent.
        if (ownerUid !== uid) {
            const [ownerBlocksActor, actorBlocksOwner] = await Promise.all([
                transaction.get(db.collection("users").doc(ownerUid).collection("blocked").doc(uid)),
                transaction.get(db.collection("users").doc(uid).collection("blocked").doc(ownerUid)),
            ]);
            if (ownerBlocksActor.exists || actorBlocksOwner.exists) {
                throw new https_1.HttpsError("permission-denied", "This post is not available for engagement.");
            }
        }
        const actorStateSnapshot = await transaction.get(actorStateRef);
        const actorSnapshot = await transaction.get(actorRef);
        const actorState = actorStateSnapshot.data() ?? {};
        const lastViewAt = actorState.lastViewAt;
        const lastViewAtMillis = lastViewAt && typeof lastViewAt.toMillis === "function"
            ? Number(lastViewAt.toMillis())
            : null;
        const mutation = (0, postEngagementPolicy_1.calculatePostEngagementMutation)(post, input.kind, nowMillis, {
            lastViewAtMillis: Number.isFinite(lastViewAtMillis) ? lastViewAtMillis : null,
            liked: actorState.liked === true,
            disliked: actorState.disliked === true,
            commentGranted: actorState.commentGranted === true,
            paidRepeatViews: typeof actorState.paidRepeatViews === "number"
                ? actorState.paidRepeatViews
                : 0,
        }, 
        // The post's own author. Read from the stored document inside the
        // transaction, never from anything the caller sent.
        ownerUid === uid);
        const result = {
            postId: input.postId,
            eventId: input.eventId,
            kind: input.kind,
            applied: mutation.applied,
            radiusDeltaMeters: mutation.radiusDeltaMeters,
            counters: mutation.counters,
        };
        if (mutation.applied) {
            transaction.update(postRef, {
                ...mutation.postUpdate,
                lastEngagementAt: firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            // The pop's history, written with the change it records. A comment
            // after the first pays 0 m and moves nothing: it stays out of the
            // curve so the history is a line of changes, not a log of taps.
            if (mutation.counters.radiusMeters !== mutation.previous.radiusMeters) {
                transaction.create((0, radiusHistory_1.radiusHistoryRef)(postRef, postEngagementPolicy_1.radiusHistoryEntryId.engagement(eventRef.id)), (0, radiusHistory_1.radiusHistoryDocument)((0, postEngagementPolicy_1.buildRadiusHistoryEntry)({
                    atMillis: nowMillis,
                    cause: "engagement",
                    writer: "recordPostEngagement",
                    previous: mutation.previous,
                    next: mutation.counters,
                    seedRadiusMeters: mutation.radius.seed,
                    boostedRadiusMeters: mutation.radius.boost,
                    kind: input.kind,
                    engagementId: eventRef.id,
                })));
            }
        }
        const persistViewAt = mutation.nextViewAtMillis != null;
        const persistGrants = Object.keys(mutation.actorStateUpdate).length > 0;
        if (persistViewAt || persistGrants) {
            transaction.set(actorStateRef, {
                actorUid: uid,
                ...(persistViewAt
                    ? { lastViewAt: firestore_1.Timestamp.fromMillis(mutation.nextViewAtMillis) }
                    : {}),
                // What this account has already been paid for on this post. Written
                // in the same transaction as the counters, so a concurrent double-tap
                // cannot be granted twice.
                ...mutation.actorStateUpdate,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        transaction.create(eventRef, {
            actorUid: uid,
            actorHandle: actorHandle(actorSnapshot.data() ?? {}),
            postOwnerUid: ownerUid,
            clientEventId: input.eventId,
            kind: input.kind,
            applied: mutation.applied,
            radiusDeltaMeters: mutation.radiusDeltaMeters,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            result,
        });
        return { ...result, duplicate: false };
    });
});
