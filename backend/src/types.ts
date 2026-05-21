export interface HeartRateZone {
  min: number;
  max: number;
}

export interface UserHRProfile {
  maxHr: number;
  lthr: number; // Lactate Threshold Heart Rate
  zones: {
    z1: HeartRateZone; // Recovery
    z2: HeartRateZone; // Endurance / Aerobic
    z3: HeartRateZone; // Tempo
    z4: HeartRateZone; // Threshold
    z5: HeartRateZone; // Anaerobic / Sprint
  };
  hasCustomOverrides: boolean;
  lastUpdated: string;
}
