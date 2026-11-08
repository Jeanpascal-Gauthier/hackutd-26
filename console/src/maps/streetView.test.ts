import { test } from "node:test";
import assert from "node:assert/strict";
import { findPanorama } from "./streetView";

type Service = Pick<google.maps.StreetViewService, "getPanorama">;
type Callback = NonNullable<Parameters<Service["getPanorama"]>[1]>;
const position = { lat: 0, lng: 0.001 };
const panorama = (pano = "outdoor-street-pano", lat = 0, lng = 0, street = true) => ({
  location: { pano, description: street ? "1311 Main St, Dallas, Texas" : "", latLng: { lat: () => lat, lng: () => lng } },
  links: [{ pano: "next-pano", description: street ? "Main St" : "" }],
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
  assert.deepEqual(await findPanorama(service, position), { pano: "outdoor-street-pano", heading: 90, kind: "outdoor" });
});

test("an expanded search retains outdoor and Google restrictions", async () => {
  const radii: number[] = [];
  const service = fakeService((request, callback) => {
    radii.push(request.radius!);
    assert.deepEqual(request.sources, ["google", "outdoor"]);
    callback(radii.length === 1 ? null : panorama(), radii.length === 1 ? "ZERO_RESULTS" : "OK");
  });
  assert.equal((await findPanorama(service, position))?.kind, "outdoor");
  assert.deepEqual(radii, [150, 500]);
});

test("outdoor contributor imagery keeps Street View rather than falling back to Interior View", async () => {
  let calls = 0;
  const service = fakeService((request, callback) => {
    calls++;
    assert.deepEqual(request.sources, calls < 3 ? ["google", "outdoor"] : ["outdoor"]);
    callback(calls < 3 ? null : panorama("contributor-street"), calls < 3 ? "ZERO_RESULTS" : "OK");
  });
  assert.deepEqual(await findPanorama(service, position), { pano: "contributor-street", heading: 90, kind: "outdoor" });
  assert.equal(calls, 3);
});

test("only missing outdoor coverage allows a close-by Interior View fallback", async () => {
  const requests: google.maps.StreetViewLocationRequest[] = [];
  const service = fakeService((request, callback) => {
    requests.push(request);
    callback(requests.length < 4 ? null : panorama("interior-tour", position.lat, position.lng, false), requests.length < 4 ? "ZERO_RESULTS" : "OK");
  });
  assert.deepEqual(await findPanorama(service, position), { pano: "interior-tour", heading: 0, kind: "interior" });
  assert.deepEqual(requests.map(request => ({ radius: request.radius, sources: request.sources })), [
    { radius: 150, sources: ["google", "outdoor"] },
    { radius: 500, sources: ["google", "outdoor"] },
    { radius: 500, sources: ["outdoor"] },
    { radius: 50, sources: ["default"] },
  ]);
});

test("no outdoor or interior coverage returns unavailable", async () => {
  let calls = 0;
  const service = fakeService((_, callback) => {
    calls++;
    callback(null, "ZERO_RESULTS");
  });
  assert.equal(await findPanorama(service, position), null);
  assert.equal(calls, 4);
});

test("White House and Burj tours returned by outdoor requests are labelled Interior View", async () => {
  for (const location of [{ lat: 38.897685, lng: -77.036529 }, { lat: 25.197206, lng: 55.274369 }]) {
    let calls = 0;
    const service = fakeService((request, callback) => {
      calls++;
      // Reproduce Google's blank descriptions and unnamed tour links, even with outdoor sources.
      if (calls <= 3) callback(panorama("landmark-tour", location.lat, location.lng, false), "OK");
      else {
        assert.deepEqual(request.sources, ["google", "outdoor"]);
        callback(null, "ZERO_RESULTS");
      }
    });
    assert.deepEqual(await findPanorama(service, location), { pano: "landmark-tour", heading: 0, kind: "interior" });
    assert.equal(calls, 11);
  }
});

test("nearby roads are preferred when centre queries keep returning an interior tour", async () => {
  const location = { lat: 38.897676, lng: -77.03653 };
  let calls = 0;
  const service = fakeService((request, callback) => {
    calls++;
    assert.deepEqual(request.sources, calls === 3 ? ["outdoor"] : ["google", "outdoor"]);
    if (calls <= 3) callback(panorama("indoor-tour", location.lat, location.lng, false), "OK");
    else if (calls === 4) callback(panorama("farther-road", location.lat + 0.0025, location.lng), "OK");
    else if (calls === 5) callback(panorama("closer-road", location.lat, location.lng + 0.0025), "OK");
    else callback(null, "ZERO_RESULTS");
  });
  const result = await findPanorama(service, location);
  assert.equal(result?.pano, "closer-road");
  assert.equal(result?.kind, "outdoor");
  assert.ok(result && Math.abs(result.heading - 270) < 1);
  assert.equal(calls, 7);
});

test("a city or landmark title without matching street links does not establish street context", async () => {
  for (const description of ["Dubai", "The White House", "Burj Khalifa", ""]) {
    let calls = 0;
    const service = fakeService((_, callback) => {
      calls++;
      const data = panorama("unclassified-tour", position.lat, position.lng, false);
      data.location!.description = description;
      callback(calls <= 3 ? data : null, calls <= 3 ? "OK" : "ZERO_RESULTS");
    });
    assert.equal((await findPanorama(service, position))?.kind, "interior");
  }
});

test("a distant interior is not used as the address's interior fallback", async () => {
  const service = fakeService((_, callback) => callback(panorama("other-building", 0, 0, false), "OK"));
  assert.equal(await findPanorama(service, position), null);
});

test("failed nearby-road searches do not silently promote a tour to Street View", async () => {
  let calls = 0;
  const service = fakeService((_, callback) => {
    calls++;
    callback(calls <= 3 ? panorama("indoor-tour", position.lat, position.lng, false) : null, calls <= 3 ? "OK" : "UNKNOWN_ERROR");
  });
  await assert.rejects(findPanorama(service, position), /lookup failed/);
});

test("provider errors and malformed metadata fail without relaxing the source filter", async () => {
  for (const data of [null, panorama(""), panorama("pano", NaN)]) {
    let calls = 0;
    const service = fakeService((_, callback) => { calls++; callback(data, data ? "OK" : "UNKNOWN_ERROR"); });
    await assert.rejects(findPanorama(service, position));
    assert.equal(calls, 1);
  }
  const service = fakeService(() => { throw new Error("upstream?key=secret-do-not-return"); });
  await assert.rejects(findPanorama(service, position), error => {
    assert.equal(String(error).includes("secret-do-not-return"), false);
    return true;
  });
});

test("a stalled panorama service reaches a controlled timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(findPanorama(fakeService(() => {}), position), /timed out/);
  t.mock.timers.tick(15000);
  await rejected;
});
