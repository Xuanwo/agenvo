import { RelayAddress } from "@agenvo/protocol/address";
import logo from "./logo.json" with { type: "json" };
import { VERSION } from "@agenvo/protocol";

export const BRAND_NAME = "Agenvo";
export const BRAND_WEBSITE = "https://github.com/Xuanwo/agenvo";
export const BRAND_ICON_PATH = "/assets/agenvo.png";

export function serverInfo(baseUrl: string) {
  return {
    name: "agenvo",
    title: BRAND_NAME,
    version: VERSION,
    websiteUrl: BRAND_WEBSITE,
    icons: [
      {
        src: new RelayAddress(baseUrl).url(BRAND_ICON_PATH),
        mimeType: "image/png",
        sizes: ["256x256"],
      },
    ],
  };
}

// logo.json embeds a 256px rendition of docs/images/logo/agenvo-pigeon.png,
// so both deployment bundles serve it without an asset host. See that folder's README.
const icon = Uint8Array.from(atob(logo.base64), (c) => c.charCodeAt(0));

export function brandAsset(
  request: Request,
  baseUrl: string,
): Response | undefined {
  if (new RelayAddress(baseUrl).route(request.url) !== BRAND_ICON_PATH) return;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  return new Response(request.method === "HEAD" ? null : icon, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(icon.byteLength),
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
