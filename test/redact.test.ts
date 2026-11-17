import assert from "node:assert/strict";
import test from "node:test";

import { REDACTION_RULES, redact } from "../src/redact.js";

const PEM_BLOCK = [
  "-----BEGIN " + "FAKE " + "PRIVATE KEY-----",
  "FAKEBODY",
  "-----END " + "FAKE " + "PRIVATE KEY-----",
].join("\n");

test("defines exactly eleven redaction rules", () => {
  assert.equal(REDACTION_RULES.length, 11);
});

test("redacts PEM, key, token, and URL credential forms", () => {
  const source = [
    PEM_BLOCK,
    "sk-" + "FAKESECRET".repeat(2),
    "sk-ant-" + "FAKEANTHROPIC".repeat(2),
    "ghp_" + "FAKEgithub".repeat(3),
    "xoxb-" + "FAKEslack".repeat(3),
    "AIza" + "FAKEgoogle".repeat(5),
    "AKIA" + "A".repeat(16),
    "Authorization: Bearer " + "FAKEBearer".repeat(3),
    "access_token=" + "FAKErefresh".repeat(2),
    "api_key=" + "FAKEsecretvalue",
    "https://example.test/callback?token=" + "FAKEqueryvalue",
    "https://user:" + "FAKEpasswordvalue" + "@example.test",
  ].join("\n");
  const output = redact(source);
  assert.doesNotMatch(
    output,
    /FAKESECRET|FAKEANTHROPIC|FAKEgithub|FAKEslack|FAKEgoogle|FAKEBearer|FAKErefresh|FAKEsecretvalue|FAKEqueryvalue|FAKEpasswordvalue/,
  );
  assert.match(output, /\[redacted:pem\]/);
  assert.match(output, /api_key=\[redacted:secret\]/);
  assert.match(output, /^\[redacted:token\]$/m);
  assert.match(output, /https:\/\/example\.test\/callback\?token=\[redacted:secret\]/);
  assert.match(output, /https:\/\/user:\[redacted:secret\]@example\.test/);
});

test("leaves ordinary prose untouched", () => {
  assert.equal(redact("rotate credentials should be documented"), "rotate credentials should be documented");
});
