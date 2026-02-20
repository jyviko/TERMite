import type Anthropic from "@anthropic-ai/sdk";

/**
 * Extract text from Anthropic ContentBlock array.
 * Handles the union type properly.
 */
export function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("");
}
