import { createComponent, Types } from '@iwsdk/core';

export const FireEyeStatus = createComponent('FireEyeStatus', {
  phase: { type: Types.String, default: 'briefing' },
  perspective: { type: Types.String, default: 'overview' },
  mapReady: { type: Types.Boolean, default: false },
});

/** Observable FireEye lifecycle, shared by the spatial briefing and city renderer. */
export type FireEyePhase = 'briefing' | 'countdown' | 'transition' | 'city' | 'error';

export interface FireEyeState {
  phase: FireEyePhase;
  status: string;
  latitude: number | null;
  longitude: number | null;
  tilesLoaded: number;
  perspective: 'overview' | 'north' | 'east' | 'south' | 'west';
}
