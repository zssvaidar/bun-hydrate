import { useState } from "react";

export function Counter({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);

  return (
    <button type="button" data-testid="counter" onClick={() => setCount((value) => value + 1)}>
      Clicked {count} times
    </button>
  );
}
