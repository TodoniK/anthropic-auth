const HOST_PATTERN =
  /(?:^|[/\\])(opencode|litecode|opencode2|pi)(?:\.exe)?(?=$|\s|")/i

export class ProcessInspectionError extends Error {
  readonly code = 'process-inspection-failed'
  constructor() {
    super('Process inspection failed; setup cannot prove hosts are stopped.')
    this.name = 'ProcessInspectionError'
  }
}

export class ProcessFenceViolationError extends Error {
  readonly activeHosts: Array<{ pid: number; command: string }>
  constructor(activeHosts: Array<{ pid: number; command: string }>) {
    // Process arguments can contain bearer material. Retain only the recognized
    // executable name in diagnostics, never the full command or runner stderr.
    const safeHosts = activeHosts.map((host) => ({
      pid: host.pid,
      command: HOST_PATTERN.exec(host.command)?.[1] ?? 'host',
    }))
    const list = safeHosts
      .map((h) => `  - PID ${h.pid}: ${h.command}`)
      .join('\n')
    super(
      `OpenCode or Pi processes are currently running:\n${list}\n\n` +
        `Please quit all OpenCode, LiteCode, and Pi processes before running setup.`,
    )
    this.activeHosts = safeHosts
    this.name = 'ProcessFenceViolationError'
  }
}
