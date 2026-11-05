'use strict';
// Date-only columns that Dataverse stores in the person's time zone ("user local"), like a gift's book date
// (msnfp_bookdate). The app shows the LOCAL day of the stored instant, so a bare "2026-10-12" (stored as
// 2026-10-12T00:00:00Z, 5 PM the day before in Pacific time) shows as 10/11. That is what happened to batch
// 2026_863 (10/13/26, 46 gifts) and to the first API gift write (8/11/26). The plan therefore writes LOCAL
// midnight for such a column. A true date-only column (behaviour DateOnly) has no time zone and is left alone.
//
// SBRM's people and its Dataverse users are all on Pacific time.
const TIME_ZONE = 'America/Los_Angeles';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// The hour (0-23) that a UTC instant reads as in the time zone.
function localHour(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { hour: Number(get('hour')), day: `${get('year')}-${get('month')}-${get('day')}` };
}

// "2026-10-12" -> "2026-10-12T07:00:00Z" (PDT) or "...T08:00:00Z" (PST): the instant that is midnight on that
// day in the time zone. Tries each whole-hour offset Pacific can have, so daylight saving needs no table.
function localMidnightUtc(day, timeZone = TIME_ZONE) {
  const m = DAY.exec(day);
  if (!m) throw new Error(`not a date: ${day}`);
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  for (let h = 0; h <= 14; h += 1) {
    const ms = base + h * 3600 * 1000;
    const local = localHour(ms, timeZone);
    if (local.hour === 0 && local.day === day) return new Date(ms).toISOString().replace('.000Z', 'Z');
  }
  throw new Error(`no local midnight found for ${day} in ${timeZone}`);
}

// The date a value names, when it is a bare date or midnight UTC (how a bare date comes back); else null.
// Any other time (local midnight already, or a real time of day) is kept as it is.
function namedDay(v) {
  if (typeof v !== 'string') return null;
  if (DAY.test(v)) return v;
  const m = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0+)?)?Z?$/.exec(v);
  return m ? m[1] : null;
}

// Rewrites, in place, every user-local date-only value in the job's rows to local midnight. `behaviours` is
// meta.dateBehaviours(): logical name -> { format, behaviour }. Returns nothing; the plan shows the new value.
function toLocalMidnight(job, columns, behaviours) {
  for (const col of Object.values(columns)) {
    if (col.kind !== 'plain' || col.type !== 'DateTime') continue;
    const b = behaviours.get(col.attr);
    if (!b || b.format !== 'DateOnly' || b.behaviour !== 'UserLocal') continue;
    for (const r of job.rows) {
      if (!(col.key in r.body)) continue;
      const day = namedDay(r.body[col.key]);
      if (day) r.body[col.key] = localMidnightUtc(day);
    }
  }
}

// A TRUE date-only column (behaviour DateOnly, Edm.Date) has no time zone and takes a bare "YYYY-MM-DD"; Dataverse
// refuses anything with a time at the write (D-1874, Daian's gift batch 11/4/26: "2026-11-04T08:00:00Z" into the
// batch's Batch Date, refused only at apply). Midnight UTC names its day unambiguously here (no zone to shift it), so it
// becomes the bare date; any other time of day is refused at plan: guessing the day from a zoned instant is the 10/14
// trap the other way round, so the job must say the day. Rewrites in place; returns the refusal reasons.
function dateOnlyErrors(job, columns, behaviours) {
  const errs = [];
  for (const col of Object.values(columns)) {
    if (col.kind !== 'plain' || col.type !== 'DateTime') continue;
    const b = behaviours.get(col.attr);
    if (!b || b.behaviour !== 'DateOnly') continue;
    for (const r of job.rows) {
      if (!(col.key in r.body)) continue;
      const v = r.body[col.key];
      if (v === null || (typeof v === 'string' && DAY.test(v))) continue;
      const day = namedDay(v);
      if (day) { r.body[col.key] = day; continue; }
      const like = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '2026-11-04';
      errs.push(`${r.name}: ${col.label} takes a date only, like ${like} (it has no time of day or time zone); the job sent ${JSON.stringify(v)}`);
    }
  }
  return errs;
}

module.exports = { localMidnightUtc, namedDay, toLocalMidnight, dateOnlyErrors, TIME_ZONE };
