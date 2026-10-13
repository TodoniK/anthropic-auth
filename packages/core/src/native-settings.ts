/** Treat malformed or absent settings sections as empty, without accepting arrays. */
export function nativeSettingsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Patch one section without replacing unrelated native settings or section fields. */
export function mergeNativeSettingsSection(
  settings: Readonly<Record<string, unknown>>,
  section: string,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...settings,
    [section]: { ...nativeSettingsRecord(settings[section]), ...patch },
  }
}

/** When keep-warm runs continuously, remove any previous start/end hour restriction. */
export function nativeCacheKeepAlways(
  settings: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const {
    startHour: _start,
    endHour: _end,
    ...keep
  } = nativeSettingsRecord(settings.cacheKeep)
  return { ...settings, cacheKeep: { ...keep, enabled: true, always: true } }
}
