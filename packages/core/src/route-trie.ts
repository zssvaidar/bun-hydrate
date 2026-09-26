import { BadRequestError } from "./errors";

/** Method key used for routes that accept every method (`router.all`). */
export const ANY_METHOD = "*";

export type MatchResult<T> =
  | { kind: "found"; value: T; params: Record<string, string> }
  | { kind: "method-not-allowed"; allowed: string[] }
  | { kind: "not-found" };

interface Node<T> {
  handlers: Map<string, T>;
  statics: Map<string, Node<T>>;
  param?: { name: string; node: Node<T> };
  wildcard?: Node<T>;
}

interface Found<T> {
  handlers: Map<string, T>;
  params: Record<string, string>;
}

const createNode =<T>(): Node<T> => ({ handlers: new Map(), statics: new Map() });

export function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Segment trie with a fixed priority of static > :param > * at every level, so the route a
 * request reaches never depends on the order routes were registered in.
 */
export class RouteTrie<T> {
  private readonly root = createNode<T>();

  add(method: string, path: string, value: T): void {
    const segments = splitPath(path);
    let node = this.root;

    segments.forEach((segment, index) => {
      if (segment === "*") {
        if (index !== segments.length - 1) throw new Error(`The wildcard must be the last segment: ${path}`);
        node = node.wildcard ??= createNode();
      } else if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (node.param && node.param.name !== name) {
          throw new Error(`Route ${path} has conflicting parameter names: :${node.param.name} and :${name}`);
        }
        node.param ??= { name, node: createNode() };
        node = node.param.node;
      } else {
        let next = node.statics.get(segment);
        if (!next) node.statics.set(segment, (next = createNode()));
        node = next;
      }
    });

    if (node.handlers.has(method)) throw new Error(`Route already registered: ${method} ${path}`);
    node.handlers.set(method, value);
  }

  match(method: string, path: string): MatchResult<T> {
    const segments = splitPath(path).map(decodeSegment);

    const exact = this.find(segments, (handlers) => pickHandler(handlers, method) !== undefined);
    if (exact) return { kind: "found", value: pickHandler(exact.handlers, method)!, params: exact.params };

    const anyMethod = this.find(segments, (handlers) => handlers.size > 0);
    if (anyMethod) return { kind: "method-not-allowed", allowed: allowedMethods(anyMethod.handlers) };

    return { kind: "not-found" };
  }

  private find(segments: string[], accept: (handlers: Map<string, T>) => boolean): Found<T> | undefined {
    const visit = (node: Node<T>, index: number, params: Record<string, string>): Found<T> | undefined => {
      if (index === segments.length && accept(node.handlers)) return { handlers: node.handlers, params };

      if (index < segments.length) {
        const segment = segments[index]!;
        const staticChild = node.statics.get(segment);
        const found =
          (staticChild && visit(staticChild, index + 1, params)) ||
          (node.param && visit(node.param.node, index + 1, { ...params, [node.param.name]: segment }));
        if (found) return found;
      }

      if (node.wildcard && accept(node.wildcard.handlers)) {
        return { handlers: node.wildcard.handlers, params: { ...params, "*": segments.slice(index).join("/") } };
      }
      return undefined;
    };

    return visit(this.root, 0, {});
  }
}

function pickHandler<T>(handlers: Map<string, T>, method: string): T | undefined {
  return (
    handlers.get(method) ??
    (method === "HEAD" ? handlers.get("GET") : undefined) ??
    handlers.get(ANY_METHOD)
  );
}

function allowedMethods(handlers: Map<string, unknown>): string[] {
  const allowed = new Set(handlers.keys());
  if (allowed.has("GET")) allowed.add("HEAD");
  allowed.add("OPTIONS");
  return [...allowed].sort();
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BadRequestError("Malformed URL encoding in path", { code: "MALFORMED_PATH" });
  }
}
