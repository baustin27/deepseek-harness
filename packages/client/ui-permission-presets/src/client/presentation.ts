import { en } from './locales.ts'

/** Machine value of the preset that runs directly in the current host account/container. */
export const DEVELOPER_HOST_ACCESS_PRESET = 'developer-host-access'

/** Machine value of the legacy unrestricted sandbox opt-down. */
export const FULL_ACCESS_PRESET = 'danger-full-access'

/** Locale dictionary key for a built-in permission preset label. */
export type PermissionPresetLabelKey =
  | 'preset.readOnly'
  | 'preset.workspaceWrite'
  | 'preset.fullAccess'
  | 'preset.developerHostAccess'

const PRESET_LABEL_KEYS = new Map<string, PermissionPresetLabelKey>([
  ['read-only', 'preset.readOnly'],
  ['workspace-write', 'preset.workspaceWrite'],
  [FULL_ACCESS_PRESET, 'preset.fullAccess'],
  [DEVELOPER_HOST_ACCESS_PRESET, 'preset.developerHostAccess'],
])

const DEFAULT_PRESET_LABELS: Record<PermissionPresetLabelKey, string> = {
  'preset.readOnly': en['preset.readOnly'],
  'preset.workspaceWrite': en['preset.workspaceWrite'],
  'preset.fullAccess': en['preset.fullAccess'],
  'preset.developerHostAccess': en['preset.developerHostAccess'],
}

/**
 * Convert conventional kebab-case preset names into user-facing title case.
 * @param name - host-supplied preset label or key.
 * @returns the title-cased conventional key, or a non-kebab label unchanged.
 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * Render a permission preset under its product label.
 * @param value - preset machine value.
 * @param name - host-supplied preset name.
 * @param t - optional locale dictionary lookup for built-in product labels.
 * @returns the built-in product label or the conventional display name.
 */
export function displayPermissionPreset(
  value: string,
  name: string,
  t?: (key: PermissionPresetLabelKey) => string,
): string {
  const key = PRESET_LABEL_KEYS.get(value)
  if (key !== undefined && (name === value || name === DEFAULT_PRESET_LABELS[key])) {
    return t?.(key) ?? DEFAULT_PRESET_LABELS[key]
  }
  return displayPresetName(name)
}
