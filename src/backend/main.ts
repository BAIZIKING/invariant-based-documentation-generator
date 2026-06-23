import { query_claude, continue_claude } from "./anthropic-claude";
import { query_gemini, continue_gemini } from "./google-gemini";
import { query_openai, continue_openai } from "./openai-compatible";
import { z } from "zod";

// Provider-agnostic types shared by the LLM provider adapters.

export const SYSTEM_PROMPT = "You are an expert Python programmer.";

// The supported providers. OpenAI, Ollama, and LiteLLM all speak the OpenAI
// chat-completions API, so they are served by the same adapter; only Anthropic
// needs its own SDK.
export type Provider = "anthropic" | "openai" | "ollama" | "litellm" | "gemini";

export interface LLMConfig {
    apiKey: string;
    model: string;
    provider: Provider;
    // Base URL for the OpenAI-compatible providers (OpenAI / Ollama / LiteLLM).
    // The Anthropic adapter ignores it. When omitted, each provider's default
    // endpoint is used.
    baseURL?: string;
}

// A single conversation turn. Kept provider-agnostic (plain string content) so
// the same history can be replayed against any provider, rather than tying the
// stored conversation to one SDK's message shape.
export interface ChatMessage {
    role: "user" | "assistant";
    content: any;
}

// Continuation handle threaded from one turn to the next. Stateless providers
// (Anthropic) replay the full `messages` history. Stateful providers (OpenAI's
// Responses API, Gemini's interactions API) instead keep the history server-side
// and continue by sending only the new turn plus `previousResponseId` — the id
// of the last turn (OpenAI's response id / Gemini's interaction id).
export interface Conversation {
    messages: ChatMessage[];
    previousResponseId?: string;
}

// What every adapter returns: the reply text, plus — for stateful providers —
// the id of this turn, to be used as the next turn's `previousResponseId`.
export interface LLMResult {
    text: string;
    responseId?: string;
}


// Zod is the single source of truth for the structured-output schemas. Each
// adapter derives what its SDK needs from these: the OpenAI adapter feeds them
// to zodTextFormat, the Anthropic adapter to z.toJSONSchema. We also validate
// the model's reply against the same schema here, so one definition drives the
// request format, the response validation, and (via z.infer) the result type.
// `.nullable()` is the standard way to allow null — it survives to both APIs as
// a `null`-permitting type, unlike the JSON-Schema `nullable: true` keyword.
export const InvariantsSchema = z.object({
    output: z.array(z.object({
        invariant: z.string(),
        lineno: z.number().int().nullable(),
        end_lineno: z.number().int().nullable(),
    })),
});

export const PbtSchema = z.object({
    output: z.array(z.object({
        invariant: z.string(),
        explanation: z.string(),
        test: z.string(),
    })),
});



// Route a one-shot prompt to the right provider adapter. OpenAI, Ollama, and
// LiteLLM share the OpenAI-compatible adapter; only Anthropic differs.
function query_llm(prompt: string, config: LLMConfig, format?: z.ZodType): Promise<LLMResult> {
    switch (config.provider) {
        case "anthropic":
            return query_claude(prompt, config, format);
        case "gemini":
            return query_gemini(prompt, config, format);
        default:
            return query_openai(prompt, config, format);
    }
}

// Same routing for a continued conversation.
function continue_llm(prompt: string, prev: Conversation, config: LLMConfig, format?: z.ZodType): Promise<LLMResult> {
    switch (config.provider) {
        case "anthropic":
            return continue_claude(prompt, prev, config, format);
        case "gemini":
            return continue_gemini(prompt, prev, config, format);
        default:
            return continue_openai(prompt, prev, config, format);
    }
}

export function invariant_prompt(source: string) {
    return `You are extracting candidate invariants for property-based testing and invariant-based documentation.

Source code:
${source}

Task:
Identify 5 to 8 high-value semantic invariants that are directly supported by the source code and its docstring.

Requirements:
- Focus on observable behavior users can rely on.
- Include preconditions when a property is not valid for every input.
- Prefer strong API contracts over vague restatements.
- Include edge cases suggested by branches, exceptions, dtype, shape, axis handling, return values, or version notes.
- Do not invent behavior not supported by the source code.
- Do not write tests.
- Include 1-based source line metadata when possible.

Return ONLY a JSON array. Each item should be:
{"invariant": "...", "lineno": 10, "end_lineno": 14}

Use the smallest line range that supports the invariant. If no specific line supports it, use null for lineno and end_lineno. No markdown, no commentary.`;

}

export function test_case_prompt(invariants: string[]) {
    return `I have chosen these invariants to develop property based test cases and include in the final invariant-based documentation: ${invariants}
Now, for each of the invariants that I have chosen, generate exactly one property-based test function verifying that the source code satisfies the invariant using the hypothesis library. Also provide a little explanation in plain text. 
Return only a JSON array, where each item follows the format below:
{"invariant": "...", "explanation": "...", "test": "..."}
where "invariant" is the exact same text of the invariant being evaluated, 
"explanation" is the explanation that you should provide in plain text, and
"test" is the test function that you write using the hypothesis library, which should include the necessary import statements.
The order of the items in the json array that you return should match the order of invariants passed to you.`;

}

export function documentation_prompt(source: string, invariants: string[]) {
    return `Generate publishable Markdown documentation for the function defined in the source code below.

Source code:
${source}

Human-approved semantic invariants:
${invariants.map(inv => `- ${inv}`).join("\n")}

Important:
- Do not mention prompts, validity scores, soundness scores, mutation scores, or testing methodology.
- Use the approved invariants as semantic guarantees.
- Derive the documentation from the source code, including docstring facts, branches, exceptions, and return behavior.
- Be careful around behavior that depends on dtype, endpoint, axis, version, platform, or input validity.

Output exactly this Markdown structure (replace the heading with the actual function name):

# <function name>

## Overview

## Parameters

## Returns

## Raises

## Semantic Guarantees

## Edge Cases

## Examples

## Notes`;
}



// Given Python source code, generate invariants. Returns the generated text
// plus the conversation (`messages`) that produced it, so the caller can pass
// `messages` as `prev` into query_test_cases to continue the chat.
export async function query_invariants(code: string, config: LLMConfig) {
    const prompt = invariant_prompt(code);
    const result = await query_llm(prompt, config, InvariantsSchema);
    const conversation: Conversation = {
        messages: [
            { role: "user", content: prompt },
            { role: "assistant", content: result.text },
        ],
        previousResponseId: result.responseId,
    };
    const text = InvariantsSchema.parse(JSON.parse(result.text));
    return { text, conversation };
}

// Given user-chosen invariants, generate PBT functions using Python hypothesis library.
// returns an object 
export async function query_test_cases(
    invariants: string[],
    prev: Conversation,
    config: LLMConfig
) {
    const result = await continue_llm(test_case_prompt(invariants), prev, config, PbtSchema);
    return PbtSchema.parse(JSON.parse(result.text));
}

export async function query_documentation(code: string, invariants: string[], config: LLMConfig) {
    const result = await query_llm(documentation_prompt(code, invariants), config);
    return result.text;
}

// Indirection layer so the test suite can run without making real (slow and
// expensive) LLM calls. extension.ts invokes the generation functions through
// this object rather than importing them directly; the test suite overrides
// these fields with stub implementations that return canned data. In normal use
// the object holds the real functions defined above.
export const backend = {
    query_invariants,
    query_test_cases,
    query_documentation,
};