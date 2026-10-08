import { nativeRequest } from './native-request.mjs';
// Adapted from owner-authored todo-plugin tests; all identities/keys are synthetic.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  authorizeDsaRead,
  JWKS_REFRESH_COOLDOWN_MS,
  MAX_ACCESS_JWT_BYTES,
  MAX_JWKS_CACHE_MS,
  MAX_JWKS_BYTES,
  withDsaRouteAccess,
} from "../dist/access.js";

const HOST = "dsa-workbench.example.invalid";
const ISSUER = "https://team-name.cloudflareaccess.com";
const AUDIENCE = "access-application-audience";
const EMAIL = "allowed-user@example.invalid";
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
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })).toString("base64url");
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: ISSUER,
    aud: ["another-application", AUDIENCE],
    email: EMAIL,
    nbf: NOW_SECONDS - 30,
    exp: NOW_SECONDS + 300,
    ...claims,
  })).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), key.privateKey).toString("base64url")}`;
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=600", ...init.headers },
    ...init,
  });
}

function cloudflareConfig({ key, now = () => NOW_SECONDS * 1000, jwksFetch } = {}) {
  const activeKey = key ?? keyPair("key-1");
  return {
    key: activeKey,
    config: {
      tailscaleBin: "/usr/bin/tailscale",
      tailscaleLogin: "owner@example.invalid",
      cloudflareAccessHost: HOST,
      cloudflareAccessIssuer: ISSUER,
      cloudflareAccessAudience: AUDIENCE,
      cloudflareAccessEmail: EMAIL,
      now,
      jwksFetch: jwksFetch ?? (async () => jsonResponse({ keys: [activeKey.jwk] })),
    },
  };
}

function cloudflareHeaders(assertion, extra = {}) {
  return {
    host: HOST,
    "x-forwarded-proto": "https",
    "cf-access-jwt-assertion": assertion,
    ...extra,
  };
}

async function request({ headers = {}, method = "GET", config, path = "/plugins/dsa-workbench/" } = {}) {
  const inner = (req, res) => {
    res.statusCode = 200;
    res.setHeader("x-seen-method", req.method ?? "");
    res.end(req.method === "HEAD" ? undefined : "ok");
    return true;
  };
  const effectiveConfig = config ?? {
    tailscaleBin: "/usr/bin/tailscale",
    tailscaleLogin: "owner@example.invalid",
    whois: async () => null,
  };
  const handler = withDsaRouteAccess(inner, effectiveConfig);
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await nativeRequest({ port, path, method, headers });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const tailscaleHeaders = {
  "x-forwarded-for": "100.101.102.103",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "pi.example.ts.net",
  "tailscale-user-login": "owner@example.invalid",
};

test("direct loopback access remains allowed only without proxy-shaped headers", async () => {
  assert.equal((await request()).status, 200);
  assert.equal((await request({ headers: { "cf-ray": "spoofed" } })).status, 401);
  assert.equal((await request({ headers: { "x-forwarded-proto": "https" } })).status, 401);
});

test("verified Tailscale Serve identity remains allowed", async () => {
  const config = {
    tailscaleBin: "/usr/bin/tailscale",
    tailscaleLogin: "owner@example.invalid",
    whois: async (ip) => ip === "100.101.102.103" ? "owner@example.invalid" : null,
  };
  assert.equal((await request({ headers: tailscaleHeaders, config })).status, 200);
});

test("spoofed, duplicate, Funnel, mismatched, or unverified Tailscale traffic is rejected", async () => {
  const config = {
    tailscaleBin: "/usr/bin/tailscale",
    tailscaleLogin: "owner@example.invalid",
    whois: async () => "other@example.invalid",
  };
  assert.equal((await request({ headers: tailscaleHeaders, config })).status, 401);
  config.whois = async () => "owner@example.invalid";
  assert.equal((await request({ headers: { ...tailscaleHeaders, "tailscale-user-login": "other@example.invalid" }, config })).status, 401);
  assert.equal((await request({ headers: { ...tailscaleHeaders, "tailscale-user-login": "Owner@example.invalid" }, config })).status, 401);
  assert.equal((await request({ headers: { ...tailscaleHeaders, "tailscale-funnel-request": "?1" }, config })).status, 401);
  assert.equal((await request({ headers: { ...tailscaleHeaders, "x-forwarded-proto": "http" }, config })).status, 401);
  assert.equal((await request({ headers: { ...tailscaleHeaders, "x-forwarded-for": ["100.101.102.103", "100.101.102.104"] }, config })).status, 401);
  assert.equal((await request({ headers: { ...tailscaleHeaders, "cf-ray": "mixed-route" }, config })).status, 401);
});

test("valid Cloudflare Access JWT authorizes generic GET, HEAD, and POST handlers", async () => {
  let fetchCalls = 0;
  const key = keyPair("valid-key");
  const { config } = cloudflareConfig({
    key,
    jwksFetch: async (url, init) => {
      fetchCalls += 1;
      assert.equal(String(url), `${ISSUER}/cdn-cgi/access/certs`);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      return jsonResponse({ keys: [key.jwk] });
    },
  });
  const assertion = jwt(key);
  const headers = cloudflareHeaders(assertion, { "cf-access-authenticated-user-email": EMAIL });
  for (const method of ["GET", "HEAD", "POST"]) {
    const response = await request({ method, headers, config });
    assert.equal(response.status, 200, `${method} should pass the same auth guard`);
    assert.equal(response.headers["x-seen-method"], method);
  }
  assert.equal(fetchCalls, 1, "GET, HEAD, and POST share the bounded JWKS cache");
});

test("Cloudflare JWT alg, signature, kid, issuer, audience, email, exp, and nbf fail closed", async () => {
  let now = NOW_SECONDS * 1000;
  let fetchCalls = 0;
  const trusted = keyPair("trusted-key");
  const untrusted = keyPair("untrusted-key");
  const { config } = cloudflareConfig({
    key: trusted,
    now: () => now,
    jwksFetch: async () => { fetchCalls += 1; return jsonResponse({ keys: [trusted.jwk] }); },
  });

  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted)), config })).status, 200);
  assert.equal((await request({ headers: cloudflareHeaders("not-a-jwt"), config })).status, 401);
  const oversizedRequest = {
    headers: {
      host: HOST,
      "x-forwarded-proto": "https",
      "cf-access-jwt-assertion": "x".repeat(MAX_ACCESS_JWT_BYTES + 1),
    },
    rawHeaders: [],
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(await authorizeDsaRead(oversizedRequest, config), false);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted, {}, { alg: "HS256" })), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(untrusted, {}, { kid: trusted.kid })), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted, {}, { kid: "missing-key" })), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted, { iss: "https://other.cloudflareaccess.com" })), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted, { aud: ["other-audience"] })), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted, { email: "other-user@example.invalid" })), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted, { exp: NOW_SECONDS })), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted, { nbf: NOW_SECONDS + 1 })), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted, { nbf: "soon" })), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted), { "cf-access-authenticated-user-email": "other-user@example.invalid" }), config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted), { "cf-access-authenticated-user-email": [EMAIL, EMAIL] }), config })).status, 401);
  assert.equal(fetchCalls, 1, "invalid claims and signatures do not bypass or churn a fresh key cache");

  now += JWKS_REFRESH_COOLDOWN_MS + 1;
  assert.equal((await request({ headers: cloudflareHeaders(jwt(trusted, {}, { kid: "still-missing" })), config })).status, 401);
  assert.equal(fetchCalls, 2, "an unknown kid may cause one refresh after the bounded cooldown");
});

test("Cloudflare required headers, exact host/proto, uniqueness, Funnel, and complete config fail closed", async () => {
  const { key, config } = cloudflareConfig();
  const assertion = jwt(key);
  const valid = cloudflareHeaders(assertion);
  const cases = [
    { host: HOST, "x-forwarded-proto": "https" },
    { host: HOST, "cf-access-jwt-assertion": assertion },
    { host: "other.example.invalid", "x-forwarded-proto": "https", "cf-access-jwt-assertion": assertion },
    { ...valid, "x-forwarded-proto": "http" },
    { ...valid, "x-forwarded-host": "other.example.invalid" },
    { ...valid, "tailscale-funnel-request": "?1" },
    { ...valid, "tailscale-user-login": "owner@example.invalid" },
  ];
  for (const headers of cases) assert.equal((await request({ headers, config })).status, 401);
  assert.equal((await request({ headers: { ...valid, "cf-access-jwt-assertion": [assertion, assertion] }, config })).status, 401);
  assert.equal((await request({ headers: { ...valid, "x-forwarded-proto": ["https", "https"] }, config })).status, 401);

  const incomplete = { ...config, cloudflareAccessAudience: "" };
  assert.equal((await request({ headers: valid, config: incomplete })).status, 401);
});

test("Cloudflare public-host and header spoofing cannot turn direct traffic into trusted local traffic", async () => {
  const { key, config } = cloudflareConfig();
  assert.equal((await request({ headers: { host: HOST }, config })).status, 401);
  assert.equal((await request({ headers: { host: `${HOST}:443` }, config })).status, 401);
  assert.equal((await request({ headers: { host: "127.0.0.1", "cf-access-authenticated-user-email": EMAIL }, config })).status, 401);
  assert.equal((await request({ headers: { host: HOST, "x-forwarded-proto": "https", "cf-ray": "spoofed" }, config })).status, 401);
  assert.equal((await request({ headers: cloudflareHeaders(jwt(key), { "x-forwarded-for": "203.0.113.10, 127.0.0.1" }), config })).status, 200,
    "untrusted X-Forwarded-For is not used as identity after JWT verification");

  const directRemote = {
    headers: {},
    rawHeaders: [],
    socket: { remoteAddress: "203.0.113.10" },
  };
  assert.equal(await authorizeDsaRead(directRemote, config), false);
  const duplicatePublicHost = {
    headers: { host: HOST },
    rawHeaders: ["Host", HOST, "Host", "127.0.0.1"],
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(await authorizeDsaRead(duplicatePublicHost, config), false);
});

test("JWKS cache, rotation refresh, fetch failure, expiry, and invalid key sets are bounded and fail closed", async () => {
  let now = NOW_SECONDS * 1000;
  let mode = "key-1";
  let fetchCalls = 0;
  const first = keyPair("key-1");
  const second = keyPair("key-2");
  const fetcher = async () => {
    fetchCalls += 1;
    if (mode === "fail") throw new Error("offline");
    if (mode === "invalid") return jsonResponse({ keys: [{ kid: "bad", kty: "oct", k: "unused" }] });
    return jsonResponse({ keys: mode === "both" ? [first.jwk, second.jwk] : [first.jwk] });
  };
  const { config } = cloudflareConfig({ key: first, now: () => now, jwksFetch: fetcher });

  assert.equal((await request({ headers: cloudflareHeaders(jwt(first)), config })).status, 200);
  assert.equal(fetchCalls, 1);
  mode = "fail";
  assert.equal((await request({ headers: cloudflareHeaders(jwt(first)), config })).status, 200);
  assert.equal(fetchCalls, 1, "a fresh cached key does not depend on a live issuer fetch");

  now += JWKS_REFRESH_COOLDOWN_MS + 1;
  assert.equal((await request({ headers: cloudflareHeaders(jwt(second)), config })).status, 401);
  assert.equal(fetchCalls, 2, "unknown kid refresh failure does not evict a valid cached key");
  assert.equal((await request({ headers: cloudflareHeaders(jwt(first)), config })).status, 200);

  now += JWKS_REFRESH_COOLDOWN_MS + 1;
  mode = "both";
  assert.equal((await request({ headers: cloudflareHeaders(jwt(second)), config })).status, 200);
  assert.equal(fetchCalls, 3, "rotation is accepted only after a successful issuer refresh");

  mode = "fail";
  now += MAX_JWKS_CACHE_MS + 1;
  assert.equal((await request({ headers: cloudflareHeaders(jwt(second, { exp: NOW_SECONDS + 10_000 })), config })).status, 401);
  assert.equal(fetchCalls, 4, "an expired cache is not a valid fallback after fetch failure");

  const noCache = cloudflareConfig({ key: first, jwksFetch: async () => { throw new Error("offline"); } }).config;
  assert.equal((await request({ headers: cloudflareHeaders(jwt(first)), config: noCache })).status, 401);
  const invalidKeys = cloudflareConfig({ key: first, jwksFetch: async () => jsonResponse({ keys: [{ kid: "bad", kty: "oct", k: "unused" }] }) }).config;
  assert.equal((await request({ headers: cloudflareHeaders(jwt(first)), config: invalidKeys })).status, 401);
  const oversized = cloudflareConfig({ key: first, jwksFetch: async () => new Response("x".repeat(MAX_JWKS_BYTES + 1)) }).config;
  assert.equal((await request({ headers: cloudflareHeaders(jwt(first)), config: oversized })).status, 401);
});
