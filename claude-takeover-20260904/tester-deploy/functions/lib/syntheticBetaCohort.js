"use strict";
/**
 * Contracts for the isolated browser-runner beta cohort.
 *
 * These records describe test personas only. They do not generate activity,
 * create Firebase Auth accounts, or prescribe a journey. Every dashboard event
 * must come from a real isolated browser session through testSessionIngest.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYNTHETIC_RUNNER_EVENT_TYPES = exports.SYNTHETIC_RUNNER_ACTIONS = exports.SYNTHETIC_RUNNER_SCREENS = exports.SYNTHETIC_BETA_PROFILES = exports.SYNTHETIC_RUNNER_RECENT_EVENT_LIMIT = exports.SYNTHETIC_BETA_COHORT_ID = void 0;
exports.syntheticProfile = syntheticProfile;
exports.emptySyntheticBrowserRuntime = emptySyntheticBrowserRuntime;
exports.advanceSyntheticBrowserRuntime = advanceSyntheticBrowserRuntime;
exports.SYNTHETIC_BETA_COHORT_ID = "beta-browser-v1";
exports.SYNTHETIC_RUNNER_RECENT_EVENT_LIMIT = 80;
exports.SYNTHETIC_BETA_PROFILES = [
    {
        id: "sim-food-001",
        label: "RUNNER · @sauceboss",
        handle: "@sauceboss",
        persona: "Food scout",
        place: "Toronto",
        avatarTile: "food",
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
    },
    {
        id: "sim-sports-002",
        label: "RUNNER · @pitchside",
        handle: "@pitchside",
        persona: "Live sports fan",
        place: "London",
        avatarTile: "sports",
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
    },
    {
        id: "sim-music-003",
        label: "RUNNER · @basement.set",
        handle: "@basement.set",
        persona: "Music curator",
        place: "Toronto",
        avatarTile: "music",
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
    },
    {
        id: "sim-tech-004",
        label: "RUNNER · @shipit",
        handle: "@shipit",
        persona: "Performance tester",
        place: "World beta region",
        avatarTile: "tech",
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
    },
    {
        id: "sim-news-005",
        label: "RUNNER · @citydesk",
        handle: "@citydesk",
        persona: "News explorer",
        place: "New York",
        avatarTile: "news",
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
    },
    // Business testers. Same cohort, same runner, same approved media — the
    // difference is the listing: each owns users/{uid} with accountType
    // "business" and a world-readable businesses/{uid}, which is how every
    // surface tells a business byline from a person's.
    {
        id: "sim-biz-food-006",
        label: "RUNNER · @nightmarket",
        handle: "@nightmarket",
        persona: "Restaurant",
        place: "Toronto",
        avatarTile: "food",
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
        kind: "business",
        businessName: "Night Market Eats",
        businessCategory: "Restaurant",
    },
    {
        id: "sim-biz-shop-007",
        label: "RUNNER · @hauls.to",
        handle: "@hauls.to",
        persona: "Retail",
        place: "Toronto",
        avatarTile: "shopping",
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
        kind: "business",
        businessName: "Hauls Outlet",
        businessCategory: "Retail",
    },
    {
        id: "sim-biz-fashion-008",
        label: "RUNNER · @fitcheck.nyc",
        handle: "@fitcheck.nyc",
        persona: "Boutique",
        place: "New York",
        avatarTile: "fashion",
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
        kind: "business",
        businessName: "Fit Check Daily",
        businessCategory: "Boutique",
    },
];
exports.SYNTHETIC_RUNNER_SCREENS = new Set([
    "home",
    "map",
    "feed",
    "map-radio",
    "feed-news",
    "profile",
    "profile-wardrobe",
    "profile-house",
    "hold-menu",
    "games",
]);
exports.SYNTHETIC_RUNNER_ACTIONS = new Set([
    "app-open",
    "screen-view",
    "open-map",
    "open-feed",
    "open-profile",
    "open-hold-menu",
    "open-radio",
    "open-news",
    "open-wardrobe",
    "open-house",
    "open-games",
    "radius-view",
    "back",
    "idle",
    "session-end",
]);
exports.SYNTHETIC_RUNNER_EVENT_TYPES = new Set([
    "session",
    "navigation",
    "discovery",
    "playback",
    "lifecycle",
]);
function syntheticProfile(actorId) {
    return exports.SYNTHETIC_BETA_PROFILES.find(profile => profile.id === actorId);
}
function emptySyntheticBrowserRuntime(generation, nowMs) {
    return {
        generation,
        lastEventId: "",
        dwellTotalMs: 0,
        recentEvents: [],
        sessions: [],
        analytics: {
            eventCount: 0,
            sessionCount: 0,
            averageDwellMs: 0,
            screenCounts: {},
            actionCounts: {},
            eventTypeCounts: {},
            windowStartMs: nowMs,
            windowEndMs: nowMs,
        },
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
    };
}
/** Pure aggregation helper; storage-level idempotency is enforced by the ingest transaction. */
function advanceSyntheticBrowserRuntime(current, event) {
    const runtime = current?.generation === event.generation
        ? current
        : emptySyntheticBrowserRuntime(event.generation, event.eventAtMs);
    if (runtime.lastEventId === event.eventId
        || runtime.recentEvents.some(candidate => candidate.eventId === event.eventId)) {
        return runtime;
    }
    const profile = syntheticProfile(event.actorId);
    if (!profile)
        throw new Error("Runner actor is outside the fixed beta cohort.");
    const previousSession = runtime.sessions.find(session => session.actorId === event.actorId);
    const sessionChanged = !previousSession || previousSession.sessionId !== event.sessionId;
    const session = {
        id: event.actorId,
        actorId: event.actorId,
        actor: profile.label,
        handle: profile.handle,
        persona: profile.persona,
        place: profile.place,
        status: "live",
        sessionId: event.sessionId,
        generation: event.generation,
        sequence: event.sequence,
        priorScreen: event.priorScreen,
        screen: event.currentScreen,
        currentScreen: event.currentScreen,
        action: event.action,
        eventType: event.eventType,
        stepIndex: event.stepIndex,
        journeyLength: event.journeyLength,
        dwellMs: event.dwellMs,
        startedAtMs: sessionChanged ? event.eventAtMs : previousSession.startedAtMs,
        lastEventAtMs: event.eventAtMs,
        eventId: event.eventId,
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
    };
    const sessions = previousSession
        ? runtime.sessions.map(candidate => candidate.actorId === event.actorId ? session : candidate)
        : [...runtime.sessions, session];
    const dwellTotalMs = runtime.dwellTotalMs + event.dwellMs;
    const eventCount = runtime.analytics.eventCount + 1;
    return {
        generation: event.generation,
        lastEventId: event.eventId,
        dwellTotalMs,
        recentEvents: [...runtime.recentEvents, event].slice(-exports.SYNTHETIC_RUNNER_RECENT_EVENT_LIMIT),
        sessions,
        analytics: {
            eventCount,
            sessionCount: runtime.analytics.sessionCount + (sessionChanged ? 1 : 0),
            averageDwellMs: Math.round(dwellTotalMs / eventCount),
            screenCounts: {
                ...runtime.analytics.screenCounts,
                [event.currentScreen]: (runtime.analytics.screenCounts[event.currentScreen] ?? 0) + 1,
            },
            actionCounts: {
                ...runtime.analytics.actionCounts,
                [event.action]: (runtime.analytics.actionCounts[event.action] ?? 0) + 1,
            },
            eventTypeCounts: {
                ...runtime.analytics.eventTypeCounts,
                [event.eventType]: (runtime.analytics.eventTypeCounts[event.eventType] ?? 0) + 1,
            },
            windowStartMs: runtime.analytics.eventCount > 0
                ? Math.min(runtime.analytics.windowStartMs, event.eventAtMs)
                : event.eventAtMs,
            windowEndMs: Math.max(runtime.analytics.windowEndMs, event.eventAtMs),
        },
        source: "synthetic-browser",
        cohortId: exports.SYNTHETIC_BETA_COHORT_ID,
    };
}
