import { definePages } from "../../src/pages";

export function Greeting({ name, items }: { name: string; items: string[] }) {
  return (
    <main>
      <h1>Hello, {name}</h1>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}

export function Boom(): never {
  throw new Error("render failed");
}

export const pages = definePages({ Greeting, Boom });
