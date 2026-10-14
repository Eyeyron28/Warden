// One formatter each, made once. `date.toLocaleDateString(undefined, options)` builds a whole new Intl.DateTimeFormat on EVERY
// call, which is slow enough to matter in a list: profiling My files at 4x CPU slowdown showed this function as the largest
// single piece of script time (about 590 ms) because the page formats two dates per file on every render. Same output.
const DATE = { year: 'numeric', month: 'short', day: 'numeric' };
const DATE_TIME = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

let dateFormat = null;
let dateTimeFormat = null;
const dayCache = new Map(); // ms of the day -> text (many files share a day)

const invalid = (date) => Number.isNaN(date.getTime());

export function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (invalid(date)) return 'Invalid Date';
  dateFormat ||= new Intl.DateTimeFormat(undefined, DATE);
  // The text depends on the local day only, so one result serves every file made that day.
  const key = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  let text = dayCache.get(key);
  if (text === undefined) {
    text = dateFormat.format(date);
    if (dayCache.size > 2000) dayCache.clear();
    dayCache.set(key, text);
  }
  return text;
}

export function formatDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (invalid(date)) return 'Invalid Date';
  dateTimeFormat ||= new Intl.DateTimeFormat(undefined, DATE_TIME);
  return dateTimeFormat.format(date);
}
