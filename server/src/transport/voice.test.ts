import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { VOICE_FALLBACK, hasVoiceToken, speakable } from "./voice.ts";

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

test("token: header or bearer must match exactly", () => {
  assert.equal(hasVoiceToken(req({}), "s3cret"), false);
  assert.equal(hasVoiceToken(req({ "x-firesight-token": "wrong" }), "s3cret"), false);
  assert.equal(hasVoiceToken(req({ "x-firesight-token": "s3cre" }), "s3cret"), false, "length mismatch");
  assert.equal(hasVoiceToken(req({ "x-firesight-token": "s3cret" }), "s3cret"), true);
  assert.equal(hasVoiceToken(req({ authorization: "Bearer s3cret" }), "s3cret"), true);
});

test("speakable: ranges read as words, parentheticals dropped, at most 3 sentences", () => {
  assert.equal(
    speakable("Evacuate floors 6–12 (202 people) by Stairwell A (Stairwell B fills with smoke from minute 11)"),
    "Evacuate floors 6 to 12 by Stairwell A.",
  );
  assert.equal(
    speakable("Fire crews are on the way. Leave now by Stairwell A; do not use Stairwell B or the elevator. Stay low if there is smoke. Extra."),
    "Fire crews are on the way. Leave now by Stairwell A; do not use Stairwell B or the elevator. Stay low if there is smoke.",
  );
  assert.equal(speakable("Which floor are you on?"), "Which floor are you on?");
  assert.equal(speakable(undefined), VOICE_FALLBACK);
  assert.equal(speakable("   "), VOICE_FALLBACK);
});
