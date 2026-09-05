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
exports.meshyStatus = exports.meshyGenerate = void 0;
/**
 * Meshy image-to-3D, behind Poplur's own authorization and credit ledger.
 *
 * The key never leaves this function: the app posts an image, this decides
 * whether the caller may generate at all, debits credits, calls Meshy, and
 * hands back a Poplur-hosted model. See functions/MESHY-ENDPOINT-SPEC.md.
 *
 * WHY onRequest AND NOT onCall: the caller is the clay web bundle, which has no
 * Firebase SDK and no identity of its own — the native shell owns auth. So the
 * shell must pass its Firebase ID token into the web layer, and the web sends
 * it as `Authorization: Bearer <idToken>`. That bridge hand-off does not exist
 * yet; until it does, this function will correctly reject every call as
 * unauthenticated. That is the right failure: the alternative is trusting a
 * client that cannot prove who it is.
 */
const admin = __importStar(require("firebase-admin"));
const firebase_functions_1 = require("firebase-functions");
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const meshyApiKey = (0, params_1.defineSecret)("MESHY_API_KEY");
const MESHY_API = "https://api.meshy.ai/openapi/v1/image-to-3d";
/** Text prompts go to the v2 Text to 3D endpoint. One URL for both stages —
 *  `mode` discriminates: preview builds geometry, refine paints it. A job
 *  records its own `api` so status polls the right service. Contract verified
 *  against docs.meshy.ai on 2026-09-02. */
const MESHY_TEXT_API = "https://api.meshy.ai/openapi/v2/text-to-3d";
/** Credits per generation. One knob, deliberately — pricing is a product call. */
const GENERATION_COST = 25;
/** Per-account ceiling. Generation is slow and paid; a loop is expensive. */
const MAX_JOBS_PER_DAY = 20;
/**
 * Landmarks are shared world furniture — one generation is rendered for every
 * user — so only an admin may mint one. A business account may generate a model
 * of its own business, and nobody else may generate anything.
 *
 * The allowlist lives in Firestore (`poplurConfig/meshy.adminUids`) rather than
 * in code so it can change without a deploy, and it is readable only by
 * functions. It is NEVER derived from anything the client sends.
 */
async function authorize(uid, kind) {
    const db = admin.firestore();
    if (kind === "landmark" || kind === "ar-filter") {
        const config = await db.collection("poplurConfig").doc("meshy").get();
        const admins = config.data()?.adminUids;
        const allowed = Array.isArray(admins) && admins.includes(uid);
        if (!allowed)
            throw httpError(403, "Only an admin may generate shared models.");
        return;
    }
    const user = await db.collection("users").doc(uid).get();
    if (user.data()?.accountType !== "business") {
        throw httpError(403, "Business models require a business account.");
    }
}
class MeshyHttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
function httpError(status, message) {
    return new MeshyHttpError(status, message);
}
/** Verify the shell's Firebase ID token. No token, no generation. */
async function requireUid(req) {
    const header = req.get("Authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match)
        throw httpError(401, "Sign in before generating a model.");
    try {
        const decoded = await admin.auth().verifyIdToken(match[1]);
        return decoded.uid;
    }
    catch {
        throw httpError(401, "That session is no longer valid. Sign in again.");
    }
}
/**
 * Debit before calling Meshy, keyed by job id so a retry cannot double-charge.
 * Returns the balance left, and throws if the account cannot afford it.
 */
async function debitCredits(uid, jobId) {
    const db = admin.firestore();
    const balanceRef = db.collection("creatorCreditBalances").doc(uid);
    const ledgerRef = db.collection("creatorCreditTransactions").doc(`meshy_${jobId}`);
    return db.runTransaction(async (transaction) => {
        const [ledger, balance] = await Promise.all([
            transaction.get(ledgerRef),
            transaction.get(balanceRef),
        ]);
        const available = Number(balance.data()?.availableCredits ?? 0);
        if (ledger.exists)
            return available; // already charged for this job
        if (available < GENERATION_COST) {
            throw httpError(402, `This costs ${GENERATION_COST} credits and you have ${available}.`);
        }
        transaction.set(balanceRef, {
            availableCredits: available - GENERATION_COST,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(ledgerRef, {
            uid, jobId, kind: "meshy_generation",
            credits: -GENERATION_COST,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        });
        return available - GENERATION_COST;
    });
}
/** A failed generation must not cost the user. Idempotent, like the debit. */
async function refundCredits(uid, jobId) {
    const db = admin.firestore();
    const balanceRef = db.collection("creatorCreditBalances").doc(uid);
    const refundRef = db.collection("creatorCreditTransactions").doc(`meshy_refund_${jobId}`);
    await db.runTransaction(async (transaction) => {
        const [refund, balance] = await Promise.all([
            transaction.get(refundRef),
            transaction.get(balanceRef),
        ]);
        if (refund.exists)
            return;
        transaction.set(balanceRef, {
            availableCredits: Number(balance.data()?.availableCredits ?? 0) + GENERATION_COST,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(refundRef, {
            uid, jobId, kind: "meshy_refund",
            credits: GENERATION_COST,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
}
/**
 * A per-uid-per-day counter document, not a range query over meshyJobs.
 *
 * The original version queried meshyJobs with an equality filter (uid) plus a
 * range filter (createdAt > since) — Firestore has no automatic index for
 * that combination, so it 500'd on the very first real call, with the actual
 * cause visible only in Cloud Logging (the client response is deliberately
 * generic). A composite index would fix it too, but takes minutes to build
 * and is more moving parts than a counter needs: one document read, one
 * transactional write, never an index, and it counts attempts rather than
 * scanning history that only grows.
 */
async function enforceRateLimit(uid) {
    const day = new Date().toISOString().slice(0, 10); // UTC calendar day
    const ref = admin.firestore().collection("meshyRateLimits").doc(`${uid}_${day}`);
    await admin.firestore().runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        const count = Number(snap.data()?.count ?? 0);
        if (count >= MAX_JOBS_PER_DAY) {
            throw httpError(429, "Daily generation limit reached. Try again tomorrow.");
        }
        transaction.set(ref, { uid, day, count: count + 1, updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
    });
}
/** POST /  { image: <data URI> | prompt: string, style?, name?, kind: "landmark" | "business" | "ar-filter" } */
exports.meshyGenerate = (0, https_1.onRequest)({ secrets: [meshyApiKey], cors: false, memory: "512MiB", timeoutSeconds: 120 }, async (req, res) => {
    try {
        if (req.method !== "POST")
            throw httpError(405, "POST only.");
        const uid = await requireUid(req);
        const kind = req.body?.kind === "landmark" ? "landmark"
            : req.body?.kind === "ar-filter" ? "ar-filter" : "business";
        await authorize(uid, kind);
        await enforceRateLimit(uid);
        const image = String(req.body?.image ?? "");
        const prompt = String(req.body?.prompt ?? "").trim();
        const textJob = prompt.length > 0;
        if (!textJob && !image.startsWith("data:image/"))
            throw httpError(400, "image must be a data URI, or send a prompt.");
        if (textJob && prompt.length > 800)
            throw httpError(400, "Keep the prompt under 800 characters.");
        const jobId = admin.firestore().collection("meshyJobs").doc().id;
        await debitCredits(uid, jobId);
        const api = textJob ? MESHY_TEXT_API : MESHY_API;
        const meshy = await fetch(api, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${meshyApiKey.value()}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(textJob
                ? {
                    // Preview first: geometry only. Status hands it to refine for
                    // textures once it lands, so the caller sees one job end to end.
                    mode: "preview",
                    prompt,
                    ai_model: "latest",
                    // Required, or topology/target_polycount are ignored and the
                    // default is an undecimated ~30k-face mesh.
                    should_remesh: true,
                    topology: "triangle",
                    // Phone-weight: a face accessory is small on screen, and polycount
                    // past this only costs decode time (see meshy.ts on 20MB exports).
                    target_polycount: 5000,
                    target_formats: ["glb"],
                    moderation: true,
                }
                : {
                    image_url: image,
                    enable_pbr: true,
                    should_remesh: true,
                    // Named so a Meshy-side audit can be traced back to a Poplur job
                    // without exposing the uid to the vendor.
                    name: String(req.body?.name ?? `poplur_${kind}_${jobId.slice(0, 8)}`),
                }),
        });
        if (!meshy.ok) {
            await refundCredits(uid, jobId);
            firebase_functions_1.logger.error("meshy_start_failed", { status: meshy.status, jobId });
            throw httpError(502, "The model service refused the job. You were not charged.");
        }
        const started = await meshy.json();
        const taskId = started.result;
        if (!taskId) {
            await refundCredits(uid, jobId);
            throw httpError(502, "The model service did not return a task. You were not charged.");
        }
        await admin.firestore().collection("meshyJobs").doc(jobId).set({
            uid, kind, taskId, status: "PENDING",
            api,
            stage: textJob ? "preview" : "single",
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        });
        res.json({ taskId: jobId });
    }
    catch (error) {
        respondWithError(res, error, "meshy_generate");
    }
});
/** GET /{jobId} -> { status, progress, modelUrl? } */
exports.meshyStatus = (0, https_1.onRequest)({ secrets: [meshyApiKey], cors: false, memory: "512MiB", timeoutSeconds: 120 }, async (req, res) => {
    try {
        const uid = await requireUid(req);
        const jobId = req.path.split("/").filter(Boolean).pop() ?? "";
        const jobRef = admin.firestore().collection("meshyJobs").doc(jobId);
        const job = await jobRef.get();
        // Ownership, not just authentication: one account must never poll (or
        // collect the model from) another account's job.
        if (!job.exists || job.data()?.uid !== uid)
            throw httpError(404, "No such job.");
        const data = job.data();
        if (data.status === "SUCCEEDED" && data.modelUrl) {
            res.json({ status: "SUCCEEDED", progress: 100, modelUrl: data.modelUrl });
            return;
        }
        const api = typeof data.api === "string" ? data.api : MESHY_API;
        const poll = await fetch(`${api}/${data.taskId}`, {
            headers: { Authorization: `Bearer ${meshyApiKey.value()}` },
        });
        if (!poll.ok)
            throw httpError(502, "Could not read the job status.");
        const task = await poll.json();
        if (task.status === "FAILED" || task.status === "CANCELED" || task.status === "EXPIRED") {
            await refundCredits(uid, jobId);
            await jobRef.set({ status: "FAILED" }, { merge: true });
            res.json({ status: "FAILED", progress: task.progress ?? 0 });
            return;
        }
        // A text job's preview is geometry only. Hand it straight to refine so
        // the caller gets a painted GLB from one job; the preview counts as the
        // first half of the progress bar.
        if (task.status === "SUCCEEDED" && data.stage === "preview") {
            // Claim the hand-off atomically first: two polls in flight would
            // otherwise both see a finished preview and both start (and pay for)
            // a refine. The loser reports progress and lets the winner's job run.
            const claimed = await admin.firestore().runTransaction(async (transaction) => {
                const fresh = await transaction.get(jobRef);
                if (fresh.data()?.stage !== "preview")
                    return false;
                transaction.set(jobRef, { stage: "refining" }, { merge: true });
                return true;
            });
            if (!claimed) {
                res.json({ status: "IN_PROGRESS", progress: 50 });
                return;
            }
            const refine = await fetch(MESHY_TEXT_API, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${meshyApiKey.value()}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    mode: "refine",
                    preview_task_id: data.taskId,
                    enable_pbr: true,
                    ai_model: "latest",
                    target_formats: ["glb"],
                }),
            });
            const started = refine.ok ? await refine.json() : {};
            if (!refine.ok || !started.result) {
                // A paid preview with no refine is a dead end: refund and close the
                // job so the caller stops polling instead of stranding 25 credits.
                await refundCredits(uid, jobId);
                await jobRef.set({ status: "FAILED", stage: "preview-orphaned" }, { merge: true });
                firebase_functions_1.logger.error("meshy_refine_start_failed", { status: refine.status, jobId });
                res.json({ status: "FAILED", progress: 50 });
                return;
            }
            await jobRef.set({ stage: "refine", previewTaskId: data.taskId, taskId: started.result }, { merge: true });
            res.json({ status: "IN_PROGRESS", progress: 50 });
            return;
        }
        if (task.status !== "SUCCEEDED" || !task.model_urls?.glb) {
            const progress = task.progress ?? 0;
            res.json({
                status: task.status ?? "PENDING",
                progress: data.stage === "preview" ? Math.round(progress / 2)
                    : data.stage === "refine" ? 50 + Math.round(progress / 2) : progress,
            });
            return;
        }
        // Take a copy: Meshy's URL expires, and handing it to the client leaks the
        // vendor into the app and breaks the model later.
        const glb = await fetch(task.model_urls.glb);
        if (!glb.ok)
            throw httpError(502, "The finished model could not be collected.");
        const bytes = Buffer.from(await glb.arrayBuffer());
        const path = data.kind === "landmark"
            ? `landmarks/pending/${jobId}.glb` // pending: a human approves before it ships
            : data.kind === "ar-filter"
                ? `ar-filters/pending/${jobId}.glb` // pending: the pack build copies what is approved
                : `businessModels/${uid}/${jobId}.glb`;
        const file = admin.storage().bucket().file(path);
        await file.save(bytes, { contentType: "model/gltf-binary" });
        const [modelUrl] = await file.getSignedUrl({
            action: "read",
            expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        });
        await jobRef.set({ status: "SUCCEEDED", modelUrl, storagePath: path }, { merge: true });
        res.json({ status: "SUCCEEDED", progress: 100, modelUrl });
    }
    catch (error) {
        respondWithError(res, error, "meshy_status");
    }
});
function respondWithError(res, error, tag) {
    if (error instanceof MeshyHttpError) {
        res.status(error.status).json({ error: error.message });
        return;
    }
    firebase_functions_1.logger.error(`${tag}_unexpected`, {
        error: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
    res.status(500).json({ error: "Model generation is unavailable right now." });
}
