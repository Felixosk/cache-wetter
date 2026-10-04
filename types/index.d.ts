export type Reading = {
  /** Ende der letzten Antwort, ms seit Epoch */
  lastAt: number
  /** Cache-Hit-Rate der letzten Antwort, 0 bis 100 */
  hit: number | null
  /** Kontextfüllung in Prozent des Fensters */
  ctxPct: number | null
  /** Auto-Compact-Schwelle in Prozent des Fensters */
  thresholdPct: number
  /** true, wenn die Schwelle gelesen wurde (sonst Ersatzwert 83) */
  isThresholdRead: boolean
}

export type ModelTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
  /** Kosten in US-Dollar (Listenpreis, API-Wert) */
  usd: number
}

export type SourceTotals = { usd: number; turns: number }

export type ToolTotals = {
  /** Tool, MCP, Skill */
  kind: string
  calls: number
  /** geschätzte Tokens der Ergebnisse (Zeichen / 4) */
  tokens: number
  /** geschätzte Kosten: Ergebnis einmal in den Cache geschrieben */
  usd: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-wetter': {
      reading: Reading | null
      ttlMinutes: number
      isCollapsed: boolean
      tick: number
      usage: Record<string, ModelTotals>
      isCostOpen: boolean
      sources: Record<string, SourceTotals>
      tools: Record<string, ToolTotals>
      agentTypes: Record<string, string>
      lastModel: string
    }
  }
}
