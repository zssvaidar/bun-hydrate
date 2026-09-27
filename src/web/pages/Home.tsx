import { Can } from "../auth";
import { AccountBar } from "../components/AccountBar";
import { Counter } from "../components/Counter";
import { ServerTime } from "../components/ServerTime";

export function Home({ initialCount }: { initialCount: number }) {
  return (
    <main>
      <AccountBar />
      <h1>bun-hydrate</h1>
      <p>This page was rendered on the server and hydrated in the browser.</p>
      <Counter initial={initialCount} />
      <ServerTime />
      {/* Hidden unless the server would allow it too: the same permission names on both sides. */}
      <Can permission="users.delete">
        <section className="admin">
          <h2>Admin tools</h2>
          <p>
            You can manage users through <code>/api/v1/users</code>.
          </p>
        </section>
      </Can>
      <nav>
        <a href="/page/1">Page 1</a>
      </nav>
    </main>
  );
}
