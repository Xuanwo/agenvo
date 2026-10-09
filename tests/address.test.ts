import test from "node:test";
import assert from "node:assert/strict";
import { RelayAddress, baseUrlSchema } from "@agenvo/protocol/address";
import { configSchema } from "@agenvo/connector/config";
import { instanceConfigSchema } from "./support/config.js";
import { localReturn, sameOrigin } from "@agenvo/relay/admin/auth";

test("public addresses normalize roots and arbitrary multilevel mount paths", () => {
  for (const prefix of [
    "",
    "/team/alice/relay",
    "/tools/:agent+@work",
    "/%E5%B7%A5%E5%85%B7",
  ]) {
    const baseUrl = "https://example.com" + prefix;
    const address = new RelayAddress(baseUrl + "/");
    assert.equal(address.baseUrl, baseUrl);
    assert.equal(address.url("/mcp"), baseUrl + "/mcp");
    assert.equal(address.route(baseUrl + "/mcp?q=1"), "/mcp");
    assert.equal(address.route(baseUrl), "/");
    assert.equal(
      address.route("https://other.example" + prefix + "/mcp"),
      undefined,
    );
    if (prefix) assert.equal(address.route(baseUrl + "-other/mcp"), undefined);
    assert.equal(baseUrlSchema.parse(baseUrl + "/"), baseUrl);
    assert.equal(
      configSchema(instanceConfigSchema).parse({
        schema: 1,
        relay: baseUrl + "/",
        name: "test",
        instances: [],
      }).relay,
      baseUrl,
    );
    assert.equal(
      address.authorizationMetadataUrl,
      "https://example.com/.well-known/oauth-authorization-server" + prefix,
    );
    assert.equal(
      address.resourceMetadataUrl,
      "https://example.com/.well-known/oauth-protected-resource" +
        prefix +
        "/mcp",
    );
  }
});

test("ambiguous deployment URLs fail before configuration is saved", () => {
  for (const value of [
    "http://example.com",
    "https://user:pass@example.com/x",
    "https://example.com/x?q=1",
    "https://example.com/x#part",
    "https://example.com/x?",
    "https://example.com/x#",
    "https://example.com/a/../b",
    "https://example.com/a/%2e./b",
    "https://example.com/a%2Fb",
    "https://example.com/a%5cb",
    "https://example.com/a\\b",
    "https://example.com/a//b",
    " https://example.com",
    "https://example.com/a\nb",
  ]) {
    assert.equal(baseUrlSchema.safeParse(value).success, false, value);
  }
});

test("return links stay in the instance while CSRF uses the origin", () => {
  const baseUrl = "https://example.com/tools/agents";
  assert.equal(
    localReturn("/tools/agents/authorize?state=x", baseUrl),
    "/tools/agents/authorize?state=x",
  );
  for (const value of [
    "/admin",
    "/tools/agents-other/admin",
    "//evil.example/admin",
    "/tools/agents/../other/admin",
    "/tools/agents/mcp",
  ]) {
    assert.equal(localReturn(value, baseUrl), "/tools/agents/admin");
  }
  assert.doesNotThrow(() =>
    sameOrigin(
      new Request(baseUrl + "/login", {
        headers: { Origin: "https://example.com" },
      }),
      { BASE_URL: baseUrl },
    ),
  );
  assert.throws(() =>
    sameOrigin(
      new Request(baseUrl + "/login", { headers: { Origin: baseUrl } }),
      { BASE_URL: baseUrl },
    ),
  );
});
