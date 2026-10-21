export const INLINE_TRUSTED_LIMIT = 3;

export function currentFirst(devices) {
  return [...devices.filter((device) => device.current), ...devices.filter((device) => !device.current)];
}

export function inlineDevices(devices, limit = INLINE_TRUSTED_LIMIT) {
  return currentFirst(devices).slice(0, limit);
}

export function hasOverflow(devices, limit = INLINE_TRUSTED_LIMIT) {
  return devices.length > limit;
}

export function overflowCount(devices, limit = INLINE_TRUSTED_LIMIT) {
  return Math.max(0, devices.length - limit);
}
