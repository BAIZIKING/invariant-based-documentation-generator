import { LLMConfig, Conversation, LLMResult, SYSTEM_PROMPT } from "./main";
import { z } from "zod";

// Gemini's interactions API takes a JSON Schema for structured output; derive it
// from the shared Zod schema (the same schema OpenAI/Anthropic get).
function responseFormat(schema?: z.ZodType) {
    if (!schema) {
        return undefined;
    }
    return {
        response_format: {
            type: "text" as const,
            mime_type: "application/json",
            schema: z.toJSONSchema(schema),
        },
    };
}

export async function query_gemini(prompt: string, config: LLMConfig, schema?: z.ZodType): Promise<LLMResult> {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({apiKey: config.apiKey});
    const interaction = await ai.interactions.create({
        model: config.model,
        input: prompt,
        system_instruction: SYSTEM_PROMPT,
        ...responseFormat(schema),
    });
    // Return this interaction's id so the next turn can continue from it.
    return { text: extractText(interaction), responseId: interaction.id };
}

// Continues via the interactions API's server-side state: reference the previous
// interaction by id and send only the new prompt.
export async function continue_gemini(prompt: string, prev: Conversation, config: LLMConfig, schema?: z.ZodType): Promise<LLMResult> {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({apiKey: config.apiKey});
    const interaction = await ai.interactions.create({
        model: config.model,
        input: prompt,
        system_instruction: SYSTEM_PROMPT,
        ...(prev.previousResponseId && { previous_interaction_id: prev.previousResponseId }),
        ...responseFormat(schema),
    });
    return { text: extractText(interaction), responseId: interaction.id };
}

function extractText(response: any): string {
    const text = response.output_text;
    if (!text) {
        throw new Error("The model returned no text content.");
    }
    return text;
}
