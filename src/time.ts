import * as chrono from "chrono-node";

export interface TimeFilter {
  since?: string;
  until?: string;
}

export interface TimeFilterInput extends TimeFilter {
  /** Natural-language window such as "last week", "yesterday", or "Sep 12-13". */
  time?: string;
}

type ParsedTimeFilter = { filter: TimeFilter; error?: undefined } | { filter?: undefined; error: string };

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function iso(date: Date): string {
  return date.toISOString();
}

function validDate(input: string): Date | null {
  const date = ISO_DATE_ONLY.test(input) ? new Date(`${input}T00:00:00.000Z`) : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  const mondayBasedDay = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayBasedDay);
  return d;
}

function startOfMonth(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

function startOfYear(date: Date): Date {
  const d = startOfDay(date);
  d.setMonth(0, 1);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

function addUnit(date: Date, amount: number, unit: string): Date {
  if (unit.startsWith("day")) return addDays(date, amount);
  if (unit.startsWith("week")) return addDays(date, amount * 7);
  if (unit.startsWith("month")) return addMonths(date, amount);
  return addYears(date, amount);
}

function naturalWindow(phrase: string, now: Date): TimeFilter | null {
  const p = phrase.trim().toLowerCase();
  const day = startOfDay(now);

  if (p === "today") return { since: iso(day), until: iso(addDays(day, 1)) };
  if (p === "yesterday") return { since: iso(addDays(day, -1)), until: iso(day) };

  if (p === "this week") {
    const start = startOfWeek(now);
    return { since: iso(start), until: iso(addDays(start, 7)) };
  }
  if (p === "last week") {
    const end = startOfWeek(now);
    return { since: iso(addDays(end, -7)), until: iso(end) };
  }

  if (p === "this month") {
    const start = startOfMonth(now);
    return { since: iso(start), until: iso(addMonths(start, 1)) };
  }
  if (p === "last month") {
    const end = startOfMonth(now);
    return { since: iso(addMonths(end, -1)), until: iso(end) };
  }

  if (p === "this year") {
    const start = startOfYear(now);
    return { since: iso(start), until: iso(addYears(start, 1)) };
  }
  if (p === "last year") {
    const end = startOfYear(now);
    return { since: iso(addYears(end, -1)), until: iso(end) };
  }

  const rolling = p.match(/^(?:past|last)\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/);
  if (rolling) {
    const amount = Number(rolling[1]);
    return { since: iso(addUnit(now, -amount, rolling[2])), until: iso(now) };
  }

  const between = p.match(/^between\s+(.+?)\s+and\s+(.+)$/);
  if (between) return dateRange(between[1], between[2], now);

  const fromTo = p.match(/^(?:from\s+)?(.+?)\s+(?:to|through|until)\s+(.+)$/);
  if (fromTo) return dateRange(fromTo[1], fromTo[2], now);

  const since = p.match(/^since\s+(.+)$/);
  if (since) {
    const parsed = chrono.parseDate(since[1], now);
    return parsed ? { since: iso(floorChronoDate(chrono.parse(since[1], now)[0]?.start, parsed)) } : null;
  }

  const before = p.match(/^(?:before|until)\s+(.+)$/);
  if (before) {
    const result = chrono.parse(before[1], now)[0];
    return result ? { until: iso(floorChronoDate(result.start, result.start.date())) } : null;
  }

  const after = p.match(/^(?:after|from)\s+(.+)$/);
  if (after) {
    const result = chrono.parse(after[1], now)[0];
    return result ? { since: iso(floorChronoDate(result.start, result.start.date())) } : null;
  }

  return null;
}

function dateRange(startText: string, endText: string, now: Date): TimeFilter | null {
  const start = chrono.parse(startText, now)[0];
  const end = chrono.parse(endText, now)[0];
  if (!start || !end) return null;
  return {
    since: iso(floorChronoDate(start.start, start.start.date())),
    until: iso(ceilChronoDate(end.end ?? end.start, (end.end ?? end.start).date())),
  };
}

function hasTime(c: chrono.ParsedComponents): boolean {
  return c.isCertain("hour") || c.isCertain("minute") || c.isCertain("second") || c.isCertain("millisecond");
}

function floorChronoDate(c: chrono.ParsedComponents | undefined, fallback: Date): Date {
  if (!c) return fallback;
  const date = c.date();
  if (hasTime(c)) return date;
  if (c.isCertain("day")) return startOfDay(date);
  if (c.isCertain("month")) return startOfMonth(date);
  if (c.isCertain("year")) return startOfYear(date);
  return date;
}

function ceilChronoDate(c: chrono.ParsedComponents | undefined, fallback: Date): Date {
  if (!c) return fallback;
  const start = floorChronoDate(c, fallback);
  if (hasTime(c)) return c.date();
  if (c.isCertain("day")) return addDays(start, 1);
  if (c.isCertain("month")) return addMonths(start, 1);
  if (c.isCertain("year")) return addYears(start, 1);
  return start;
}

export function parseNaturalTimeWindow(time: string, now = new Date()): TimeFilter | null {
  const natural = naturalWindow(time, now);
  if (natural) return natural;

  const result = chrono.parse(time, now)[0];
  if (!result) return null;

  const start = floorChronoDate(result.start, result.start.date());
  const end = result.end ? ceilChronoDate(result.end, result.end.date()) : ceilChronoDate(result.start, result.start.date());
  return { since: iso(start), until: iso(end) };
}

export function resolveTimeFilter(input: TimeFilterInput, now = new Date()): ParsedTimeFilter {
  const filter: TimeFilter = {};

  if (input.time?.trim()) {
    const parsed = parseNaturalTimeWindow(input.time, now);
    if (!parsed) return { error: `Could not parse time window "${input.time}".` };
    Object.assign(filter, parsed);
  }

  if (input.since) {
    const since = validDate(input.since);
    if (!since) return { error: `Invalid since timestamp "${input.since}".` };
    filter.since = iso(since);
  }

  if (input.until) {
    const until = validDate(input.until);
    if (!until) return { error: `Invalid until timestamp "${input.until}".` };
    filter.until = iso(until);
  }

  if (filter.since && filter.until && filter.since >= filter.until) {
    return { error: "`since` must be earlier than `until`." };
  }

  return { filter };
}
