/**
 * Marked blocks: the orchestrator rewrites only the lines between `hydrate:<name>:start` and
 * `hydrate:<name>:end` (in any comment syntax); everything else in the file is yours (D7).
 */

function locate(text: string, block: string): { start: number; end: number } | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(`hydrate:${block}:start`));
  const end = lines.findIndex((line, index) => index > start && line.includes(`hydrate:${block}:end`));
  return start === -1 || end === -1 ? undefined : { start, end };
}

export function readBlock(text: string, block: string): string | undefined {
  const found = locate(text, block);
  return found && text.split("\n").slice(found.start + 1, found.end).join("\n");
}

/** Returns the text with the block's contents replaced, or undefined when the markers are missing. */
export function replaceBlock(text: string, block: string, contents: string): string | undefined {
  const found = locate(text, block);
  if (!found) return undefined;
  const lines = text.split("\n");
  const inner = contents === "" ? [] : contents.split("\n");
  return [...lines.slice(0, found.start + 1), ...inner, ...lines.slice(found.end)].join("\n");
}
