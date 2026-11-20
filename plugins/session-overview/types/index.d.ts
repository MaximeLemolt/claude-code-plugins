export type Line = {
  model: string
  configModel: string
  effort: string
  branch: string
  percent: number | null
  // The context figure predates the last compaction and could not be refreshed yet.
  isStale: boolean
  cost: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-overview': { line: Line }
  }
}
