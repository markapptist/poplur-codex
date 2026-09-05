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
exports.setAccountLocationPrivacy = void 0;
const admin = __importStar(require("firebase-admin"));
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
if (admin.apps.length === 0)
    admin.initializeApp();
const db = admin.firestore();
const region = "us-central1";
const MIGRATION_CHUNK = 200;
// Version 2 retires the legacy public `lat`/`lng` aliases as well as the
// current latitude/longitude fields. Bumping forces accounts already marked
// migrated by v1 to receive the stronger cleanup on their next privacy save.
const PRIVACY_SCHEMA_VERSION = 2;
function finiteCoordinate(value, limit) {
    const numberValue = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numberValue) && Math.abs(numberValue) <= limit ? numberValue : null;
}
function publicCell(value) {
    return Math.round(value * 1_000);
}
function coordinatePair(latitudeValue, longitudeValue) {
    const latitude = finiteCoordinate(latitudeValue, 90);
    const longitude = finiteCoordinate(longitudeValue, 180);
    return latitude != null && longitude != null ? { latitude, longitude } : null;
}
function chunks(values, size) {
    const result = [];
    for (let index = 0; index < values.length; index += size) {
        result.push(values.slice(index, index + size));
    }
    return result;
}
/**
 * Account privacy changes also migrate existing posts. Firestore cannot hide
 * selected fields from a publicly readable document, so coordinates are
 * physically moved into the owner's protected postLocations collection.
 */
exports.setAccountLocationPrivacy = (0, https_1.onCall)({ region, timeoutSeconds: 120, memory: "256MiB" }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Sign in to change privacy.");
    if (typeof request.data?.privateAccount !== "boolean"
        || typeof request.data?.ghostMode !== "boolean") {
        throw new https_1.HttpsError("invalid-argument", "Private Account and Ghost Mode must be true or false.");
    }
    const privateAccount = request.data.privateAccount;
    const ghostMode = request.data.ghostMode;
    const hideOrigin = privateAccount || ghostMode;
    const userRef = db.collection("users").doc(uid);
    const currentAccount = (await userRef.get()).data();
    if (currentAccount?.locationPrivacySchemaVersion === PRIVACY_SCHEMA_VERSION
        && currentAccount?.privateAccount === privateAccount
        && currentAccount?.ghostMode === ghostMode) {
        return { privateAccount, ghostMode, migratedPosts: 0 };
    }
    // Setting the hiding flags first makes every new publisher choose the
    // hidden contract while legacy rows are being migrated.
    if (hideOrigin) {
        await userRef.set({
            privateAccount,
            ghostMode,
            accountPrivacyUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
    }
    const [canonical, legacy] = await Promise.all([
        db.collection("posts").where("userID", "==", uid).get(),
        db.collection("posts").where("userId", "==", uid).get(),
    ]);
    const posts = new Map();
    canonical.docs.forEach((document) => posts.set(document.id, document));
    legacy.docs.forEach((document) => posts.set(document.id, document));
    const documents = [...posts.values()];
    if (hideOrigin) {
        for (const group of chunks(documents, MIGRATION_CHUNK)) {
            const batch = db.batch();
            for (const document of group) {
                const data = document.data();
                // Never combine one coordinate from the modern pair with the other
                // from the legacy pair: only a complete, validated pair is an origin.
                const origin = coordinatePair(data.latitude, data.longitude)
                    ?? coordinatePair(data.lat, data.lng);
                if (origin) {
                    batch.set(userRef.collection("postLocations").doc(document.id), {
                        latitude: origin.latitude,
                        longitude: origin.longitude,
                        updatedAt: firestore_1.FieldValue.serverTimestamp(),
                        source: "legacy-public-migration",
                    }, { merge: true });
                }
                batch.update(document.ref, {
                    latitude: firestore_1.FieldValue.delete(),
                    longitude: firestore_1.FieldValue.delete(),
                    latitudeCell: firestore_1.FieldValue.delete(),
                    longitudeCell: firestore_1.FieldValue.delete(),
                    lat: firestore_1.FieldValue.delete(),
                    lng: firestore_1.FieldValue.delete(),
                    locationVisibility: "hidden",
                    originHiddenByPrivateAccount: privateAccount,
                    originHiddenByGhostMode: ghostMode,
                });
            }
            await batch.commit();
        }
    }
    else {
        for (const group of chunks(documents, MIGRATION_CHUNK)) {
            const locationRefs = group.map((document) => userRef.collection("postLocations").doc(document.id));
            const locations = locationRefs.length > 0 ? await db.getAll(...locationRefs) : [];
            const batch = db.batch();
            let writes = 0;
            group.forEach((document, index) => {
                const location = locations[index]?.data();
                const post = document.data();
                const protectedOrigin = coordinatePair(location?.latitude, location?.longitude);
                const origin = protectedOrigin
                    ?? coordinatePair(post.latitude, post.longitude)
                    ?? coordinatePair(post.lat, post.lng);
                if (!origin) {
                    // No valid origin can be restored, but v2 still removes deprecated
                    // aliases and any partial modern pair so no coordinate can linger
                    // on a post that must remain hidden.
                    batch.update(document.ref, {
                        latitude: firestore_1.FieldValue.delete(),
                        longitude: firestore_1.FieldValue.delete(),
                        latitudeCell: firestore_1.FieldValue.delete(),
                        longitudeCell: firestore_1.FieldValue.delete(),
                        lat: firestore_1.FieldValue.delete(),
                        lng: firestore_1.FieldValue.delete(),
                        locationVisibility: "hidden",
                        originHiddenByPrivateAccount: firestore_1.FieldValue.delete(),
                        originHiddenByGhostMode: firestore_1.FieldValue.delete(),
                    });
                    writes += 1;
                    return;
                }
                const { latitude, longitude } = origin;
                const latitudeCell = publicCell(latitude);
                const longitudeCell = publicCell(longitude);
                if (!protectedOrigin) {
                    batch.set(locationRefs[index], {
                        latitude,
                        longitude,
                        updatedAt: firestore_1.FieldValue.serverTimestamp(),
                        source: "legacy-public-migration",
                    }, { merge: true });
                    writes += 1;
                }
                batch.update(document.ref, {
                    latitude: latitudeCell / 1_000,
                    longitude: longitudeCell / 1_000,
                    latitudeCell,
                    longitudeCell,
                    lat: firestore_1.FieldValue.delete(),
                    lng: firestore_1.FieldValue.delete(),
                    locationVisibility: "approximate",
                    originHiddenByPrivateAccount: firestore_1.FieldValue.delete(),
                    originHiddenByGhostMode: firestore_1.FieldValue.delete(),
                });
                writes += 1;
            });
            if (writes > 0)
                await batch.commit();
        }
        await userRef.set({
            privateAccount: false,
            ghostMode: false,
            accountPrivacyUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
    }
    await userRef.set({ locationPrivacySchemaVersion: PRIVACY_SCHEMA_VERSION }, { merge: true });
    return { privateAccount, ghostMode, migratedPosts: documents.length };
});
