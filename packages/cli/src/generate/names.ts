export interface ModuleNames {
  /** order-items — directory and file names, URL path */
  kebab: string;
  /** OrderItems — class name prefix */
  pascal: string;
  /** orderItems — function name prefix */
  camel: string;
  /** order_items — table name */
  snake: string;
  /** OrderItem — the type of one record */
  entity: string;
}

const capitalize = (word: string) => word[0]!.toUpperCase() + word.slice(1);

/** Naive English singular, good enough for table-like module names; the result is only a type name. */
function singular(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/(ss|us|is|news)$/.test(word)) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Accepts kebab-case, camelCase, PascalCase, snake_case or spaced names. */
export function moduleNames(input: string): ModuleNames {
  const words = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0 || /^\d/.test(words[0]!)) throw new Error(`"${input}" is not a valid module name`);

  const pascal = words.map(capitalize).join("");
  return {
    kebab: words.join("-"),
    pascal,
    camel: pascal[0]!.toLowerCase() + pascal.slice(1),
    snake: words.join("_"),
    entity: [...words.slice(0, -1), singular(words.at(-1)!)].map(capitalize).join(""),
  };
}

/** `OrderItem` → `Order item`, for messages. */
export function humanize(pascal: string): string {
  const spaced = pascal.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return capitalize(spaced);
}

/** `OrderItem` → `ORDER_ITEM`, for error codes. */
export function constantCase(pascal: string): string {
  return pascal.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}
