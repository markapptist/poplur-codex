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
exports.poplurPassOnProfileChange = exports.poplurPassWebService = void 0;
const node_http2_1 = require("node:http2");
const admin = __importStar(require("firebase-admin"));
const firebase_functions_1 = require("firebase-functions");
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-functions/v2/firestore");
const firestore_2 = require("firebase-admin/firestore");
const walletPass_1 = require("./walletPass");
/**
 * Apple's PassKit Web Service, so an installed pass can change after it is
 * added instead of being a snapshot frozen at the moment of the tap.
 *
 * The protocol is five endpoints and one push. A device registers itself and
 * its APNs token against a pass; when the pass content changes we push an EMPTY
 * payload to those tokens; the device then asks us for the pass again and
 * replaces what it holds. Wallet never receives content over push — the push is
 * only a nudge — so nothing sensitive travels through APNs.
 *
 * @see https://developer.apple.com/documentation/walletpasses
 */
const passSignerCert = (0, params_1.defineSecret)("POPLUR_PASS_SIGNER_CERT");
const passSignerKey = (0, params_1.defineSecret)("POPLUR_PASS_SIGNER_KEY");
/**
 * Only an ENCRYPTED signing key needs this, and ours is not encrypted, so it is
 * read from the environment rather than declared as a secret: Secret Manager
 * rejects an empty payload, and requiring a secret that must exist but has
 * nothing meaningful in it would have meant inventing a sentinel value for
 * every deploy. If an encrypted key is ever used, add it back as a
 * defineSecret and list it in the secrets array below.
 */
const passSignerKeyPassphrase = process.env.POPLUR_PASS_SIGNER_KEY_PASSPHRASE || undefined;
const passWWDRCert = (0, params_1.defineSecret)("POPLUR_PASS_WWDR_CERT");
const passTypeIdentifier = (0, params_1.defineString)("POPLUR_PASS_TYPE_ID", {
    default: "pass.com.apptist.Poplur2025.card",
});
// Apptist Inc.'s team, read off the developer portal. Not a secret — it is
// printed inside every pass and every provisioning profile — so it ships as a
// default rather than as one more thing to configure before this works.
const passTeamIdentifier = (0, params_1.defineString)("POPLUR_PASS_TEAM_ID", { default: "VDQS4882Z8" });
const passWebServiceURL = (0, params_1.defineString)("POPLUR_PASS_WEB_SERVICE_URL", { default: "" });
const PASS_SECRETS = [passSignerCert, passSignerKey, passWWDRCert];
/** `{uid}.{cardId}` — the serial minted in walletPass.ts. */
function parseSerial(serialNumber) {
    const separator = serialNumber.lastIndexOf(".");
    if (separator <= 0)
        return null;
    const uid = serialNumber.slice(0, separator);
    const cardID = serialNumber.slice(separator + 1);
    if (!uid || !(cardID in walletPass_1.CARD_ASSET))
        return null;
    return { uid, cardID };
}
/**
 * Every authenticated endpoint carries `Authorization: ApplePass <token>`.
 * Compared against the token stored when the pass was minted — and compared in
 * constant time, because a length-varying compare on a secret handed out inside
 * a shareable file is exactly the kind of oracle worth not building.
 */
async function authorizedFor(request, serialNumber) {
    const header = request.get("authorization") ?? "";
    const presented = header.startsWith("ApplePass ") ? header.slice("ApplePass ".length) : "";
    if (!presented)
        return false;
    const snapshot = await admin.firestore().collection("walletPasses").doc(serialNumber).get();
    const expected = snapshot.data()?.authenticationToken;
    if (typeof expected !== "string" || expected.length !== presented.length)
        return false;
    const { timingSafeEqual } = await Promise.resolve().then(() => __importStar(require("node:crypto")));
    return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}
function certificatesConfigured() {
    return Boolean(passSignerCert.value() && passSignerKey.value()
        && passWWDRCert.value() && passTeamIdentifier.value());
}
/** Re-signs the pass from current profile data. */
async function currentPass(uid, cardID, serialNumber) {
    const { handle, displayName } = await (0, walletPass_1.profileFor)(uid);
    const token = (await admin.firestore().collection("walletPasses").doc(serialNumber).get())
        .data()?.authenticationToken;
    return await (0, walletPass_1.buildCardPass)({
        cardID,
        assetKey: walletPass_1.CARD_ASSET[cardID],
        handle,
        displayName,
        serialNumber,
        passTypeIdentifier: passTypeIdentifier.value(),
        teamIdentifier: passTeamIdentifier.value(),
        authenticationToken: token,
        webServiceURL: passWebServiceURL.value() || undefined,
        certificates: {
            wwdr: passWWDRCert.value(),
            signerCert: passSignerCert.value(),
            signerKey: passSignerKey.value(),
            signerKeyPassphrase: passSignerKeyPassphrase,
        },
    });
}
exports.poplurPassWebService = (0, https_1.onRequest)({ secrets: PASS_SECRETS, memory: "512MiB", timeoutSeconds: 60, cors: false }, async (request, response) => {
    // Firebase strips the function name, so paths arrive as /v1/... regardless
    // of whether this is hosted at the function URL or behind a rewrite.
    const path = request.path.replace(/^\/+/, "");
    const segments = path.split("/").filter(Boolean);
    try {
        // POST /v1/log — Wallet's own diagnostics. Always 200; a failure here
        // must never look like a pass problem.
        if (segments[0] === "v1" && segments[1] === "log") {
            firebase_functions_1.logger.info("Wallet pass log", { logs: request.body?.logs });
            response.status(200).send("");
            return;
        }
        // /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeId}[/{serial}]
        if (segments[0] === "v1" && segments[1] === "devices" && segments[3] === "registrations") {
            const deviceLibraryIdentifier = segments[2];
            const serialNumber = segments[5];
            // GET without a serial: which of this device's passes changed since TAG.
            if (request.method === "GET" && !serialNumber) {
                const since = typeof request.query.passesUpdatedSince === "string"
                    ? Number(request.query.passesUpdatedSince)
                    : 0;
                const registrations = await admin.firestore()
                    .collection("walletPassRegistrations")
                    .where("deviceLibraryIdentifier", "==", deviceLibraryIdentifier)
                    .get();
                const serials = [];
                let lastUpdated = since;
                for (const doc of registrations.docs) {
                    const serial = doc.data().serialNumber;
                    const passDoc = await admin.firestore().collection("walletPasses").doc(serial).get();
                    const updatedAt = passDoc.data()?.contentUpdatedAt?.toMillis?.() ?? 0;
                    if (updatedAt > since) {
                        serials.push(serial);
                        lastUpdated = Math.max(lastUpdated, updatedAt);
                    }
                }
                if (serials.length === 0) {
                    response.status(204).send("");
                    return;
                }
                response.status(200).json({ lastUpdated: String(lastUpdated), serialNumbers: serials });
                return;
            }
            if (!serialNumber || !parseSerial(serialNumber)) {
                response.status(404).send("");
                return;
            }
            if (!(await authorizedFor(request, serialNumber))) {
                response.status(401).send("");
                return;
            }
            const registrationID = `${deviceLibraryIdentifier}.${serialNumber}`;
            const registrationRef = admin.firestore()
                .collection("walletPassRegistrations").doc(registrationID);
            if (request.method === "POST") {
                const pushToken = request.body?.pushToken;
                if (typeof pushToken !== "string" || !pushToken) {
                    response.status(400).send("");
                    return;
                }
                const existing = await registrationRef.get();
                await registrationRef.set({
                    deviceLibraryIdentifier,
                    serialNumber,
                    pushToken,
                    updatedAt: firestore_2.FieldValue.serverTimestamp(),
                });
                // 201 the first time, 200 on a repeat — Wallet uses the difference.
                response.status(existing.exists ? 200 : 201).send("");
                return;
            }
            if (request.method === "DELETE") {
                await registrationRef.delete();
                response.status(200).send("");
                return;
            }
            response.status(405).send("");
            return;
        }
        // GET /v1/passes/{passTypeIdentifier}/{serialNumber} — hand back the
        // latest pass. This is what the device calls after a push.
        if (segments[0] === "v1" && segments[1] === "passes" && segments.length >= 4) {
            const serialNumber = segments[3];
            const parsed = parseSerial(serialNumber);
            if (!parsed) {
                response.status(404).send("");
                return;
            }
            if (!(await authorizedFor(request, serialNumber))) {
                response.status(401).send("");
                return;
            }
            if (!certificatesConfigured()) {
                firebase_functions_1.logger.error("Pass update requested before signing was configured");
                response.status(500).send("");
                return;
            }
            // Ownership is re-checked on every re-issue, not just at the first add:
            // a refunded or revoked card should stop updating rather than keep
            // living in a wallet forever.
            if (!(await (0, walletPass_1.ownsCard)(parsed.uid, parsed.cardID))) {
                response.status(401).send("");
                return;
            }
            const passDoc = await admin.firestore()
                .collection("walletPasses").doc(serialNumber).get();
            const updatedAt = passDoc.data()?.contentUpdatedAt?.toMillis?.() ?? 0;
            const ifModifiedSince = Date.parse(request.get("if-modified-since") ?? "");
            // Second granularity: the header carries whole seconds, so comparing
            // against millisecond precision would re-send the pass every time.
            if (Number.isFinite(ifModifiedSince)
                && updatedAt > 0
                && Math.floor(updatedAt / 1000) <= Math.floor(ifModifiedSince / 1000)) {
                response.status(304).send("");
                return;
            }
            const pkpass = await currentPass(parsed.uid, parsed.cardID, serialNumber);
            response.status(200);
            response.set("Content-Type", "application/vnd.apple.pkpass");
            response.set("Last-Modified", new Date(updatedAt || Date.now()).toUTCString());
            response.send(pkpass);
            return;
        }
        response.status(404).send("");
    }
    catch (error) {
        firebase_functions_1.logger.error("Wallet pass web service failed", { error: String(error), path });
        response.status(500).send("");
    }
});
/**
 * The nudge. An empty APNs payload on the pass topic tells every registered
 * device to come back and re-fetch; Wallet then shows the new content.
 *
 * Authenticated with the SAME Pass Type ID certificate that signs the pass —
 * APNs uses it as a client TLS certificate, which is why no separate push key
 * is needed and why this cannot work until the certificate exists.
 */
async function pushPassUpdate(pushTokens) {
    if (pushTokens.length === 0)
        return;
    if (!certificatesConfigured()) {
        firebase_functions_1.logger.warn("Skipping pass push — signing certificate is not configured");
        return;
    }
    const client = (0, node_http2_1.connect)("https://api.push.apple.com", {
        cert: passSignerCert.value(),
        key: passSignerKey.value(),
        passphrase: passSignerKeyPassphrase,
    });
    try {
        await Promise.all(pushTokens.map(token => new Promise(resolve => {
            const stream = client.request({
                ":method": "POST",
                ":path": `/3/device/${token}`,
                "apns-topic": passTypeIdentifier.value(),
                "apns-push-type": "background",
                "content-type": "application/json",
            });
            stream.setEncoding("utf8");
            let body = "";
            stream.on("data", chunk => { body += chunk; });
            stream.on("response", headers => {
                const status = headers[":status"];
                if (status !== 200) {
                    // A 410 means the device dropped the pass. Logged rather than
                    // thrown: one dead token must not stop the rest of the fan-out.
                    firebase_functions_1.logger.warn("APNs rejected a pass push", { status, body });
                }
            });
            stream.on("error", error => {
                firebase_functions_1.logger.warn("APNs push failed", { error: String(error) });
                resolve();
            });
            stream.on("end", () => resolve());
            // Wallet ignores the payload entirely; it is the wake-up that counts.
            stream.end("{}");
        })));
    }
    finally {
        client.close();
    }
}
/**
 * What actually changes on a Poplur pass: the holder's name and handle.
 *
 * Deliberately NOT the radius. Radius decays continuously, so pushing on it
 * would wake every device in the fleet constantly to redraw a number that had
 * already moved again — the pass carries identity, which changes rarely and
 * visibly, and that is what is worth a push.
 */
exports.poplurPassOnProfileChange = (0, firestore_1.onDocumentUpdated)({ document: "users/{uid}", secrets: PASS_SECRETS }, async (event) => {
    const before = event.data?.before.data() ?? {};
    const after = event.data?.after.data() ?? {};
    const identityChanged = before.username !== after.username
        || before.handle !== after.handle
        || before.displayName !== after.displayName;
    if (!identityChanged)
        return;
    const uid = event.params.uid;
    const db = admin.firestore();
    const passes = await db.collection("walletPasses").where("userId", "==", uid).get();
    if (passes.empty)
        return;
    const stamped = firestore_2.FieldValue.serverTimestamp();
    const tokens = [];
    for (const passDoc of passes.docs) {
        await passDoc.ref.set({ contentUpdatedAt: stamped }, { merge: true });
        const registrations = await db.collection("walletPassRegistrations")
            .where("serialNumber", "==", passDoc.id)
            .get();
        for (const registration of registrations.docs) {
            const token = registration.data().pushToken;
            if (typeof token === "string" && token)
                tokens.push(token);
        }
    }
    firebase_functions_1.logger.info("Pushing wallet pass update", { uid, passes: passes.size, devices: tokens.length });
    await pushPassUpdate([...new Set(tokens)]);
});
