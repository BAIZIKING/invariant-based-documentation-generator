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

export async function query_claude(code: string, config: ClaudeConfig) {
    const client = new Anthropic({ apiKey: config.apiKey });
    const msg = await client.messages.create({
        model: config.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: "You are an expert Python programmer.",
        messages: [{
            role: "user",
            content: invariant_prompt(code)
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
