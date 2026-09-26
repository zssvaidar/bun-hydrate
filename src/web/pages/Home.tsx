import { Counter } from "../components/Counter";
import { ServerTime } from "../components/ServerTime";

export function Home({ initialCount }: { initialCount: number }) {
  return (
    <main>
      <h1>bun-hydrate</h1>
      <p>This page was rendered on the server and hydrated in the browser.</p>
      <Counter initial={initialCount} />
      <ServerTime />
      <nav>
        <a href="/page/1">Page 1</a>
      </nav>
    </main>
  );
}
