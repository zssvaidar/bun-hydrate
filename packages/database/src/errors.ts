interface DriverError {
  code?: unknown;
  errno?: unknown;
}

// Postgres reports the SQLSTATE in `errno`; SQLite uses named result codes; MySQL numeric errnos.
const UNIQUE = {
  postgres: "23505",
  sqlite: ["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"],
  mysql: 1062,
};
const FOREIGN_KEY = {
  postgres: "23503",
  sqlite: ["SQLITE_CONSTRAINT_FOREIGNKEY"],
  mysql: [1451, 1452],
};

function driverError(error: unknown): DriverError | undefined {
  return typeof error === "object" && error !== null ? (error as DriverError) : undefined;
}

/** True for a unique or primary-key constraint violation, whatever the engine. */
export function isUniqueViolation(error: unknown): boolean {
  const e = driverError(error);
  if (!e) return false;
  return e.errno === UNIQUE.postgres || UNIQUE.sqlite.includes(e.code as string) || e.errno === UNIQUE.mysql;
}

/** True for a foreign key constraint violation, whatever the engine. */
export function isForeignKeyViolation(error: unknown): boolean {
  const e = driverError(error);
  if (!e) return false;
  return (
    e.errno === FOREIGN_KEY.postgres ||
    FOREIGN_KEY.sqlite.includes(e.code as string) ||
    FOREIGN_KEY.mysql.includes(e.errno as number)
  );
}
