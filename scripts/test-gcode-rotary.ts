import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseGCode, parseGCodeAsync } from '../src/lib/gcode'
import { buildJobTimingEstimate } from '../src/lib/jobRuntime'
import { buildRotaryRenderLines, DEFAULT_ROTARY_SETUP, findRotaryProgress, rotaryBounds, rotaryMotionPoint, rotaryPartPoint, rotaryProgressAt, rotaryPlaybackDistances } from '../src/lib/gcodeRotary'

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`)
const lastA = (code: string) => { const s = parseGCode(code).segments; return s.get(s.length - 1).a1 }

// A-only blocks, case-insensitivity, signed/multiple turns and G90/G91.
assert.equal(lastA('G90 G1 A720 F100\ng91 a-90\nG90 A-360'), -360)
assert.equal(parseGCode('G1 A360 F100\nA720').segments.length, 2)
assert.equal(lastA('G20 G1 X1 A360'), 360)
near(parseGCode('G20 G1 X1 A360').segments.get(0).x1, 25.4)
assert.equal(parseGCode('G1 X1 Y2 Z3').segments.pa, null)

// Zero changes never move the table; subsequent absolute angles use the new zero.
assert.equal(lastA('G1 A160000\nG10 L20 P0 A0\nA20000'), 180000)
assert.equal(lastA('G1 A90\nG92 A0\nA10'), 100)
assert.equal(lastA('G1 A90\nG92 A0\nG92.1\nA10'), 10)
assert.equal(lastA('G1 A90\nG10 L2 P2 A100\nG55 A20'), 120)
{
  const m = parseGCode('G1 A90\nG53 G0 A110\nG1 A20', { currentWco: { x: 0, y: 0, z: 0, a: 100 } })
  assert.equal(m.segments.get(1).a1, 10)
  assert.equal(m.segments.get(2).a1, 20)
  assert.equal(m.referenceWco?.a, 100)
}

// The user's actual small program, including modal lowercase moves and G10 resets.
const fixture = readFileSync('docs/examples/colonnona40.nc', 'utf8')
const model = parseGCode(fixture)
assert.equal(model.segments.length, 6)
const first = model.segments.get(3), second = model.segments.get(4)
assert.deepEqual([first.y0, first.y1, first.z0, first.z1, first.a0, first.a1], [-4, 415, 33, 25, 0, 160000])
assert.deepEqual([second.a0, second.a1, second.aOffset], [160000, 180000, 160000])
assert.equal(model.segments.get(5).a1, 180000)
assert.equal(buildJobTimingEstimate(model, {}), null)
const asyncModel = await parseGCodeAsync(fixture, {}, () => {}, () => true)
assert.deepEqual(asyncModel.segments.pa, model.segments.pa)

// Both machine mountings, inverse table rotation and selectable direction.
const y90 = rotaryPartPoint({ x: 0, y: 30, z: 10, a: 90 }, DEFAULT_ROTARY_SETUP)
near(y90.x, -10); near(y90.y, 30); near(y90.z, 0)
const x90 = rotaryPartPoint({ x: 30, y: 0, z: 10, a: 90 }, { ...DEFAULT_ROTARY_SETUP, axis: 'X' })
near(x90.x, 30); near(x90.y, 10); near(x90.z, 0)
near(rotaryPartPoint({ x: 0, y: 0, z: 10, a: 90 }, { ...DEFAULT_ROTARY_SETUP, reverse: true }).x, 10)
const offset = rotaryPartPoint({ x: 5, y: 30, z: 17, a: 90 }, { ...DEFAULT_ROTARY_SETUP, center: 5, centerZ: 7 })
near(offset.x, -5); near(offset.z, 7)

// Sampling preserves all complete turns even when endpoints coincide.
const circle = parseGCode('G0 Z10\nG1 A720 F100').segments
const lines = await buildRotaryRenderLines(circle, DEFAULT_ROTARY_SETUP)
assert.equal(lines.count, 145)
const bounds = rotaryBounds(lines)
near(bounds.minX, -10); near(bounds.maxX, 10); near(bounds.minZ, -10); near(bounds.maxZ, 10)
const distances = rotaryPlaybackDistances(circle, DEFAULT_ROTARY_SETUP)
assert.deepEqual(rotaryProgressAt(distances, 1), { segmentIndex: 1, fraction: 1 })
const match = findRotaryProgress(circle, { x: 0, y: 0, z: 10, a: 540 })
assert.equal(match?.segmentIndex, 1); near(match!.fraction, 0.75)
assert.equal(rotaryMotionPoint(circle.get(1), match!.fraction).a, 540)
assert.equal(findRotaryProgress(circle, { x: 100, y: 0, z: 10, a: 540 }), null)

// Arc + A interpolation uses the original arc in all three planes.
for (const plane of [17, 18, 19]) {
  const arc = parseGCode(`G${plane} G1 X10 Y10 Z10\nG3 ${plane === 17 ? 'I-10 J0' : plane === 18 ? 'K-10 I0' : 'J-10 K0'} A720`).segments.get(1)
  near(rotaryMotionPoint(arc, 0.5).a, 360)
  assert.ok(Number.isFinite(rotaryPartPoint(rotaryMotionPoint(arc, 0.5), DEFAULT_ROTARY_SETUP).z))
}
await assert.rejects(buildRotaryRenderLines(parseGCode('G1 A10000000').segments, DEFAULT_ROTARY_SETUP), /troppo grande/)
await assert.rejects(buildRotaryRenderLines(model.segments, DEFAULT_ROTARY_SETUP, () => false), /stale-load/)
const full = await buildRotaryRenderLines(model.segments, DEFAULT_ROTARY_SETUP)
assert.equal(full.count, 36004)
console.log('rotary A: parser, fixture, X/Y geometry, full turns, offsets, arcs, live matching and limits passed')
