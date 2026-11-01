import { yieldToEventLoop, type GCodeModel, type Segment, type SegmentTable } from './gcode'
import { clamp01, getArcGeometry, getArcPoint, RenderLineWriter, type RenderLines } from './gcodeBuild'

export interface RotarySetup {
  axis: 'X' | 'Y'
  /** Transverse work coordinate of the rotary centre (Y for parallel X, X for parallel Y). */
  center: number
  centerZ: number
  reverse: boolean
}

export const DEFAULT_ROTARY_SETUP: RotarySetup = { axis: 'Y', center: 0, centerZ: 0, reverse: false }
export const MAX_ROTARY_RENDER_LINES = 1_000_000
const DEGREES = Math.PI / 180

export interface RotaryPoint { x: number; y: number; z: number; a: number }
export interface RotaryProgress { segmentIndex: number; fraction: number }

/** Interpolate the original motion before rotating: interpolating wrapped endpoints loses turns. */
export function rotaryMotionPoint(seg: Segment, fraction: number): RotaryPoint {
  const t = clamp01(fraction)
  const xyz = seg.i !== undefined ? getArcPoint(seg, getArcGeometry(seg), t) : {
    x: seg.x0 + (seg.x1 - seg.x0) * t,
    y: seg.y0 + (seg.y1 - seg.y0) * t,
    z: seg.z0 + (seg.z1 - seg.z0) * t,
  }
  return { ...xyz, a: (seg.a0 ?? 0) + ((seg.a1 ?? 0) - (seg.a0 ?? 0)) * t }
}

/** Toolpath in the stationary part's frame: apply the inverse table rotation. */
export function rotaryPartPoint(point: RotaryPoint, setup: RotarySetup) {
  const angle = (setup.reverse ? 1 : -1) * (point.a % 360) * DEGREES
  const c = Math.cos(angle), s = Math.sin(angle), z = point.z - setup.centerZ
  if (setup.axis === 'X') {
    const y = point.y - setup.center
    return { x: point.x, y: setup.center + c * y - s * z, z: setup.centerZ + s * y + c * z }
  }
  const x = point.x - setup.center
  return { x: setup.center + c * x + s * z, y: point.y, z: setup.centerZ - s * x + c * z }
}

export function rotarySubdivisionCount(seg: Segment) {
  const angular = Math.ceil(Math.abs((seg.a1 ?? 0) - (seg.a0 ?? 0)) / 5)
  const arc = seg.i !== undefined ? getArcGeometry(seg) : null
  return Math.max(1, angular, arc ? Math.ceil(arc.sweep / (5 * DEGREES)) : 0)
}

export async function buildRotaryRenderLines(
  segments: SegmentTable, setup: RotarySetup, shouldContinue: () => boolean = () => true,
): Promise<RenderLines> {
  const writer = new RenderLineWriter(Math.min(segments.length, 65536))
  let total = 0, sinceYield = 0
  for (let index = 0; index < segments.length; index++) {
    const seg = segments.get(index), steps = rotarySubdivisionCount(seg)
    total += steps
    if (total > MAX_ROTARY_RENDER_LINES) throw new Error('Percorso troppo grande per la vista rotativa (oltre 1 milione di tratti).')
    writer.breakChain()
    let from = rotaryPartPoint(rotaryMotionPoint(seg, 0), setup)
    for (let step = 1; step <= steps; step++) {
      const to = rotaryPartPoint(rotaryMotionPoint(seg, step / steps), setup)
      writer.push(from.x, from.y, from.z, to.x, to.y, to.z, segments.moveCode(index), segments.tools[index], false)
      from = to
      if (++sinceYield >= 4096) {
        sinceYield = 0
        await yieldToEventLoop()
        if (!shouldContinue()) throw new Error('stale-load')
      }
    }
  }
  return writer.finish(segments.hasTools)
}

export function rotaryBounds(lines: RenderLines): GCodeModel['bounds'] {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
  const p = lines.positions
  for (let i = 0; i < p.length; i += 3) {
    bounds.minX = Math.min(bounds.minX, p[i]); bounds.maxX = Math.max(bounds.maxX, p[i])
    bounds.minY = Math.min(bounds.minY, p[i + 1]); bounds.maxY = Math.max(bounds.maxY, p[i + 1])
    bounds.minZ = Math.min(bounds.minZ, p[i + 2]); bounds.maxZ = Math.max(bounds.maxZ, p[i + 2])
  }
  return p.length ? bounds : { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 }
}

/** Geometric playback distance only. Degrees are never used as mm or as a runtime estimate. */
export function rotaryPlaybackDistances(segments: SegmentTable, setup: RotarySetup) {
  const distances = new Float64Array(segments.length + 1)
  for (let i = 0; i < segments.length; i++) {
    const seg = segments.get(i)
    const transverse0 = (setup.axis === 'X' ? seg.y0 : seg.x0) - setup.center
    const transverse1 = (setup.axis === 'X' ? seg.y1 : seg.x1) - setup.center
    const radius = Math.max(1, Math.hypot(transverse0, seg.z0 - setup.centerZ), Math.hypot(transverse1, seg.z1 - setup.centerZ))
    const linear = seg.i !== undefined ? getArcGeometry(seg).sweep * getArcGeometry(seg).r
      : Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0, seg.z1 - seg.z0)
    distances[i + 1] = distances[i] + Math.max(1e-9, Math.hypot(linear, ((seg.a1 ?? 0) - (seg.a0 ?? 0)) * DEGREES * radius))
  }
  return distances
}

export function rotaryProgressAt(distances: Float64Array, fraction: number): RotaryProgress | null {
  if (distances.length < 2) return null
  const distance = clamp01(fraction) * distances[distances.length - 1]
  let low = 0, high = distances.length - 2
  while (low < high) {
    const mid = (low + high) >>> 1
    if (distances[mid + 1] < distance) low = mid + 1
    else high = mid
  }
  return { segmentIndex: low, fraction: clamp01((distance - distances[low]) / Math.max(1e-9, distances[low + 1] - distances[low])) }
}

/** A participates unwrapped in the match, so repeated turns and pure A moves remain distinct. */
export function findRotaryProgress(segments: SegmentTable, position: RotaryPoint, hint = 0): RotaryProgress | null {
  let best: RotaryProgress | null = null, bestError = Infinity
  for (let i = 0; i < segments.length; i++) {
    const seg = segments.get(i)
    const steps = seg.i !== undefined ? Math.max(8, Math.ceil(getArcGeometry(seg).sweep / (5 * DEGREES))) : 1
    for (let step = 0; step < steps; step++) {
      const from = rotaryMotionPoint(seg, step / steps), to = rotaryMotionPoint(seg, (step + 1) / steps)
      const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, da = (to.a - from.a) * DEGREES
      const px = position.x - from.x, py = position.y - from.y, pz = position.z - from.z, pa = (position.a - from.a) * DEGREES
      const lengthSq = dx * dx + dy * dy + dz * dz + da * da
      const t = lengthSq ? clamp01((px * dx + py * dy + pz * dz + pa * da) / lengthSq) : 0
      const error = (px - t * dx) ** 2 + (py - t * dy) ** 2 + (pz - t * dz) ** 2 + (pa - t * da) ** 2
      if (error < bestError - 1e-9 || (Math.abs(error - bestError) <= 1e-9 && Math.abs(i - hint) < Math.abs((best?.segmentIndex ?? 0) - hint))) {
        bestError = error
        best = { segmentIndex: i, fraction: (step + t) / steps }
      }
    }
  }
  return bestError <= 1 ? best : null
}
