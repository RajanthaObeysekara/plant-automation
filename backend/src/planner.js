// Turns a room_schedules row into a concrete, dated 7-day forward plan —
// this is what "server-initiated" scheduling means in this system: the
// server decides and hands down *which calendar days* get a feed dose or a
// fungicide reminder, rather than the device re-deriving that from raw rule
// math on every boot. A device caches this array and can act on it fully
// offline for up to 7 days without ever re-deriving the date math itself.
//
// Deliberately NOT included here: humidity/temp-triggered opportunistic
// misting and the daily AM window. Those are inherently sensor-driven and
// can't be known in advance — the device still evaluates those locally,
// live, against real readings. This plan only covers what's actually
// deterministic from today's config.

// Formats a Date using its LOCAL year/month/day — never toISOString() for
// this, which converts to UTC first and would silently print the wrong
// calendar date for several hours a day in any timezone ahead of UTC
// (Sri Lanka is UTC+5:30 — this bit for real during testing).
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(a, b) {
  const ms = new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0);
  return Math.floor(ms / 86400000);
}

function feedPhaseFor(date, feedStartDate, cycleWeeks) {
  const elapsedDays = daysBetween(feedStartDate, date);
  const weekIndex = Math.floor(elapsedDays / 7) % cycleWeeks;
  const weekNumber = weekIndex + 1;
  const isFeedWeek = weekNumber <= cycleWeeks - 1; // last week of the cycle is a plain-water salt flush
  const isFeedDay = new Date(feedStartDate).getDay() === date.getDay();
  return { weekNumber, isFeedDay: isFeedWeek && isFeedDay };
}

// Fungicide "due" is a standing condition once it starts (stays true every
// day until sprayed) — projected forward assuming no spray happens in the
// window, which is the honest worst case for a forward plan. An actual
// spray before then updates fungicide_last_sprayed_date server-side, and
// the next real sync (not this cached plan) is what reflects that.
function fungicideDueFor(date, lastSprayedDate, intervalDays) {
  return daysBetween(lastSprayedDate, date) >= intervalDays;
}

function buildSevenDayPlan(schedule, startDate = new Date()) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);

    const feed = feedPhaseFor(d, schedule.feed_start_date, schedule.cycle_weeks);
    const fungicideDue = fungicideDueFor(d, schedule.fungicide_last_sprayed_date, schedule.fungicide_interval_days);

    days.push({
      date: localDateKey(d),
      isFeedDay: feed.isFeedDay,
      feedWeekNumber: feed.weekNumber,
      doseMl: feed.isFeedDay ? schedule.dose_ml : null,
      fungicideDue,
      fungicideDoseMl: fungicideDue ? schedule.fungicide_dose_ml : null,
    });
  }
  return days;
}

module.exports = { buildSevenDayPlan, feedPhaseFor, fungicideDueFor, daysBetween, localDateKey };
