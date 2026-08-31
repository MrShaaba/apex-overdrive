/**
 * Tyre force curves. A simplified Pacejka "magic formula" shape parameterised by
 * the slip value at which force peaks and how much force survives past the peak
 * (`falloff`). Returns a normalised force in [0, 1] which callers multiply by
 * `mu * Fz`.
 */

export interface TireCurve {
  peakSlip: number
  falloff: number
}

/**
 * Normalised magic-formula style response.
 *  - rises roughly linearly up to `peakSlip` (peak = 1.0)
 *  - decays smoothly to `falloff` past the peak
 */
export function tireCurve(slip: number, peakSlip: number, falloff: number): number {
  const s = Math.abs(slip) / peakSlip
  if (s <= 1) {
    // Smooth rise with slight rounding near the peak (C ≈ 1.6 pacejka shape).
    const x = s * 1.5708 // to π/2
    return Math.sin(x) * (1 - 0.08 * (1 - s)) + 0.08 * s
  }
  // Past the peak: decay toward falloff with a soft knee.
  const over = Math.min(s - 1, 6)
  const decay = 1 - Math.exp(-over * 0.9)
  return 1 - (1 - falloff) * decay
}

/**
 * Combined-slip friction ellipse. Given desired longitudinal and lateral forces,
 * clamp their vector magnitude to the available friction budget. Lateral force
 * is slightly prioritised (real tyres keep some cornering ability under braking)
 * unless the wheel is fully locked/spinning.
 */
export function frictionEllipse(
  longForce: number,
  latForce: number,
  maxForce: number,
  longSlipFraction: number,
): { long: number; lat: number; saturation: number } {
  const total = Math.hypot(longForce, latForce)
  if (total <= maxForce || total === 0) return { long: longForce, lat: latForce, saturation: total / Math.max(maxForce, 1e-3) }
  const scale = maxForce / total
  // Locked or spinning wheels lose lateral authority first.
  const lockPenalty = Math.max(0, Math.min(1, (Math.abs(longSlipFraction) - 1) * 0.8))
  const lat = latForce * scale * (1 - lockPenalty * 0.65)
  const long = longForce * scale
  return { long, lat, saturation: total / maxForce }
}
