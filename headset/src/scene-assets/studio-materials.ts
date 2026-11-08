import {
  DataTexture, LinearFilter, MeshStandardMaterial, RepeatWrapping,
  RGBAFormat, SRGBColorSpace,
} from '@iwsdk/core';

// Small deterministic textures work in both the editor and runtime realms.
function surfaceTexture(grain: boolean) {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const noise = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      const fine = noise - Math.floor(noise);
      const value = grain
        ? 243 + 3 * Math.sin(x * 0.14 + 0.5 * Math.sin(y * Math.PI / 64)) + fine * 3
        : 239 + fine * 10;
      const index = (y * size + x) * 4;
      pixels[index] = pixels[index + 1] = pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  const texture = new DataTexture(pixels, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.repeat.set(grain ? 2 : 4, grain ? 0.6 : 4);
  texture.needsUpdate = true;
  return texture;
}

export const studioMaterials = {
  oak: new MeshStandardMaterial({ color: '#c9b18b', map: surfaceTexture(true), roughness: 0.76 }),
  plaster: new MeshStandardMaterial({ color: '#e8e3d9', map: surfaceTexture(false), roughness: 0.95 }),
  floor: new MeshStandardMaterial({ color: '#929087', map: surfaceTexture(false), roughness: 0.98 }),
  cabinet: new MeshStandardMaterial({ color: '#d5d0c5', roughness: 0.86 }),
  graphite: new MeshStandardMaterial({ color: '#474b4a', roughness: 0.86 }),
  fabric: new MeshStandardMaterial({ color: '#b9b5aa', map: surfaceTexture(false), roughness: 1 }),
  light: new MeshStandardMaterial({ color: '#fff6e6', emissive: '#fff3de', emissiveIntensity: 0.6 }),
};
