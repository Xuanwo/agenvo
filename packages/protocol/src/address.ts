import { z } from "zod";

/** The public deployment address owns URL normalization and mount boundaries. */
export class RelayAddress {
  readonly baseUrl: string;
  readonly origin: string;
  readonly prefix: string;

  constructor(value: string) {
    const url = new URL(value);
    // Reject ambiguous separators and dot segments before URL parsing can erase them.
    const rawPath = value.replace(/^https:\/\/[^/]+/i, "");
    if (
      !/^https:\/\//i.test(value) ||
      /[\s\x00-\x1f\x7f]/.test(value) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      value.includes("?") ||
      value.includes("#") ||
      value.includes("\\") ||
      /%2f|%5c/i.test(url.pathname) ||
      url.pathname.includes("//") ||
      rawPath.split("/").some((part) => /^(\.|%2e){1,2}$/i.test(part))
    )
      throw new Error(
        "Expected an HTTPS base URL without credentials, query, fragment or ambiguous path segments",
      );
    this.origin = url.origin;
    this.prefix = url.pathname.replace(/\/$/, "");
    this.baseUrl = this.origin + this.prefix;
  }

  get authorizationMetadataUrl() {
    return (
      this.origin + "/.well-known/oauth-authorization-server" + this.prefix
    );
  }

  get resourceMetadataUrl() {
    return (
      this.origin + "/.well-known/oauth-protected-resource" + this.path("/mcp")
    );
  }

  path(route: string) {
    return this.prefix + route;
  }

  url(route: string) {
    return this.baseUrl + route;
  }

  /** Undefined means this URL does not belong to this deployment. */
  route(value: string): string | undefined {
    const url = new URL(value);
    if (url.origin !== this.origin) return;
    if (url.pathname === this.prefix) return "/";
    if (!url.pathname.startsWith(this.prefix + "/")) return;
    return url.pathname.slice(this.prefix.length);
  }
}

export const baseUrlSchema = z.string().transform((value, ctx) => {
  try {
    return new RelayAddress(value).baseUrl;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Expected an HTTPS base URL with an optional path prefix",
    });
    return z.NEVER;
  }
});
