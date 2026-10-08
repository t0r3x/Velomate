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
  // Each segment runs from the previous zone's max to its own. Using max - min instead
  // dropped the 1 bpm between zones, and rounding each width to whole percent compounded
  // it — together the bar stopped a few percent short of the right edge.
  const scale = zoneBarScale(zones, maxHr)
  return ZONE_KEYS.map((key, i) => {
    const z = zones[key]
    const from = i === 0 ? 0 : zones[ZONE_KEYS[i - 1]].max
    return { key, min: z.min, max: z.max, width: (z.max - from) / scale * 100 }
  })
}

/** The bpm at the bar's right edge: the top of Z5, so the segments always fill it exactly. */
export function zoneBarScale(zones: HrZones, maxHr: number): number {
  return zones.z5.max > 0 ? zones.z5.max : maxHr
}
