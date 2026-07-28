import type { HrZones } from '@/types'

export interface ZoneSegment {
  key: 'z1' | 'z2' | 'z3' | 'z4' | 'z5'
  min: number
  max: number
  width: number // percentage
}

/** Calculate HR zones from LTHR and max HR — mirrors backend calculateDefaultZones. */
export function calcZones(lthr: number, maxHr: number): HrZones {
  return {
    z1: { min: 0,                            max: Math.round(lthr * 0.65) },
    z2: { min: Math.round(lthr * 0.65) + 1, max: Math.round(lthr * 0.80) },
    z3: { min: Math.round(lthr * 0.80) + 1, max: Math.round(lthr * 0.89) },
    z4: { min: Math.round(lthr * 0.89) + 1, max: lthr },
    z5: { min: lthr + 1,                     max: maxHr }
  }
}

const ZONE_KEYS: ZoneSegment['key'][] = ['z1', 'z2', 'z3', 'z4', 'z5']

/**
 * Turn a (possibly manually-edited) HrZones object into bar segments.
 * Driven purely by the zones' own min/max — doesn't assume any LTHR relationship,
 * since a dragged boundary is no longer necessarily on the formula's curve.
 */
export function zonesToSegments(zones: HrZones, maxHr: number): ZoneSegment[] {
  return ZONE_KEYS.map(key => {
    const z = zones[key]
    const span = key === 'z1' ? z.max : (z.max - z.min)
    return { key, min: z.min, max: z.max, width: Math.max(1, Math.round(span / maxHr * 100)) }
  })
}
