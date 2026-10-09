import { logger } from "@agenvo/logging";
import type { Instance } from "@agenvo/protocol";
import valid from "semver/functions/valid.js";
import gt from "semver/functions/gt.js";
import { z } from "zod";
import type { RecordStore } from "./core.js";

const log = logger.child({ component: "relay.releases" });
const repository = "https://github.com/Xuanwo/agenvo";
const api = "https://api.github.com/repos/Xuanwo/agenvo/releases";
const cacheKey = "releases:v1";
const cacheMs = 60 * 60 * 1000;
const connectorPackages: Record<Instance["kind"], string> = {
  herdr: "@agenvo/herdr",
  codex: "@agenvo/codex-app-server",
  paseo: "@agenvo/paseo",
  amp: "@agenvo/amp",
  lody: "@agenvo/lody",
  opencode: "@agenvo/opencode",
};
const packages = ["@agenvo/server", ...Object.values(connectorPackages)];

export type ReleaseFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export type Release = {
  version: string;
  packages: string[];
  releaseUrl: string;
  guideUrl?: string;
};
type CachedRelease = {
  nextCheck: number;
  expires: number;
  release?: Release;
};
export type Update = {
  component: "server" | "connector";
  deviceId?: string;
  package?: string;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  guideUrl?: string;
};
export type ConnectorVersion = {
  deviceId: string;
  kind: Instance["kind"];
  online: boolean;
  connectorVersion?: string;
};

export function releaseVersion(value: unknown): string | undefined {
  // semver.valid omits build metadata; preserve the reported version.
  return typeof value === "string" &&
    value.length <= 128 &&
    valid(value) === value.split("+")[0]
    ? value
    : undefined;
}

export function updateNotices(
  release: Release | null,
  serverVersion: string,
  instances: ConnectorVersion[],
): Update[] {
  if (!release) return [];
  const updates: Update[] = [];
  const notice = (
    component: Update["component"],
    current: string | undefined,
    pkg: string,
    deviceId?: string,
  ) => {
    const currentVersion = releaseVersion(current);
    if (
      !currentVersion ||
      !release.packages.includes(pkg) ||
      !gt(release.version, currentVersion)
    )
      return;
    updates.push({
      component,
      ...(deviceId ? { deviceId, package: pkg } : {}),
      currentVersion,
      latestVersion: release.version,
      releaseUrl: release.releaseUrl,
      ...(release.guideUrl ? { guideUrl: release.guideUrl } : {}),
    });
  };
  notice("server", serverVersion, "@agenvo/server");
  const seen = new Set<string>();
  for (const instance of instances) {
    if (!instance.online || seen.has(instance.deviceId)) continue;
    seen.add(instance.deviceId);
    notice(
      "connector",
      instance.connectorVersion,
      connectorPackages[instance.kind],
      instance.deviceId,
    );
  }
  return updates;
}

const githubReleases = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullable(),
  }),
);
const npmVersion = z.object({ name: z.string(), version: z.string() });

// Public registry responses can include large release notes. Bound the bytes
// before parsing instead of trusting Content-Length or buffering without a limit.
async function json(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Release source returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Release source returned an empty body");
  let size = 0;
  let body = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("Release response too large");
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    await reader.cancel();
  }
}

async function latestRelease(
  fetcher: ReleaseFetch,
  signal: AbortSignal,
): Promise<Release | undefined> {
  const request = (url: string, method = "GET") =>
    fetcher(url, {
      method,
      redirect: "error",
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "agenvo-release-check",
      },
    });
  let latest: string | undefined;
  for (let page = 1; ; page++) {
    // Do not claim to have found the highest version from a truncated list.
    if (page > 10) throw new Error("Release listing exceeds pagination limit");
    const releases = githubReleases.parse(
      await json(await request(`${api}?per_page=100&page=${page}`)),
    );
    for (const release of releases) {
      if (
        release.draft ||
        release.prerelease ||
        !release.published_at ||
        !/^v\d+\.\d+\.\d+$/.test(release.tag_name)
      )
        continue;
      const version = releaseVersion(release.tag_name.slice(1));
      if (version && (!latest || gt(version, latest))) latest = version;
    }
    if (releases.length < 100) break;
  }
  if (!latest) return;
  const version = latest;
  const published = await Promise.all(
    packages.map(async (name) => {
      const response = await request(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
      );
      if (response.status === 404) {
        await response.body?.cancel();
        return [];
      }
      const pkg = npmVersion.parse(await json(response));
      if (pkg.name !== name || pkg.version !== version)
        throw new Error("Registry version does not match release");
      return [name];
    }),
  );
  const release: Release = {
    version,
    packages: published.flat(),
    releaseUrl: `${repository}/releases/tag/v${version}`,
  };
  // Older formal releases may not contain the update guide. Its absence or a
  // documentation outage must not hide otherwise verified release information.
  try {
    const response = await request(
      `https://raw.githubusercontent.com/Xuanwo/agenvo/refs/tags/v${version}/docs/updating.md`,
      "HEAD",
    );
    if (response.ok)
      release.guideUrl = `${repository}/blob/v${version}/docs/updating.md`;
    await response.body?.cancel();
  } catch {
    /* The release URL remains usable without a guide. */
  }
  return release;
}

/** One public release snapshot per relay; search never awaits registry I/O. */
export class Releases {
  private task?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  constructor(
    private readonly host: {
      store: RecordStore;
      fetch?: ReleaseFetch;
      background?: (task: Promise<void>) => void;
      now?: () => number;
    },
  ) {}

  read(): Release | null {
    if (this.closed) return null;
    try {
      const now = this.host.now?.() ?? Date.now();
      const cached = this.host.store.get<CachedRelease>(cacheKey);
      if (!this.task && (!cached || cached.nextCheck <= now)) {
        this.host.store.put(cacheKey, {
          ...cached,
          expires: cached?.expires ?? 0,
          nextCheck: now + cacheMs,
        });
        const controller = (this.controller = new AbortController());
        this.task = this.refresh(
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        ).finally(() => {
          controller.abort();
          this.task = undefined;
          this.controller = undefined;
        });
        this.host.background?.(this.task);
      }
      return cached && cached.expires > now ? (cached.release ?? null) : null;
    } catch (err) {
      log.warn(
        { event: "release.check.failed", err },
        "Unable to read release information",
      );
      return null;
    }
  }

  private async refresh(signal: AbortSignal) {
    try {
      const release = await latestRelease(this.host.fetch ?? fetch, signal);
      if (this.closed) return;
      const expires = (this.host.now?.() ?? Date.now()) + cacheMs;
      this.host.store.put(cacheKey, { release, expires, nextCheck: expires });
    } catch (err) {
      if (!this.closed)
        log.warn(
          { event: "release.check.failed", err },
          "Unable to refresh release information",
        );
    }
  }

  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.task;
  }
}
