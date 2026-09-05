// Mirrors device-simulator/src/rules.js, but only for *display* — the unit's
// own rule engine is always the source of truth for what actually happens.

function daysBetween(a, b) {
  const ms = new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0);
  return Math.floor(ms / 86400000);
}

export function nextMistWindow(schedule, now = new Date()) {
  const [sh, sm] = schedule.window_start.split(':').map(Number);
  const [eh, em] = schedule.window_end.split(':').map(Number);
  const todayStart = new Date(now);
  todayStart.setHours(sh, sm, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(eh, em, 0, 0);

  if (now < todayEnd) return { start: todayStart, end: todayEnd, isToday: now >= todayStart };
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const tomorrowEnd = new Date(todayEnd);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
  return { start: tomorrowStart, end: tomorrowEnd, isToday: false };
}

export function feedForecast(schedule, now = new Date()) {
  const feedStart = new Date(schedule.feed_start_date);
  const cycleWeeks = schedule.cycle_weeks;
  const weekday = feedStart.getDay();

  for (let i = 0; i < 14; i++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + i);
    if (candidate.getDay() !== weekday) continue;
    const elapsed = daysBetween(feedStart, candidate);
    const weekNumber = (Math.floor(elapsed / 7) % cycleWeeks) + 1;
    const isFeedWeek = weekNumber <= cycleWeeks - 1;
    if (isFeedWeek && (i > 0 || candidate.toDateString() === now.toDateString())) {
      return { date: candidate, weekNumber, cycleWeeks, isToday: i === 0 };
    }
  }
  return null;
}

export function fungicideForecast(schedule) {
  const last = new Date(schedule.fungicide_last_sprayed_date);
  const due = new Date(last);
  due.setDate(due.getDate() + schedule.fungicide_interval_days);
  const daysLeft = daysBetween(new Date(), due);
  return { dueDate: due, daysLeft, overdue: daysLeft < 0 };
}
