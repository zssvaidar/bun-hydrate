import { describe, expect, test } from "bun:test";
import { escapeHtml, serializeForScript } from "../src/serialize";

describe("serializeForScript", () => {
  test("cannot close the surrounding script element", () => {
    const serialized = serializeForScript({ bio: "</script><script>alert(1)</script>" });

    expect(serialized).not.toContain("</script");
    expect(serialized).not.toContain("<");
  });

  test("escapes HTML comment openers and line separators", () => {
    const serialized = serializeForScript({ a: "<!--", b: "\u2028\u2029", c: "&amp;" });

    expect(serialized).not.toMatch(/[<>&\u2028\u2029]/);
  });

  test("round-trips exactly through JSON.parse", () => {
    const value = {
      text: "</script> <!-- & \u2028 \u2029 > ünïcødé 🚀",
      nested: [1, null, true, { deep: "x" }],
    };

    expect(JSON.parse(serializeForScript(value))).toEqual(value);
  });
});

describe("escapeHtml", () => {
  test("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
