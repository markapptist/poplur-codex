"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildGoogleInteractionRequest = buildGoogleInteractionRequest;
exports.shouldUseVertexImageFallback = shouldUseVertexImageFallback;
exports.supportsVertexImageFallback = supportsVertexImageFallback;
exports.buildVertexImageRequest = buildVertexImageRequest;
exports.boundedInlineGeneratedImage = boundedInlineGeneratedImage;
exports.callVertexImageGeneration = callVertexImageGeneration;
const firebase_functions_1 = require("firebase-functions");
const googleapis_1 = require("googleapis");
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const defaultVertexLocation = "us-central1";
const defaultVertexImageModel = "gemini-2.5-flash-image";
const maxInlineImageBytes = 8 * 1024 * 1024;
const supportedInlineImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
function interactionResponseModalities(contentType) {
    if (contentType === "video")
        return ["video"];
    if (contentType === "voice")
        return ["audio"];
    return ["text"];
}
/** Build the Google Interactions request without the unsupported top-level
 * metadata or image response_modalities fields that previously broke edits. */
function buildGoogleInteractionRequest(input) {
    const sourceInput = input.sourceImage
        ? [
            { type: "text", text: input.prompt },
            { type: "image", mime_type: input.sourceImage.mimeType, data: input.sourceImage.data },
        ]
        : input.prompt;
    const imageOutput = input.contentType === "image"
        || input.contentType === "edit"
        || input.contentType === "vfx"
        || input.contentType === "3d";
    return {
        model: input.model,
        input: sourceInput,
        ...(input.contentType === "video" ? { background: true } : {}),
        ...(imageOutput ? {
            response_format: {
                type: "image",
                mime_type: "image/jpeg",
            },
        } : {
            generation_config: {
                response_modalities: interactionResponseModalities(input.contentType),
            },
        }),
    };
}
function shouldUseVertexImageFallback(status) {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
function supportsVertexImageFallback(contentType) {
    return contentType === "image" || contentType === "edit";
}
function buildVertexImageRequest(prompt, sourceImage) {
    const parts = [{ text: prompt }];
    if (sourceImage) {
        parts.push({
            inlineData: {
                mimeType: sourceImage.mimeType,
                data: sourceImage.data,
            },
        });
    }
    return {
        contents: [{ role: "user", parts }],
        generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
        },
    };
}
function boundedInlineGeneratedImage(asset) {
    if (!supportedInlineImageTypes.has(asset.mimeType)) {
        throw new Error("Vertex returned an unsupported generated image type.");
    }
    if (!asset.bytes.length || asset.bytes.length > maxInlineImageBytes) {
        throw new Error("The generated image exceeds the 8 MiB response limit.");
    }
    return {
        data: asset.bytes.toString("base64"),
        mimeType: asset.mimeType,
    };
}
async function callVertexImageGeneration(input) {
    const auth = new googleapis_1.google.auth.GoogleAuth({ scopes: [cloudPlatformScope] });
    const projectId = process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT ||
        await auth.getProjectId();
    const accessToken = await auth.getAccessToken();
    if (!projectId || !accessToken) {
        throw new Error("Vertex AI Application Default Credentials are unavailable.");
    }
    const configuredLocation = process.env.POPLUR_VERTEX_LOCATION || defaultVertexLocation;
    const location = /^[a-z0-9-]+$/.test(configuredLocation) ? configuredLocation : defaultVertexLocation;
    const model = process.env.POPLUR_VERTEX_IMAGE_MODEL || defaultVertexImageModel;
    const endpoint = [
        `https://${location}-aiplatform.googleapis.com/v1/projects`,
        encodeURIComponent(projectId),
        "locations",
        encodeURIComponent(location),
        "publishers/google/models",
        `${encodeURIComponent(model)}:generateContent`,
    ].join("/");
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(buildVertexImageRequest(input.prompt, input.sourceImage)),
    });
    const responseText = await response.text();
    if (!response.ok) {
        firebase_functions_1.logger.error("vertex_image_provider_failed", {
            status: response.status,
            jobId: input.jobId,
            model,
            location,
        });
        throw new Error(`Vertex AI image generation failed with status ${response.status}.`);
    }
    try {
        return JSON.parse(responseText);
    }
    catch {
        throw new Error("Vertex AI returned an invalid response.");
    }
}
