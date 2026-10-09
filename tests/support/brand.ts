import assert from "node:assert/strict";

export async function assertPublicBrand(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  origin: string,
) {
  const metadata = await request("/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.status, 200);
  const resource = (await metadata.json()) as {
    resource_name?: string;
    resource: string;
  };
  assert.equal(resource.resource_name, "Agenvo");
  assert.equal(resource.resource, origin + "/mcp");

  const icon = await request("/assets/agenvo.png");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("Content-Type"), "image/png");
  assert.equal(icon.headers.get("Cache-Control"), "public, max-age=86400");
  const bytes = Buffer.from(await icon.arrayBuffer());
  assert.equal(Number(icon.headers.get("Content-Length")), bytes.length);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 256);
  assert.equal(bytes.readUInt32BE(20), 256);
  const head = await request("/assets/agenvo.png", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(
    (await request("/assets/agenvo.png", { method: "POST" })).status,
    405,
  );
}

export function assertServerBrand(
  info:
    | { name: string; title?: string; icons?: unknown; websiteUrl?: string }
    | undefined,
  origin: string,
) {
  assert.equal(info?.name, "agenvo");
  assert.equal(info?.title, "Agenvo");
  assert.equal(info?.websiteUrl, "https://github.com/Xuanwo/agenvo");
  assert.deepEqual(info?.icons, [
    {
      src: origin + "/assets/agenvo.png",
      mimeType: "image/png",
      sizes: ["256x256"],
    },
  ]);
}
