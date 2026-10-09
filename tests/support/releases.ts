import type { ReleaseFetch } from "@agenvo/relay/releases";

/** Keep ordinary tests isolated from public release infrastructure. */
export const noReleases: ReleaseFetch = async (url) => {
  if (!url.startsWith("https://api.github.com/repos/Xuanwo/agenvo/releases?"))
    throw new Error("Unexpected release fixture request: " + url);
  return Response.json([]);
};

export const formalRelease: ReleaseFetch = async (url, init) => {
  if (url.startsWith("https://api.github.com/repos/Xuanwo/agenvo/releases?"))
    return Response.json([
      {
        tag_name: "v9.0.0",
        draft: false,
        prerelease: false,
        published_at: "2026-10-09T00:00:00Z",
      },
      {
        tag_name: "v10.0.0-rc.1",
        draft: false,
        prerelease: true,
        published_at: "2026-10-09T00:00:00Z",
      },
    ]);
  if (url.startsWith("https://registry.npmjs.org/")) {
    const [name, version] = new URL(url).pathname.slice(1).split("/");
    return Response.json({ name: decodeURIComponent(name), version });
  }
  if (
    url ===
      "https://raw.githubusercontent.com/Xuanwo/agenvo/refs/tags/v9.0.0/docs/updating.md" &&
    init.method === "HEAD"
  )
    return new Response(null, { status: 200 });
  throw new Error("Unexpected release fixture request: " + url);
};
