import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ModelTotals, Reading, SourceTotals, ToolTotals } from '../types'

const reading = atom({ plugin: 'cache-wetter', key: 'reading' } as const, null)
// Diese Session läuft mit 1 Stunde Cache. Wird unten aus echten Antworten nachgelernt.
const ttlMinutes = atom({ plugin: 'cache-wetter', key: 'ttlMinutes' } as const, 60)
const isCollapsed = atom({ plugin: 'cache-wetter', key: 'isCollapsed' } as const, false)
const tick = atom({ plugin: 'cache-wetter', key: 'tick' } as const, 0)

const usage = atom({ plugin: 'cache-wetter', key: 'usage' } as const, {} as Record<string, ModelTotals>)
const isCostOpen = atom({ plugin: 'cache-wetter', key: 'isCostOpen' } as const, false)
const sources = atom({ plugin: 'cache-wetter', key: 'sources' } as const, {} as Record<string, SourceTotals>)
const tools = atom({ plugin: 'cache-wetter', key: 'tools' } as const, {} as Record<string, ToolTotals>)
const agentTypes = atom({ plugin: 'cache-wetter', key: 'agentTypes' } as const, {} as Record<string, string>)
const lastModel = atom({ plugin: 'cache-wetter', key: 'lastModel' } as const, 'claude-opus-5-5')

function toolKey(name: string, input: Record<string, unknown>): { key: string; kind: string } {
  if (name === 'Skill' && typeof input.skill === 'string') return { key: `/${input.skill}`, kind: 'Skill' }
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1] ?? name
    return { key: server, kind: 'MCP' }
  }
  return { key: name, kind: 'Tool' }
}

// Listenpreise in $ pro 1 Mio. Token (Stand 25.09.2026). Cache schreiben: 5 Min = 1,25x, 1 Std = 2x Input.
const PRICES: { match: string; name: string; input: number; output: number; read: number }[] = [
  { match: 'fable', name: 'Fable', input: 10, output: 50, read: 0.25 },
  { match: 'opus', name: 'Opus', input: 4, output: 20, read: 0.2 },
  { match: 'sonnet', name: 'Sonnet', input: 2, output: 10, read: 0.2 },
  { match: 'haiku', name: 'Haiku', input: 1, output: 5, read: 0.1 },
]

function priceOf(model: string) {
  return PRICES.find(p => model.includes(p.match)) ?? null
}

function labelOf(model: string): string {
  const p = priceOf(model)
  if (!p) return model
  const ver = model.replace(/-\d{8}$/, '').match(/-(\d{1,2})(?:-(\d{1,2}))?$/)
  return ver ? `${p.name} ${ver[2] ? `${ver[1]}.${ver[2]}` : ver[1]}` : p.name
}

function costOf(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }, ttl: number): number {
  const p = priceOf(model)
  if (!p) return 0
  const write = p.input * (ttl >= 60 ? 2 : 1.25)
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.read + u.cacheWrite * write) / 1_000_000
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–'
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

const FALLBACK_THRESHOLD = 83

// Farben wie bei /usage: blau normal, orange und rot nur als Warnung
const BLUE = '#5b7cfa'
const ORANGE = '#f59e0b'
const RED = '#ef4444'
const TRACK = '#3a3f4b'

function weatherOf(ctxPct: number, thresholdPct: number): string {
  const ratio = ctxPct / thresholdPct
  if (ratio < 0.5) return '☀️'
  if (ratio < 0.8) return '🌧'
  return '⛈'
}

export const register: Register = on => {
  let gapMs: number | null = null

  on('session.start', ($, e, next) => {
    $.clock.every(60_000, () => {
      void update($, tick, n => n + 1)
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const last = await read($, reading)
    gapMs = last ? (await $.clock.now()) - last.lastAt : null
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    if (res.agentId) {
      const id = res.agentId
      await update($, agentTypes, all => ({ ...all, [id]: e.subagentType }))
    }
    return res
  })

  on('tool.call', async ($, e, next) => {
    const res = await next(e)
    if (res.deny !== undefined || e.tool === 'Agent' || e.tool === 'Task') return res
    let chars = 0
    try {
      chars = res.text?.length ?? JSON.stringify(res.result ?? '').length
    } catch {
      chars = 0
    }
    const tok = Math.round(chars / 4)
    const model = await read($, lastModel)
    const ttlNow = await read($, ttlMinutes)
    const usdEst = costOf(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: tok }, ttlNow)
    const { key, kind } = toolKey(e.tool, e as unknown as Record<string, unknown>)
    await update($, tools, all => {
      const old = all[key] ?? { kind, calls: 0, tokens: 0, usd: 0 }
      return { ...all, [key]: { kind, calls: old.calls + 1, tokens: old.tokens + tok, usd: old.usd + usdEst } }
    })
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    const now = await $.clock.now()
    const u = e.usage
    let hit: number | null = null
    if (u) {
      const ttlNow = await read($, ttlMinutes)
      const part = {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      }
      const turnUsd = costOf(u.model, part, ttlNow)
      const types = await read($, agentTypes)
      const src = e.agentId === undefined ? 'Haupt-Chat' : (types[e.agentId] ?? 'Unteragent')
      await update($, sources, all => {
        const old = all[src] ?? { usd: 0, turns: 0 }
        return { ...all, [src]: { usd: old.usd + turnUsd, turns: old.turns + 1 } }
      })
      if (e.agentId === undefined) await update($, lastModel, () => u.model)
      await update($, usage, all => {
        const old = all[u.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, usd: 0 }
        return {
          ...all,
          [u.model]: {
            input: old.input + part.input,
            output: old.output + part.output,
            cacheRead: old.cacheRead + part.cacheRead,
            cacheWrite: old.cacheWrite + part.cacheWrite,
            turns: old.turns + 1,
            usd: old.usd + costOf(u.model, part, ttlNow),
          },
        }
      })
    }
    if (e.agentId !== undefined) return result
    if (u) {
      const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      hit = total > 0 ? Math.round((u.cache_read_input_tokens / total) * 100) : null

      // Laufzeit nachlernen: Pause zwischen 6 und 55 Minuten verrät, ob 5 Min oder 1 Std gilt
      if (gapMs !== null && gapMs > 6 * 60_000 && gapMs < 55 * 60_000) {
        const isWarm = u.cache_read_input_tokens > u.cache_creation_input_tokens
        await update($, ttlMinutes, () => (isWarm ? 60 : 5))
      }
    }

    let ctxPct: number | null = null
    let thresholdPct = FALLBACK_THRESHOLD
    let isThresholdRead = false
    try {
      const { context } = await $.session.usage({ breakdown: 'summary' })
      ctxPct = context.percent ?? null
      const threshold = context.breakdown?.autoCompactThreshold
      if (threshold && context.window > 0) {
        thresholdPct = Math.round((threshold / context.window) * 100)
        isThresholdRead = true
      }
    } catch {
      // Ersatzwert bleibt
    }

    const next_: Reading = { lastAt: now, hit, ctxPct, thresholdPct, isThresholdRead }
    await update($, reading, () => next_)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const r: Reading = (await read($, reading)) ?? {
      lastAt: await $.clock.now(),
      hit: null,
      ctxPct: null,
      thresholdPct: FALLBACK_THRESHOLD,
      isThresholdRead: false,
    }

    await read($, tick)
    const ttl = await read($, ttlMinutes)
    const collapsed = await read($, isCollapsed)
    const now = await $.clock.now()
    const totals = await read($, usage)
    const costOpen = await read($, isCostOpen)
    const srcAll = await read($, sources)
    const toolAll = await read($, tools)
    const rows = Object.entries(totals).sort((a, b) => b[1].usd - a[1].usd)
    const sumUsd = rows.reduce((acc, [, t]) => acc + t.usd, 0)

    const totalMs = ttl * 60_000
    const leftMs = Math.max(0, r.lastAt + totalMs - now)
    const leftMin = Math.ceil(leftMs / 60_000)
    const frac = leftMs / totalMs
    const cacheColor = frac <= 0.1 ? RED : frac <= 0.25 ? ORANGE : BLUE
    const cacheText = leftMs === 0 ? 'expired' : `${leftMin} min`

    const ctx = r.ctxPct ?? 0
    const weather = weatherOf(ctx, r.thresholdPct)
    const isStorm = weather === '⛈'

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined

    // Balken wie bei /usage: in der App als SVG (rund, mittig, passt sich der Breite an),
    // im Terminal aus ▬-Zeichen
    const BLOCK = '▬'.repeat(400)
    const meter = (fillPct: number, color: string, key?: string, marginX = 0) => {
      const fill = Math.max(0, Math.min(100, fillPct))
      if (Svg) {
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="8">` +
          `<rect x="0" y="0" width="100%" height="8" rx="4" fill="${TRACK}"/>` +
          (fill > 0 ? `<rect x="0" y="0" width="${fill}%" height="8" rx="4" fill="${color}"/>` : '') +
          `</svg>`
        return (
          <Box key={key} flexGrow={1} minWidth={6} marginX={marginX} alignItems="center" justifyContent="center">
            <Svg source={svg} alt={`${Math.round(fill)}%`} height={8} />
          </Box>
        )
      }
      return (
        <Box key={key} flexGrow={1} minWidth={6} height={1} overflow="hidden" position="relative" marginX={marginX}>
          <Text color={TRACK}>{BLOCK}</Text>
          <Box position="absolute" top={0} left={0} width={`${fill}%`} height={1} overflow="hidden">
            <Text color={color}>{BLOCK}</Text>
          </Box>
        </Box>
      )
    }

    const toggle = (
      <Button
        key="toggle"
        plain
        dimColor
        label={collapsed ? '▸' : costOpen ? '▴' : '▾'}
        onPress={async () => {
          if (collapsed) {
            await update($, isCollapsed, () => false)
            await update($, isCostOpen, () => false)
          } else if (!costOpen) {
            await update($, isCostOpen, () => true)
          } else {
            await update($, isCostOpen, () => false)
            await update($, isCollapsed, () => true)
          }
        }}
      />
    )

    if (collapsed) {
      return (
        <Box flexDirection="row" gap={1}>
          {toggle}
          <Text>{weather}</Text>
          <Text color={cacheColor}>Cache {cacheText}</Text>
          <Text dimColor>Context {ctx}%</Text>
          <Text bold>{usd(sumUsd)}</Text>
        </Box>
      )
    }

    const compact = async () => {
      if (e.props.isWorking) {
        $.ui.toast('Compact works once Claude is done')
        return
      }
      try {
        await $.session.compact()
      } catch {
        $.ui.toast('Compact did not work right now')
      }
    }

    const LABEL_W = 19
    const COL_W = 11
    const sum = rows.reduce(
      (acc, [, t]) => ({
        input: acc.input + t.input,
        output: acc.output + t.output,
        cacheRead: acc.cacheRead + t.cacheRead,
        cacheWrite: acc.cacheWrite + t.cacheWrite,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    )
    const inAll = sum.input + sum.cacheRead + sum.cacheWrite
    const hitAll = inAll > 0 ? Math.round((sum.cacheRead / inAll) * 100) : null

    const rule = (
      <Box width="100%" height={1} overflow="hidden">
        <Text color={TRACK}>{'─'.repeat(400)}</Text>
      </Box>
    )

    // Hauptzahlen hell, Details grau
    const tableRow = (label: string, values: string[], tone: 'head' | 'detail' | 'total') => (
      <Box key={label} flexDirection="row">
        <Box width={LABEL_W} flexShrink={0}>
          <Text bold={tone !== 'detail'} dimColor={tone === 'detail'}>
            {label}
          </Text>
        </Box>
        {values.map((v, i) => (
          <Box key={`${label}-${i}`} flexGrow={1} width={COL_W} justifyContent="flex-end">
            <Text bold={tone !== 'detail'} dimColor={tone === 'detail'}>
              {v}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const perModel = (pick: (t: ModelTotals) => string, total: string) => [
      ...rows.map(([, t]) => pick(t)),
      total,
    ]

    const modelsView =
      rows.length === 0 ? (
        <Text dimColor>Nothing counted yet</Text>
      ) : (
        <Box flexDirection="column">
          {tableRow('Models', [...rows.map(([m]) => labelOf(m)), 'Total'], 'head')}
          {tableRow('Input', perModel(t => tokens(t.input), tokens(sum.input)), 'detail')}
          {tableRow('Output', perModel(t => tokens(t.output), tokens(sum.output)), 'detail')}
          {tableRow('Cache read', perModel(t => tokens(t.cacheRead), tokens(sum.cacheRead)), 'detail')}
          {tableRow('Cache write', perModel(t => tokens(t.cacheWrite), tokens(sum.cacheWrite)), 'detail')}
          {tableRow('Cache hit', perModel(t => pct(t.cacheRead, t.input + t.cacheRead + t.cacheWrite), hitAll === null ? '–' : `${hitAll}%`), 'detail')}
          {tableRow('Cost', perModel(t => usd(t.usd), usd(sumUsd)), 'total')}
        </Box>
      )

    // Main chat und Subagents genau, Tools/Skills/MCP geschätzt (~)
    const sourcesList = [
      ...Object.entries(srcAll).map(([name, t]) => ({
        name: name === 'Haupt-Chat' ? 'Main chat' : name,
        kind: name === 'Haupt-Chat' ? 'Chat' : 'Subagent',
        usd: t.usd,
        count: t.turns,
        isEstimate: false,
      })),
      ...Object.entries(toolAll).map(([name, t]) => ({
        name,
        kind: t.kind,
        usd: t.usd,
        count: t.calls,
        isEstimate: true,
      })),
    ]
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5)

    const sourcesView = (
      <Box flexDirection="column">
        <Text bold>What's costing money?</Text>
        {sourcesList.length === 0 ? <Text dimColor>Nothing counted yet</Text> : null}
        {sourcesList.map(q => {
          const share = sumUsd > 0 ? Math.min(1, q.usd / sumUsd) : 0
          const fillPct = q.usd > 0 ? Math.max(2, Math.round(share * 100)) : 0
          return (
            <Box key={`${q.kind}-${q.name}`} flexDirection="row" alignItems="center">
              <Box width={LABEL_W + COL_W} flexShrink={0} flexDirection="row" gap={1}>
                <Text wrap="truncate-end">{q.name}</Text>
                <Text dimColor>{q.kind}</Text>
              </Box>
              <Box width={5} flexShrink={0} justifyContent="flex-end">
                <Text dimColor>{q.count}×</Text>
              </Box>
              {meter(fillPct, BLUE, undefined, 2)}
              <Box width={9} flexShrink={0} justifyContent="flex-end">
                <Text bold={!q.isEstimate} dimColor={q.isEstimate}>
                  {`${q.isEstimate ? '~' : ''}${usd(q.usd)}`}
                </Text>
              </Box>
              <Box width={6} flexShrink={0} justifyContent="flex-end">
                <Text dimColor>{Math.round(share * 100)}%</Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )

    const legend = (
      <Box flexDirection="column">
        <Text bold>Legend</Text>
        <Text dimColor>
          ☀️ context under half the auto-compact limit · 🌧 over half · ⛈ close to the limit, compact now. Cache bar turns orange, then red, shortly before the cache expires. ~ means estimated, already part of Main chat.
        </Text>
      </Box>
    )

    const costRows = costOpen ? (
      <Box flexDirection="column" paddingLeft={2} gap={1}>
        {rule}
        {modelsView}
        {sourcesView}
        {legend}
      </Box>
    ) : null

    const keep = { flexShrink: 0 } as const

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          {toggle}
          <Box {...keep}>
            <Text color={cacheColor}>Cache {cacheText}</Text>
          </Box>
          {meter(leftMs > 0 ? Math.max(2, Math.round(frac * 100)) : 0, cacheColor, 'cache-meter')}
          <Text color={TRACK}>│</Text>
          <Box {...keep}>
            <Text dimColor>Hit {r.hit === null ? '–' : `${r.hit}%`}</Text>
          </Box>
          <Text color={TRACK}>│</Text>
          <Text>{weather}</Text>
          <Box {...keep}>
            <Text dimColor>Context {ctx}%</Text>
          </Box>
          <Button
            key="compact"
            label="Compact"
            variant={isStorm ? 'primary' : undefined}
            dimColor={!isStorm}
            onPress={compact}
          />
          <Text color={TRACK}>│</Text>
          <Box {...keep}>
            <Text bold>{usd(sumUsd)}</Text>
          </Box>
        </Box>
        {costRows}
      </Box>
    )
  })
}
