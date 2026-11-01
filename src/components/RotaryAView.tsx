import { useEffect, useMemo, useRef, useState } from 'react'
import type { GCodeModel } from '../lib/gcode'
import { buildStatic3DGeometry, type RenderLines } from '../lib/gcodeBuild'
import { createRenderer, renderLines, setStaticLineData, type WebGLRenderer, type Camera } from '../lib/webgl'
import { buildRotaryRenderLines, DEFAULT_ROTARY_SETUP, findRotaryProgress, rotaryBounds, rotaryMotionPoint, rotaryPartPoint, rotaryPlaybackDistances, rotaryProgressAt, type RotarySetup } from '../lib/gcodeRotary'
import { useMachineStore } from '../store'
import { getBase } from '../lib/http'

function readSetup(): RotarySetup {
  try {
    // Controller address is part of the key: the X and Y machines keep separate setups.
    const saved = JSON.parse(localStorage.getItem(`gcode.rotaryA.${getBase() || location.host}`) ?? '{}')
    return {
      axis: saved.axis === 'X' ? 'X' : 'Y',
      center: Number.isFinite(saved.center) ? saved.center : 0,
      centerZ: Number.isFinite(saved.centerZ) ? saved.centerZ : 0,
      reverse: saved.reverse === true,
    }
  } catch { return DEFAULT_ROTARY_SETUP }
}

interface Props {
  model: GCodeModel
  showRapids: boolean
  showTool: boolean
  hiddenTools: Set<number>
  fitSignal: number
  stale: boolean
}

export function RotaryAView({ model, showRapids, showTool, hiddenTools, fitSignal, stale }: Props) {
  const [setup, setSetup] = useState<RotarySetup>(readSetup)
  const [lines, setLines] = useState<RenderLines | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [webglError, setWebglError] = useState(false)
  const [contextVersion, setContextVersion] = useState(0)
  const [fraction, setFraction] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [follow, setFollow] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)
  const cameraState = useRef({ theta: Math.PI / 4, phi: Math.PI / 3, zoom: 1, panX: 0, panY: 0 })
  const drag = useRef<{ x: number; y: number; pan: boolean } | null>(null)
  const redrawRef = useRef<() => void>(() => {})
  const [cameraVersion, setCameraVersion] = useState(0)
  const liveHint = useRef(0)
  const status = useMachineStore(s => s.status)
  const connected = useMachineStore(s => s.connected)
  const machineActive = connected && ['Run', 'Hold', 'Door'].includes(status.state)
  const distances = useMemo(() => rotaryPlaybackDistances(model.segments, setup), [model, setup])
  const bounds = useMemo(() => lines ? rotaryBounds(lines) : model.bounds, [lines, model])
  const geometry = useMemo(() => lines ? buildStatic3DGeometry(lines, showRapids, hiddenTools) : null, [lines, showRapids, hiddenTools])

  useEffect(() => {
    localStorage.setItem(`gcode.rotaryA.${getBase() || location.host}`, JSON.stringify(setup))
    let active = true
    setLines(null); setError(null); setPlaying(false)
    buildRotaryRenderLines(model.segments, setup, () => active).then(result => {
      if (active) setLines(result)
    }).catch(reason => { if (active) setError(String(reason.message ?? reason)) })
    return () => { active = false }
  }, [model, setup])

  useEffect(() => { setFraction(0); liveHint.current = 0 }, [model])
  useEffect(() => {
    cameraState.current.zoom = 1; cameraState.current.panX = 0; cameraState.current.panY = 0
    setCameraVersion(v => v + 1)
  }, [model, setup, fitSignal])
  useEffect(() => { if (machineActive) setPlaying(false) }, [machineActive])

  useEffect(() => {
    if (!playing || machineActive) return
    let frame = 0, previous = performance.now()
    const tick = (now: number) => {
      // Preview speed only: a complete traversal in 30 seconds, unrelated to machine ETA.
      const delta = Math.min(now - previous, 100) / 30000
      previous = now
      setFraction(old => Math.min(1, old + delta))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, machineActive])
  useEffect(() => { if (fraction >= 1) setPlaying(false) }, [fraction])

  const liveProgress = useMemo(() => {
    if (!follow || !machineActive || stale || status.mpos.a == null) return null
    const ref = model.referenceWco ?? { x: 0, y: 0, z: 0, a: 0 }
    const match = findRotaryProgress(model.segments, {
      x: status.mpos.x - ref.x, y: status.mpos.y - ref.y, z: status.mpos.z - ref.z,
      a: status.mpos.a - (ref.a ?? 0),
    }, liveHint.current)
    if (match) liveHint.current = match.segmentIndex
    return match
  }, [model, follow, machineActive, stale, status.mpos])
  const progress = liveProgress ?? rotaryProgressAt(distances, fraction)
  const seg = progress ? model.segments.get(progress.segmentIndex) : null
  const motionPoint = seg && progress ? rotaryMotionPoint(seg, progress.fraction) : null
  const point = motionPoint ? rotaryPartPoint(motionPoint, setup) : null
  const displayedA = follow && machineActive ? status.wpos.a
    : motionPoint ? motionPoint.a - (seg?.aOffset ?? 0) : 0
  const liveUnmatched = follow && machineActive && !liveProgress

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const renderer = createRenderer(canvas)
    rendererRef.current = renderer
    setWebglError(!renderer)
    const resize = new ResizeObserver(() => redrawRef.current())
    resize.observe(canvas)
    const lost = (event: Event) => { event.preventDefault(); rendererRef.current = null; setWebglError(true) }
    const restored = () => setContextVersion(v => v + 1)
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation()
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1)
      cameraState.current.zoom = Math.max(0.01, Math.min(100, cameraState.current.zoom * Math.exp(pixels * 0.001)))
      redrawRef.current()
    }
    canvas.addEventListener('webglcontextlost', lost)
    canvas.addEventListener('webglcontextrestored', restored)
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => {
      resize.disconnect()
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('webglcontextrestored', restored)
      canvas.removeEventListener('wheel', wheel)
      if (renderer && !renderer.gl.isContextLost()) {
        const gl = renderer.gl
        for (const buffer of [renderer.staticPositionBuffer, renderer.staticColorBuffer, renderer.dynamicPositionBuffer, renderer.dynamicColorBuffer, renderer.trianglePositionBuffer, renderer.triangleColorBuffer]) gl.deleteBuffer(buffer)
        for (const shader of gl.getAttachedShaders(renderer.program) ?? []) gl.deleteShader(shader)
        gl.deleteProgram(renderer.program)
      }
      rendererRef.current = null
    }
  }, [contextVersion])

  useEffect(() => {
    const renderer = rendererRef.current
    if (renderer) setStaticLineData(renderer, geometry?.vertices ?? new Float32Array(), geometry?.colors ?? new Uint8Array())
  }, [geometry, contextVersion])

  function draw() {
    const canvas = canvasRef.current, renderer = rendererRef.current
    if (!canvas || !renderer) return
    const rect = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    const aspect = width / height, state = cameraState.current
    const target = {
      x: (bounds.minX + bounds.maxX) / 2 + state.panX,
      y: (bounds.minY + bounds.maxY) / 2 + state.panY,
      z: (bounds.minZ + bounds.maxZ) / 2,
    }
    const diagonal = Math.max(10, Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ))
    const radius = diagonal * 3
    const camera: Camera = {
      position: { x: target.x + radius * Math.sin(state.phi) * Math.cos(state.theta), y: target.y + radius * Math.sin(state.phi) * Math.sin(state.theta), z: target.z + radius * Math.cos(state.phi) },
      target, up: { x: 0, y: 0, z: 1 }, fov: Math.PI / 4, aspect, near: 0.01, far: radius * 3,
      projection: 'orthographic', orthoSize: diagonal * 0.58 / Math.min(1, aspect) * state.zoom,
    }
    const vertices: number[] = [], colors: number[] = []
    const add = (a: number[], b: number[], color: number[]) => { vertices.push(...a, ...b); colors.push(...color, ...color) }
    // Rotary centreline in the stationary part frame.
    if (setup.axis === 'X') add([bounds.minX, setup.center, setup.centerZ], [bounds.maxX, setup.center, setup.centerZ], [0.4, 0.7, 1, 0.8])
    else add([setup.center, bounds.minY, setup.centerZ], [setup.center, bounds.maxY, setup.centerZ], [0.4, 0.7, 1, 0.8])
    const toolStart = vertices.length / 3
    if (showTool && point && !liveUnmatched) {
      const r = diagonal * 0.012 * state.zoom
      add([point.x - r, point.y, point.z], [point.x + r, point.y, point.z], [1, 0.25, 0.2, 1])
      add([point.x, point.y - r, point.z], [point.x, point.y + r, point.z], [1, 0.25, 0.2, 1])
      add([point.x, point.y, point.z - r], [point.x, point.y, point.z + r], [1, 0.25, 0.2, 1])
    }
    renderLines(renderer, camera, new Float32Array(vertices), new Float32Array(colors), toolStart, 3, undefined, undefined, stale ? 0.3 : 1)
  }
  redrawRef.current = draw
  useEffect(draw, [geometry, bounds, point?.x, point?.y, point?.z, showTool, liveUnmatched, setup, cameraVersion, contextVersion, stale])

  const update = (patch: Partial<RotarySetup>) => setSetup(old => ({ ...old, ...patch }))
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-surface" aria-label="Visualizzatore asse A">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <strong className="text-accent">A rotativo</strong>
        <label className="flex items-center gap-1">Parallelo a
          <select className="rounded border border-border bg-elevated px-2 py-1" value={setup.axis} onChange={e => update({ axis: e.currentTarget.value as 'X' | 'Y' })}>
            <option value="X">X</option><option value="Y">Y</option>
          </select>
        </label>
        <button className="btn px-2 py-1 text-xs" onClick={() => setSettingsOpen(v => !v)} aria-expanded={settingsOpen}>Centro e verso</button>
        <button className="btn px-2 py-1 text-xs" onClick={() => { cameraState.current = { theta: Math.PI / 4, phi: Math.PI / 3, zoom: 1, panX: 0, panY: 0 }; setCameraVersion(v => v + 1) }}>Adatta</button>
      </div>
      {settingsOpen && <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-xs">
        {(['center', 'centerZ'] as const).map(key => <label key={key} className="flex items-center gap-1">
          {key === 'center' ? `Centro ${setup.axis === 'X' ? 'Y' : 'X'}` : 'Centro Z'} (mm)
          <input aria-label={key === 'center' ? 'Centro trasversale' : 'Centro Z'} type="number" step="any" className="w-20 rounded border border-border bg-elevated px-2 py-1" value={setup[key]} onChange={e => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value)) update({ [key]: value }) }} />
        </label>)}
        <label className="flex items-center gap-1"><input type="checkbox" checked={setup.reverse} onChange={e => update({ reverse: e.currentTarget.checked })} />Inverti verso A</label>
        <span className="text-text-muted">Z0 al centro: centro Z = 0</span>
      </div>}
      <div className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-grab" style={{ touchAction: 'none' }}
          onContextMenu={e => e.preventDefault()}
          onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button !== 0 } }}
          onPointerMove={e => {
            if (!drag.current) return
            const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y
            if (drag.current.pan) {
              const size = Math.max(10, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) * cameraState.current.zoom / Math.max(100, e.currentTarget.clientHeight)
              const theta = cameraState.current.theta
              cameraState.current.panX += (Math.sin(theta) * dx + Math.cos(theta) * dy) * size
              cameraState.current.panY += (-Math.cos(theta) * dx + Math.sin(theta) * dy) * size
            } else {
              cameraState.current.theta -= dx * 0.008
              cameraState.current.phi = Math.max(0.02, Math.min(Math.PI - 0.02, cameraState.current.phi + dy * 0.008))
            }
            drag.current.x = e.clientX; drag.current.y = e.clientY; draw()
          }}
          onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
        {(!lines || error || webglError) && <div role="status" className="absolute inset-0 flex items-center justify-center bg-surface/90 p-4 text-center text-sm">
          {error ?? (webglError ? 'WebGL non disponibile. Usa la vista XYZ o riattiva WebGL nel browser.' : 'Preparazione del percorso rotativo…')}
        </div>}
        <div className="pointer-events-none absolute bottom-2 left-3 text-xs text-text-muted">Pezzo fermo · trascina per ruotare · rotella per zoom · Maiusc per spostare</div>
      </div>
      <div className="space-y-2 border-t border-border bg-surface px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono">
          <span>A {displayedA?.toFixed(2) ?? '—'}°</span><span>Giri {displayedA != null ? (displayedA / 360).toFixed(2) : '—'}</span>
          <span>Riga {seg?.sourceLine ?? '—'}</span>
          <span className="text-text-muted">{liveProgress ? 'Posizione macchina' : liveUnmatched ? 'Posizione macchina non agganciata' : 'Anteprima'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn px-3 py-1 text-xs" disabled={machineActive || !lines || !!error} onClick={() => { if (fraction >= 1) setFraction(0); setPlaying(v => !v) }}>{playing ? 'Pausa' : 'Riproduci'}</button>
          <button className="btn px-2 py-1 text-xs" disabled={machineActive} onClick={() => { setPlaying(false); setFraction(0) }}>Inizio</button>
          <input className="min-w-12 flex-1" aria-label="Scorri percorso A" type="range" min="0" max="1" step="0.00001" value={liveProgress ? (distances[liveProgress.segmentIndex] + liveProgress.fraction * (distances[liveProgress.segmentIndex + 1] - distances[liveProgress.segmentIndex])) / Math.max(1e-9, distances[distances.length - 1]) : fraction} disabled={machineActive && follow} onChange={e => { setPlaying(false); setFraction(Number(e.currentTarget.value)) }} />
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={follow} onChange={e => setFollow(e.currentTarget.checked)} />Segui macchina</label>
        </div>
        <div className="text-xs text-text-muted">Percorso utensile sul pezzo · riproduzione indicativa, senza stima tempi né asportazione materiale</div>
      </div>
    </div>
  )
}
