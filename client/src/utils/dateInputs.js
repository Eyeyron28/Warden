function pad(value) {
  return String(value).padStart(2, '0');
}

export function getTodayDateInputValue() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function getNowDateTimeInputValue(offsetMs = 0) {
  const moment = new Date(Date.now() + offsetMs);
  const day = `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
  return `${day}T${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}
