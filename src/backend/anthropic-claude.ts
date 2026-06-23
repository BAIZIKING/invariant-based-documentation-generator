import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { LLMConfig, ChatMessage, Conversation, LLMResult, SYSTEM_PROMPT } from "./main";


export async function query_claude(prompt: string, config: LLMConfig, schema?: z.ZodType): Promise<LLMResult> {
    const client = new Anthropic({ apiKey: config.apiKey });
    const msg = await client.messages.create({
        model: config.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        // Build Anthropic's structured-output format from the shared Zod schema,
        // mirroring zodTextFormat on the OpenAI adapter.
        ...(schema && { output_config: { format: zodOutputFormat(schema) } })
    });
    // Anthropic is stateless: no response id to carry, the history is replayed.
    return { text: extractText(msg) };
}

// `prev` is the conversation so far: the same message list that produced the
// previous turn, plus that turn's assistant reply. continue_claude appends the
// new user `prompt`, sends the whole thing so Claude has full context, and
// returns the latest assistant text. Pass the returned `messages` back in as
// `prev` to keep chaining further turns.
export async function continue_claude(
    prompt: string,
    prev: Conversation,
    config: LLMConfig,
    schema?: z.ZodType
): Promise<LLMResult> {
    const client = new Anthropic({ apiKey: config.apiKey });
    // Anthropic has no server-side state, so replay the full history.
    // ChatMessage ({ role, content: string }) is a valid Anthropic MessageParam.
    const messages: ChatMessage[] = [...prev.messages, { role: "user", content: prompt }];
    const msg = await client.messages.create({
        model: config.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages,
        ...(schema && { output_config: { format: zodOutputFormat(schema) } })
    });
    return { text: extractText(msg) };
}

// content is a union of block types (and may include thinking blocks); pull the
// first text block rather than assuming content[0] is text.
function extractText(msg: Anthropic.Message): string {
    const textBlock = msg.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text"
    );
    if (!textBlock) {
        throw new Error("Claude returned no text content.");
    }
    return textBlock.text;
}
