import Anthropic from "@anthropic-ai/sdk";

export interface ClaudeConfig {
    apiKey: string;
    model: string;
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

// TODO: Use this one
export async function query_claude(prompt: string, config: ClaudeConfig) {
    const client = new Anthropic({ apiKey: config.apiKey });
    const msg = await client.messages.create({
        model: config.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: "You are an expert Python programmer.",
        messages: [{
            role: "user",
            content: prompt
        }],
    });

    // content is a union of block types (and may include thinking blocks);
    // pull the first text block rather than assuming content[0] is text.
    const textBlock = msg.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text"
    );
    if (!textBlock) {
        throw new Error("Claude returned no text content.");
    }
    return textBlock.text;
}

// `prev` is the conversation so far: the same message list that produced the
// previous turn, plus that turn's assistant reply. continue_claude appends the
// new user `prompt`, sends the whole thing so Claude has full context, and
// returns the latest assistant text. Pass the returned `messages` back in as
// `prev` to keep chaining further turns.
export async function continue_claude(
    prompt: string,
    prev: Anthropic.MessageParam[],
    config: ClaudeConfig
) {
    const client = new Anthropic({ apiKey: config.apiKey });
    const messages: Anthropic.MessageParam[] = [
        ...prev,
        { role: "user", content: prompt },
    ];
    const msg = await client.messages.create({
        model: config.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: "You are an expert Python programmer.",
        messages,
    });

    // content is a union of block types (and may include thinking blocks);
    // pull the first text block rather than assuming content[0] is text.
    const textBlock = msg.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text"
    );
    if (!textBlock) {
        throw new Error("Claude returned no text content.");
    }

    return {
        text: textBlock.text,
        // Full conversation including this turn's reply, ready to feed back in
        // as `prev` for the next continue_claude call.
        messages: [...messages, { role: "assistant", content: msg.content }],
    };
}

// Given Python source code, generate invariants. Returns the generated text
// plus the conversation (`messages`) that produced it, so the caller can pass
// `messages` as `prev` into query_test_cases to continue the chat.
export async function query_invariants(code: string, config: ClaudeConfig) {
    const prompt = invariant_prompt(code);
    const text = await query_claude(prompt, config);
    const messages: Anthropic.MessageParam[] = [
        { role: "user", content: prompt },
        { role: "assistant", content: text },
    ];
    return { text, messages };
}

// Given user-chosen invariants, generate PBT functions using Python hypothesis library.
export async function query_test_cases(
    invariants: string[],
    prev: Anthropic.MessageParam[],
    config: ClaudeConfig
) {
    return continue_claude(test_case_prompt(invariants), prev, config);
}

export async function query_documentation(code: string, invariants: string[], config: ClaudeConfig) {
    return query_claude(documentation_prompt(code, invariants), config);
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