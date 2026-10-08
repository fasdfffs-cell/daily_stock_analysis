import { nativeRequest } from './native-request.mjs';
// Adapted from owner-authored todo-plugin tests; all identities/keys are synthetic.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { authorizeDsaRead, withDsaRouteAccess } from "../dist/access.js";

const HOST = "dsa.example.invalid";
const ISSUER = "https://team-fixture.cloudflareaccess.com";
const AUDIENCE = "audience-marker";
const EMAIL = "identity-marker";
const NOW_SECONDS = 1_800_000_000;

function keyPair(kid) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig", key_ops: ["verify"] },
  };
}

function jwt(key, claims = {}, header = {}) {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid, ...header })).toString("base64url");
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: ISSUER,
    aud: AUDIENCE,
    email: EMAIL,
    nbf: NOW_SECONDS - 1,
    exp: NOW_SECONDS + 60,
    ...claims,
  })).toString("base64url");
  const input = `${encodedHeader}.${encodedClaims}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`;
}

function fixture(overrides = {}) {
  const key = keyPair("trusted-key");
  const logs = [];
  const config = {
    tailscaleBin: "/usr/bin/tailscale",
    tailscaleLogin: "tailnet-identity",
    cloudflareAccessHost: HOST,
    cloudflareAccessIssuer: ISSUER,
    cloudflareAccessAudience: AUDIENCE,
    cloudflareAccessEmail: EMAIL,
    now: () => NOW_SECONDS * 1000,
    jwksFetch: async () => new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 }),
    logger: { warn: (line) => logs.push(line) },
    ...overrides,
  };
  return { key, logs, config };
}

function requestShape(headers = {}, remoteAddress = "127.0.0.1") {
  const rawHeaders = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) rawHeaders.push(name, String(item));
  }
  return { headers, rawHeaders, socket: { remoteAddress } };
}

async function expectReason(headers, expected, options = {}) {
  const fx = fixture(options.overrides);
  const allowed = await authorizeDsaRead(requestShape(headers, options.remoteAddress), fx.config);
  assert.equal(allowed, false);
  assert.deepEqual(fx.logs, [`[access-reject] plugin=dsa-workbench reason=${expected}`]);
}

function headers(assertion, extra = {}) {
  return { host: HOST, "x-forwarded-proto": "https", "cf-access-jwt-assertion": assertion, ...extra };
}

test("rejections emit one bounded plugin/reason diagnostic", async () => {
  const trusted = keyPair("trusted-key");
  const untrusted = keyPair("untrusted-key");
  const good = jwt(trusted);
  const common = {
    jwksFetch: async () => new Response(JSON.stringify({ keys: [trusted.jwk] }), { status: 200 }),
  };
  await expectReason({}, "non-loopback", { remoteAddress: "not-loopback" });
  await expectReason({ host: HOST, "cf-ray": "marker" }, "incomplete-config", { overrides: { cloudflareAccessAudience: "" } });
  await expectReason({ host: "mismatch.invalid", "cf-ray": "marker" }, "host-mismatch");
  await expectReason(headers(good, { "x-forwarded-host": "mismatch.invalid" }), "forwarded-host-mismatch", { overrides: common });
  await expectReason(headers(good, { "x-forwarded-proto": "http" }), "proto-mismatch", { overrides: common });
  await expectReason(headers(good, { "tailscale-user-login": "marker" }), "mixed-ingress", { overrides: common });
  await expectReason({ host: HOST, "x-forwarded-proto": "https" }, "missing-assertion");
  await expectReason(headers("not-a-token"), "jwt-format");
  await expectReason(headers(jwt(trusted, {}, { alg: "HS256" })), "jwt-alg", { overrides: common });
  await expectReason(headers(jwt(trusted, {}, { kid: "unknown-key" })), "jwt-kid", { overrides: common });
  await expectReason(headers(jwt(untrusted, {}, { kid: trusted.kid })), "jwt-signature", { overrides: common });
  await expectReason(headers(good), "jwt-jwks", { overrides: { jwksFetch: async () => { throw new Error("offline"); } } });
  await expectReason(headers(jwt(trusted, { iss: "wrong-issuer" })), "jwt-issuer", { overrides: common });
  await expectReason(headers(jwt(trusted, { aud: "wrong-audience" })), "jwt-audience", { overrides: common });
  await expectReason(headers(jwt(trusted, { exp: NOW_SECONDS })), "jwt-time", { overrides: common });
  await expectReason(headers(jwt(trusted, { email: "wrong-identity" })), "jwt-email", { overrides: common });
  await expectReason(headers(good, { "cf-access-authenticated-user-email": "wrong-identity" }), "email-mismatch", { overrides: common });
});

test("optional email trusts Access policy only after all JWT verification succeeds", async () => {
  const fx = fixture({ cloudflareAccessEmail: "" });
  assert.equal(await authorizeDsaRead(requestShape(headers(jwt(fx.key, { email: "allowed-fixture@example.invalid" }))), fx.config), true);
  for (const claims of [{ email: "" }, { email: null }, { email: "a".repeat(321) }, { iss: "wrong" }, { aud: "wrong" }, { exp: NOW_SECONDS }]) {
    assert.equal(await authorizeDsaRead(requestShape(headers(jwt(fx.key, claims))), fx.config), false);
  }
  const other = keyPair("untrusted");
  assert.equal(await authorizeDsaRead(requestShape(headers(jwt(other, {}, { kid: fx.key.kid }))), fx.config), false);
  assert.equal(await authorizeDsaRead(requestShape(headers(jwt(fx.key))), { ...fx.config, cloudflareAccessAudience: "" }), false);
});

test("Tailscale rejection paths use finite diagnostics without identity or address values", async () => {
  const clientAddress = [100, 64, 0, 1].join(".");
  const base = {
    "x-forwarded-proto": "https",
    "x-forwarded-host": "peer.ts.net",
    "x-forwarded-for": clientAddress,
    "tailscale-user-login": "tailnet-identity",
  };
  await expectReason(base, "tailscale-config", { overrides: { tailscaleLogin: "" } });
  await expectReason({ ...base, "x-forwarded-for": "not-an-address" }, "tailscale-client-mismatch");
  await expectReason({ ...base, "tailscale-user-login": "wrong-identity" }, "tailscale-login-mismatch");
  await expectReason(base, "tailscale-whois-mismatch", { overrides: { whois: async () => "wrong-identity" } });
});

test("diagnostics and generic 401 response exclude sensitive request input", async () => {
  const marker = "private-sentinel-value";
  const fx = fixture();
  const inner = (_req, res) => { res.statusCode = 200; res.end("ok"); return true; };
  const handler = withDsaRouteAccess(inner, fx.config);
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const response = await nativeRequest({ port, path: "/plugins/dsa-workbench/", headers: headers(marker, { cookie: marker }) });
    assert.equal(response.status, 401);
    assert.equal(response.body, JSON.stringify({ error: "Dsa 页面访问身份验证失败" }));
    assert.doesNotMatch(response.body, /jwt-format|private-sentinel-value/u);
    assert.deepEqual(fx.logs, ["[access-reject] plugin=dsa-workbench reason=jwt-format"]);
    assert.doesNotMatch(fx.logs.join("\n"), /private-sentinel-value/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
