"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.premiumAiFlow = exports.PremiumAIFlowOutputSchema = exports.PremiumAIFlowInputSchema = exports.PremiumAIActionSchema = void 0;
exports.validatePremiumAIInput = validatePremiumAIInput;
const genkit_1 = require("genkit");
const google_genai_1 = require("@genkit-ai/google-genai");
exports.PremiumAIActionSchema = genkit_1.z.enum([
    "generate_caption",
    "suggest_post_idea",
    "business_promo",
    "translate_caption",
]);
const GenerateCaptionInputSchema = genkit_1.z.object({
    mediaType: genkit_1.z.enum(["image", "video"]),
    locationName: genkit_1.z.string().max(120).optional(),
    userPrompt: genkit_1.z.string().max(1000).optional(),
});
const GenerateCaptionOutputSchema = genkit_1.z.object({
    title: genkit_1.z.string(),
    caption: genkit_1.z.string(),
    hashtags: genkit_1.z.array(genkit_1.z.string()),
    radiusTip: genkit_1.z.string(),
});
const SuggestPostIdeaInputSchema = genkit_1.z.object({
    locationName: genkit_1.z.string().max(120),
    category: genkit_1.z.string().max(80),
    vibe: genkit_1.z.string().max(120),
});
const SuggestPostIdeaOutputSchema = genkit_1.z.object({
    postIdea: genkit_1.z.string(),
    suggestedCaption: genkit_1.z.string(),
    bestTimeToPost: genkit_1.z.string(),
    radiusStrategy: genkit_1.z.string(),
});
const BusinessPromoInputSchema = genkit_1.z.object({
    businessName: genkit_1.z.string().max(120),
    businessType: genkit_1.z.string().max(80),
    offerDetails: genkit_1.z.string().max(500),
    locationName: genkit_1.z.string().max(120),
});
const BusinessPromoOutputSchema = genkit_1.z.object({
    promoTitle: genkit_1.z.string(),
    promoCaption: genkit_1.z.string(),
    couponText: genkit_1.z.string(),
    callToAction: genkit_1.z.string(),
});
const TranslateCaptionInputSchema = genkit_1.z.object({
    text: genkit_1.z.string().min(1).max(2000),
    targetLanguage: genkit_1.z.string().min(2).max(80),
});
const TranslateCaptionOutputSchema = genkit_1.z.object({
    translatedText: genkit_1.z.string(),
});
exports.PremiumAIFlowInputSchema = genkit_1.z.object({
    action: exports.PremiumAIActionSchema,
    input: genkit_1.z.record(genkit_1.z.unknown()),
});
exports.PremiumAIFlowOutputSchema = genkit_1.z.object({
    action: exports.PremiumAIActionSchema,
    output: genkit_1.z.record(genkit_1.z.unknown()),
});
const ai = (0, genkit_1.genkit)({
    plugins: [(0, google_genai_1.googleAI)()],
});
const modelName = process.env.POPLUR_AI_MODEL || "gemini-flash-latest";
function validatePremiumAIInput(action, input) {
    switch (action) {
        case "generate_caption":
            return GenerateCaptionInputSchema.parse(input);
        case "suggest_post_idea":
            return SuggestPostIdeaInputSchema.parse(input);
        case "business_promo":
            return BusinessPromoInputSchema.parse(input);
        case "translate_caption":
            return TranslateCaptionInputSchema.parse(input);
    }
}
exports.premiumAiFlow = ai.defineFlow({
    name: "premiumAiFlow",
    inputSchema: exports.PremiumAIFlowInputSchema,
    outputSchema: exports.PremiumAIFlowOutputSchema,
}, async ({ action, input }) => {
    switch (action) {
        case "generate_caption": {
            const parsed = GenerateCaptionInputSchema.parse(input);
            const output = await generateStructured([
                "You are Poplur's premium create-flow assistant.",
                "Return punchy, map-native social copy as JSON only.",
                `Media type: ${parsed.mediaType}`,
                parsed.locationName ? `Location: ${parsed.locationName}` : "Location: not provided",
                parsed.userPrompt ? `Creator direction: ${parsed.userPrompt}` : "Creator direction: infer a tasteful local angle",
            ].join("\n"), GenerateCaptionOutputSchema, mockCaption(parsed));
            return { action, output };
        }
        case "suggest_post_idea": {
            const parsed = SuggestPostIdeaInputSchema.parse(input);
            const output = await generateStructured([
                "You are Poplur's premium local content strategist.",
                "Return one concrete post idea as JSON only.",
                `Location: ${parsed.locationName}`,
                `Category: ${parsed.category}`,
                `Vibe: ${parsed.vibe}`,
            ].join("\n"), SuggestPostIdeaOutputSchema, mockPostIdea(parsed));
            return { action, output };
        }
        case "business_promo": {
            const parsed = BusinessPromoInputSchema.parse(input);
            const output = await generateStructured([
                "You are Poplur's premium business promo generator.",
                "Write local promotional copy that is clear, specific, and not spammy. Return JSON only.",
                `Business: ${parsed.businessName}`,
                `Type: ${parsed.businessType}`,
                `Offer: ${parsed.offerDetails}`,
                `Location: ${parsed.locationName}`,
            ].join("\n"), BusinessPromoOutputSchema, mockBusinessPromo(parsed));
            return { action, output };
        }
        case "translate_caption": {
            const parsed = TranslateCaptionInputSchema.parse(input);
            const output = await generateStructured([
                "Translate the caption for Poplur while keeping hashtags and proper nouns natural.",
                "Return JSON only.",
                `Target language: ${parsed.targetLanguage}`,
                `Caption: ${parsed.text}`,
            ].join("\n"), TranslateCaptionOutputSchema, mockTranslation(parsed));
            return { action, output };
        }
    }
});
async function generateStructured(prompt, schema, emulatorFallback) {
    if (!process.env.GEMINI_API_KEY && process.env.FUNCTIONS_EMULATOR === "true") {
        return emulatorFallback;
    }
    const response = await ai.generate({
        model: google_genai_1.googleAI.model(modelName),
        prompt,
        output: { schema },
    });
    if (!response.output) {
        throw new Error("AI provider returned no structured output.");
    }
    return response.output;
}
function mockCaption(input) {
    const place = input.locationName || "right here";
    return {
        title: `Poplur moment in ${place}`,
        caption: `A fresh ${input.mediaType} from ${place}. ${input.userPrompt || "Tap in and see what is happening nearby."}`,
        hashtags: ["#Poplur", "#Local", "#Radius"],
        radiusTip: "Start with a tight radius, then boost if early engagement is strong.",
    };
}
function mockPostIdea(input) {
    return {
        postIdea: `Capture a ${input.vibe} ${input.category} moment at ${input.locationName}.`,
        suggestedCaption: `Found this at ${input.locationName}. Worth the radius.`,
        bestTimeToPost: "Late afternoon or early evening when local traffic is highest.",
        radiusStrategy: "Begin local, watch saves and replies, then expand radius.",
    };
}
function mockBusinessPromo(input) {
    return {
        promoTitle: `${input.businessName} local drop`,
        promoCaption: `${input.offerDetails} at ${input.businessName} in ${input.locationName}.`,
        couponText: "Show this Poplur post in-store.",
        callToAction: "Tap in, save it, and stop by today.",
    };
}
function mockTranslation(input) {
    return {
        translatedText: `[${input.targetLanguage}] ${input.text}`,
    };
}
