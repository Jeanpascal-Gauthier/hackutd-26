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
  /** off -> aiming (toggle on) -> loading -> street (panorama) or ground (3D city, no imagery). */
  street: StreetMode;
  /** Current panorama id while street === 'street'. */
  panoId: string | null;
}

export type StreetMode = 'off' | 'aiming' | 'loading' | 'street' | 'ground';
