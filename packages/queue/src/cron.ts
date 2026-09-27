/**
 * Five-field cron expressions (spec-6 §3.5): minute hour day-of-month month day-of-week, with
 * `*`, lists, ranges, steps, month/day names and @hourly/@daily/@weekly/@monthly/@yearly. When both
 * day fields are restricted, a day matches if either does (as in Vixie cron).
 */

interface Field {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
}

const FIELDS: readonly Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { name: "day-of-week", min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];

const SHORTCUTS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MINUTE = 60_000;
/** Long enough to reach Feb 29 from any starting point. */
const HORIZON_MS = 8 * 366 * 24 * 60 * MINUTE;

export interface CronSchedule {
  readonly expression: string;
  /** The first matching minute strictly after `after`, in `timezone` (IANA name). Default: UTC. */
  next(after: Date, timezone?: string): Date;
}

export function parseCron(expression: string): CronSchedule {
  const source = expression.trim();
  const expanded = source.startsWith("@") ? SHORTCUTS[source.toLowerCase()] : source;
  if (!expanded) throw new Error(`Unknown cron shortcut "${source}"`);

  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expressions have 5 fields${parts.length === 6 ? " (seconds are not supported)" : ""}: "${source}"`);
  }
  const [minutes, hours, days, months, weekdays] = parts.map((part, i) => parseField(part, FIELDS[i]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.delete(7)) weekdays.add(0);
  const anyDay = parts[2] === "*";
  const anyWeekday = parts[4] === "*";

  const dayMatches = (wall: Date) => {
    const dayOfMonth = days.has(wall.getUTCDate());
    const dayOfWeek = weekdays.has(wall.getUTCDay());
    if (anyDay || anyWeekday) return dayOfMonth && dayOfWeek;
    return dayOfMonth || dayOfWeek;
  };

  const schedule: CronSchedule = {
    expression: source,
    next(after, timezone = "UTC") {
      const zone = timeZone(timezone);
      const limit = after.getTime() + HORIZON_MS;
      // Walk wall-clock time in the zone, skipping whole months, days and hours that can't match.
      let wall = new Date(Math.floor(zone.toWall(after.getTime()) / MINUTE) * MINUTE + MINUTE);
      while (wall.getTime() < zone.toWall(limit)) {
        if (!months.has(wall.getUTCMonth() + 1)) {
          wall = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1));
        } else if (!dayMatches(wall)) {
          wall = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1));
        } else if (!hours.has(wall.getUTCHours())) {
          wall = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours() + 1));
        } else if (!minutes.has(wall.getUTCMinutes())) {
          wall = new Date(wall.getTime() + MINUTE);
        } else {
          const instant = zone.fromWall(wall.getTime());
          if (instant !== undefined && instant > after.getTime()) return new Date(instant);
          wall = new Date(wall.getTime() + MINUTE); // skipped by DST, or not after `after`
        }
      }
      throw new Error(`Cron expression "${source}" never matches`);
    },
  };
  schedule.next(new Date(Date.UTC(2000, 0, 1)));
  return schedule;
}

function parseField(text: string, field: Field): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const [range = "", stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Cron ${field.name} step "${stepText}" must be at least 1`);

    let from = field.min;
    let to = field.max === 7 ? 6 : field.max; // "*" in day-of-week is 0-6
    if (range !== "*") {
      const [start = "", end] = range.split("-");
      from = value(start, field);
      to = end === undefined ? (stepText === undefined ? from : field.max) : value(end, field);
      if (to < from) throw new Error(`Cron ${field.name} range "${range}" is backwards`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

function value(text: string, field: Field): number {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
  const number = named >= 0 ? named + (field.name === "month" ? 1 : 0) : /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isNaN(number)) throw new Error(`Cron ${field.name} "${text}" is not a number or name`);
  if (number < field.min || number > field.max) throw new Error(`Cron ${field.name} "${text}" is out of range ${field.min}-${field.max}`);
  return number;
}

interface Zone {
  /** An instant → the zone's wall-clock time, expressed as if it were UTC. */
  toWall(instant: number): number;
  /** A wall-clock time → the instant it happens (the first one when repeated), or undefined when skipped. */
  fromWall(wall: number): number | undefined;
}

const zones = new Map<string, Zone>();

function timeZone(name: string): Zone {
  const cached = zones.get(name);
  if (cached) return cached;

  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    throw new Error(`Unknown timezone "${name}"`);
  }

  const toWall = (instant: number) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
  };
  const zone: Zone = {
    toWall,
    fromWall(wall) {
      // The two offsets in effect around this time; a wall time valid under both is repeated.
      const offsets = new Set([toWall(wall - 12 * 60 * MINUTE) - (wall - 12 * 60 * MINUTE), toWall(wall + 12 * 60 * MINUTE) - (wall + 12 * 60 * MINUTE)]);
      const instants = [...offsets].map((offset) => wall - offset).filter((instant) => toWall(instant) === wall);
      return instants.length === 0 ? undefined : Math.min(...instants);
    },
  };
  zones.set(name, zone);
  return zone;
}
