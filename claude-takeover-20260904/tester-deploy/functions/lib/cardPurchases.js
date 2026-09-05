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
exports.verifyCardPurchase = void 0;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const app_store_server_library_1 = require("@apple/app-store-server-library");
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
const googleapis_1 = require("googleapis");
const protectedRegion = "us-central1";
const iosBundleID = "com.apptist.Poplur2025";
const androidPackageName = "com.apptists.poplur2025";
const appleAppID = (0, params_1.defineString)("APPLE_APP_ID", {
    default: "",
    description: "The numeric App Store Connect Apple ID for com.apptist.Poplur2025.",
});
const cards = [
    {
        cardID: "inverted",
        iosProductID: "com.apptist.Poplur2025.card.inverted",
        androidProductID: "com.apptists.poplur2025.card.inverted",
        credits: 300,
    },
    {
        cardID: "lens",
        iosProductID: "com.apptist.Poplur2025.card.lens",
        androidProductID: "com.apptists.poplur2025.card.lens",
        credits: 550,
    },
    {
        cardID: "splitDiamond",
        iosProductID: "com.apptist.Poplur2025.card.splitdiamond",
        androidProductID: "com.apptists.poplur2025.card.splitdiamond",
        credits: 800,
    },
    {
        cardID: "swoosh",
        iosProductID: "com.apptist.Poplur2025.card.swoosh",
        androidProductID: "com.apptists.poplur2025.card.swoosh",
        credits: 1_200,
    },
];
const cardProducts = new Map(cards.flatMap(card => [
    [card.iosProductID, card],
    [card.androidProductID, card],
]));
/**
 * Verifies a StoreKit or Google Play transaction with the store, then grants
 * Poplur credits in one idempotent Admin SDK transaction. Clients never send
 * a credit amount and never write the protected balance or ledger themselves.
 */
exports.verifyCardPurchase = (0, https_1.onCall)({
    region: protectedRegion,
    enforceAppCheck: true,
    timeoutSeconds: 60,
    memory: "512MiB",
}, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "Sign in before purchasing Poplur credits.");
    }
    const platform = requiredString(request.data?.platform, "platform", 16);
    const claimedProductID = requiredString(request.data?.productId, "productId", 160);
    const product = cardProducts.get(claimedProductID);
    if (!product) {
        throw new https_1.HttpsError("invalid-argument", "This Poplur card product is not supported.");
    }
    try {
        const verified = platform === "ios"
            ? await verifyApplePurchase(uid, product, request.data)
            : platform === "android"
                ? await verifyGooglePlayPurchase(uid, product, request.data)
                : null;
        if (!verified) {
            throw new https_1.HttpsError("invalid-argument", "platform must be ios or android.");
        }
        const grant = await grantVerifiedPurchase(uid, verified);
        return {
            verified: true,
            alreadyGranted: grant.alreadyGranted,
            productId: platform === "ios" ? product.iosProductID : product.androidProductID,
            cardId: product.cardID,
            credits: product.credits,
            creditsAdded: grant.alreadyGranted ? 0 : product.credits,
            availableCredits: grant.availableCredits,
        };
    }
    catch (error) {
        if (error instanceof https_1.HttpsError)
            throw error;
        firebase_functions_1.logger.error("card_purchase_verification_failed", {
            platform,
            productID: claimedProductID,
            uidSuffix: uid.slice(-6),
            error: error instanceof Error ? error.message.slice(0, 240) : "unknown",
        });
        throw new https_1.HttpsError("failed-precondition", "The store could not verify this purchase. You have not been charged again; retry from your bag.");
    }
});
async function verifyApplePurchase(uid, product, data) {
    const body = objectValue(data);
    const signedTransaction = requiredString(body.signedTransaction, "signedTransaction", 30_000);
    const transaction = await decodeVerifiedAppleTransaction(signedTransaction);
    if (transaction.bundleId !== iosBundleID ||
        transaction.productId !== product.iosProductID ||
        transaction.type !== app_store_server_library_1.Type.CONSUMABLE ||
        (transaction.quantity ?? 1) !== 1 ||
        !transaction.transactionId ||
        !transaction.purchaseDate ||
        transaction.revocationDate !== undefined) {
        throw new https_1.HttpsError("failed-precondition", "The App Store transaction does not match this card.");
    }
    const expectedToken = storeKitAccountToken(uid);
    if (transaction.appAccountToken?.toLowerCase() !== expectedToken) {
        throw new https_1.HttpsError("permission-denied", "This purchase belongs to a different Poplur account.");
    }
    return {
        platform: "ios",
        product,
        receiptID: transaction.transactionId,
        accountBinding: expectedToken,
        purchasedAt: new Date(transaction.purchaseDate),
        environment: String(transaction.environment ?? "unknown"),
    };
}
async function decodeVerifiedAppleTransaction(signedTransaction) {
    const roots = appleRootCertificates();
    const sandboxVerifier = new app_store_server_library_1.SignedDataVerifier(roots, true, app_store_server_library_1.Environment.SANDBOX, iosBundleID);
    try {
        return await sandboxVerifier.verifyAndDecodeTransaction(signedTransaction);
    }
    catch (sandboxError) {
        const configuredAppID = Number.parseInt(appleAppID.value(), 10);
        if (!Number.isSafeInteger(configuredAppID) || configuredAppID <= 0) {
            firebase_functions_1.logger.warn("apple_production_verifier_not_configured", {
                sandboxError: sandboxError instanceof Error ? sandboxError.message : "verification failed",
            });
            throw new https_1.HttpsError("failed-precondition", "Production purchase verification is not configured yet.");
        }
        const productionVerifier = new app_store_server_library_1.SignedDataVerifier(roots, true, app_store_server_library_1.Environment.PRODUCTION, iosBundleID, configuredAppID);
        return productionVerifier.verifyAndDecodeTransaction(signedTransaction);
    }
}
async function verifyGooglePlayPurchase(uid, product, data) {
    const body = objectValue(data);
    const purchaseToken = requiredString(body.purchaseToken, "purchaseToken", 4_096);
    const auth = new googleapis_1.google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
    const publisher = googleapis_1.google.androidpublisher({ version: "v3", auth });
    const response = await publisher.purchases.products.get({
        packageName: androidPackageName,
        productId: product.androidProductID,
        token: purchaseToken,
    });
    const purchase = response.data;
    const expectedBinding = googlePlayAccountBinding(uid);
    const purchasedAtMillis = Number(purchase.purchaseTimeMillis);
    if (purchase.purchaseState !== 0 ||
        !Number.isFinite(purchasedAtMillis) ||
        purchasedAtMillis <= 0 ||
        (purchase.productId !== undefined && purchase.productId !== product.androidProductID) ||
        (purchase.quantity ?? 1) !== 1 ||
        (purchase.refundableQuantity ?? 1) < 1 ||
        purchase.obfuscatedExternalAccountId?.toLowerCase() !== expectedBinding) {
        throw new https_1.HttpsError("failed-precondition", "The Google Play purchase does not match this card.");
    }
    return {
        platform: "android",
        product,
        receiptID: purchaseToken,
        orderID: purchase.orderId ?? undefined,
        accountBinding: expectedBinding,
        purchasedAt: new Date(purchasedAtMillis),
        environment: purchase.purchaseType === 0 ? "test" : "production",
    };
}
async function grantVerifiedPurchase(uid, purchase) {
    const db = admin.firestore();
    const receiptFingerprint = sha256(`${purchase.platform}:${purchase.receiptID}`);
    const purchaseRef = db.collection("verifiedStorePurchases").doc(receiptFingerprint);
    const balanceRef = db.collection("creatorCreditBalances").doc(uid);
    const ledgerRef = db.collection("creatorCreditTransactions").doc(`store_${receiptFingerprint}`);
    return db.runTransaction(async (transaction) => {
        const [purchaseSnapshot, balanceSnapshot] = await Promise.all([
            transaction.get(purchaseRef),
            transaction.get(balanceRef),
        ]);
        const balance = balanceSnapshot.data() ?? {};
        const availableCredits = nonNegativeInteger(balance.availableCredits);
        if (purchaseSnapshot.exists) {
            const previous = purchaseSnapshot.data() ?? {};
            const platformProductID = purchase.platform === "ios"
                ? purchase.product.iosProductID
                : purchase.product.androidProductID;
            if (previous.userId !== uid || previous.productId !== platformProductID) {
                throw new https_1.HttpsError("permission-denied", "This store transaction was already claimed.");
            }
            return { alreadyGranted: true, availableCredits };
        }
        const newBalance = availableCredits + purchase.product.credits;
        transaction.set(balanceRef, {
            availableCredits: newBalance,
            lifetimeEarned: nonNegativeInteger(balance.lifetimeEarned) + purchase.product.credits,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.create(purchaseRef, {
            userId: uid,
            platform: purchase.platform,
            productId: purchase.platform === "ios"
                ? purchase.product.iosProductID
                : purchase.product.androidProductID,
            cardId: purchase.product.cardID,
            credits: purchase.product.credits,
            receiptFingerprint,
            orderId: purchase.orderID ?? null,
            accountBinding: purchase.accountBinding,
            environment: purchase.environment,
            purchasedAt: admin.firestore.Timestamp.fromDate(purchase.purchasedAt),
            grantedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        transaction.create(ledgerRef, {
            userId: uid,
            amount: purchase.product.credits,
            type: "store_card_purchase",
            platform: purchase.platform,
            productId: purchase.platform === "ios"
                ? purchase.product.iosProductID
                : purchase.product.androidProductID,
            cardId: purchase.product.cardID,
            verifiedPurchaseId: purchaseRef.id,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        });
        return { alreadyGranted: false, availableCredits: newBalance };
    });
}
function appleRootCertificates() {
    return ["AppleIncRootCertificate.cer", "AppleRootCA-G2.cer", "AppleRootCA-G3.cer"].map(file => (0, fs_1.readFileSync)((0, path_1.join)(__dirname, "apple-root-certificates", file)));
}
function storeKitAccountToken(uid) {
    const bytes = Buffer.from((0, crypto_1.createHash)("sha256").update(uid, "utf8").digest().subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function googlePlayAccountBinding(uid) {
    return sha256(uid);
}
function sha256(value) {
    return (0, crypto_1.createHash)("sha256").update(value, "utf8").digest("hex");
}
function requiredString(value, name, maxLength) {
    if (typeof value !== "string") {
        throw new https_1.HttpsError("invalid-argument", `${name} is required.`);
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength) {
        throw new https_1.HttpsError("invalid-argument", `${name} is invalid.`);
    }
    return trimmed;
}
function objectValue(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new https_1.HttpsError("invalid-argument", "Purchase data must be an object.");
    }
    return value;
}
function nonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
