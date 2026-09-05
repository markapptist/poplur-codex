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
exports.notifyOnDirectMessage = void 0;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const firestore_2 = require("firebase-functions/v2/firestore");
if (admin.apps.length === 0)
    admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();
function preview(message) {
    if (message.kind === "image")
        return "Sent a photo";
    if (message.kind === "video")
        return "Sent a video";
    if (message.kind === "audio")
        return "Sent a voice message";
    const sticker = /^\[\[poplur:sticker:([a-z]+)\]\]$/.exec(message.text?.trim() ?? "");
    if (sticker)
        return "Sent a Poplur sticker";
    const text = message.text?.trim() ?? "";
    return text.length > 140 ? `${text.slice(0, 137)}…` : text || "Sent a message";
}
exports.notifyOnDirectMessage = (0, firestore_2.onDocumentCreated)({
    document: "dmThreads/{threadId}/messages/{messageId}",
    region: "us-central1",
}, async (event) => {
    const message = event.data?.data();
    const senderId = message?.senderId;
    if (!message || !senderId)
        return;
    const { threadId, messageId } = event.params;
    const threadSnapshot = await db.collection("dmThreads").doc(threadId).get();
    const thread = threadSnapshot.data();
    const participants = Array.isArray(thread?.participants)
        ? thread.participants.filter((value) => typeof value === "string")
        : [];
    const recipientId = participants.find((uid) => uid !== senderId);
    if (!recipientId || !participants.includes(senderId)) {
        firebase_functions_1.logger.warn("DM notification has no valid recipient", { threadId, messageId, senderId });
        return;
    }
    const [senderSnapshot, recipientSnapshot] = await Promise.all([
        db.collection("users").doc(senderId).get(),
        db.collection("users").doc(recipientId).get(),
    ]);
    const sender = senderSnapshot.data() ?? {};
    const participantNames = thread?.participantNames;
    const senderName = (typeof participantNames?.[senderId] === "string" && participantNames[senderId])
        || (typeof sender.username === "string" && sender.username)
        || (typeof sender.displayName === "string" && sender.displayName)
        || "Someone on Poplur";
    const tokenMap = (recipientSnapshot.data()?.fcmTokens ?? {});
    const notificationId = `dm:${threadId}:${messageId}`;
    const messagePreview = preview(message);
    // Persist before checking for a device token. A person with notifications
    // disabled—or no registered phone yet—still owns a complete in-app inbox
    // when they next sign in.
    await db.collection("users").doc(recipientId)
        .collection("notifications").doc(notificationId)
        .set({
        id: notificationId,
        kind: "dm",
        actorUid: senderId,
        actorHandle: String(senderName),
        title: String(senderName),
        detail: messagePreview,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
        isUnread: true,
        isDismissed: false,
        threadId,
        messageId,
    }, { merge: true });
    const tokens = Object.keys(tokenMap);
    if (tokens.length === 0) {
        firebase_functions_1.logger.info("DM recipient has no registered devices", { threadId, messageId, recipientId });
        return;
    }
    const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: String(senderName), body: messagePreview },
        data: {
            kind: "dm",
            threadId,
            messageId,
            senderId,
            notificationId,
        },
        apns: {
            payload: {
                aps: {
                    "thread-id": threadId,
                    sound: "default",
                },
            },
        },
        android: {
            priority: "high",
            notification: {
                channelId: "poplur_alerts",
                tag: threadId,
                clickAction: "com.apptists.poplur2025.OPEN_DM",
            },
        },
    });
    const dead = [];
    response.responses.forEach((result, index) => {
        const code = result.error?.code;
        if (code === "messaging/registration-token-not-registered"
            || code === "messaging/invalid-registration-token") {
            dead.push(tokens[index]);
        }
    });
    if (dead.length > 0) {
        const updates = {};
        dead.forEach((token) => { updates[`fcmTokens.${token}`] = firestore_1.FieldValue.delete(); });
        await db.collection("users").doc(recipientId).update(updates);
    }
    firebase_functions_1.logger.info("DM notification sent", {
        threadId,
        messageId,
        recipientId,
        sent: response.successCount,
        failed: response.failureCount,
        pruned: dead.length,
    });
});
