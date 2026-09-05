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
exports.liveNewsApi = exports.refreshLiveNews = void 0;
const admin = __importStar(require("firebase-admin"));
const crypto_1 = require("crypto");
const firebase_functions_1 = require("firebase-functions");
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const liveNewsCore_1 = require("./liveNewsCore");
const REGION = "us-central1";
const GDELT_GEO_ENDPOINT = "https://api.gdeltproject.org/api/v2/geo/geo";
const GDELT_DOC_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const GDELT_GEO_DOCUMENTATION = "https://blog.gdeltproject.org/gdelt-geo-2-0-api-debuts/";
const GDELT_DOC_DOCUMENTATION = "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/";
const SNAPSHOT_COLLECTION = "liveNewsPublic";
const SNAPSHOT_DOCUMENT = "current";
const SYSTEM_COLLECTION = "liveNewsSystem";
const LEASE_DOCUMENT = "ingest";
const LEASE_MS = 3 * 60_000;
const PROVIDER_TIMEOUT_MS = 14_000;
/**
 * GDELT asks for one request every five seconds, and says so in the body of
 * its own 429: "Please limit requests to one every 5 seconds".
 *
 * This refresh issues eight requests — a geo and a doc query for each of the
 * four categories — and it used to fire them in overlapping pairs, so the
 * provider rejected them and every scheduled run died with
 * live_news_all_provider_queries_failed. The feed has never had real news.
 *
 * 5.5s rather than 5s: the limit is enforced on GDELT's clock, not ours, and
 * a request that lands a few milliseconds early is refused outright.
 */
const PROVIDER_MIN_INTERVAL_MS = 5_500;
/** Serialises every provider request process-wide, whatever calls it. */
let providerGate = Promise.resolve();
let lastProviderStartedAt = 0;
function paceProviderRequest() {
    const turn = providerGate.then(async () => {
        const waitMs = PROVIDER_MIN_INTERVAL_MS - (Date.now() - lastProviderStartedAt);
        if (waitMs > 0)
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        lastProviderStartedAt = Date.now();
    });
    // Swallow rejections on the CHAIN only: one failed turn must not poison
    // every request behind it. The caller still sees its own rejection.
    providerGate = turn.catch(() => undefined);
    return turn;
}
const GEO_RESPONSE_LIMIT = 8 * 1024 * 1024;
const DOC_RESPONSE_LIMIT = 5 * 1024 * 1024;
const MAX_PUBLIC_EVENTS = 40;
/**
 * These deliberately describe observable public-interest events. Each query is
 * joined across GEO and DOC by article URL; a DOC headline without provider
 * coordinates is useful news, but is not allowed to move Poplur's map.
 */
const QUERY_DEFINITIONS = [
    {
        category: "public safety",
        liveKind: "safety",
        query: "(earthquake OR wildfire OR flood OR hurricane OR tornado OR eruption OR explosion OR evacuation OR \"state of emergency\")",
    },
    {
        category: "live events",
        liveKind: "event",
        query: "(parade OR festival OR protest OR demonstration OR rally OR march OR marathon OR election OR ceremony OR concert)",
    },
    {
        category: "transport",
        liveKind: "transport",
        query: "(derailment OR \"service suspended\" OR \"airport closed\" OR \"road closure\" OR \"transit disruption\")",
    },
    {
        category: "world",
        liveKind: "top",
        query: "(government OR economy OR health OR science OR climate)",
    },
];
function database() {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
}
function snapshotRef() {
    return database().collection(SNAPSHOT_COLLECTION).doc(SNAPSHOT_DOCUMENT);
}
function leaseRef() {
    return database().collection(SYSTEM_COLLECTION).doc(LEASE_DOCUMENT);
}
function providerUrl(endpoint, definition, kind) {
    const url = new URL(endpoint);
    url.searchParams.set("query", definition.query);
    url.searchParams.set("timespan", "24h");
    if (kind === "geo") {
        url.searchParams.set("mode", "pointdata");
        url.searchParams.set("format", "geojson");
        url.searchParams.set("maxpoints", "125");
        // Excludes country and ADM1-only mentions so their centroids are not
        // presented as the site of a local event. City/landmark points remain.
        url.searchParams.set("geores", "2");
        // SORTBY, not sort: "sort" is the DOC 2.0 spelling and GEO silently
        // ignores it, so this request has never actually been date-sorted.
        url.searchParams.set("sortby", "date");
    }
    else {
        url.searchParams.set("mode", "artlist");
        url.searchParams.set("format", "json");
        url.searchParams.set("maxrecords", "250");
        url.searchParams.set("sort", "datedesc");
    }
    return url;
}
async function fetchProviderJson(url, byteLimit) {
    if (url.protocol !== "https:" || url.hostname !== "api.gdeltproject.org") {
        throw new Error("live_news_provider_host_rejected");
    }
    // One retry, and only for 429. Any other failure is the caller's to report:
    // retrying a 404 or a parse error just spends the pacing budget twice.
    for (let attempt = 0;; attempt += 1) {
        await paceProviderRequest();
        try {
            return await requestProviderJson(url, byteLimit);
        }
        catch (error) {
            const rateLimited = error instanceof Error && error.message === "live_news_provider_http_429";
            if (!rateLimited || attempt >= 1)
                throw error;
            firebase_functions_1.logger.warn("live_news_provider_rate_limited", { url: url.pathname });
        }
    }
}
async function requestProviderJson(url, byteLimit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: "GET",
            redirect: "error",
            signal: controller.signal,
            headers: {
                Accept: "application/json, application/geo+json",
                "User-Agent": "Poplur-News/1.0 (+https://poplur.com)",
            },
        });
        if (!response.ok)
            throw new Error(`live_news_provider_http_${response.status}`);
        if (response.url && new URL(response.url).hostname !== "api.gdeltproject.org") {
            throw new Error("live_news_provider_redirect_rejected");
        }
        const declaredSize = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredSize) && declaredSize > byteLimit) {
            throw new Error("live_news_provider_response_too_large");
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength === 0 || buffer.byteLength > byteLimit) {
            throw new Error("live_news_provider_response_size_invalid");
        }
        try {
            return JSON.parse(buffer.toString("utf8"));
        }
        catch {
            throw new Error("live_news_provider_json_invalid");
        }
    }
    finally {
        clearTimeout(timeout);
    }
}
async function fetchQueryBatch(definition) {
    // allSettled, NOT all. Joining these with Promise.all meant one endpoint
    // being down rejected the whole batch, every category failed, and every
    // scheduled run died at live_news_all_provider_queries_failed — which is
    // exactly what has been happening since GDELT's GEO 2.0 route started
    // returning 404 (their /api/v2/geo/ directory still answers 403, so the
    // directory exists and only the CGI inside it fails to resolve; Wayback
    // shows this endpoint serving 200 as recently as February). Losing the geo
    // leg should cost us the PINS, not the news.
    const [geoResult, docResult] = await Promise.allSettled([
        fetchProviderJson(providerUrl(GDELT_GEO_ENDPOINT, definition, "geo"), GEO_RESPONSE_LIMIT),
        fetchProviderJson(providerUrl(GDELT_DOC_ENDPOINT, definition, "doc"), DOC_RESPONSE_LIMIT),
    ]);
    if (geoResult.status === "rejected") {
        firebase_functions_1.logger.warn("live_news_geo_unavailable", {
            category: definition.category,
            reason: errorCode(geoResult.reason),
        });
    }
    // The documents ARE the news. Without them there is nothing to publish for
    // this category, so this half still throws and the caller logs the miss.
    if (docResult.status === "rejected")
        throw docResult.reason;
    return {
        category: definition.category,
        liveKind: definition.liveKind,
        geo: geoResult.status === "fulfilled" ? geoResult.value : null,
        documents: docResult.value,
    };
}
async function fetchProviderBatches() {
    const batches = [];
    // Two categories at a time bounds both upstream load and function memory.
    for (let index = 0; index < QUERY_DEFINITIONS.length; index += 2) {
        const definitions = QUERY_DEFINITIONS.slice(index, index + 2);
        const settled = await Promise.allSettled(definitions.map(fetchQueryBatch));
        settled.forEach((result, resultIndex) => {
            const definition = definitions[resultIndex];
            if (result.status === "fulfilled")
                batches.push(result.value);
            else
                firebase_functions_1.logger.warn("live_news_provider_query_failed", {
                    category: definition?.category ?? "unknown",
                    reason: errorCode(result.reason),
                });
        });
    }
    if (batches.length === 0)
        throw new Error("live_news_all_provider_queries_failed");
    return batches;
}
function storedEvents(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return false;
        const event = entry;
        return typeof event.id === "string"
            && typeof event.title === "string"
            && typeof event.summary === "string"
            && typeof event.category === "string"
            && typeof event.place === "string"
            && typeof event.updatedAt === "string"
            && Array.isArray(event.coords)
            && event.coords.length === 2
            && event.coords.every(Number.isFinite)
            && Array.isArray(event.sources)
            && event.sources.every(source => source && typeof source.url === "string" && typeof source.publisher === "string")
            && Array.isArray(event.media);
    }).slice(0, MAX_PUBLIC_EVENTS);
}
async function acquireLease(token, nowMs) {
    const ref = leaseRef();
    return database().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const leaseUntil = snapshot.data()?.leaseUntil;
        if (leaseUntil instanceof admin.firestore.Timestamp && leaseUntil.toMillis() > nowMs)
            return false;
        transaction.set(ref, {
            leaseToken: token,
            leaseUntil: admin.firestore.Timestamp.fromMillis(nowMs + LEASE_MS),
            lastStartedAt: admin.firestore.FieldValue.serverTimestamp(),
            state: "running",
        }, { merge: true });
        return true;
    });
}
async function releaseFailedLease(token, error) {
    const ref = leaseRef();
    await database().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (snapshot.data()?.leaseToken !== token)
            return;
        transaction.set(ref, {
            leaseToken: admin.firestore.FieldValue.delete(),
            leaseUntil: admin.firestore.Timestamp.fromMillis(0),
            lastFailedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastError: errorCode(error).slice(0, 160),
            state: "failed",
        }, { merge: true });
    });
}
function makePublicSnapshot(events, generatedAt, checkedAt) {
    return {
        schemaVersion: 1,
        provider: "gdelt-geo-2.0",
        generatedAt,
        checkedAt,
        contentHash: (0, liveNewsCore_1.liveNewsContentHash)(events),
        events,
        policy: {
            coordinates: "gdelt-geo-point-only",
            summaries: "deterministic-source-derived",
            media: "omit-without-explicit-reuse-rights",
            geoDocumentation: GDELT_GEO_DOCUMENTATION,
            docDocumentation: GDELT_DOC_DOCUMENTATION,
        },
    };
}
async function publishSnapshot(token, rawEvents, nowMs) {
    const currentRef = snapshotRef();
    const stateRef = leaseRef();
    const checkedAt = new Date(nowMs).toISOString();
    return database().runTransaction(async (transaction) => {
        const [state, current] = await Promise.all([
            transaction.get(stateRef),
            transaction.get(currentRef),
        ]);
        if (state.data()?.leaseToken !== token)
            throw new Error("live_news_lease_lost");
        const previousEvents = storedEvents(current.data()?.events);
        const events = (0, liveNewsCore_1.preserveLiveNewsIds)(rawEvents, previousEvents).slice(0, MAX_PUBLIC_EVENTS);
        if (events.length === 0)
            throw new Error("live_news_no_publishable_events");
        const contentHash = (0, liveNewsCore_1.liveNewsContentHash)(events);
        const existingHash = typeof current.data()?.contentHash === "string" ? current.data()?.contentHash : "";
        const existingGeneratedAt = typeof current.data()?.generatedAt === "string" ? current.data()?.generatedAt : null;
        const changed = contentHash !== existingHash;
        const generatedAt = changed || !existingGeneratedAt ? checkedAt : existingGeneratedAt;
        const next = makePublicSnapshot(events, generatedAt, checkedAt);
        if (changed || !current.exists)
            transaction.set(currentRef, next);
        else
            transaction.set(currentRef, { checkedAt, events, contentHash }, { merge: true });
        transaction.set(stateRef, {
            leaseToken: admin.firestore.FieldValue.delete(),
            leaseUntil: admin.firestore.Timestamp.fromMillis(0),
            lastCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastError: admin.firestore.FieldValue.delete(),
            lastEventCount: events.length,
            lastContentHash: contentHash,
            state: "idle",
        }, { merge: true });
        return { changed, count: events.length };
    });
}
async function runLiveNewsRefresh() {
    const token = (0, crypto_1.randomUUID)();
    const startedAt = Date.now();
    if (!await acquireLease(token, startedAt)) {
        firebase_functions_1.logger.info("live_news_refresh_skipped_lease_active");
        return;
    }
    try {
        const batches = await fetchProviderBatches();
        const events = (0, liveNewsCore_1.buildLiveNewsEvents)(batches, Date.now());
        // Never overwrite a good edition with an empty one. Every event is located
        // from the GEO leg, so while that endpoint is down every batch yields zero
        // events even though the documents arrived fine — and publishing that
        // would erase the last real snapshot and keep erasing it every 15 minutes.
        // Leaving the old one in place lets it go stale honestly, which the client
        // already renders as "SAVED EDITION".
        if (events.length === 0) {
            await releaseFailedLease(token, new Error("live_news_no_locatable_events")).catch(() => undefined);
            firebase_functions_1.logger.warn("live_news_refresh_produced_nothing", {
                providerBatchCount: batches.length,
                elapsedMs: Date.now() - startedAt,
            });
            return;
        }
        const published = await publishSnapshot(token, events, Date.now());
        firebase_functions_1.logger.info("live_news_refresh_completed", {
            changed: published.changed,
            count: published.count,
            providerBatchCount: batches.length,
            elapsedMs: Date.now() - startedAt,
        });
    }
    catch (error) {
        await releaseFailedLease(token, error).catch(releaseError => {
            firebase_functions_1.logger.error("live_news_lease_release_failed", { reason: errorCode(releaseError) });
        });
        firebase_functions_1.logger.error("live_news_refresh_failed", {
            reason: errorCode(error),
            elapsedMs: Date.now() - startedAt,
        });
        throw error;
    }
}
/** Provider ingest is server-owned and idempotent; clients cannot trigger it. */
exports.refreshLiveNews = (0, scheduler_1.onSchedule)({
    region: REGION,
    schedule: "every 15 minutes",
    timeZone: "Etc/UTC",
    retryCount: 2,
    minBackoffSeconds: 30,
    maxBackoffSeconds: 180,
    // Eight provider requests, paced 5.5s apart, each allowed 14s and each
    // permitted one 429 retry. 120s could not fit that and the run would be
    // killed mid-sweep, discarding categories it had already fetched.
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 1,
}, async () => runLiveNewsRefresh());
function publicLimit(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_PUBLIC_EVENTS, parsed)) : MAX_PUBLIC_EVENTS;
}
function errorCode(error) {
    if (error instanceof Error && error.name === "AbortError")
        return "provider_timeout";
    if (error instanceof Error && error.message)
        return error.message.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160);
    return "unknown_error";
}
/** Public, cacheable, read-only endpoint consumed by both Map and Poplur News. */
exports.liveNewsApi = (0, https_1.onRequest)({
    region: REGION,
    cors: true,
    timeoutSeconds: 15,
    memory: "256MiB",
    maxInstances: 20,
}, async (request, response) => {
    response.set("Access-Control-Allow-Origin", "*");
    response.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Accept, If-None-Match");
    response.set("X-Content-Type-Options", "nosniff");
    if (request.method === "OPTIONS") {
        response.status(204).send("");
        return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.set("Allow", "GET, HEAD, OPTIONS");
        response.status(405).json({ error: "method_not_allowed" });
        return;
    }
    const snapshot = await snapshotRef().get();
    const data = snapshot.data();
    const events = storedEvents(data?.events);
    if (!snapshot.exists || events.length === 0) {
        response.set("Cache-Control", "public, max-age=30");
        response.status(503).json({ events: [], generatedAt: null, stale: true, error: "live_news_initializing" });
        return;
    }
    const generatedAt = typeof data?.generatedAt === "string" ? data.generatedAt : null;
    const checkedAt = typeof data?.checkedAt === "string" ? data.checkedAt : generatedAt;
    const ageMs = checkedAt ? Date.now() - Date.parse(checkedAt) : Number.POSITIVE_INFINITY;
    const stale = !Number.isFinite(ageMs) || ageMs > 90 * 60_000;
    const fullHash = typeof data?.contentHash === "string" ? data.contentHash : (0, liveNewsCore_1.liveNewsContentHash)(events);
    const etag = `\"${fullHash}\"`;
    response.set("ETag", etag);
    response.set("Cache-Control", stale
        ? "public, max-age=30, stale-if-error=3600"
        : "public, max-age=60, stale-while-revalidate=900, stale-if-error=3600");
    if (request.get("if-none-match") === etag) {
        response.status(304).send("");
        return;
    }
    const payload = {
        events: events.slice(0, publicLimit(request.query.limit)),
        generatedAt,
        checkedAt,
        stale,
        provider: "GDELT GEO 2.0 + DOC 2.0",
        policy: data?.policy ?? makePublicSnapshot([], new Date(0).toISOString(), new Date(0).toISOString()).policy,
    };
    if (request.method === "HEAD")
        response.status(200).send("");
    else
        response.status(200).json(payload);
});
