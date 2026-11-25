import { COOKWARE, DISHES, TASKS } from './recipes';
import type { PlanInput, PlanSettings } from './scheduler';
import { DEFAULT_KITCHEN_START, DEFAULT_TARGET, DEFAULT_TURKEY_ETA } from './time';

export function defaultSettings(): PlanSettings {
  return { burners: 4, cookware: Object.fromEntries(COOKWARE.map((c) => [c.id, true])), helperCarvesTurkey: false, hotRoom: false };
}

/** A fresh baseline planning input at the kitchen start time. */
export function baselineInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    tasks: TASKS,
    dishes: DISHES,
    progress: {},
    nowMs: DEFAULT_KITCHEN_START,
    kitchenStartMs: DEFAULT_KITCHEN_START,
    targetMs: DEFAULT_TARGET,
    turkeyEtaMs: DEFAULT_TURKEY_ETA,
    paused: false,
    settings: defaultSettings(),
    ...over,
  };
}
