import { describe, expect, test } from "bun:test";
import { moduleNames } from "../src/generate/names";

describe("moduleNames", () => {
  test.each(["order-items", "orderItems", "OrderItems", "order_items", "Order Items"])("normalizes %p", (input) => {
    expect(moduleNames(input)).toEqual({
      kebab: "order-items",
      pascal: "OrderItems",
      camel: "orderItems",
      snake: "order_items",
      entity: "OrderItem",
    });
  });

  test.each([
    ["users", "User"],
    ["categories", "Category"],
    ["addresses", "Address"],
    ["news", "News"],
    ["inventory", "Inventory"],
    ["status", "Status"],
  ])("singularizes %p to the entity %p", (input, entity) => {
    expect(moduleNames(input).entity).toBe(entity);
  });

  test("rejects names that cannot become identifiers", () => {
    expect(() => moduleNames("123")).toThrow('"123" is not a valid module name');
    expect(() => moduleNames("  ")).toThrow('"  " is not a valid module name');
  });
});
