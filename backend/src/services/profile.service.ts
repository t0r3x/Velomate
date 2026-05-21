import fs from 'fs';
import path from 'path';
import { HeartRateZone, UserHRProfile } from '../types';

const configFile = path.join(__dirname, '../../config.json');

// Default HR Zone Calculation based on LTHR
export const calculateDefaultZones = (lthr: number, maxHr: number): UserHRProfile['zones'] => {
  return {
    z1: { min: 0, max: Math.round(lthr * 0.65) },
    z2: { min: Math.round(lthr * 0.65) + 1, max: Math.round(lthr * 0.80) },
    z3: { min: Math.round(lthr * 0.80) + 1, max: Math.round(lthr * 0.89) },
    z4: { min: Math.round(lthr * 0.89) + 1, max: lthr },
    z5: { min: lthr + 1, max: maxHr }
  };
};

export const loadProfile = (): UserHRProfile => {
  const defaultProfile: UserHRProfile = {
    maxHr: 190,
    lthr: 165,
    zones: calculateDefaultZones(165, 190),
    hasCustomOverrides: false,
    lastUpdated: new Date().toISOString()
  };

  try {
    if (fs.existsSync(configFile)) {
      const data = fs.readFileSync(configFile, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading profile config, using defaults:', error);
  }
  return defaultProfile;
};

export const saveProfile = (profile: UserHRProfile): void => {
  try {
    fs.writeFileSync(configFile, JSON.stringify(profile, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving profile config:', error);
  }
};
