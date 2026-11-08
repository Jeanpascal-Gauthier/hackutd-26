// The google.maps namespace comes from @types/google.maps (see console/tsconfig.json).
// These are the extra window globals the script loader in this folder relies on.

interface Window {
  google?: typeof google;
  /** Google calls this when the key is rejected, possibly long after the script has loaded. */
  gm_authFailure?: () => void;
  /** The `callback` named in the script URL. */
  __firewatchMapsReady?: () => void;
}
