import { test } from "node:test";
import assert from "node:assert/strict";
import { findOutdoorPanorama } from "./streetView";

type Service = Pick<google.maps.StreetViewService, "getPanorama">;
type Callback = NonNullable<Parameters<Service["getPanorama"]>[1]>;
const position = { lat: 0, lng: 0.001 };
const panorama = (pano = "outdoor-street-pano", lat = 0, lng = 0) => ({
  location: { pano, latLng: { lat: () => lat, lng: () => lng } },
} as google.maps.StreetViewPanoramaData);

function fakeService(handler: (request: google.maps.StreetViewLocationRequest, callback: Callback) => void): Service {
  return { getPanorama(request, callback) {
    assert.ok(callback);
    handler(request as google.maps.StreetViewLocationRequest, callback);
    return Promise.resolve({ data: panorama() });
  } };
}

test("street selection requires both Google and outdoor sources and faces the building", async () => {
  const service = fakeService((request, callback) => {
    assert.deepEqual(request.location, position);
    assert.deepEqual(request.sources, ["google", "outdoor"]);
    assert.equal(request.preference, "nearest");
    assert.equal(request.radius, 150);
    callback(panorama(), "OK");
  });
  assert.deepEqual(await findOutdoorPanorama(service, position), { pano: "outdoor-street-pano", heading: 90 });
});

test("an expanded search retains outdoor and Google restrictions", async () => {
  const radii: number[] = [];
  const service = fakeService((request, callback) => {
    radii.push(request.radius!);
    assert.deepEqual(request.sources, ["google", "outdoor"]);
    callback(radii.length === 1 ? null : panorama(), radii.length === 1 ? "ZERO_RESULTS" : "OK");
  });
  assert.ok(await findOutdoorPanorama(service, position));
  assert.deepEqual(radii, [150, 500]);
});

test("no outdoor coverage returns unavailable without trying indoor or default sources", async () => {
  let calls = 0;
  const service = fakeService((request, callback) => {
    calls++;
    assert.deepEqual(request.sources, ["google", "outdoor"]);
    callback(null, "ZERO_RESULTS");
  });
  assert.equal(await findOutdoorPanorama(service, position), null);
  assert.equal(calls, 2);
});

test("provider errors and malformed metadata fail without relaxing the source filter", async () => {
  for (const data of [null, panorama(""), panorama("pano", NaN)]) {
    let calls = 0;
    const service = fakeService((_, callback) => { calls++; callback(data, data ? "OK" : "UNKNOWN_ERROR"); });
    await assert.rejects(findOutdoorPanorama(service, position));
    assert.equal(calls, 1);
  }
  const service = fakeService(() => { throw new Error("upstream?key=secret-do-not-return"); });
  await assert.rejects(findOutdoorPanorama(service, position), error => {
    assert.equal(String(error).includes("secret-do-not-return"), false);
    return true;
  });
});

test("a stalled panorama service reaches a controlled timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(findOutdoorPanorama(fakeService(() => {}), position), /timed out/);
  t.mock.timers.tick(15000);
  await rejected;
});
