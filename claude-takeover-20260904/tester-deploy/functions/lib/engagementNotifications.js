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
exports.notifyOnEngagement = void 0;
const admin = __importStar(require("firebase-admin"));
const firebase_functions_1 = require("firebase-functions");
const firestore_1 = require("firebase-functions/v2/firestore");
const firestore_2 = require("firebase-admin/firestore");
/**
 * Phase 3 of engagement push notifications: turn a new engagement document into
 * a banner on the post owner's devices.
 *
 * Triggered by `posts/{postId}/engagements/{engagementId}`. Tokens come from
 * `users/{uid}.fcmTokens`, written by PoplurMessaging on both platforms as a map
 * keyed by token, which is what lets a dead token be deleted here without a
 * read-modify-write race against a device registering at the same moment.
 */
// This module reaches for Firestore and Messaging at import time, and
// index.ts re-exports it — ES re-exports evaluate BEFORE the importing
// module's own body, so index's initializeApp() had not run yet and deploy
// analysis died with app/no-app. Guarded so it is safe wherever it loads
// first, and safe to call again.
if (admin.apps.length === 0)
    admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();
/** Likes inside this window collapse into one digest instead of one each. */
const LIKE_COALESCE_WINDOW_MS = 5 * 60 * 1000;
/**
 * Decides whether this engagement notifies, and with what copy.
 *
 * Views never notify. Instagram does not notify per view, and radius is the
 * product here -- a post reaching thousands of people is the GOAL, so per-view
 * notifications would scale exactly with success and turn the feature into a
 * pager. Views are still recorded and still appear in the in-app list; they
 * just do not light up the phone.
 *
 * Likes coalesce; comments never do. A comment is a conversation and a delayed
 * one reads as broken, whereas a like is an applause count and reads fine
 * summarised.
 */
async function resolveNotification(postId, engagement) {
    const handle = engagement.actorHandle?.trim() || "Someone";
    if (engagement.kind === "view" || engagement.kind === "dislike")
        return null;
    if (engagement.kind === "comment") {
        const comment = engagement.body?.trim();
        return {
            title: `${handle} commented`,
            body: comment && comment.length > 0 ? comment : "commented on your post",
        };
    }
    if (engagement.kind !== "like")
        return null;
    // Coalescing state lives on the post so the trigger needs one document, and
    // the transaction makes concurrent likes safe: two arriving at once cannot
    // both decide they are the first in the window.
    const postRef = db.collection("posts").doc(postId);
    const decision = await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(postRef);
        const data = snapshot.data() ?? {};
        const lastNotifyAt = data.likeNotifyAt ?? 0;
        const pending = data.likesPendingNotify ?? 0;
        const now = Date.now();
        if (now - lastNotifyAt >= LIKE_COALESCE_WINDOW_MS) {
            // Window is open. Send now, and carry any likes that accumulated while it
            // was closed -- this is also what flushes them, so no scheduled function
            // is needed to drain the backlog.
            tx.set(postRef, { likeNotifyAt: now, likesPendingNotify: 0 }, { merge: true });
            return { send: true, alsoPending: pending };
        }
        tx.set(postRef, { likesPendingNotify: firestore_2.FieldValue.increment(1) }, { merge: true });
        return { send: false, alsoPending: 0 };
    });
    if (!decision.send)
        return null;
    if (decision.alsoPending > 0) {
        return {
            title: "Your post is popping",
            body: `${handle} and ${decision.alsoPending} other${decision.alsoPending === 1 ? "" : "s"} liked your post`,
        };
    }
    return { title: `${handle} liked your post`, body: "Tap to see it" };
}
exports.notifyOnEngagement = (0, firestore_1.onDocumentCreated)({
    document: "posts/{postId}/engagements/{engagementId}",
    region: "us-central1",
}, async (event) => {
    const engagement = event.data?.data();
    if (!engagement || engagement.applied === false)
        return;
    const { postId, engagementId } = event.params;
    const ownerUid = engagement.postOwnerUid;
    if (!ownerUid) {
        firebase_functions_1.logger.warn("engagement has no postOwnerUid", { postId, engagementId });
        return;
    }
    // Never notify someone about their own action on their own post.
    if (engagement.actorUid === ownerUid)
        return;
    // The inbox is the durable source of truth. Write every engagement first,
    // including views (which intentionally do not produce a push), so opening
    // Notifications after a cold launch or on a second device reconstructs the
    // same history instead of depending on which banners this device saw.
    const notificationId = `engagement:${postId}:${engagementId}`;
    const actorHandle = engagement.actorHandle?.trim() || "Someone";
    const inboxDetail = engagement.kind === "comment"
        ? (engagement.body?.trim() || "commented on your post")
        : engagement.kind === "view"
            ? "viewed your post"
            : engagement.kind === "dislike"
                ? "disliked your post"
                : "liked your post";
    await db.collection("users").doc(ownerUid)
        .collection("notifications").doc(notificationId)
        .set({
        id: notificationId,
        kind: engagement.kind ?? "like",
        actorUid: engagement.actorUid ?? "",
        actorHandle,
        title: actorHandle,
        detail: inboxDetail,
        createdAt: firestore_2.FieldValue.serverTimestamp(),
        isUnread: true,
        isDismissed: false,
        postId,
        engagementId,
    }, { merge: true });
    const notification = await resolveNotification(postId, engagement);
    if (!notification)
        return; // a view, or a like inside the coalesce window
    const userSnapshot = await db.collection("users").doc(ownerUid).get();
    const tokenMap = (userSnapshot.data()?.fcmTokens ?? {});
    const tokens = Object.keys(tokenMap);
    if (tokens.length === 0) {
        firebase_functions_1.logger.info("no registered devices for owner", { ownerUid, postId });
        return;
    }
    const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: notification.title, body: notification.body },
        data: {
            // Everything the client needs to open the post with the engagement lit,
            // and to build the matching in-app row. All values must be strings.
            postId,
            engagementId,
            notificationId,
            kind: engagement.kind ?? "",
            actorHandle: engagement.actorHandle ?? "",
        },
        apns: {
            payload: {
                aps: {
                    // One thread per post, so many engagements on the same post group
                    // in Notification Center instead of stacking as unrelated banners.
                    "thread-id": postId,
                    sound: "default",
                },
            },
        },
        android: {
            priority: "high",
            notification: {
                channelId: "poplur_alerts",
                tag: postId,
            },
        },
    });
    // Prune tokens FCM says are dead. Deleting by key needs no read and cannot
    // clobber a token another device registered a moment ago -- the reason the
    // map is keyed by token rather than being an array.
    const dead = [];
    response.responses.forEach((result, index) => {
        const code = result.error?.code;
        if (code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token") {
            dead.push(tokens[index]);
        }
    });
    if (dead.length > 0) {
        const updates = {};
        dead.forEach((token) => {
            updates[`fcmTokens.${token}`] = firestore_2.FieldValue.delete();
        });
        await db.collection("users").doc(ownerUid).update(updates);
    }
    firebase_functions_1.logger.info("engagement notification sent", {
        postId,
        engagementId,
        kind: engagement.kind,
        sent: response.successCount,
        failed: response.failureCount,
        pruned: dead.length,
    });
});
