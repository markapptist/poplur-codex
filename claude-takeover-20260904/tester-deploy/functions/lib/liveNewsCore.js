"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildLiveNewsEvents = buildLiveNewsEvents;
exports.preserveLiveNewsIds = preserveLiveNewsIds;
exports.liveNewsContentHash = liveNewsContentHash;
const crypto_1 = require("crypto");
const MAX_EVENTS = 40;
const MAX_FEATURES_PER_BATCH = 250;
const MAX_LINKS_PER_FEATURE = 8;
const MAX_ARTICLES_PER_DOC_RESPONSE = 400;
const MAX_SOURCE_AGE_MS = 48 * 60 * 60_000;
const TITLE_CLUSTER_THRESHOLD = 0.24;
const STOP_WORDS = new Set([
    "a", "about", "after", "an", "and", "are", "as", "at", "be", "before",
    "by", "for", "from", "has", "have", "in", "into", "is", "it", "its",
    "new", "of", "on", "or", "says", "that", "the", "their", "this", "to",
    "was", "were", "will", "with",
]);
const SAFETY_WORDS = /\b(?:earthquake|wildfire|flood|hurricane|tornado|eruption|explosion|evacuat|emergency|tsunami)\b/i;
const LIVE_EVENT_WORDS = /\b(?:parade|festival|protest|demonstration|rally|march|marathon|election|ceremony|concert)\b/i;
const TRANSPORT_WORDS = /\b(?:derail|closure|closed|suspend|delay|disruption|airport|transit|rail|train|flight)\b/i;
function recordValue(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function cleanText(value, maxLength) {
    if (typeof value !== "string")
        return "";
    return decodeHtmlEntities(value)
        .replace(/<[^>]*>/g, " ")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}
function decodeHtmlEntities(value) {
    const named = {
        amp: "&", apos: "'", gt: ">", hellip: "…", lt: "<", nbsp: " ", quot: "\"",
    };
    return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
        if (entity.startsWith("#")) {
            const hex = entity[1]?.toLowerCase() === "x";
            const parsed = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
            return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
                ? String.fromCodePoint(parsed)
                : match;
        }
        return named[entity.toLowerCase()] ?? match;
    });
}
function safeHttpsUrl(value) {
    if (typeof value !== "string" || value.length > 2_048)
        return null;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
            return null;
        const hostname = url.hostname.toLowerCase();
        if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal"))
            return null;
        const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
        if (ipv4) {
            const octets = ipv4.slice(1).map(Number);
            if (octets.some(octet => octet > 255)
                || octets[0] === 0 || octets[0] === 10 || octets[0] === 127
                || octets[0] >= 224
                || octets[0] === 169 && octets[1] === 254
                || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
                || octets[0] === 192 && octets[1] === 168)
                return null;
        }
        const ipv6 = /^\[([0-9a-f:.]+)\]$/i.exec(hostname)?.[1]?.toLowerCase();
        if (ipv6 && (ipv6 === "::"
            || ipv6 === "::1"
            // URL canonicalization turns dotted IPv4-mapped literals into this hex
            // form. Reject every mapped address rather than accidentally accepting
            // a loopback/private IPv4 target through its IPv6 spelling.
            || ipv6.startsWith("::ffff:")
            || /^(?:fc|fd)/.test(ipv6)
            || /^fe[89abcdef]/.test(ipv6)
            || /^ff/.test(ipv6)))
            return null;
        return url.toString();
    }
    catch {
        return null;
    }
}
function canonicalArticleUrl(value) {
    const safe = safeHttpsUrl(value);
    if (!safe)
        return null;
    const url = new URL(safe);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
        if (/^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key))
            url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1)
        url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
}
function parseProviderDate(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    const compact = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(trimmed);
    if (compact) {
        const time = Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]), Number(compact[4]), Number(compact[5]), Number(compact[6]));
        return Number.isFinite(time) ? new Date(time).toISOString() : null;
    }
    const time = Date.parse(trimmed);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function coordinates(value) {
    if (!Array.isArray(value) || value.length < 2)
        return null;
    const longitude = Number(value[0]);
    const latitude = Number(value[1]);
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180)
        return null;
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90)
        return null;
    return [longitude, latitude];
}
function publisherFromUrl(url, explicitDomain) {
    const supplied = cleanText(explicitDomain, 100).replace(/^www\./i, "");
    if (supplied)
        return supplied;
    try {
        return new URL(url).hostname.replace(/^www\./i, "").slice(0, 100);
    }
    catch {
        return "News source";
    }
}
function parseDocumentArticles(payload, nowMs) {
    const root = recordValue(payload);
    const rawArticles = Array.isArray(root?.articles) ? root.articles.slice(0, MAX_ARTICLES_PER_DOC_RESPONSE) : [];
    const articles = new Map();
    for (const raw of rawArticles) {
        const record = recordValue(raw);
        if (!record)
            continue;
        const url = safeHttpsUrl(record.url);
        const canonicalUrl = canonicalArticleUrl(url);
        const title = cleanText(record.title, 220);
        const publishedAt = parseProviderDate(record.seendate ?? record.publishedAt ?? record.date);
        if (!url || !canonicalUrl || !title || !publishedAt)
            continue;
        const ageMs = nowMs - Date.parse(publishedAt);
        if (ageMs < -60 * 60_000 || ageMs > MAX_SOURCE_AGE_MS)
            continue;
        const article = {
            title,
            url,
            canonicalUrl,
            publisher: publisherFromUrl(url, record.domain),
            publishedAt,
        };
        const existing = articles.get(canonicalUrl);
        if (!existing || Date.parse(article.publishedAt) > Date.parse(existing.publishedAt)) {
            articles.set(canonicalUrl, article);
        }
    }
    return articles;
}
function htmlArticleLinks(value) {
    if (typeof value !== "string" || value.length > 100_000)
        return [];
    const links = [];
    const pattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(value)) && links.length < MAX_LINKS_PER_FEATURE) {
        const url = safeHttpsUrl(decodeHtmlEntities(match[2] ?? ""));
        const title = cleanText(match[3], 220);
        if (url && title)
            links.push({ url, title });
    }
    return links;
}
function titleTokens(title) {
    const words = title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    return new Set(words.filter(word => !STOP_WORDS.has(word)).slice(0, 30));
}
function titleSimilarity(left, right) {
    const a = titleTokens(left);
    const b = titleTokens(right);
    if (a.size === 0 || b.size === 0)
        return 0;
    let intersection = 0;
    for (const token of a)
        if (b.has(token))
            intersection += 1;
    return intersection / Math.max(1, Math.min(a.size, b.size));
}
function sameLocation(left, right) {
    return Math.abs(left[0] - right[0]) <= 0.01 && Math.abs(left[1] - right[1]) <= 0.01;
}
function extractLocatedArticles(batch, nowMs) {
    const documents = parseDocumentArticles(batch.documents, nowMs);
    const root = recordValue(batch.geo);
    const features = Array.isArray(root?.features) ? root.features.slice(0, MAX_FEATURES_PER_BATCH) : [];
    const found = new Map();
    for (const rawFeature of features) {
        const feature = recordValue(rawFeature);
        const geometry = recordValue(feature?.geometry);
        const properties = recordValue(feature?.properties);
        if (geometry?.type !== "Point")
            continue;
        const coords = coordinates(geometry.coordinates);
        const place = cleanText(properties?.name ?? properties?.location ?? properties?.title, 160);
        if (!coords || !place)
            continue;
        const links = htmlArticleLinks(properties?.html ?? properties?.description);
        for (const link of links) {
            const canonical = canonicalArticleUrl(link.url);
            if (!canonical)
                continue;
            const article = documents.get(canonical);
            // GEO provides the location and DOC provides the observed date. Requiring
            // the URL to exist in both responses prevents us from inventing either.
            if (!article)
                continue;
            const key = `${canonical}|${coords[0].toFixed(4)}|${coords[1].toFixed(4)}`;
            found.set(key, {
                ...article,
                category: batch.category,
                liveKind: batch.liveKind,
                place,
                coords,
            });
        }
    }
    return [...found.values()];
}
function clusterLocatedArticles(articles) {
    const clusters = [];
    const ordered = [...articles].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    for (const article of ordered) {
        const cluster = clusters.find(candidate => candidate.category === article.category
            && sameLocation(candidate.coords, article.coords)
            && titleSimilarity(candidate.articles[0]?.title ?? "", article.title) >= TITLE_CLUSTER_THRESHOLD);
        if (cluster)
            cluster.articles.push(article);
        else
            clusters.push({
                category: article.category,
                liveKind: article.liveKind,
                place: article.place,
                coords: article.coords,
                articles: [article],
            });
    }
    return clusters;
}
function distinctPublisherArticles(articles) {
    const byPublisher = new Map();
    for (const article of articles) {
        const key = article.publisher.toLowerCase();
        const existing = byPublisher.get(key);
        if (!existing || Date.parse(article.publishedAt) > Date.parse(existing.publishedAt)) {
            byPublisher.set(key, article);
        }
    }
    return [...byPublisher.values()]
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, 6);
}
function classifyStatus(cluster, sources, nowMs) {
    const latestAgeMs = Math.max(0, nowMs - Math.max(...sources.map(source => Date.parse(source.publishedAt))));
    const combinedTitles = sources.map(source => source.title).join(" ");
    const corroborated = sources.length >= 2;
    if (cluster.liveKind === "top")
        return "top";
    if (cluster.liveKind === "safety" && SAFETY_WORDS.test(combinedTitles) && sources.length >= 2 && latestAgeMs <= 2 * 60 * 60_000) {
        return "breaking";
    }
    const expresslyLive = cluster.liveKind === "event" && LIVE_EVENT_WORDS.test(combinedTitles)
        || cluster.liveKind === "transport" && TRANSPORT_WORDS.test(combinedTitles);
    if (expresslyLive && corroborated && latestAgeMs <= 8 * 60 * 60_000)
        return "live";
    if (latestAgeMs <= 24 * 60 * 60_000)
        return "developing";
    return "top";
}
function eventConfidence(sources, updatedAt, nowMs) {
    const ageHours = Math.max(0, (nowMs - Date.parse(updatedAt)) / 3_600_000);
    const sourceScore = Math.min(sources.length, 3) * 0.1;
    const freshnessScore = ageHours <= 3 ? 0.08 : ageHours <= 12 ? 0.04 : 0;
    return Math.min(0.96, Number((0.55 + sourceScore + freshnessScore).toFixed(2)));
}
function stableEventId(cluster, sources) {
    const signatureTokens = [...titleTokens(sources[0]?.title ?? "")].sort().slice(0, 10).join("-");
    const signature = [
        cluster.category,
        cluster.place.toLowerCase(),
        cluster.coords[0].toFixed(3),
        cluster.coords[1].toFixed(3),
        signatureTokens,
    ].join("|");
    return `gdelt-${(0, crypto_1.createHash)("sha256").update(signature).digest("hex").slice(0, 24)}`;
}
function eventFromCluster(cluster, nowMs) {
    const sources = distinctPublisherArticles(cluster.articles);
    if (sources.length === 0)
        return null;
    const publishedAt = new Date(Math.min(...sources.map(source => Date.parse(source.publishedAt)))).toISOString();
    const updatedAt = new Date(Math.max(...sources.map(source => Date.parse(source.publishedAt)))).toISOString();
    const title = sources[0].title;
    const sourceWord = sources.length === 1 ? "source is" : "sources are";
    const summary = cleanText(`“${title}” is the latest source description linked to ${cluster.place}. ${sources.length} independent ${sourceWord} included in this update.`, 520);
    return {
        id: stableEventId(cluster, sources),
        title,
        summary,
        status: classifyStatus(cluster, sources, nowMs),
        place: cluster.place,
        coords: cluster.coords,
        // PointData with geores=2 excludes country and ADM1 centroids. Treating
        // the remaining provider city/landmark points as local avoids AI scope.
        scope: "local",
        category: cluster.category,
        publishedAt,
        updatedAt,
        confidence: eventConfidence(sources, updatedAt, nowMs),
        sources: sources.map(source => ({
            publisher: source.publisher,
            url: source.url,
            publishedAt: source.publishedAt,
        })),
        // GDELT/social images do not carry a reusable-content licence. They are
        // intentionally omitted rather than scraped, proxied, or rehosted.
        media: [],
    };
}
function eventScore(event, nowMs) {
    const status = event.status === "breaking" ? 400 : event.status === "live" ? 300 : event.status === "developing" ? 200 : 100;
    const recency = Math.max(0, 48 - (nowMs - Date.parse(event.updatedAt)) / 3_600_000);
    return status + event.confidence * 80 + Math.min(event.sources.length, 3) * 12 + recency;
}
/** Convert joined GEO + DOC provider payloads into the public client wire. */
function buildLiveNewsEvents(batches, nowMs = Date.now()) {
    const located = batches.flatMap(batch => extractLocatedArticles(batch, nowMs));
    const events = clusterLocatedArticles(located)
        .map(cluster => eventFromCluster(cluster, nowMs))
        .filter((event) => Boolean(event));
    // One article may mention multiple nearby locations. Keep its strongest
    // corroborated location instead of letting one story move the camera twice.
    const byPrimarySource = new Map();
    for (const event of events) {
        const primary = canonicalArticleUrl(event.sources[0]?.url) ?? event.id;
        const existing = byPrimarySource.get(primary);
        if (!existing || eventScore(event, nowMs) > eventScore(existing, nowMs)) {
            byPrimarySource.set(primary, event);
        }
    }
    return [...byPrimarySource.values()]
        .sort((a, b) => eventScore(b, nowMs) - eventScore(a, nowMs))
        .slice(0, MAX_EVENTS);
}
/** Preserve public IDs across refreshes when a source URL or close headline matches. */
function preserveLiveNewsIds(next, previous) {
    const claimed = new Set();
    return next.map(event => {
        const nextUrls = new Set(event.sources.map(source => canonicalArticleUrl(source.url)).filter(Boolean));
        const match = previous.find(candidate => {
            if (claimed.has(candidate.id))
                return false;
            if (candidate.sources.some(source => nextUrls.has(canonicalArticleUrl(source.url))))
                return true;
            return candidate.category === event.category
                && sameLocation(candidate.coords, event.coords)
                && titleSimilarity(candidate.title, event.title) >= 0.4;
        });
        if (!match)
            return event;
        claimed.add(match.id);
        return { ...event, id: match.id };
    });
}
function liveNewsContentHash(events) {
    return (0, crypto_1.createHash)("sha256").update(JSON.stringify(events)).digest("hex");
}
