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
exports.poplurWalletPass = exports.poplurOwnedCards = exports.CARD_ASSET = void 0;
exports.ownsCard = ownsCard;
exports.profileFor = profileFor;
exports.passAuthenticationToken = passAuthenticationToken;
exports.buildCardPass = buildCardPass;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
/**
 * Issues an Apple Wallet pass for a Poplur card the caller actually owns.
 *
 * A Wallet pass is STATIC 2D — images, text fields and a barcode. The cards are
 * SceneKit models that turn, and none of that survives, so the pass carries the
 * flat poster that already ships in the app rather than a render of the model.
 * No new artwork is produced here; `pass-assets/` holds resized copies of the
 * posters and the app icon and nothing else.
 *
 * It is deliberately a `generic` pass and not a `storeCard`. Apple expects a
 * pass to DO something — a purely decorative collectible reads as off-label at
 * review — so this is issued as an identity card: the holder's handle, the card
 * they own, and a QR that resolves to their profile. That also makes it useful
 * in Poplur's own terms, since a scanned card is another way to be found.
 * `generic` is also the style whose thumbnail is square (90/180/270), which is
 * exactly the posters' native 720x720 — a `storeCard` strip is a wide banner and
 * would have meant cropping the art.
 */
/** PEM, from the Pass Type ID certificate issued in the Apple Developer portal. */
const passSignerCert = (0, params_1.defineSecret)("POPLUR_PASS_SIGNER_CERT");
/** PEM private key for the above. Encrypted keys need the passphrase secret. */
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
/** Apple WWDR intermediate, PEM. Public, but kept beside the rest for one setup path. */
const passWWDRCert = (0, params_1.defineSecret)("POPLUR_PASS_WWDR_CERT");
/** Not secrets — they are printed on the pass and visible to anyone holding it. */
const passTypeIdentifier = (0, params_1.defineString)("POPLUR_PASS_TYPE_ID", {
    default: "pass.com.apptist.Poplur2025.card",
});
// Apptist Inc.'s team, read off the developer portal. Not a secret — it is
// printed inside every pass and every provisioning profile — so it ships as a
// default rather than as one more thing to configure before this works.
const passTeamIdentifier = (0, params_1.defineString)("POPLUR_PASS_TEAM_ID", { default: "VDQS4882Z8" });
/**
 * Where Wallet asks for updates. Empty means "no update service": the pass is
 * then a snapshot, which is the correct behaviour before the web service is
 * deployed — advertising a URL that 404s would leave Wallet retrying forever.
 */
const passWebServiceURL = (0, params_1.defineString)("POPLUR_PASS_WEB_SERVICE_URL", { default: "" });
/** The four purchasable cards, keyed exactly as cardPurchases.ts records them. */
const CARD_NAMES = {
    inverted: "Inverted",
    lens: "Lens",
    splitDiamond: "Split Diamond",
    swoosh: "Swoosh",
};
/** cardID -> the poster basename in pass-assets. Only these ids are issuable. */
exports.CARD_ASSET = {
    inverted: "inverted",
    lens: "lens",
    splitDiamond: "split_diamond",
    swoosh: "swoosh",
};
// The card posters are product shots on a LIGHT backdrop (they double as store
// tiles), and the generic pass shows that thumbnail large. On Poplur's usual
// dark ground it read as a bright white tile stuck to a black card, so the pass
// takes the poster's side instead: light ground, dark ink, and the darker pink
// the app already uses for pink-on-light (NewsPaper's #c81d5e), not the neon
// that only works on black.
const PASS_BACKGROUND = "rgb(244, 244, 246)";
const PASS_INK = "rgb(22, 6, 15)";
const PASS_LABEL_PINK = "rgb(200, 29, 94)";
function assetPath(name) {
    return (0, node_path_1.join)(__dirname, "pass-assets", name);
}
function readAsset(name) {
    return (0, node_fs_1.readFileSync)(assetPath(name));
}
/**
 * Ownership comes from the same record the purchase verifier writes, so a pass
 * cannot be minted for a card the caller never bought. `verifiedStorePurchases`
 * is keyed by receipt fingerprint and carries `{userId, cardId}`; one matching
 * document is proof.
 */
async function ownsCard(uid, cardID) {
    const snapshot = await admin
        .firestore()
        .collection("verifiedStorePurchases")
        .where("userId", "==", uid)
        .where("cardId", "==", cardID)
        .limit(1)
        .get();
    return !snapshot.empty;
}
async function profileFor(uid) {
    const snapshot = await admin.firestore().collection("users").doc(uid).get();
    const data = snapshot.data() ?? {};
    const handleRaw = typeof data.username === "string" && data.username.trim()
        ? data.username.trim()
        : typeof data.handle === "string" && data.handle.trim()
            ? data.handle.trim()
            : uid.slice(0, 8);
    const handle = handleRaw.startsWith("@") ? handleRaw : `@${handleRaw}`;
    const displayName = typeof data.displayName === "string" && data.displayName.trim()
        ? data.displayName.trim()
        : handle;
    return { handle, displayName };
}
/**
 * Mint-once, reuse-after. Wallet keeps the token from the pass it holds, so
 * regenerating it on every add would silently break updates for every copy
 * already installed. Stored beside the registration state rather than derived
 * from the uid, because a derived token is only as secret as the derivation.
 */
async function passAuthenticationToken(uid, serialNumber) {
    const ref = admin.firestore().collection("walletPasses").doc(serialNumber);
    const snapshot = await ref.get();
    const existing = snapshot.data()?.authenticationToken;
    if (typeof existing === "string" && existing.length > 0) {
        return existing;
    }
    const token = (0, node_crypto_1.randomBytes)(24).toString("hex");
    await ref.set({
        userId: uid,
        authenticationToken: token,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    return token;
}
/**
 * Which cards this user actually owns. The client cannot read
 * `verifiedStorePurchases` (it has no Firestore rule, so it is server-only by
 * default), and without this the Wallet button had to be offered on every card
 * and rejected server-side — an button that fails is worse than no button.
 */
exports.poplurOwnedCards = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "Sign in to see your cards.");
    }
    const snapshot = await admin
        .firestore()
        .collection("verifiedStorePurchases")
        .where("userId", "==", uid)
        .get();
    const cardIds = [
        ...new Set(snapshot.docs
            .map(doc => doc.data().cardId)
            .filter((id) => typeof id === "string" && id in exports.CARD_ASSET)),
    ];
    return { cardIds };
});
exports.poplurWalletPass = (0, https_1.onCall)({
    secrets: [passSignerCert, passSignerKey, passWWDRCert],
    memory: "512MiB",
    timeoutSeconds: 60,
}, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "Sign in to add a card to Wallet.");
    }
    const cardID = typeof request.data?.cardId === "string" ? request.data.cardId : "";
    const assetKey = exports.CARD_ASSET[cardID];
    if (!assetKey) {
        throw new https_1.HttpsError("invalid-argument", `Unknown card "${cardID}".`);
    }
    const teamIdentifier = passTeamIdentifier.value();
    const signerCert = passSignerCert.value();
    const signerKey = passSignerKey.value();
    const wwdr = passWWDRCert.value();
    // Fail with the actual reason. Until the Pass Type ID certificate exists in
    // the Apple Developer portal there is nothing to sign with, and a generic
    // "internal" here would send someone hunting through the client.
    if (!signerCert || !signerKey || !wwdr || !teamIdentifier) {
        const missing = [
            !signerCert && "POPLUR_PASS_SIGNER_CERT",
            !signerKey && "POPLUR_PASS_SIGNER_KEY",
            !wwdr && "POPLUR_PASS_WWDR_CERT",
            !teamIdentifier && "POPLUR_PASS_TEAM_ID",
        ].filter(Boolean).join(", ");
        firebase_functions_1.logger.error("Wallet pass signing is not configured", { missing });
        throw new https_1.HttpsError("failed-precondition", `Wallet passes are not configured yet (missing: ${missing}).`);
    }
    if (!(await ownsCard(uid, cardID))) {
        throw new https_1.HttpsError("permission-denied", "You do not own that card.");
    }
    const { handle, displayName } = await profileFor(uid);
    // The serial is stable per user+card, so re-adding replaces the existing
    // pass in Wallet instead of stacking duplicates every time the button is
    // tapped.
    const serialNumber = `${uid}.${cardID}`;
    // Wallet authenticates every update call with this, so it is a per-pass
    // secret and never the uid: the token travels inside a pass the holder can
    // hand to anyone, and a guessable one would let a stranger pull someone
    // else's pass. Minted once and reused so re-adding does not orphan the
    // registrations Wallet already made against the old token.
    const authenticationToken = await passAuthenticationToken(uid, serialNumber);
    try {
        const pkpass = await buildCardPass({
            cardID,
            assetKey,
            handle,
            displayName,
            serialNumber,
            authenticationToken,
            webServiceURL: passWebServiceURL.value() || undefined,
            passTypeIdentifier: passTypeIdentifier.value(),
            teamIdentifier,
            certificates: {
                wwdr,
                signerCert,
                signerKey,
                signerKeyPassphrase: passSignerKeyPassphrase,
            },
        });
        return { pkpass: pkpass.toString("base64"), serialNumber };
    }
    catch (error) {
        // A signing failure here is almost always a certificate mismatch: the
        // Pass Type ID inside the certificate must equal passTypeIdentifier, and
        // the team must match. Say which, rather than a bare "internal".
        firebase_functions_1.logger.error("Could not sign the pass", {
            error: String(error),
            passTypeIdentifier: passTypeIdentifier.value(),
        });
        throw new https_1.HttpsError("internal", "Could not sign the pass — check that the certificate matches "
            + `${passTypeIdentifier.value()} and team ${teamIdentifier}.`);
    }
});
/**
 * Builds and signs the .pkpass. Deliberately separate from the callable above
 * and free of auth, Firestore and secrets, so the pass itself — assets, fields,
 * barcode, manifest, signature — can be exercised directly in a test with a
 * throwaway certificate instead of only in production.
 */
async function buildCardPass(request) {
    // Imported HERE, not at module scope. passkit-generator pulls in Joi and cost
    // 5.2s of cold require — on top of an index that already loads the Anthropic
    // SDK, genkit and googleapis — which pushed deployment past the 10s backend
    // discovery timeout and failed the deploy outright. Pass signing is rare;
    // paying that cost on the calls that actually sign is the right trade.
    const { PKPass } = await Promise.resolve().then(() => __importStar(require("passkit-generator")));
    const profileURL = `https://poplur.com/u/${request.handle.replace(/^@/, "")}`;
    const pass = new PKPass({}, request.certificates, {
        passTypeIdentifier: request.passTypeIdentifier,
        teamIdentifier: request.teamIdentifier,
        serialNumber: request.serialNumber,
        organizationName: "Poplur",
        description: `Poplur card — ${CARD_NAMES[request.cardID] ?? request.cardID}`,
        // Only advertised together. A pass carrying a webServiceURL but no token
        // (or vice versa) is rejected by Wallet outright.
        ...(request.webServiceURL && request.authenticationToken
            ? {
                webServiceURL: request.webServiceURL,
                authenticationToken: request.authenticationToken,
            }
            : {}),
        foregroundColor: PASS_INK,
        backgroundColor: PASS_BACKGROUND,
        labelColor: PASS_LABEL_PINK,
    });
    pass.type = "generic";
    pass.addBuffer("icon.png", readAsset("icon.png"));
    pass.addBuffer("icon@2x.png", readAsset("icon@2x.png"));
    pass.addBuffer("icon@3x.png", readAsset("icon@3x.png"));
    pass.addBuffer("logo.png", readAsset("logo.png"));
    pass.addBuffer("logo@2x.png", readAsset("logo@2x.png"));
    pass.addBuffer("thumbnail.png", readAsset(`thumbnail-${request.assetKey}.png`));
    pass.addBuffer("thumbnail@2x.png", readAsset(`thumbnail-${request.assetKey}@2x.png`));
    pass.addBuffer("thumbnail@3x.png", readAsset(`thumbnail-${request.assetKey}@3x.png`));
    pass.primaryFields.push({ key: "holder", label: "POPLUR", value: request.displayName });
    pass.secondaryFields.push({ key: "handle", label: "HANDLE", value: request.handle });
    pass.auxiliaryFields.push({
        key: "card",
        label: "CARD",
        value: CARD_NAMES[request.cardID] ?? request.cardID,
    });
    pass.backFields.push({
        key: "about",
        label: "About",
        value: "Your Poplur card. Scan the code to open this profile in Poplur — "
            + "everything you post reaches the people inside your radius.",
    }, { key: "profile", label: "Profile", value: profileURL });
    // The QR is what makes this a card that DOES something rather than a picture
    // in a wallet: someone scans it and lands on the holder's profile.
    pass.setBarcodes({
        message: profileURL,
        format: "PKBarcodeFormatQR",
        messageEncoding: "iso-8859-1",
        altText: request.handle,
    });
    return pass.getAsBuffer();
}
