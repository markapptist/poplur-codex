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
exports.testActivityControl = exports.TEST_ACTIVITY_SCREEN_IDS = void 0;
exports.privacySafeTestActivityHeartbeat = privacySafeTestActivityHeartbeat;
const admin = __importStar(require("firebase-admin"));
const node_crypto_1 = require("node:crypto");
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const params_1 = require("firebase-functions/params");
const syntheticBetaCohort_1 = require("./syntheticBetaCohort");
const syntheticBrowserRunner_1 = require("./syntheticBrowserRunner");
/**
 * Privacy-safe, opt-in operations telemetry for the September test cohort.
 *
 * This is intentionally a closed-beta operations feed, not general product
 * analytics. It never accepts message text, media, raw coordinates, contacts,
 * camera or microphone data. Map reporting is deliberately limited to a
 * coarse, user-visible city/region label. Each row carries a 14-day
 * `expiresAt` field enforced by the production Firestore TTL policy; the
 * dashboard is further restricted to the two retained production-test
 * administrators.
 */
const REGION = "us-central1";
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const BETA_DESK_ACCESS_TOKEN = (0, params_1.defineSecret)("BETA_DESK_ACCESS_TOKEN");
const BETA_DESK_OPERATOR_UID = "LiEG6SNtKEZN6eEGeybf0afZnHm1";
const TEST_ADMIN_UIDS = new Set([
    "LiEG6SNtKEZN6eEGeybf0afZnHm1", // testcall@poplur.com
    "eoP2Z0ElxIa0Eua7xpFxNlr6tur1", // mark@apptist.ca
]);
exports.TEST_ACTIVITY_SCREEN_IDS = Object.freeze([
    "home", "map", "feed", "camera", "camera-roll", "profile", "hold-menu",
    "upload-flows", "arcade", "games", "battle", "map-radio", "feed-news",
    "map-conquer", "map-directions", "map-ipod", "map-show-me",
    "feed-apps", "feed-browser", "feed-casino", "feed-games", "feed-tvguide",
    "camera-ai-chat", "camera-studio",
    "profile-avatar", "profile-house", "profile-messages", "profile-notifications",
    "profile-phone", "profile-settings", "profile-stats", "profile-store",
    "profile-trophies", "profile-wallet", "profile-wardrobe",
]);
const SCREENS = new Set(exports.TEST_ACTIVITY_SCREEN_IDS);
const STATUSES = new Set(["foreground", "background"]);
const PLATFORMS = new Set(["native", "browser"]);
const EVENT_KINDS = new Set(["posted", "like", "view", "comment", "radius-up", "radius-down"]);
const FEEDBACK_LIMIT = 1_200;
const ACTIVITY_LIMIT = 100;
const POST_LIMIT = 120;
const FEEDBACK_LIST_LIMIT = 80;
function db() {
    if (!admin.apps.length)
        admin.initializeApp();
    return admin.firestore();
}
function requireSignedIn(uid) {
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Sign in to use the Test Control Center.");
    return uid;
}
function requireAdmin(uid) {
    if (!TEST_ADMIN_UIDS.has(uid)) {
        throw new https_1.HttpsError("permission-denied", "This private tester dashboard is restricted.");
    }
}
/** A local owner-only proxy presents this value; it never reaches browser JS. */
function hasValidDeskCredential(value) {
    const supplied = typeof value === "string" ? value.trim() : "";
    const expected = BETA_DESK_ACCESS_TOKEN.value();
    if (!supplied || !expected || supplied.length !== expected.length)
        return false;
    return (0, node_crypto_1.timingSafeEqual)(Buffer.from(supplied), Buffer.from(expected));
}
function enumValue(value, allowed, fallback) {
    return typeof value === "string" && allowed.has(value) ? value : fallback;
}
function appVersion(value) {
    return typeof value === "string" && /^\d+\.\d+(?:\.\d+)?$/.test(value)
        ? value.slice(0, 24)
        : "0.1.0";
}
/**
 * Copy only the bounded presence fields accepted by a heartbeat. Keeping this
 * as a positive projection means extra request fields (including content,
 * coordinates, media/input, and mic/camera state) can never reach Firestore.
 */
function privacySafeTestActivityHeartbeat(data) {
    return {
        screen: enumValue(data.screen, SCREENS, "home"),
        status: enumValue(data.status, STATUSES, "foreground"),
        platform: enumValue(data.platform, PLATFORMS, "browser"),
        appVersion: appVersion(data.appVersion),
    };
}
function text(value, maxLength) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}
function safeMetric(value, minimum, maximum, fallback = 0) {
    const metric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(metric) ? Math.max(minimum, Math.min(maximum, metric)) : fallback;
}
function safeKey(value) {
    return text(value, 80).replace(/[^a-zA-Z0-9_-]/g, "_") || "untitled";
}
function timestampMs(value) {
    return value && typeof value.toMillis === "function"
        ? value.toMillis()
        : 0;
}
function activeConsent(profile) {
    return profile?.testActivityConsent === true;
}
async function clearTelemetryForUser(uid) {
    const posts = await db().collection("testBetaPosts").where("uid", "==", uid).limit(POST_LIMIT).get();
    const batch = db().batch();
    posts.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(db().collection("testActivity").doc(uid));
    await batch.commit();
}
function labelFor(uid, profile, authName) {
    const username = typeof profile?.username === "string" ? profile.username.trim().replace(/^@/, "") : "";
    if (username)
        return `@${username.slice(0, 40)}`;
    const name = typeof authName === "string" ? authName.trim() : "";
    if (name)
        return name.slice(0, 50);
    return `Tester ${uid.slice(-4)}`;
}
function currentRunnerRuntime(data, generation) {
    if (data?.source !== "synthetic-browser"
        || data?.cohortId !== syntheticBetaCohort_1.SYNTHETIC_BETA_COHORT_ID
        || data.generation !== generation
        || !Array.isArray(data.recentEvents)
        || !Array.isArray(data.sessions)
        || !data.analytics)
        return undefined;
    return data;
}
function runnerGeneration(data) {
    return Number.isSafeInteger(data?.generation) && data.generation > 0 ? data.generation : 0;
}
function publicRunnerActors(data) {
    if (!Array.isArray(data?.actors))
        return [];
    return data.actors
        .map((actor) => {
        if (!actor || typeof actor !== "object")
            return null;
        const value = actor;
        const actorId = text(value.actorId, 80);
        if (!(0, syntheticBetaCohort_1.syntheticProfile)(actorId))
            return null;
        return {
            actorId,
            active: value.active === true,
        };
    })
        .filter((actor) => actor !== null);
}
async function setRunnerEnabled(enabled, updatedBy) {
    const configRef = db().collection("testControl").doc(syntheticBrowserRunner_1.SYNTHETIC_RUNNER_CONFIG_DOC);
    return db().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(configRef);
        const previousEnabled = snapshot.data()?.enabled === true;
        const previousGeneration = runnerGeneration(snapshot.data());
        const generation = enabled && !previousEnabled ? previousGeneration + 1 : previousGeneration;
        transaction.set(configRef, {
            enabled,
            generation,
            cohortId: syntheticBetaCohort_1.SYNTHETIC_BETA_COHORT_ID,
            actors: publicRunnerActors(snapshot.data()),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
            updatedBy,
        }, { merge: true });
        return { enabled, generation };
    });
}
async function setRunnerActor(actorId, runnerUid, active, updatedBy) {
    const profile = (0, syntheticBetaCohort_1.syntheticProfile)(actorId);
    if (!profile)
        throw new https_1.HttpsError("invalid-argument", "Runner actor is outside the fixed cohort.");
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(runnerUid)) {
        throw new https_1.HttpsError("invalid-argument", "Runner Firebase UID is invalid.");
    }
    const configRef = db().collection("testControl").doc(syntheticBrowserRunner_1.SYNTHETIC_RUNNER_CONFIG_DOC);
    const user = await admin.auth().getUser(runnerUid);
    const claims = { ...(user.customClaims ?? {}) };
    if (active) {
        claims.syntheticBeta = true;
        claims.syntheticActorId = actorId;
    }
    else {
        delete claims.syntheticBeta;
        delete claims.syntheticActorId;
    }
    await admin.auth().setCustomUserClaims(runnerUid, claims);
    const actorRef = db().collection(syntheticBrowserRunner_1.SYNTHETIC_RUNNER_ACTOR_COLLECTION).doc(actorId);
    return db().runTransaction(async (transaction) => {
        const configSnapshot = await transaction.get(configRef);
        const generation = runnerGeneration(configSnapshot.data());
        const actors = publicRunnerActors(configSnapshot.data()).filter(actor => actor.actorId !== actorId);
        actors.push({ actorId, active });
        transaction.set(actorRef, {
            actorId,
            uid: runnerUid,
            active,
            source: "synthetic-browser",
            cohortId: syntheticBetaCohort_1.SYNTHETIC_BETA_COHORT_ID,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
            updatedBy,
        });
        transaction.set(configRef, {
            ...(configSnapshot.exists ? {} : {
                enabled: false,
                generation: 0,
                cohortId: syntheticBetaCohort_1.SYNTHETIC_BETA_COHORT_ID,
            }),
            actors,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
            updatedBy,
        }, { merge: true });
        return { actorId, active, generation };
    });
}
exports.testActivityControl = (0, https_1.onCall)({ region: REGION, secrets: [BETA_DESK_ACCESS_TOKEN] }, async (request) => {
    const action = request.data?.action;
    const operatorAction = action === "dashboard"
        || action === "simulation"
        || action === "simulationStep"
        || action === "simulationPulse"
        || action === "runner"
        || action === "runnerActor";
    const hasDeskAccess = hasValidDeskCredential(request.data?.accessCode)
        || (typeof request.auth?.uid === "string" && TEST_ADMIN_UIDS.has(request.auth.uid));
    const uid = request.auth?.uid
        ?? (operatorAction && hasDeskAccess ? BETA_DESK_OPERATOR_UID : requireSignedIn(request.auth?.uid));
    if (action === "setConsent") {
        const enabled = request.data?.enabled === true;
        const user = db().collection("users").doc(uid);
        await user.set({
            testActivityConsent: enabled,
            testActivityConsentUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (!enabled)
            await clearTelemetryForUser(uid);
        return { enabled };
    }
    if (action === "getConsent") {
        const profile = await db().collection("users").doc(uid).get();
        return { enabled: profile.data()?.testActivityConsent === true };
    }
    if (action === "heartbeat") {
        const user = db().collection("users").doc(uid);
        const profile = await user.get();
        if (!activeConsent(profile.data())) {
            throw new https_1.HttpsError("failed-precondition", "Test activity sharing is turned off.");
        }
        const now = Date.now();
        const heartbeat = privacySafeTestActivityHeartbeat(request.data ?? {});
        await db().collection("testActivity").doc(uid).set({
            label: labelFor(uid, profile.data(), request.auth?.token.name),
            ...heartbeat,
            lastActivityAt: firestore_1.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromMillis(now + RETENTION_MS),
        }, { merge: true });
        return { accepted: true };
    }
    if (action === "post") {
        const profile = await db().collection("users").doc(uid).get();
        if (!activeConsent(profile.data())) {
            throw new https_1.HttpsError("failed-precondition", "Closed-beta analytics sharing is turned off.");
        }
        const now = Date.now();
        const postKey = safeKey(request.data?.postKey);
        const place = text(request.data?.place, 64) || "Private beta region";
        const radiusKm = safeMetric(request.data?.radiusKm, 0, 20_000);
        const id = `${uid}_${postKey}`;
        await db().collection("testBetaPosts").doc(id).set({
            uid,
            label: labelFor(uid, profile.data(), request.auth?.token.name),
            place,
            postKey,
            initialRadiusKm: radiusKm,
            radiusKm,
            radiusDeltaKm: 0,
            viralScore: 0,
            postedAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromMillis(now + RETENTION_MS),
        }, { merge: true });
        return { accepted: true };
    }
    if (action === "radius") {
        const profile = await db().collection("users").doc(uid).get();
        if (!activeConsent(profile.data())) {
            throw new https_1.HttpsError("failed-precondition", "Closed-beta analytics sharing is turned off.");
        }
        const now = Date.now();
        const postKey = safeKey(request.data?.postKey);
        const radiusKm = safeMetric(request.data?.radiusKm, 0, 20_000);
        const deltaKm = safeMetric(request.data?.deltaKm, -2_000, 2_000);
        const signal = text(request.data?.signal, 24);
        const ref = db().collection("testBetaPosts").doc(`${uid}_${postKey}`);
        const current = await ref.get();
        const previous = current.data();
        const previousScore = safeMetric(previous?.viralScore, 0, 1_000_000);
        const scoreDelta = signal === "comment" ? 3 : signal === "like" ? 2 : signal === "view" ? 1 : Math.abs(deltaKm) >= 2 ? 2 : 1;
        await ref.set({
            uid,
            label: labelFor(uid, profile.data(), request.auth?.token.name),
            place: text(previous?.place, 64) || "Private beta region",
            postKey,
            initialRadiusKm: safeMetric(previous?.initialRadiusKm, 0, 20_000, radiusKm),
            radiusKm,
            radiusDeltaKm: safeMetric(previous?.radiusDeltaKm, -20_000, 20_000) + deltaKm,
            viralScore: previousScore + scoreDelta,
            postedAt: previous?.postedAt ?? firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromMillis(now + RETENTION_MS),
        }, { merge: true });
        return { accepted: true };
    }
    if (action === "feedback") {
        const finding = text(request.data?.finding, FEEDBACK_LIMIT);
        const liked = text(request.data?.liked, FEEDBACK_LIMIT);
        const improve = text(request.data?.improve, FEEDBACK_LIMIT);
        if (!finding && !liked && !improve) {
            throw new https_1.HttpsError("invalid-argument", "Add a finding, a positive, or an improvement idea.");
        }
        const profile = await db().collection("users").doc(uid).get();
        const now = Date.now();
        await db().collection("testFeedback").add({
            uid,
            label: labelFor(uid, profile.data(), request.auth?.token.name),
            finding,
            liked,
            improve,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromMillis(now + RETENTION_MS),
        });
        return { accepted: true };
    }
    if (action === "simulation") {
        const config = db().collection("testControl").doc("simulation");
        if (typeof request.data?.enabled === "boolean") {
            requireAdmin(uid);
            await config.set({
                enabled: request.data.enabled,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
                updatedBy: uid,
            }, { merge: true });
        }
        const snapshot = await config.get();
        return { enabled: snapshot.data()?.enabled === true };
    }
    if (action === "simulationStep") {
        requireAdmin(uid);
        return { accepted: false, enabled: false, event: null, reason: "browser-runner-required" };
    }
    if (action === "simulationFeed") {
        return { enabled: false, events: [], reason: "runner-events-are-private" };
    }
    if (action === "simulationPulse") {
        requireAdmin(uid);
        return { accepted: false, enabled: false, event: null, reason: "browser-runner-required" };
    }
    if (action === "runner") {
        requireAdmin(uid);
        if (typeof request.data?.enabled === "boolean") {
            await setRunnerEnabled(request.data.enabled, uid);
        }
        const snapshot = await db().collection("testControl").doc(syntheticBrowserRunner_1.SYNTHETIC_RUNNER_CONFIG_DOC).get();
        return {
            enabled: snapshot.data()?.enabled === true,
            generation: runnerGeneration(snapshot.data()),
            actors: publicRunnerActors(snapshot.data()),
        };
    }
    if (action === "runnerActor") {
        requireAdmin(uid);
        const actorId = text(request.data?.actorId, 80);
        const runnerUid = text(request.data?.uid, 128);
        if (typeof request.data?.active !== "boolean") {
            throw new https_1.HttpsError("invalid-argument", "Runner actor active state is required.");
        }
        return setRunnerActor(actorId, runnerUid, request.data.active, uid);
    }
    if (action === "dashboard") {
        requireAdmin(uid);
        const now = Date.now();
        const [activitySnapshot, postSnapshot, feedbackSnapshot, runtimeSnapshot, runnerConfigSnapshot, simulationConfigSnapshot] = await Promise.all([
            db().collection("testActivity").orderBy("lastActivityAt", "desc").limit(ACTIVITY_LIMIT).get(),
            db().collection("testBetaPosts").orderBy("updatedAt", "desc").limit(POST_LIMIT).get(),
            db().collection("testFeedback").orderBy("createdAt", "desc").limit(FEEDBACK_LIST_LIMIT).get(),
            db().collection("testControl").doc(syntheticBrowserRunner_1.SYNTHETIC_RUNNER_RUNTIME_DOC).get(),
            db().collection("testControl").doc(syntheticBrowserRunner_1.SYNTHETIC_RUNNER_CONFIG_DOC).get(),
            db().collection("testControl").doc("simulation").get(),
        ]);
        const posts = postSnapshot.docs.map(doc => {
            const post = doc.data();
            const postedAtMs = timestampMs(post.postedAt);
            const updatedAtMs = timestampMs(post.updatedAt);
            const elapsedHours = Math.max((now - (postedAtMs || now)) / 3_600_000, 0.1);
            const viralScore = safeMetric(post.viralScore, 0, 1_000_000);
            return {
                id: doc.id,
                label: text(post.label, 50) || "Tester",
                place: text(post.place, 64) || "Private beta region",
                postedAtMs,
                updatedAtMs,
                initialRadiusKm: safeMetric(post.initialRadiusKm, 0, 20_000),
                radiusKm: safeMetric(post.radiusKm, 0, 20_000),
                radiusDeltaKm: safeMetric(post.radiusDeltaKm, -20_000, 20_000),
                viralScore,
                viralPerHour: Math.round((viralScore / elapsedHours) * 10) / 10,
            };
        });
        const simulationEnabled = simulationConfigSnapshot.data()?.enabled === true;
        const runnerEnabled = runnerConfigSnapshot.data()?.enabled === true;
        const runnerGenerationValue = runnerGeneration(runnerConfigSnapshot.data());
        const runtime = currentRunnerRuntime(runtimeSnapshot.data(), runnerGenerationValue)
            ?? (0, syntheticBetaCohort_1.emptySyntheticBrowserRuntime)(runnerGenerationValue, now);
        const runnerEvents = [...runtime.recentEvents]
            .sort((a, b) => b.eventAtMs - a.eventAtMs)
            .map(event => ({ id: event.eventId, ...event }));
        const actorStates = new Map(publicRunnerActors(runnerConfigSnapshot.data()).map(actor => [actor.actorId, actor]));
        const sessionStates = new Map(runtime.sessions.map(session => [session.actorId, session]));
        const runnerActors = syntheticBetaCohort_1.SYNTHETIC_BETA_PROFILES.map(profile => {
            const allowlist = actorStates.get(profile.id);
            const session = sessionStates.get(profile.id);
            const active = allowlist?.active === true;
            return {
                id: profile.id,
                actorId: profile.id,
                label: profile.label,
                handle: profile.handle,
                persona: profile.persona,
                place: profile.place,
                avatarTile: profile.avatarTile,
                active,
                state: !runnerEnabled ? "paused" : session?.status === "live" ? "live" : active ? "ready" : "not-allowlisted",
                generation: runnerGenerationValue,
                source: profile.source,
                cohortId: profile.cohortId,
            };
        });
        const map = new Map();
        [
            ...posts.map(post => ({ place: post.place, at: post.updatedAtMs, radiusKm: post.radiusKm, velocity: post.viralPerHour, source: "real" })),
            ...runnerEvents.map(event => ({ place: event.place, at: event.eventAtMs, radiusKm: 0, velocity: 1, source: "synthetic" })),
        ]
            .forEach(event => {
            const previous = map.get(event.place) ?? {
                place: event.place,
                events: 0,
                realEvents: 0,
                syntheticEvents: 0,
                latestAtMs: 0,
                peakRadiusKm: 0,
                velocity: 0,
            };
            map.set(event.place, {
                place: event.place,
                events: previous.events + 1,
                realEvents: previous.realEvents + (event.source === "real" ? 1 : 0),
                syntheticEvents: previous.syntheticEvents + (event.source === "synthetic" ? 1 : 0),
                latestAtMs: Math.max(previous.latestAtMs, event.at),
                peakRadiusKm: Math.max(previous.peakRadiusKm, event.radiusKm),
                velocity: Math.max(previous.velocity, event.velocity),
            });
        });
        return {
            generatedAtMs: now,
            rows: activitySnapshot.docs.map(doc => {
                const row = doc.data();
                const lastActivityAtMs = row.lastActivityAt?.toMillis?.() ?? 0;
                return {
                    id: doc.id,
                    label: typeof row.label === "string" ? row.label : `Tester ${doc.id.slice(-4)}`,
                    screen: typeof row.screen === "string" ? row.screen : "home",
                    platform: row.platform === "native" ? "native" : "browser",
                    appVersion: typeof row.appVersion === "string" ? row.appVersion : "0.1.0",
                    status: row.status === "background" ? "background" : "foreground",
                    lastActivityAtMs,
                    state: now - lastActivityAtMs <= 90_000 ? "active" : "away",
                };
            }),
            posts,
            map: [...map.values()].sort((a, b) => b.events - a.events || b.latestAtMs - a.latestAtMs).slice(0, 32),
            simulation: [],
            simulationEnabled,
            syntheticProfiles: runnerActors,
            syntheticSessions: [],
            syntheticAnalytics: null,
            runnerEnabled,
            runnerGeneration: runnerGenerationValue,
            runnerActors,
            runnerEvents,
            runnerSessions: runtime.sessions
                .map(session => ({ ...session, status: runnerEnabled ? session.status : "paused" }))
                .sort((a, b) => syntheticBetaCohort_1.SYNTHETIC_BETA_PROFILES.findIndex(profile => profile.id === a.actorId)
                - syntheticBetaCohort_1.SYNTHETIC_BETA_PROFILES.findIndex(profile => profile.id === b.actorId)),
            runnerAnalytics: runtime.analytics,
            counts: {
                realTesters: activitySnapshot.size,
                realPosts: posts.length,
                syntheticPersonas: syntheticBetaCohort_1.SYNTHETIC_BETA_PROFILES.length,
                syntheticEvents: runtime.analytics.eventCount,
                syntheticRecentEvents: runnerEvents.length,
                runnerActiveActors: runnerActors.filter(actor => actor.state === "live").length,
            },
            feedback: feedbackSnapshot.docs.map(doc => {
                const feedback = doc.data();
                return {
                    id: doc.id,
                    label: text(feedback.label, 50) || "Tester",
                    finding: text(feedback.finding, FEEDBACK_LIMIT),
                    liked: text(feedback.liked, FEEDBACK_LIMIT),
                    improve: text(feedback.improve, FEEDBACK_LIMIT),
                    createdAtMs: timestampMs(feedback.createdAt),
                };
            }),
        };
    }
    throw new https_1.HttpsError("invalid-argument", "Unsupported Test Control Center action.");
});
