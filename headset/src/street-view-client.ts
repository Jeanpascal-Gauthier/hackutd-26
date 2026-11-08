/**
 * Google Map Tiles API Street View client: session, nearest panorama, metadata and
 * tile stitching. Dependency-free so the request logic can be tested in Node.
 *
 * Measured against the live API (Nov 2026): tiles are 512 px; at zoom z the stitched
 * image is imageWidth / 2^(5-z) by imageHeight / 2^(5-z). Edge tiles are padded with
 * black below the image and wrap around horizontally, so stitching must crop to that size.
 */
const BASE = 'https://tile.googleapis.com/v1';
const MAX_ZOOM = 5;
/** 3328 x 1664 for current panoramas: sharp enough at arm's length, ~22 MB on the GPU. */
export const STREET_VIEW_ZOOM = 3;
/** Quick first paint (832 x 416, two tiles) while the full panorama streams in. */
export const STREET_VIEW_PREVIEW_ZOOM = 1;

export interface PanoLink { panoId: string; heading: number; text: string }

export interface PanoMetadata {
  panoId: string;
  lat: number;
  lng: number;
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  /** Compass heading of the panorama image's horizontal centre, degrees clockwise from north. */
  heading: number;
  tilt: number;
  roll: number;
  date?: string;
  copyright: string;
  reportProblemLink?: string;
  links: PanoLink[];
  /** Street name from addressComponents, when Google supplies one. */
  street?: string;
}

export interface TileGrid { width: number; height: number; columns: number; rows: number }

export function tileGrid(meta: Pick<PanoMetadata, 'imageWidth' | 'imageHeight' | 'tileWidth' | 'tileHeight'>, zoom: number): TileGrid {
  const scale = 2 ** (zoom - MAX_ZOOM);
  const width = Math.max(1, Math.round(meta.imageWidth * scale));
  const height = Math.max(1, Math.round(meta.imageHeight * scale));
  return { width, height, columns: Math.ceil(width / meta.tileWidth), rows: Math.ceil(height / meta.tileHeight) };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface RawMetadata extends Omit<PanoMetadata, 'links' | 'street'> {
  links?: { panoId?: string; heading?: number; text?: string }[];
  addressComponents?: { longName?: string; shortName?: string; types?: string[] }[];
}

export function parseMetadata(raw: RawMetadata): PanoMetadata {
  const finite = (value: unknown, name: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Street View metadata is missing ${name}`);
    return value;
  };
  if (typeof raw.panoId !== 'string' || !raw.panoId) throw new Error('Street View metadata is missing panoId');
  const route = raw.addressComponents?.find(part => part.types?.includes('route'));
  return {
    panoId: raw.panoId,
    lat: finite(raw.lat, 'lat'),
    lng: finite(raw.lng, 'lng'),
    imageWidth: finite(raw.imageWidth, 'imageWidth'),
    imageHeight: finite(raw.imageHeight, 'imageHeight'),
    tileWidth: finite(raw.tileWidth, 'tileWidth'),
    tileHeight: finite(raw.tileHeight, 'tileHeight'),
    heading: finite(raw.heading, 'heading'),
    tilt: typeof raw.tilt === 'number' ? raw.tilt : 90,
    roll: typeof raw.roll === 'number' ? raw.roll : 0,
    date: raw.date,
    copyright: typeof raw.copyright === 'string' ? raw.copyright : 'Google',
    reportProblemLink: raw.reportProblemLink,
    links: (raw.links ?? [])
      .filter((link): link is PanoLink => typeof link.panoId === 'string' && !!link.panoId && typeof link.heading === 'number')
      .map(link => ({ panoId: link.panoId, heading: link.heading, text: typeof link.text === 'string' ? link.text : '' })),
    street: route?.shortName ?? route?.longName,
  };
}

export class StreetViewClient {
  private session: Promise<string> | null = null;
  private readonly fetcher: Fetch;

  constructor(private readonly key: string, fetcher?: Fetch) {
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
  }

  private token(signal?: AbortSignal): Promise<string> {
    if (!this.session) {
      const pending = (async () => {
        const res = await this.fetcher(`${BASE}/createSession?key=${encodeURIComponent(this.key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mapType: 'streetview', language: 'en-US', region: 'US' }),
          signal,
        });
        if (!res.ok) throw new Error(`Street View session failed (${res.status}). Check that the Map Tiles API is enabled for this key.`);
        const body = await res.json() as { session?: string };
        if (!body.session) throw new Error('Street View session response had no token');
        return body.session;
      })();
      // A failed or aborted session request must not poison later attempts.
      pending.catch(() => { if (this.session === pending) this.session = null; });
      this.session = pending;
    }
    return this.session;
  }

  private async query(signal?: AbortSignal): Promise<string> {
    return `session=${encodeURIComponent(await this.token(signal))}&key=${encodeURIComponent(this.key)}`;
  }

  /** Metadata request with one retry on an expired or revoked session. */
  private async getMetadata(params: string, signal?: AbortSignal): Promise<PanoMetadata | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetcher(`${BASE}/streetview/metadata?${await this.query(signal)}&${params}`, { signal });
      if (res.status === 404) return null;
      if ((res.status === 401 || res.status === 403) && attempt === 0) { this.session = null; continue; }
      if (!res.ok) throw new Error(`Street View metadata failed (${res.status})`);
      const body = await res.json() as RawMetadata;
      // Validate that the response has a valid panoId before accepting it
      if (!body.panoId) return null;
      return parseMetadata(body);
    }
    return null;
  }

  /** Nearest panorama within radiusMetres, or null when Google has no imagery there. */
  nearest(lat: number, lng: number, radiusMetres: number, signal?: AbortSignal): Promise<PanoMetadata | null> {
    return this.getMetadata(`lat=${lat}&lng=${lng}&radius=${Math.round(radiusMetres)}`, signal);
  }

  metadata(panoId: string, signal?: AbortSignal): Promise<PanoMetadata | null> {
    return this.getMetadata(`panoId=${encodeURIComponent(panoId)}`, signal);
  }

  async tile(panoId: string, zoom: number, x: number, y: number, signal?: AbortSignal): Promise<Blob> {
    const res = await this.fetcher(`${BASE}/streetview/tiles/${zoom}/${x}/${y}?${await this.query(signal)}&panoId=${encodeURIComponent(panoId)}`, { signal });
    if (!res.ok) throw new Error(`Street View tile ${zoom}/${x}/${y} failed (${res.status})`);
    return res.blob();
  }

  /**
   * Draw every tile at `zoom` into `canvas`, resizing it to the stitched image size.
   * Tiles draw as they arrive; `onTile` lets the caller refresh its texture.
   */
  async stitch(meta: PanoMetadata, zoom: number, canvas: HTMLCanvasElement, onTile: () => void, signal?: AbortSignal): Promise<void> {
    const grid = tileGrid(meta, zoom);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    canvas.width = grid.width; canvas.height = grid.height;
    const jobs: Promise<void>[] = [];
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.columns; x++) {
        jobs.push((async () => {
          const bitmap = await createImageBitmap(await this.tile(meta.panoId, zoom, x, y, signal));
          if (signal?.aborted) { bitmap.close(); return; }
          // Overflow beyond the canvas is horizontal wrap-around or black padding.
          ctx.drawImage(bitmap, x * meta.tileWidth, y * meta.tileHeight);
          bitmap.close();
          onTile();
        })());
      }
    }
    await Promise.all(jobs);
  }
}
