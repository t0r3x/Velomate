import { 
  WorkoutBuilder, 
  Step, 
  StepType, 
  TimeDuration, 
  HrmTarget, 
  WorkoutType 
} from '@flow-js/garmin-connect';
import { getGarminClient, trySessionAuth } from './garmin.service';
import { loadProfile } from './profile.service';

export const syncAndScheduleWorkouts = async (scheduleDate?: string) => {
  const isAuthenticated = await trySessionAuth();
  if (!isAuthenticated) {
    throw new Error('Not authenticated.');
  }

  const client = getGarminClient();
  const profile = loadProfile();
  
  // Calculate duration of long ride based on recent activities
  let longRideDurationMinutes = 120; // Default 2 hours
  try {
    const activities = await client.getActivities(0, 20);
    const cyclingActivities = activities.filter(act => 
      act.activityType?.typeKey === 'cycling' || 
      act.activityType?.typeKey === 'road_cycling' ||
      act.activityType?.typeKey === 'indoor_cycling'
    );
    if (cyclingActivities.length > 0) {
      const sumSeconds = cyclingActivities.reduce((sum, act) => sum + (act.duration || 0), 0);
      const avgMinutes = (sumSeconds / cyclingActivities.length) / 60;
      // Scale by 1.2x, cap between 90 minutes and 240 minutes (4 hours)
      longRideDurationMinutes = Math.min(240, Math.max(90, Math.round(avgMinutes * 1.2)));
    }
  } catch (err) {
    console.warn('Failed to calculate dynamic long ride duration, using 2h default:', err);
  }

  const results = [];
  const dateStr = scheduleDate || new Date().toISOString().split('T')[0];

  // 1. GENERATE SPRINT WORKOUT
  const sprintBuilder = new WorkoutBuilder(
    WorkoutType.Cycling, 
    `INNERJOIN Sprint - ${profile.lthr} LTHR`,
    'Sprint intervals targeted to heart rate zones'
  );
  
  sprintBuilder.addStep(new Step(StepType.WarmUp, TimeDuration.fromMinutes(10), new HrmTarget(profile.zones.z2.min, profile.zones.z2.max), 'Warm up in Z2'));

  for (let i = 0; i < 6; i++) {
    sprintBuilder.addStep(new Step(StepType.Run, TimeDuration.fromSeconds(30), new HrmTarget(profile.zones.z5.min, profile.zones.z5.max), `Sprint interval ${i + 1}/6 - Max effort`));
    sprintBuilder.addStep(new Step(StepType.Recovery, TimeDuration.fromMinutes(4), new HrmTarget(profile.zones.z1.min, profile.zones.z1.max), `Recovery ${i + 1}/6 - Z1`));
  }

  sprintBuilder.addStep(new Step(StepType.Cooldown, TimeDuration.fromMinutes(10), new HrmTarget(profile.zones.z1.min, profile.zones.z1.max), 'Cool down in Z1'));

  console.log('Uploading Sprint Workout...');
  const sprintWorkout = await client.createWorkout(sprintBuilder.build());
  results.push({ type: 'Sprint', workoutId: sprintWorkout.workoutId, name: sprintWorkout.workoutName });

  // 2. GENERATE THRESHOLD WORKOUT
  const thresholdBuilder = new WorkoutBuilder(
    WorkoutType.Cycling,
    `INNERJOIN Drempel - ${profile.lthr} LTHR`,
    'Threshold intervals (Z4) to increase aerobic power'
  );

  thresholdBuilder.addStep(new Step(StepType.WarmUp, TimeDuration.fromMinutes(10), new HrmTarget(profile.zones.z2.min, profile.zones.z2.max), 'Warm up in Z2'));

  for (let i = 0; i < 3; i++) {
    thresholdBuilder.addStep(new Step(StepType.Run, TimeDuration.fromMinutes(8), new HrmTarget(profile.zones.z4.min, profile.zones.z4.max), `Threshold Interval ${i + 1}/3 - Z4`));
    thresholdBuilder.addStep(new Step(StepType.Recovery, TimeDuration.fromMinutes(4), new HrmTarget(profile.zones.z1.min, profile.zones.z2.max), `Recovery ${i + 1}/3 - Z1/Z2`));
  }

  thresholdBuilder.addStep(new Step(StepType.Cooldown, TimeDuration.fromMinutes(10), new HrmTarget(profile.zones.z1.min, profile.zones.z1.max), 'Cool down in Z1'));

  console.log('Uploading Threshold Workout...');
  const thresholdWorkout = await client.createWorkout(thresholdBuilder.build());
  results.push({ type: 'Threshold', workoutId: thresholdWorkout.workoutId, name: thresholdWorkout.workoutName });

  // 3. GENERATE LONG RIDE WORKOUT
  const longRideBuilder = new WorkoutBuilder(
    WorkoutType.Cycling,
    `INNERJOIN Lange Rit - ${longRideDurationMinutes}m`,
    `Steady endurance ride scaled to recent training volume`
  );

  longRideBuilder.addStep(new Step(StepType.Run, TimeDuration.fromMinutes(longRideDurationMinutes), new HrmTarget(profile.zones.z2.min, profile.zones.z2.max), 'Steady aerobic endurance ride in Z2'));

  console.log('Uploading Long Ride Workout...');
  const longRideWorkout = await client.createWorkout(longRideBuilder.build());
  results.push({ type: 'LongRide', workoutId: longRideWorkout.workoutId, name: longRideWorkout.workoutName });

  // Schedule the main Workout (Threshold Workout)
  console.log(`Scheduling main workout ${thresholdWorkout.workoutName} for date ${dateStr}`);
  await client.scheduleWorkout({ workoutId: String(thresholdWorkout.workoutId) }, dateStr);

  return {
    scheduledWorkoutId: thresholdWorkout.workoutId,
    scheduledDate: dateStr,
    workouts: results,
    profileUsed: profile,
    dynamicLongRideMinutes: longRideDurationMinutes
  };
};
