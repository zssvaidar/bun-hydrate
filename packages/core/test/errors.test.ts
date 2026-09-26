import { describe, expect, test } from "bun:test";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  InternalServerError,
  MethodNotAllowedError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  toHttpError,
} from "../src/errors";

describe("HttpError", () => {
  test("derives a default code from the status", () => {
    const error = new HttpError(404, "Missing");

    expect(error.status).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Missing");
    expect(error).toBeInstanceOf(Error);
  });

  test("accepts a custom code, details and cause", () => {
    const cause = new Error("db");
    const error = new HttpError(409, "Taken", { code: "EMAIL_TAKEN", details: { field: "email" }, cause });

    expect(error.code).toBe("EMAIL_TAKEN");
    expect(error.details).toEqual({ field: "email" });
    expect(error.cause).toBe(cause);
  });

  test("exposes the message to clients only for 4xx", () => {
    expect(new HttpError(400, "x").expose).toBe(true);
    expect(new HttpError(500, "x").expose).toBe(false);
  });

  test.each([
    [BadRequestError, 400, "BAD_REQUEST"],
    [UnauthorizedError, 401, "UNAUTHORIZED"],
    [ForbiddenError, 403, "FORBIDDEN"],
    [NotFoundError, 404, "NOT_FOUND"],
    [ConflictError, 409, "CONFLICT"],
    [ValidationError, 422, "VALIDATION_FAILED"],
    [InternalServerError, 500, "INTERNAL_SERVER_ERROR"],
  ] as const)("%p maps to %i %s", (ErrorClass, status, code) => {
    const error = new ErrorClass();

    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.name).toBe(ErrorClass.name);
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("MethodNotAllowedError carries an Allow header", () => {
    const error = new MethodNotAllowedError(["GET", "POST"]);

    expect(error.status).toBe(405);
    expect(new Headers(error.headers).get("allow")).toBe("GET, POST");
  });
});

describe("toHttpError", () => {
  test("returns HttpErrors unchanged", () => {
    const error = new NotFoundError();
    expect(toHttpError(error)).toBe(error);
  });

  test("wraps unknown values as a 500 that keeps the original as cause", () => {
    const original = new TypeError("boom");
    const error = toHttpError(original);

    expect(error.status).toBe(500);
    expect(error.message).toBe("Internal Server Error");
    expect(error.cause).toBe(original);
  });
});
