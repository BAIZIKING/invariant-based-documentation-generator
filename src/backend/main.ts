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
    return `Your task is to extract invariants and properties from a Python function. An invariant is defined as a property of the source code that holds true across all valid executions — covering inputs, outputs, state changes, exceptions raised, and boundary conditions.

<source_code> 
${source}
</source_code>

<goal>
Identify a few high-quality invariants that can be directly supported by the source code and its docstring, if present. For each invariant, provide the minimal contiguous line range that justifies it. If no precise supporting region exists, set lineno and end_lineno to null.
</goal>

<success_criteria>
- Holistic: The returned invariants should collectively cover as many observable behaviors as possible, including but not limited to: normal execution, exceptional execution, edge cases, different branches, return values, state changes, input constraints.
- Sound: every invariant must be directly supported by the source code. Do not infer behavior that is not present.
- Precise line numbers: the cited lines must be the tightest range that directly supports the invariant, with no extraneous lines included.
- Testable: each invariant must be expressible as a falsifiable assertion or test condition, and it should be possible to test each invariant by writing property-based tests. 
- Do not duplicate invariants that describe the same behavior.
- Prefer fewer high-quality invariants over many weak ones.
</success_criteria>

<output_format>
Return a JSON array where each item is formatted as follows:
{"invariant": <string>, "lineno": <integer or null>, "end_lineno": <integer or null>}
Where “invariant” is the plain text of the invariant, lineno is the starting line number of the supporting code segment, and end_lineno is the ending line number.
</output_format>
`;

}

export function test_case_prompt(invariants: string[]) {
    return `I have chosen these invariants:

${invariants.map(inv => `- ${inv}`).join("\n")}

For each invariant, generate exactly one property-based test using Hypothesis.
Imports rules:

- DO: import any Python standard-library module (math, re, datetime, collections, itertools, ...) plus:
    from hypothesis import given
    from hypothesis import strategies as st
- DON'T: any import of the implementation module or of the function under test.

The function under test is already defined earlier in the same file and is in scope. Import it and the test will fail. Call it directly by name.

Return a JSON array. Each item must be:

{
  "invariant": "<exact invariant text>",
  "explanation": "<plain English explanation>",
  "test": "<complete test code>"
}

The order of items must exactly match the order of the supplied invariants.`;

}

export function documentation_prompt(source: string, invariants: string[]) {
    return `Your task is to generate publishable Markdown documentation for the function defined below.

<source_code>
${source}
</source_code>

<approved_invariants>
${invariants.map(inv => `- ${inv}`).join("\n")}
</approved_invariants>

<instructions>
Generate publishable documentation in markdown format for the function defined in the source code.
Follow PEP 257 docstring convention, which states that your documentation should start with "a summary line just like a one-line docstring, followed by a blank line, followed by a more elaborate description", and that your documentation should "should summarize its behavior and document its arguments, return value(s), side effects, exceptions raised, and restrictions on when it can be called (all if applicable). Optional arguments should be indicated. It should be documented whether keyword arguments are part of the interface."
Treat the items in <approved_invariants> as ground-truth semantic guarantees about the function's behavior. Incorporate them into the relevant sections (Semantic Guarantees, Edge Cases, Raises) without restating them verbatim as a list — integrate them into natural, readable prose or bullet points appropriate to each section. Do not invent behavior not supported by the source code, docstring, or approved invariants.
Use plain, professional technical-writing tone.
Be careful around behavior that depends on dtype, endpoint, axis, version, platform, or input validity.
</instructions>

<output_format>
Return ONLY the Markdown documentation. No preamble, no explanation, no code fences wrapping the whole output. Below is the structure of the documentation that you should follow. Omit any section entirely if it has nothing meaningful to say for this function (e.g. omit "Raises" if the function raises no exceptions, omit "Edge Cases" if none are evidenced), but your documentation should always contain the function name, function summary, parameters, return, and example(s).

# <function name>
<one-line PEP 257 style summary, plus extended description if needed>

## Parameters

## Returns

## Raises

## Semantic Guarantees

## Edge Cases

## Examples

## Notes
</output_format>`;
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