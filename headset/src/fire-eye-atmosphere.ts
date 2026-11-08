import { Color, DomeGradient, Fog, type Entity, type World } from '@iwsdk/core';

// Keep the distant city and lower sky the same color so tile edges dissolve
// into the environment instead of ending against a contrasting background.
const CITY_HAZE_COLOR = '#e4e8eb';
const CITY_SKY_COLOR = '#9ebbd2';
// The incident is roughly 280–355 m from the viewer in the existing views.
// Start beyond it and reach solid haze well before the camera's 3000 m far plane.
export const CITY_FOG_NEAR = 450;
export const CITY_FOG_FAR = 1400;

/** City-only atmosphere; the room and the alternate command-desk view keep their setup. */
export class FireEyeAtmosphere {
  private readonly root: Entity;
  private readonly previousBackground: World['scene']['background'];
  private readonly previousFog: World['scene']['fog'];
  private readonly briefingBackground = new Color(CITY_HAZE_COLOR);
  private readonly fog = new Fog(CITY_HAZE_COLOR, CITY_FOG_NEAR, CITY_FOG_FAR);
  private active = false;

  constructor(private readonly world: World) {
    this.root = world.activeLevel.peek();
    this.previousBackground = world.scene.background;
    this.previousFog = world.scene.fog;
    world.scene.background = this.briefingBackground;
  }

  setCityVisible(visible: boolean): void {
    if (visible === this.active) return;
    this.active = visible;
    if (visible) {
      // DomeGradient takes display RGB, unlike Three's linear Color storage.
      const sky = new Color(CITY_SKY_COLOR).convertLinearToSRGB();
      const haze = new Color(CITY_HAZE_COLOR).convertLinearToSRGB();
      this.root.addComponent(DomeGradient, {
        sky: [sky.r, sky.g, sky.b, 1],
        equator: [haze.r, haze.g, haze.b, 1],
        // A flat lower hemisphere also hides the boundary when looking down.
        ground: [haze.r, haze.g, haze.b, 1],
        intensity: 1,
        elevationDeg: 90,
        azimuthDeg: 0,
        dither: true,
      });
    } else {
      this.root.removeComponent(DomeGradient);
    }
    this.world.scene.background = visible ? null : this.briefingBackground;
    this.world.scene.fog = visible ? this.fog : this.previousFog;
  }

  dispose(): void {
    this.setCityVisible(false);
    this.world.scene.background = this.previousBackground;
    this.world.scene.fog = this.previousFog;
  }
}
