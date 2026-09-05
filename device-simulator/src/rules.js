function timeToMinutes(hhmmss) {
  const [h, m] = hhmmss.split(':').map(Number);
  return h * 60 + m;
}

function isInWindow(now, windowStart, windowEnd) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= timeToMinutes(windowStart) && nowMin <= timeToMinutes(windowEnd);
}

// Never mist between dusk and dawn, even on a threshold trigger — a wet crown
// overnight is how crown rot starts.
function isDaytime(now) {
  const h = now.getHours();
  return h >= 6 && h < 18;
}

function shouldMist(now, reading, schedule) {
  if (schedule.paused) return false;
  if (reading.raining) return false;
  if (isInWindow(now, schedule.schedule.windowStart, schedule.schedule.windowEnd)) return true;
  if (!isDaytime(now)) return false;
  return reading.humidity < schedule.trigger.humidityBelow || reading.tempC > schedule.trigger.tempAbove;
}

function daysBetween(a, b) {
  const ms = new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0);
  return Math.floor(ms / 86400000);
}

function feedPhase(now, feed) {
  const elapsedDays = daysBetween(feed.feedStartDate, now);
  const weekIndex = Math.floor(elapsedDays / 7) % feed.cycleWeeks;
  const weekNumber = weekIndex + 1;
  const isFeedWeek = weekNumber <= feed.cycleWeeks - 1; // last week of the cycle is the salt flush
  const isFeedDay = new Date(feed.feedStartDate).getDay() === now.getDay();
  return { weekNumber, isFeedWeek, isFeedDay: isFeedWeek && isFeedDay };
}

function fungicideDue(now, fungicide) {
  return daysBetween(fungicide.lastSprayedDate, now) >= fungicide.intervalDays;
}

module.exports = { shouldMist, feedPhase, fungicideDue, isInWindow, isDaytime };
