#!/usr/bin/env node
// Validates every timeline collection under collections/ plus the catalog
// files (collections-metadata.json, collection-groups.json).
//
// Dependency-free (Node 22+). Mirrors what the Time Horizon app accepts in
// sanitizeImportedEvents (src/stores/index.ts) and collection-group sanitizing
// (src/helpers/collectionGroups.ts), and adds stricter data-quality checks.
//
// Usage:
//   node scripts/validate.mjs                 # everything, human-readable
//   node scripts/validate.mjs histography     # only files whose path contains "histography"
//   node scripts/validate.mjs --json          # machine-readable report on stdout
//   node scripts/validate.mjs --quiet         # summary + errors only
//   node scripts/validate.mjs --no-year-text  # skip the description/year heuristic
//
// Exit code: 1 when any error is found, 0 otherwise (warnings never fail).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTIONS_DIR = join(ROOT, "collections");
const METADATA_FILE = join(ROOT, "collections-metadata.json");
const GROUPS_FILE = join(ROOT, "collection-groups.json");

const BIG_BANG_YEAR = -13.8e9;
const MAX_REASONABLE_YEAR = new Date().getFullYear() + 100;
/** The year-in-text heuristic only makes sense for historical dates. */
const YEAR_TEXT_MIN = -10000;

const KNOWN_EVENT_KEYS = new Set([
  "title",
  "description",
  "time",
  "endTime",
  "ongoing",
  "duration",
  "emoji",
  "priority",
  "color",
  "link",
  "image",
  "video",
  "eventUid",
]);
const KNOWN_LANGS = new Set(["vi", "en"]);
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const TIME_PART_NAMES = ["year", "month", "day", "hour", "minute", "second"];
const TIME_PART_RANGES = [null, [1, 12], null, [0, 23], [0, 59], [0, 59]];

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const opts = {
  json: argv.includes("--json"),
  quiet: argv.includes("--quiet"),
  yearText: !argv.includes("--no-year-text"),
  help: argv.includes("--help") || argv.includes("-h"),
};
const filters = argv.filter((a) => !a.startsWith("--") && a !== "-h");

if (opts.help) {
  console.log(
    "Usage: node scripts/validate.mjs [--json] [--quiet] [--no-year-text] [path-filter ...]",
  );
  process.exit(0);
}

// ---------------------------------------------------------------- reporting

const issues = [];
const report = (severity, file, where, code, message, extra) => {
  issues.push({ severity, file, ...where, code, message, ...(extra ? { extra } : {}) });
};
const error = (file, where, code, message, extra) =>
  report("error", file, where, code, message, extra);
const warn = (file, where, code, message, extra) =>
  report("warning", file, where, code, message, extra);

// ---------------------------------------------------------------- helpers

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const rel = (p) => relative(ROOT, p).split("\\").join("/");

const listJsonFiles = (dir) => {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listJsonFiles(full));
    else if (name.endsWith(".json")) out.push(full);
  }
  return out;
};

const readJson = (file) => {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    error(rel(file), {}, "read-failed", `cannot read file: ${e.message}`);
    return { ok: false };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    warn(rel(file), {}, "bom", "file starts with a UTF-8 BOM");
    text = text.slice(1);
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    error(rel(file), {}, "invalid-json", `invalid JSON: ${e.message}`);
    return { ok: false };
  }
};

/**
 * Leap rule exactly as the app applies it: the app hands the stored year to
 * Date#setFullYear, i.e. proleptic Gregorian on the astronomical year number.
 */
const isLeapAstronomical = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (year, month) =>
  [31, isLeapAstronomical(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

const textValues = (lt) =>
  typeof lt === "string" ? [lt] : isPlainObject(lt) ? Object.values(lt).filter((v) => typeof v === "string") : [];

const displayTitle = (lt) => {
  if (typeof lt === "string") return lt;
  if (isPlainObject(lt)) return lt.en ?? lt.vi ?? Object.values(lt)[0] ?? "";
  return String(lt);
};

// ---------------------------------------------------------------- time checks

/**
 * Validates one time tuple. Returns the normalized 6-tuple (nulls filled) when
 * the app would accept it as a start time, or null.
 */
const checkTime = (file, where, field, value) => {
  if (!Array.isArray(value)) {
    error(file, where, `${field}-shape`, `${field} must be an array, got ${JSON.stringify(value)}`);
    return null;
  }
  if (value.length === 0) {
    error(file, where, `${field}-shape`, `${field} is an empty array`);
    return null;
  }
  if (value.length > 6) {
    error(file, where, `${field}-shape`, `${field} has ${value.length} parts (max 6): ${JSON.stringify(value)}`);
  }
  const parts = [];
  let ok = true;
  for (let i = 0; i < 6; i++) {
    const p = value[i];
    if (p === undefined || p === null) {
      parts.push(null);
      continue;
    }
    if (typeof p !== "number" || !Number.isFinite(p)) {
      error(file, where, `${field}-type`, `${field}[${i}] (${TIME_PART_NAMES[i]}) must be a number or null, got ${JSON.stringify(p)}`);
      parts.push(null);
      if (i === 0) ok = false;
      continue;
    }
    parts.push(p);
  }
  if (!ok || parts[0] === null) {
    if (ok) error(file, where, `${field}-year`, `${field}[0] (year) is required`);
    return null;
  }
  const [year, month, day] = parts;
  const str = JSON.stringify(value);

  if (!Number.isInteger(year)) {
    error(file, where, `${field}-integer`, `${field} year must be an integer: ${str}`);
  }
  if (year < BIG_BANG_YEAR) {
    error(file, where, `${field}-range`, `${field} year ${year} is before the Big Bang (${BIG_BANG_YEAR})`);
  }
  // Deep-future projections (cosmic.json: "Sun becomes a red giant") are
  // intentional; only flag near-future years that look like typos.
  if (year > MAX_REASONABLE_YEAR && year < 1e6) {
    warn(file, where, `${field}-future`, `${field} year ${year} is far in the future`);
  }
  if (year === 0) {
    warn(
      file,
      where,
      `${field}-year-zero`,
      `${field} uses year 0, which does not exist in historical dating (app renders it as "0"; -1 is 1 BC, 1 is AD 1)`,
    );
  }

  for (let i = 1; i < 6; i++) {
    const p = parts[i];
    if (p === null) continue;
    if (!Number.isInteger(p)) {
      error(file, where, `${field}-integer`, `${field}[${i}] (${TIME_PART_NAMES[i]}) must be an integer: ${str}`);
      continue;
    }
    const range = TIME_PART_RANGES[i];
    if (range && (p < range[0] || p > range[1])) {
      error(file, where, `${field}-range`, `${field} ${TIME_PART_NAMES[i]} ${p} out of range ${range[0]}-${range[1]}: ${str}`);
    }
    // A finer part without the coarser one before it ("day without month").
    if (parts[i - 1] === null) {
      error(
        file,
        where,
        `${field}-gap`,
        `${field} has ${TIME_PART_NAMES[i]} without ${TIME_PART_NAMES[i - 1]}: ${str}`,
      );
    }
  }

  if (Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day)) {
    const max = daysInMonth(year, month);
    if (day < 1 || day > max) {
      const bceNote =
        year < 1 && month === 2 && day === 29 && isLeapAstronomical(year + 1)
          ? ` — note: ${-year} BC is a leap year in historical numbering, but the app uses astronomical numbering and rolls this to 1 March`
          : "";
      error(file, where, `${field}-day`, `${field} day ${day} is invalid for month ${month} of year ${year} (max ${max}): ${str}${bceNote}`);
    } else if (month === 2 && day === 29 && year < 1) {
      // Stored negative years mean "N BC" (app labels -N as "N BC"), but the
      // leap rule the app applies is astronomical. Flag the ambiguity.
      const histLeap = isLeapAstronomical(year + 1);
      warn(
        file,
        where,
        `${field}-bce-leap`,
        `${field} is 29 Feb of a BCE year; leap-ness differs between astronomical (${year}) and historical (${-year} BC => ${year + 1}) numbering${histLeap ? "" : " — not a leap year historically"}`,
      );
    }
  }
  return parts;
};

const compareTimes = (a, b) => {
  for (let i = 0; i < 6; i++) {
    const x = a[i] ?? (i === 1 || i === 2 ? 1 : 0);
    const y = b[i] ?? (i === 1 || i === 2 ? 1 : 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

// ---------------------------------------------------------------- localized text

const checkLocalizedText = (file, where, field, value, { required }) => {
  if (value === undefined || value === null) {
    if (required) error(file, where, `${field}-missing`, `${field} is missing`);
    else warn(file, where, `${field}-missing`, `${field} is missing (app defaults to "")`);
    return;
  }
  if (typeof value === "string") {
    if (required && value.trim().length === 0) {
      error(file, where, `${field}-empty`, `${field} is empty (app drops the event)`);
    } else if (value !== value.trim() && value.trim().length > 0) {
      warn(file, where, `${field}-whitespace`, `${field} has leading/trailing whitespace`);
    }
    return;
  }
  if (!isPlainObject(value)) {
    error(file, where, `${field}-type`, `${field} must be a string or {vi,en,...} object, got ${JSON.stringify(value)}`);
    return;
  }
  const entries = Object.entries(value);
  for (const [lang, v] of entries) {
    if (typeof v !== "string") {
      error(file, where, `${field}-type`, `${field}.${lang} must be a string, got ${JSON.stringify(v)}`);
    }
    if (!KNOWN_LANGS.has(lang)) {
      warn(file, where, `${field}-lang`, `${field} has unknown language key "${lang}"`);
    }
  }
  const nonEmpty = entries.filter(([, v]) => isNonEmptyString(v));
  if (required && nonEmpty.length === 0) {
    error(file, where, `${field}-empty`, `${field} has no non-empty translation (app drops the event)`);
    return;
  }
  if (nonEmpty.length > 0) {
    for (const lang of KNOWN_LANGS) {
      if (!isNonEmptyString(value[lang])) {
        warn(file, where, `${field}-lang-missing`, `${field} object is missing a non-empty "${lang}" translation`);
      }
    }
  }
};

// ---------------------------------------------------------------- year-in-text heuristic

const MARKERS_BCE = "(?:BCE|B\\.C\\.E\\.|BC|B\\.C\\.|TCN|tr\\.\\s?CN|trước\\s+Công\\s+nguyên)";
const MARKERS_CE = "(?:CE|C\\.E\\.|AD|A\\.D\\.|SCN|sau\\s+Công\\s+nguyên)";
const NUM = "(\\d{1,3}(?:[.,]\\d{3})+|\\d{1,5})";
const NOT_PRECEDED = "(?<![\\d.,/:\\-–#$€£%])";
const NOT_FOLLOWED = "(?![\\d%]|[.,]\\d|\\s*(?:km|m\\b|kg|tấn|người|quân|soldiers|men|people|troops|ships|tàu|chiến\\s+thuyền|lần|times|%|°|triệu|million|billion|thousand|nghìn|ngàn|vạn|năm\\b|years?\\b|tuổi|year-old))";
const CONTEXT_PREFIX =
  "(?:\\b(?:in|since|from|until|till|year|years|circa|c\\.|ca\\.|around|after|before|during|early|late|mid|spring|summer|autumn|fall|winter|January|February|March|April|May|June|July|August|September|October|November|December)|năm|từ|đến|vào|tới|khoảng|mùa\\s+\\S+|tháng\\s+\\d+(?:\\s*\\/\\s*|\\s+năm\\s+))\\s+";

const parseNum = (s) => Number(s.replace(/[.,]/g, ""));

/**
 * Extracts year mentions from free text. Returns [{year, raw, strong}], where
 * strong = explicitly marked (BCE/AD/năm/in ...), weak = bare 4-digit number.
 */
const extractYears = (rawText) => {
  // Years inside quotes are usually part of a work's name ("August 1914",
  // "Pacific 1860"), not the event date: blank them out.
  const text = rawText.replace(/"[^"]*"|“[^”]*”|«[^»]*»/gu, (q) => " ".repeat(q.length));
  const found = [];
  const taken = [];
  const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);
  const add = (m, year, strong, idx = m.index, len = m[0].length, to = year) => {
    if (overlaps(idx, idx + len)) return;
    taken.push([idx, idx + len]);
    found.push({ year, to, raw: m[0].trim(), strong });
  };
  let m;
  // Ranges with an era marker: "500–400 BC", "từ 111 TCN đến 40", "1914-1918".
  const rangeBce = new RegExp(`${NOT_PRECEDED}${NUM}\\s*(?:–|—|-|đến|to|until)\\s*${NUM}\\s*${MARKERS_BCE}`, "giu");
  while ((m = rangeBce.exec(text))) {
    const a = parseNum(m[1]);
    const b = parseNum(m[2]);
    add(m, Math.min(-a, -b), true, m.index, m[0].length, Math.max(-a, -b));
  }
  // Plain year ranges: "1914-1918", "1931–1934".
  const rangePlain = new RegExp(`${NOT_PRECEDED}(1\\d{3}|20\\d{2})\\s*(?:–|—|-)\\s*(1\\d{3}|20\\d{2})(?!\\d)`, "gu");
  while ((m = rangePlain.exec(text))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    add(m, Math.min(a, b), false, m.index, m[0].length, Math.max(a, b));
  }
  const bce = new RegExp(`${NOT_PRECEDED}${NUM}\\s*${MARKERS_BCE}(?![\\p{L}])`, "giu");
  while ((m = bce.exec(text))) add(m, -parseNum(m[1]), true);
  const ceAfter = new RegExp(`${NOT_PRECEDED}${NUM}\\s*${MARKERS_CE}(?![\\p{L}])`, "gu");
  while ((m = ceAfter.exec(text))) add(m, parseNum(m[1]), true);
  const ceBefore = new RegExp(`\\b(?:AD|A\\.D\\.)\\s*(\\d{1,4})\\b`, "gu");
  while ((m = ceBefore.exec(text))) add(m, parseNum(m[1]), true);
  // Decades: "1960s" / "những năm 1960".
  const decade = /(?<![\d.,])(\d{3}0)s\b|(?:những|các)\s+năm\s+(\d{3}0)(?!\d)|thập\s+(?:niên|kỷ)\s+(\d{3}0)(?!\d)/giu;
  while ((m = decade.exec(text))) {
    const y = Number(m[1] ?? m[2] ?? m[3]);
    add(m, y, false, m.index, m[0].length, y + 9);
  }
  // Context-prefixed: "in 1896", "năm 1896", "năm 40".
  const ctx = new RegExp(`${CONTEXT_PREFIX}${NOT_PRECEDED}(\\d{1,4})${NOT_FOLLOWED}`, "giu");
  while ((m = ctx.exec(text))) {
    const y = Number(m[1]);
    // "những năm 60" / "thập niên 60" is a decade shorthand, not year 60.
    if (y < 100 && /(?:những|các|thập\s+(?:niên|kỷ))\s+$/iu.test(text.slice(Math.max(0, m.index - 12), m.index) + " ")) continue;
    const strong = /năm|year/i.test(m[0]) || y >= 100;
    if (y >= 1 && (strong || y >= 100)) add(m, y, strong);
  }
  // Bare 4-digit numbers that look like years (1000-2099).
  const bare = new RegExp(`${NOT_PRECEDED}(1\\d{3}|20\\d{2})${NOT_FOLLOWED}`, "gu");
  while ((m = bare.exec(text))) add(m, Number(m[1]), false);
  return found;
};

const isTypoOf = (a, b) => {
  if (a === b) return false;
  const sa = String(Math.abs(a));
  const sb = String(Math.abs(b));
  if (Math.sign(a) !== Math.sign(b) && sa === sb) return "sign";
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) diff++;
  if (diff === 1) return "digit";
  if (diff === 2) {
    // transposed adjacent digits
    for (let i = 0; i < sa.length - 1; i++) {
      if (sa[i] === sb[i + 1] && sa[i + 1] === sb[i] && sa.slice(0, i) === sb.slice(0, i) && sa.slice(i + 2) === sb.slice(i + 2)) return "transposed";
    }
  }
  return false;
};

const yearMismatches = [];

const checkYearText = (file, index, event, start, end) => {
  const startYear = start[0];
  if (startYear < YEAR_TEXT_MIN) return;
  const endYear = end ? end[0] : startYear;
  const lo = Math.min(startYear, endYear);
  const hi = Math.max(startYear, endYear);
  // ±1 tolerance: off-by-one around BC/AD and fiscal/season years is common.
  const inRange = (mm) => (mm.to ?? mm.year) >= lo - 1 && mm.year <= hi + 1;

  for (const field of ["title", "description", "link"]) {
    const texts =
      field === "link"
        ? typeof event.link === "string"
          ? [decodeURIComponent(event.link.replace(/^.*\/wiki\//, "")).replace(/_/g, " ")]
          : []
        : textValues(event[field]);
    let mentions;
    try {
      mentions = texts.flatMap(extractYears);
    } catch {
      continue;
    }
    if (mentions.length === 0) continue;
    if (mentions.some(inRange)) continue;
    // Weak-only (bare numbers) in descriptions are often counts; only
    // consider them when nothing better exists and they are plausible years.
    const strong = mentions.filter((mm) => mm.strong);
    const candidates = strong.length > 0 ? strong : mentions;
    const typo = candidates
      .map((mm) => ({ mm, kind: isTypoOf(mm.year, startYear) || (end ? isTypoOf(mm.year, endYear) : false) }))
      .find((x) => x.kind);
    const nearest = candidates.reduce((best, mm) =>
      Math.abs(mm.year - startYear) < Math.abs(best.year - startYear) ? mm : best,
    );
    const suspicion = typo ? `likely-${typo.kind}` : strong.length > 0 ? "strong" : "weak";
    const entry = {
      file,
      index,
      title: displayTitle(event.title),
      field,
      time: event.time,
      endTime: event.endTime ?? null,
      mentioned: [...new Set(candidates.map((mm) => mm.year))],
      snippets: [...new Set(candidates.map((mm) => mm.raw))].slice(0, 5),
      suspicion,
    };
    yearMismatches.push(entry);
    warn(
      file,
      { index, title: entry.title },
      "year-text-mismatch",
      `${field} mentions ${entry.mentioned.join(", ")} but time is ${startYear}${end ? `–${endYear}` : ""} [${suspicion}${typo ? `, near "${typo.mm.raw}"` : `, nearest "${nearest.raw}"`}]`,
    );
  }
};

// ---------------------------------------------------------------- per-file

const checkUrlField = (file, where, field, value) => {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    error(file, where, `${field}-type`, `${field} must be a string, got ${JSON.stringify(value)}`);
    return;
  }
  if (value.trim().length === 0) {
    warn(file, where, `${field}-empty`, `${field} is an empty string`);
    return;
  }
  // A bare YouTube id is a valid video value: the app embeds it directly.
  if (field === "video" && /^[\w-]{11}$/.test(value)) return;
  if (field !== "link" && !/^(https?:)?\/\//i.test(value) && !value.startsWith("/") && !value.startsWith("data:")) {
    warn(file, where, `${field}-url`, `${field} does not look like a URL: ${value}`);
  }
  if (/\s/.test(value.trim())) {
    warn(file, where, `${field}-url`, `${field} contains whitespace: ${value}`);
  }
};

const fileStats = new Map();

const validateCollectionFile = (path) => {
  const file = rel(path);
  const parsed = readJson(path);
  if (!parsed.ok) return;
  const events = parsed.value;
  if (!Array.isArray(events)) {
    error(file, {}, "not-array", "collection file must be a JSON array of events");
    return;
  }
  if (events.length === 0) warn(file, {}, "empty-collection", "collection has no events");
  fileStats.set(file, events.length);

  const seen = new Map();
  let stringTitles = 0;
  let objectTitles = 0;

  events.forEach((event, index) => {
    const where = { index, title: isPlainObject(event) ? displayTitle(event.title) : undefined };
    if (!isPlainObject(event)) {
      error(file, where, "event-type", `event must be an object, got ${JSON.stringify(event)?.slice(0, 80)}`);
      return;
    }

    for (const key of Object.keys(event)) {
      if (key === "id") {
        warn(file, where, "stored-id", `"id" is runtime-only in the app and is ignored on import; remove it`);
      } else if (!KNOWN_EVENT_KEYS.has(key)) {
        warn(file, where, "unknown-key", `unknown event key "${key}"`);
      }
    }

    checkLocalizedText(file, where, "title", event.title, { required: true });
    checkLocalizedText(file, where, "description", event.description, { required: false });
    if (typeof event.title === "string") stringTitles++;
    else if (isPlainObject(event.title)) objectTitles++;

    if (!isNonEmptyString(event.emoji)) {
      error(file, where, "emoji", `emoji must be a non-empty string (app drops the event), got ${JSON.stringify(event.emoji)}`);
    }
    if (event.priority === undefined) {
      error(file, where, "priority", "priority is missing (app defaults to 50)");
    } else if (typeof event.priority !== "number" || !Number.isFinite(event.priority)) {
      error(file, where, "priority", `priority must be a finite number, got ${JSON.stringify(event.priority)}`);
    }
    if (event.duration !== undefined && (typeof event.duration !== "number" || !Number.isFinite(event.duration) || event.duration < 0)) {
      error(file, where, "duration", `duration must be a non-negative number, got ${JSON.stringify(event.duration)}`);
    }
    if (event.ongoing !== undefined && typeof event.ongoing !== "boolean") {
      error(file, where, "ongoing", `ongoing must be a boolean, got ${JSON.stringify(event.ongoing)}`);
    }
    if (event.eventUid !== undefined && !isNonEmptyString(event.eventUid)) {
      error(file, where, "eventUid", `eventUid must be a non-empty string`);
    }
    if (event.color !== undefined && event.color !== null) {
      if (typeof event.color !== "string" || !HEX_COLOR.test(event.color)) {
        error(file, where, "color", `color must be a hex string like "#ef4444", got ${JSON.stringify(event.color)}`);
      }
    }
    checkUrlField(file, where, "link", event.link);
    checkUrlField(file, where, "image", event.image);
    checkUrlField(file, where, "video", event.video);

    const start = checkTime(file, where, "time", event.time);
    let end = null;
    if (event.endTime !== undefined && event.endTime !== null) {
      end = checkTime(file, where, "endTime", event.endTime);
      if (event.ongoing === true) {
        warn(file, where, "ongoing-with-end", "event is ongoing and also has endTime; the app drops endTime");
        end = null;
      }
      if (start && end) {
        const cmp = compareTimes(end, start);
        if (cmp < 0) {
          error(file, where, "endTime-before-time", `endTime ${JSON.stringify(event.endTime)} is before time ${JSON.stringify(event.time)}`);
        } else if (cmp === 0) {
          warn(file, where, "endTime-equals-time", `endTime equals time ${JSON.stringify(event.time)} (zero-length span)`);
        }
      }
    }
    if (event.ongoing === true && start && start[0] > new Date().getFullYear()) {
      warn(file, where, "ongoing-future", "ongoing event starts in the future (renders as a point)");
    }

    if (start) {
      const key = JSON.stringify([
        textValues(event.title).map((t) => t.trim().toLowerCase()).sort(),
        start,
      ]);
      if (seen.has(key)) {
        warn(file, where, "duplicate", `duplicate of event #${seen.get(key)} (same title and time)`);
      } else {
        seen.set(key, index);
      }
      if (opts.yearText) checkYearText(file, index, event, start, end);
    }
  });

  if (stringTitles > 0 && objectTitles > 0) {
    warn(
      file,
      {},
      "mixed-localization",
      `file mixes plain-string titles (${stringTitles}) and localized {vi,en} titles (${objectTitles})`,
    );
  }
};

// ---------------------------------------------------------------- metadata

const validateMetadata = (allCollectionFiles, checkedFiles) => {
  const metaFile = rel(METADATA_FILE);
  const groupsFile = rel(GROUPS_FILE);
  const metaParsed = readJson(METADATA_FILE);
  const referenced = new Set();
  const categoriesUsed = new Map(); // lowercase -> original

  if (metaParsed.ok) {
    const meta = metaParsed.value;
    if (!Array.isArray(meta)) {
      error(metaFile, {}, "not-array", "metadata must be a JSON array");
    } else {
      const ids = new Map();
      const urls = new Map();
      meta.forEach((entry, index) => {
        const where = { index, title: isPlainObject(entry) ? entry.id : undefined };
        if (!isPlainObject(entry)) {
          error(metaFile, where, "entry-type", "metadata entry must be an object");
          return;
        }
        if (!isNonEmptyString(entry.id)) {
          error(metaFile, where, "id", "id must be a non-empty string");
        } else {
          if (entry.id !== entry.id.trim()) warn(metaFile, where, "id", "id has surrounding whitespace");
          if (ids.has(entry.id)) error(metaFile, where, "duplicate-id", `id "${entry.id}" already used by entry #${ids.get(entry.id)}`);
          else ids.set(entry.id, index);
          if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) warn(metaFile, where, "id-format", `id "${entry.id}" is not lowercase-kebab-case`);
        }
        for (const field of ["name", "emoji"]) {
          if (!isNonEmptyString(entry[field])) error(metaFile, where, field, `${field} must be a non-empty string`);
        }
        for (const field of ["description", "author"]) {
          if (entry[field] !== undefined && typeof entry[field] !== "string") {
            error(metaFile, where, field, `${field} must be a string`);
          } else if (!isNonEmptyString(entry[field])) {
            warn(metaFile, where, field, `${field} is missing or empty`);
          }
        }
        if (entry.createdAt !== undefined) {
          if (typeof entry.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(entry.createdAt) || Number.isNaN(Date.parse(entry.createdAt))) {
            warn(metaFile, where, "createdAt", `createdAt should be an ISO date (YYYY-MM-DD), got ${JSON.stringify(entry.createdAt)}`);
          }
        } else {
          warn(metaFile, where, "createdAt", "createdAt is missing");
        }
        if (entry.color !== undefined && entry.color !== null && (typeof entry.color !== "string" || !HEX_COLOR.test(entry.color))) {
          error(metaFile, where, "color", `color must be a hex string, got ${JSON.stringify(entry.color)}`);
        }
        if (entry.categories !== undefined) {
          if (!Array.isArray(entry.categories) || entry.categories.some((c) => !isNonEmptyString(c))) {
            error(metaFile, where, "categories", "categories must be an array of non-empty strings");
          } else {
            const lower = entry.categories.map((c) => c.trim().toLowerCase());
            if (new Set(lower).size !== lower.length) warn(metaFile, where, "categories", "categories has duplicates");
            for (const c of entry.categories) {
              const k = c.trim().toLowerCase();
              if (!categoriesUsed.has(k)) categoriesUsed.set(k, c);
            }
          }
        } else {
          warn(metaFile, where, "categories", "categories is missing (collection lands in the fallback folder)");
        }
        if (!isNonEmptyString(entry.dataUrl)) {
          error(metaFile, where, "dataUrl", "dataUrl must be a non-empty string");
        } else {
          const url = entry.dataUrl;
          if (!url.startsWith("/collections/") || !url.endsWith(".json")) {
            error(metaFile, where, "dataUrl", `dataUrl should look like "/collections/<name>.json", got "${url}"`);
          }
          const target = join(ROOT, url.replace(/^\/+/, ""));
          if (urls.has(url)) warn(metaFile, where, "duplicate-dataUrl", `dataUrl "${url}" already used by entry #${urls.get(url)}`);
          else urls.set(url, index);
          if (!existsSync(target)) {
            error(metaFile, where, "dataUrl-missing", `dataUrl "${url}" does not exist`);
          } else {
            referenced.add(rel(target));
          }
        }
      });
    }
  }

  for (const path of allCollectionFiles) {
    const file = rel(path);
    if (!checkedFiles.has(file)) continue;
    if (!referenced.has(file) && metaParsed.ok) {
      warn(file, {}, "unreferenced", `collection file is not referenced by any dataUrl in ${metaFile}`);
    }
  }

  const groupsParsed = readJson(GROUPS_FILE);
  if (groupsParsed.ok) {
    const groups = groupsParsed.value;
    if (!Array.isArray(groups)) {
      error(groupsFile, {}, "not-array", "collection groups must be a JSON array");
    } else {
      const ids = new Map();
      const covered = new Set();
      let fallbackIndex = -1;
      groups.forEach((g, index) => {
        const where = { index, title: isPlainObject(g) ? g.id : undefined };
        if (!isPlainObject(g)) {
          error(groupsFile, where, "entry-type", "group must be an object (app drops it)");
          return;
        }
        if (!isNonEmptyString(g.id)) error(groupsFile, where, "id", "id must be a non-empty string (app drops it)");
        else if (ids.has(g.id)) error(groupsFile, where, "duplicate-id", `id "${g.id}" already used by group #${ids.get(g.id)} (app drops it)`);
        else ids.set(g.id, index);

        const nameOk =
          typeof g.name === "string" ||
          (isPlainObject(g.name) && Object.values(g.name).every((v) => typeof v === "string"));
        if (!nameOk) error(groupsFile, where, "name", "name must be a string or {vi,en} object (app drops it)");
        else if (isPlainObject(g.name)) {
          for (const lang of KNOWN_LANGS) {
            if (!isNonEmptyString(g.name[lang])) warn(groupsFile, where, "name-lang-missing", `name is missing "${lang}"`);
          }
        }
        const match = g.match ?? "primary";
        if (!["any", "primary", "fallback"].includes(match)) {
          error(groupsFile, where, "match", `match must be any|primary|fallback, got ${JSON.stringify(g.match)} (app drops it)`);
        }
        if (match === "fallback") {
          if (fallbackIndex !== -1) warn(groupsFile, where, "fallback", "more than one fallback group; only the first can ever match");
          fallbackIndex = fallbackIndex === -1 ? index : fallbackIndex;
        }
        if (g.categories !== undefined && (!Array.isArray(g.categories) || g.categories.some((c) => typeof c !== "string"))) {
          error(groupsFile, where, "categories", "categories must be an array of strings (app drops it)");
        } else if (match !== "fallback") {
          if (!g.categories || g.categories.length === 0) {
            error(groupsFile, where, "categories", "non-fallback group without categories never matches anything");
          } else if (metaParsed.ok) {
            for (const c of g.categories) {
              const k = c.trim().toLowerCase();
              covered.add(k);
              if (!categoriesUsed.has(k)) {
                error(groupsFile, where, "unknown-category", `category "${c}" is not used by any collection in ${metaFile}`);
              }
            }
          }
        }
      });
      if (fallbackIndex !== -1 && fallbackIndex !== groups.length - 1) {
        warn(groupsFile, { index: fallbackIndex }, "fallback", "fallback group is not last; groups after it never match");
      }
      if (fallbackIndex === -1) {
        warn(groupsFile, {}, "fallback", "no fallback group; the app adds an implicit 'Other' folder");
      }
      for (const [k, original] of categoriesUsed) {
        if (!covered.has(k)) {
          warn(metaFile, {}, "uncovered-category", `category "${original}" is not listed by any collection group`);
        }
      }
    }
  }
};

// ---------------------------------------------------------------- main

const allFiles = listJsonFiles(COLLECTIONS_DIR);
const selected = filters.length
  ? allFiles.filter((f) => filters.some((flt) => rel(f).includes(flt)))
  : allFiles;
if (filters.length && selected.length === 0) {
  console.error(`No collection file matches ${filters.map((f) => JSON.stringify(f)).join(", ")}`);
  process.exit(2);
}
for (const f of selected) validateCollectionFile(f);
validateMetadata(allFiles, new Set(selected.map(rel)));

const errors = issues.filter((i) => i.severity === "error");
const warnings = issues.filter((i) => i.severity === "warning");
const byCode = (list) =>
  Object.fromEntries(
    Object.entries(
      list.reduce((acc, i) => ((acc[i.code] = (acc[i.code] ?? 0) + 1), acc), {}),
    ).sort((a, b) => b[1] - a[1]),
  );

if (opts.json) {
  console.log(
    JSON.stringify(
      {
        summary: {
          files: selected.length,
          events: [...fileStats.values()].reduce((a, b) => a + b, 0),
          errors: errors.length,
          warnings: warnings.length,
          errorsByCode: byCode(errors),
          warningsByCode: byCode(warnings),
        },
        issues,
        yearMismatches,
      },
      null,
      2,
    ),
  );
} else {
  const fmt = (i) => {
    const loc = i.index !== undefined ? `#${i.index}${i.title ? ` "${String(i.title).slice(0, 60)}"` : ""}` : "";
    return `  ${i.severity === "error" ? "ERROR" : "warn "} ${i.file}${loc ? ` ${loc}` : ""}: [${i.code}] ${i.message}`;
  };
  const shown = opts.quiet ? errors : issues;
  let lastFile = null;
  for (const i of shown) {
    if (i.file !== lastFile) {
      console.log(`\n${i.file}`);
      lastFile = i.file;
    }
    console.log(fmt(i));
  }
  console.log(
    `\nChecked ${selected.length} collection file(s), ${[...fileStats.values()].reduce((a, b) => a + b, 0)} events, plus catalog metadata.`,
  );
  console.log(`Errors: ${errors.length}  ${JSON.stringify(byCode(errors))}`);
  console.log(`Warnings: ${warnings.length}  ${JSON.stringify(byCode(warnings))}`);
}

process.exit(errors.length > 0 ? 1 : 0);
