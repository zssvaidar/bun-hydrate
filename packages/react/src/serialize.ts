const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

const toUnicodeEscape = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;

/**
 * JSON that is safe to place inside a <script> element: `</script>`, `<!--` and the JS line
 * separators cannot appear literally, yet `JSON.parse` returns exactly the original value.
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(SCRIPT_UNSAFE, toUnicodeEscape);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}
