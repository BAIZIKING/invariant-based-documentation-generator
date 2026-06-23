import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { LLMConfig, Conversation, LLMResult, SYSTEM_PROMPT } from "./main";
import { z } from "zod";

// OpenAI's ChatGPT, a local Ollama server, and a LiteLLM gateway (e.g. CMU's
// https://ai-gateway.andrew.cmu.edu) all expose the same OpenAI chat-completions
// API. They differ only in the base URL and the API key, so a single adapter
// built on the OpenAI SDK serves all three; `config.baseURL` selects which.

function makeClient(config: LLMConfig): OpenAI {
    return new OpenAI({
        apiKey: config.apiKey,
        // undefined -> the SDK's default (the real OpenAI endpoint); Ollama and
        // LiteLLM set this to their own host.
        baseURL: config.baseURL,
    });
}

export async function query_openai(prompt: string, config: LLMConfig, schema?: z.ZodType): Promise<LLMResult> {
    const client = makeClient(config);
    const response = await client.responses.create({
        model: config.model,
        instructions: SYSTEM_PROMPT,
        input: prompt,
        ...(schema && { text: { format: zodTextFormat(schema, "list") } })
    });
    // Return this turn's id so the next turn can continue via previous_response_id.
    return { text: extractText(response), responseId: response.id };
}

// Continues via the Responses API's server-side state: when we have the previous
// turn's id, send only the new prompt plus `previous_response_id` and let the
// server supply the history. If no id is available (e.g. a backend that didn't
// return one), fall back to replaying the full message history.
export async function continue_openai(
    prompt: string,
    prev: Conversation,
    config: LLMConfig,
    schema?: z.ZodType
): Promise<LLMResult> {
    const client = makeClient(config);
    const format = schema && { text: { format: zodTextFormat(schema, "list") } };
    const response = prev.previousResponseId
        ? await client.responses.create({
            model: config.model,
            instructions: SYSTEM_PROMPT,
            previous_response_id: prev.previousResponseId,
            input: prompt,
            ...format,
        })
        : await client.responses.create({
            model: config.model,
            instructions: SYSTEM_PROMPT,
            input: [...prev.messages, { role: "user", content: prompt }],
            ...format,
        });
    return { text: extractText(response), responseId: response.id };
}

function extractText(response: OpenAI.Responses.Response): string {
    const text = response.output_text;
    if (!text) {
        throw new Error("The model returned no text content.");
    }
    return text;
}
