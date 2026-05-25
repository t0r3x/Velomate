import { computed, type Ref } from 'vue'
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

/**
 * Reactive HR zones composable.
 * Accepts refs for maxHr and lthr; returns computed zones and bar segments.
 */
export function useZones(maxHrRef: Ref<number>, lthrRef: Ref<number>) {
  const zones = computed<HrZones>(() =>
    calcZones(lthrRef.value, maxHrRef.value)
  )

  const segments = computed<ZoneSegment[]>(() => {
    const z = zones.value
    const maxHr = maxHrRef.value
    return [
      { key: 'z1', min: z.z1.min, max: z.z1.max, width: Math.max(1, Math.round(z.z1.max / maxHr * 100)) },
      { key: 'z2', min: z.z2.min, max: z.z2.max, width: Math.max(1, Math.round((z.z2.max - z.z2.min) / maxHr * 100)) },
      { key: 'z3', min: z.z3.min, max: z.z3.max, width: Math.max(1, Math.round((z.z3.max - z.z3.min) / maxHr * 100)) },
      { key: 'z4', min: z.z4.min, max: z.z4.max, width: Math.max(1, Math.round((z.z4.max - z.z4.min) / maxHr * 100)) },
      { key: 'z5', min: z.z5.min, max: z.z5.max, width: Math.max(1, Math.round((maxHr - lthrRef.value) / maxHr * 100)) }
    ]
  })

  return { zones, segments }
}
