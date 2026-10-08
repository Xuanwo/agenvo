import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LoroRepo } from "loro-repo";
import { StreamsTransportAdapter } from "loro-repo/transport/streams";
import { StreamsClient } from "@loro-dev/streams-client";
import { LoroList, LoroMap, LoroText, type LoroDoc } from "loro-crdt";
import { isolatedEnvironment, until } from "../support/environment.js";
import { stopProcess } from "../support/process.js";

// Real Loro Streams server + independent native document/RPC peer. Only Lody's
// account service and Agent execution are fixtures; no personal account is used.
export async function lodyCloudFixture() {
  const cleanups: Array<() => Promise<unknown>> = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse())
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length)
      throw new AggregateError(errors, "Lody cloud fixture cleanup failed");
  };
  try {
    const root = await mkdtemp(join(tmpdir(), "agenvo-lody-"));
    cleanups.push(() =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    );
    const child = spawn(
      process.execPath,
      [
        resolve("node_modules/@loro-dev/loro-cli/bin/loro.mjs"),
        "dev",
        "--port",
        "0",
        "--protocol",
        "http1",
        "--db-path",
        join(root, "streams.sqlite"),
        "--json",
      ],
      { env: isolatedEnvironment(root), stdio: ["ignore", "pipe", "pipe"] },
    );
    cleanups.push(() => stopProcess(child));
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    let baseUrl: string;
    try {
      await until(
        () => output,
        (s) => /http:\/\/127\.0\.0\.1:\d+/.test(s),
        15000,
      );
      baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    } catch (error) {
      throw new Error(output, { cause: error });
    }
    await fetch(`${baseUrl}/ds/lody`, { method: "PUT" });
    const repo = await LoroRepo.create({ metaDebounceCommitMs: 0 });
    cleanups.push(() => repo.destroy());
    const transport = new StreamsTransportAdapter({
      bucketId: "lody",
      baseUrl,
      auth: "fixture",
      metaStreamId: "workspace1:meta",
      docStreamId: (id) =>
        id.startsWith("session-") ? `workspace1:s:${id.slice(8)}` : id,
      flockDocStreamId: (id) => id,
      persistence: { mode: "ephemeral" },
    });
    await repo.addTransport("fixture", transport);
    const meta = await repo.joinMetaRoom();
    await meta.subscription("fixture").waitFor({ timeoutMs: 5000 });
    await repo.upsertDocMeta("machine-machine1", {
      id: "machine1",
      name: "Isolated remote machine",
      cliVersion: "fixture",
      os: "linux",
      sessions: [],
      ownerUserId: "user1",
    });
    const flockHandle = await repo.openFlockDoc("workspace1:mf:machine1");
    flockHandle.flock.set(["agentConfig", "config1"], {
      id: "config1",
      machineId: "machine1",
      name: "Codex fixture",
      cliType: "builtin",
      agentType: "codex",
      env: { SECRET_SENTINEL: "never-disclose" },
    });
    flockHandle.flock.set(["acpCapability", "config1"], {
      modes: [{ id: "agent-full-access", name: "Full access" }],
      models: [],
    });
    flockHandle.flock.commit();
    const machine = await repo.joinFlockDocRoom("workspace1:mf:machine1");
    await machine.subscription("fixture").waitUntilSynced();
    const docs = new Map<
      string,
      { doc: LoroDoc; room: Awaited<ReturnType<LoroRepo["joinDocRoom"]>> }
    >();
    const document = async (id: string) => {
      let entry = docs.get(id);
      if (!entry) {
        const { doc } = await repo.openPersistedDoc(`session-${id}`);
        const room = await repo.joinDocRoom(`session-${id}`);
        entry = { doc, room };
        docs.set(id, entry);
      }
      await entry.room.subscription("fixture").waitFor({ timeoutMs: 5000 });
      return entry;
    };
    const add = async (id = "external1") => {
      await repo.upsertDocMeta(`session-${id}`, {
        id,
        machineId: "machine1",
        userId: "user1",
        agentConfigId: "config1",
        cliType: "builtin",
        agentType: "codex",
        status: { type: "idle" },
        isArchived: false,
        historyBackend: "loro",
        createdAt: new Date().toISOString(),
      });
      const { doc, room } = await document(id);
      doc.getMap("session").set("id", id);
      doc.commit();
      await room.subscription("fixture").waitUntilSynced();
      await meta.subscription("fixture").waitUntilSynced();
      return id;
    };
    await add();
    const rpcRequests: any[] = [];
    const queries: any[] = [];
    const billing = { effectivePlanTier: "plus", checkoutPending: false };
    const states = new Map<string, string>();
    let tokenCalls = 0,
      denied = false,
      revoked = false,
      rejectStreamsOnce = false,
      droppedMethod = "";
    let blockedSession = "";
    let online = true,
      cliToken = "fixture-cli-token",
      userId = "user1";
    let rejectedToken: unknown;
    const tokenFile = join(root, "cli-token");
    await writeFile(tokenFile, "fixture-cli-token", { mode: 0o600 });
    let cloudUrl = "";
    const gateway = createServer(async (req, res) => {
      const path = new URL(req.url!, "http://fixture").pathname;
      if (!online) {
        res.writeHead(503);
        res.end();
        return;
      }
      if (path.startsWith("/ds/")) {
        if (
          blockedSession &&
          req.method === "POST" &&
          decodeURIComponent(path).endsWith(`:s:${blockedSession}`)
        ) {
          res.writeHead(503);
          res.end();
          return;
        }
        if (
          revoked ||
          rejectStreamsOnce ||
          req.headers.authorization !== "Bearer fixture-stream-token"
        ) {
          rejectStreamsOnce = false;
          res.writeHead(401);
          res.end();
          return;
        }
        const proxy = httpRequest(
          new URL(req.url!, baseUrl),
          {
            method: req.method,
            headers: { ...req.headers, host: new URL(baseUrl).host },
          },
          (upstream) => {
            res.writeHead(upstream.statusCode!, upstream.headers);
            upstream.pipe(res);
          },
        );
        res.on("close", () => proxy.destroy());
        proxy.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(proxy);
        return;
      }
      let text = "";
      for await (const c of req) text += c;
      const body = JSON.parse(text);
      res.setHeader("Content-Type", "application/json");
      if (path === "/api/loro-streams/token") {
        tokenCalls++;
        rejectedToken = body.rejectedToken;
        if (
          revoked ||
          req.headers.authorization !== `Bearer ${cliToken}` ||
          body.workspaceId !== "workspace1"
        ) {
          res.writeHead(401);
          res.end("{}");
          return;
        }
        res.end(
          JSON.stringify({
            token: "fixture-stream-token",
            expiresIn: 3600,
            gatewayBaseUrl: cloudUrl,
          }),
        );
        return;
      }
      queries.push(body);
      if (path !== "/api/query") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      const valid =
        !revoked &&
        (body.args.token === cliToken || body.args.cliToken === cliToken);
      const value =
        body.path === "deviceAuth:listMyWorkspacesForCliToken"
          ? {
              valid,
              userId: valid ? userId : null,
              workspaces: valid
                ? [
                    {
                      id: "workspace1",
                      name: "Isolated workspace",
                      slug: "fixture",
                      role: "owner",
                    },
                  ]
                : [],
            }
          : body.path === "deviceAuth:getWorkspaceBillingEntitlementForCliToken"
            ? { valid, ...billing }
            : {
                allowed:
                  valid &&
                  !denied &&
                  body.args.workspaceId === "workspace1" &&
                  body.args.machineId === "machine1",
                requesterUserId: userId,
              };
      res.end(JSON.stringify({ status: "success", value }));
    }).listen(0, "127.0.0.1");
    cleanups.push(async () => {
      gateway.closeAllConnections();
      await new Promise<void>((done) => gateway.close(() => done()));
    });
    await once(gateway, "listening");
    cloudUrl = `http://127.0.0.1:${(gateway.address() as any).port}`;
    const stream = (id: string) =>
      new StreamsClient({
        url: `${baseUrl}/ds/lody/${encodeURIComponent(id)}`,
        retry: { maxAttempts: 1 },
      });
    const requests = stream("workspace1:rpc:req:machine1");
    const created = await requests.create({
      contentType: "application/json",
      ttlSeconds: 86400,
    });
    if (!created.ok) throw new Error("fixture request stream failed");
    const abort = new AbortController();
    const pump = (async () => {
      try {
        for await (const event of requests.live({
          offset: created.result.nextOffset,
          signal: abort.signal,
        })) {
          if (event.type !== "data") continue;
          const values = event.payload.json<any>();
          for (const req of Array.isArray(values) ? values : [values]) {
            rpcRequests.push(req);
            if (req.method === droppedMethod) {
              droppedMethod = "";
              continue;
            }
            let result: any;
            if (req.method === "session/live-status")
              result = {
                type: "session/live-status_response",
                success: true,
                sessionId: req.params.sessionId,
                machineId: "machine1",
                state: states.get(req.params.sessionId) ?? "idle",
                observedAtMs: Date.now(),
              };
            else if (req.method === "session/cancel")
              result = {
                type: "session/cancel_response",
                success: req.params.turnId === "assistant1",
              };
            else
              result =
                req.params.expectedTurnId === "assistant1"
                  ? { applied: true, disposition: "applied" }
                  : { applied: false, disposition: "stale-turn" };
            await stream(req.replyTo).append({
              part: {
                contentType: "application/json",
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  rpcVersion: "1",
                  id: req.id,
                  method: req.method,
                  machineId: "machine1",
                  result,
                }),
              },
            });
          }
        }
      } catch {
        if (!abort.signal.aborted) throw new Error("Fixture RPC read failed");
      }
    })();
    cleanups.push(async () => {
      abort.abort();
      await pump;
    });
    const assistant = async (
      id: string,
      options: { finished?: boolean; question?: boolean } = {},
    ) => {
      const { doc, room } = await document(id);
      const row = doc.getList("history").pushContainer(new LoroMap());
      row.set("id", "assistant1");
      row.set("role", "assistant");
      row.set("timestamp", new Date().toISOString());
      row.set("finished", options.finished ?? true);
      const items = row.setContainer("items", new LoroList());
      const text = items.pushContainer(new LoroMap());
      text.set("type", "text");
      text
        .setContainer("text", new LoroText())
        .insert(0, "CLOUD_FIXTURE_RESULT");
      if (options.question) {
        const item = items.pushContainer(new LoroMap());
        item.set("type", "tool_call");
        item.set("toolCallId", "question-tool");
        item.set("title", "Choose target");
        const permission = item.setContainer(
          "permissionRequest",
          new LoroMap(),
        );
        permission.set("requestId", "question1");
        permission.set("options", [
          { optionId: "answer", kind: "allow_once", name: "Answer" },
        ]);
        permission.set("_meta", {
          lody: { elicitation: { version: 1, questions: [] } },
        });
      }
      doc.commit();
      await room.subscription("fixture").waitUntilSynced();
      return row;
    };
    return {
      root,
      repo,
      document,
      add,
      assistant,
      rpcRequests,
      queries,
      billing,
      states,
      tokenFile,
      config: {
        id: "lody",
        label: "Lody cloud fixture",
        kind: "lody" as const,
        mode: "cloud" as const,
        workspaceId: "workspace1",
        userId: "user1",
        tokenFile,
        authUrl: cloudUrl,
        authSiteUrl: cloudUrl,
      },
      tokenCalls: () => tokenCalls,
      rejectedToken: () => rejectedToken,
      denyMachine: (value = true) => {
        denied = value;
      },
      revoke: () => {
        revoked = true;
      },
      rejectStreamsOnce: () => {
        rejectStreamsOnce = true;
      },
      dropReply: (method: string) => {
        droppedMethod = method;
      },
      blockSessionWrites: (id: string) => {
        blockedSession = id;
      },
      setOnline: (value: boolean) => {
        online = value;
        if (!value) gateway.closeAllConnections();
      },
      setAccount: async (account: string) => {
        userId = account;
        cliToken = "fixture-rotated-token";
        await writeFile(tokenFile, cliToken, { mode: 0o600 });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
