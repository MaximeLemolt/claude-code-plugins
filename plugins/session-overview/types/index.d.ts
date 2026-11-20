export type Line = {
  model: string
  configModel: string
  effort: string
  branch: string
  percent: number | null
  cost: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-overview': { line: Line }
  }
}
