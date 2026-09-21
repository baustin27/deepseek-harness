/** `settings.permission` namespace dictionaries (the Permission row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '权限',
  'description': '选择新会话的默认权限模式',
  'loading': '加载中',
  'unavailable': '不可用',
  'preset.readOnly': '仅可查看',
  'preset.workspaceWrite': '工作区内修改',
  'preset.fullAccess': '沙箱完全访问',
  'preset.developerHostAccess': '开发者主机访问',
  'confirm.title': '确认启用沙箱完全访问？',
  'confirm.description': '启用沙箱完全访问后，新会话可以在沙箱范围外修改文件，但仍受操作系统账户和容器边界约束。仅建议在你信任后续任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '启用沙箱完全访问',
  'confirm.host.title': '确认启用开发者主机访问？',
  'confirm.host.description': '开发者主机访问会在当前操作系统账户和容器中直接运行命令，并继承主机文件系统、网络和进程可见性。附件保持不可变且不会挂载。仅建议在你信任后续任务时使用。',
  'confirm.host.enable': '启用开发者主机访问',
} satisfies Record<string, string>

/** The settings.permission namespace key union. */
export type PermissionSettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Permission',
  'description': 'Choose the default permission mode for new sessions',
  'loading': 'Loading',
  'unavailable': 'Unavailable',
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Sandbox Full access',
  'preset.developerHostAccess': 'Developer host access',
  'confirm.title': 'Enable Sandbox Full access?',
  'confirm.description': 'Sandbox Full access lets new sessions write outside the sandbox boundary, while the operating-system account and container boundaries still apply. Only use it when you trust subsequent tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Sandbox Full access',
  'confirm.host.title': 'Enable Developer host access?',
  'confirm.host.description': 'Developer host access runs commands directly in the current operating-system account and container with host filesystem, network, and process visibility. Attachments remain immutable and are never mounted. Only use it when you trust subsequent tasks.',
  'confirm.host.enable': 'Enable Developer host access',
} satisfies Record<PermissionSettingsKey, string>

/** Simplified Chinese dictionary for the current-session popup gate. */
export const accessZh = {
  'preset.readOnly': '仅可查看',
  'preset.workspaceWrite': '工作区内修改',
  'preset.fullAccess': '沙箱完全访问',
  'preset.developerHostAccess': '开发者主机访问',
  'confirm.title': '确认启用沙箱完全访问？',
  'confirm.description': '启用沙箱完全访问后，智能体可以在沙箱范围外修改文件，但仍受操作系统账户和容器边界约束。仅建议在你信任当前任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '启用沙箱完全访问',
  'confirm.host.title': '确认启用开发者主机访问？',
  'confirm.host.description': '开发者主机访问会在当前操作系统账户和容器中直接运行命令，并继承主机文件系统、网络和进程可见性。附件保持不可变且不会挂载。仅建议在你信任当前任务时使用。',
  'confirm.host.enable': '启用开发者主机访问',
} satisfies Record<string, string>

/** Current-session popup-gate key union. */
export type PermissionAccessKey = keyof typeof accessZh

/** English dictionary for the current-session popup gate. */
export const accessEn = {
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Sandbox Full access',
  'preset.developerHostAccess': 'Developer host access',
  'confirm.title': 'Enable Sandbox Full access?',
  'confirm.description': 'Sandbox Full access reduces confinement and lets the agent write outside the sandbox boundary, while the operating-system account and container boundaries still apply. Only use it when you trust the current task.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Sandbox Full access',
  'confirm.host.title': 'Enable Developer host access?',
  'confirm.host.description': 'Developer host access runs commands directly in the current operating-system account and container with host filesystem, network, and process visibility. Attachments remain immutable and are never mounted. Only use it when you trust the current task.',
  'confirm.host.enable': 'Enable Developer host access',
} satisfies Record<PermissionAccessKey, string>
