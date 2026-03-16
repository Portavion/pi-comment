/**
 * Derived from Plannotator and modified for the standalone pi-feedback project.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { execSync, spawn } from "node:child_process";
import os from "node:os";

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res: import("node:http").ServerResponse, content: string): void {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(content);
}

function injectLifecycleScript(content: string): string {
  const script = `<script>
(function() {
  let submitted = false;
  const markSubmitted = () => { submitted = true; };
  const originalFetch = window.fetch.bind(window);

  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (url.includes('/api/feedback')) {
      markSubmitted();
    }
    return originalFetch(input, init);
  };

  const ping = window.setInterval(() => {
    if (submitted) return;
    originalFetch('/api/ping', { method: 'POST', keepalive: true }).catch(() => {});
  }, 1000);

  window.addEventListener('pagehide', () => {
    if (submitted) return;
    navigator.sendBeacon('/api/close');
  });

  window.addEventListener('beforeunload', () => {
    if (submitted) return;
    navigator.sendBeacon('/api/close');
  });

  window.addEventListener('unload', () => {
    window.clearInterval(ping);
  });
})();
</script>`;

  const bodyCloseIndex = content.lastIndexOf('</body>');
  if (bodyCloseIndex === -1) {
    return `${content}${script}`;
  }

  return `${content.slice(0, bodyCloseIndex)}${script}${content.slice(bodyCloseIndex)}`;
}

const DEFAULT_REMOTE_PORT = 19432;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;
const CLIENT_HEARTBEAT_TIMEOUT_MS = 4000;
const CLIENT_HEARTBEAT_CHECK_MS = 1000;

function isRemoteSession(): boolean {
  const remote = process.env.PLANNOTATOR_REMOTE;
  if (remote === "1" || remote?.toLowerCase() === "true") return true;
  return Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
}

function getServerPort(): { port: number; portSource: "env" | "remote-default" | "random" } {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return { port: parsed, portSource: "env" };
    }
  }
  if (isRemoteSession()) {
    return { port: DEFAULT_REMOTE_PORT, portSource: "remote-default" };
  }
  return { port: 0, portSource: "random" };
}

async function listenOnPort(server: Server): Promise<{ port: number; portSource: "env" | "remote-default" | "random" }> {
  const result = getServerPort();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(result.port, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const addr = server.address() as { port: number };
      return { port: addr.port, portSource: result.portSource };
    } catch (err: unknown) {
      const isAddressInUse = err instanceof Error && err.message.includes("EADDRINUSE");
      if (isAddressInUse && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      if (isAddressInUse) {
        const hint = isRemoteSession() ? " (set PLANNOTATOR_PORT to use a different port)" : "";
        throw new Error(`Port ${result.port} in use after ${MAX_RETRIES} retries${hint}`);
      }
      throw err;
    }
  }

  throw new Error("Failed to bind port");
}

export function openBrowser(url: string): { opened: boolean; isRemote?: boolean; url?: string } {
  const browser = process.env.PLANNOTATOR_BROWSER || process.env.BROWSER;
  if (isRemoteSession() && !browser) return { opened: false, isRemote: true, url };

  try {
    const platform = process.platform;
    const wsl = platform === "linux" && os.release().toLowerCase().includes("microsoft");

    let cmd: string;
    let args: string[];

    if (browser) {
      if (process.env.PLANNOTATOR_BROWSER && platform === "darwin") {
        cmd = "open";
        args = ["-a", browser, url];
      } else if (platform === "win32" || wsl) {
        cmd = "cmd.exe";
        args = ["/c", "start", "", browser, url];
      } else {
        cmd = browser;
        args = [url];
      }
    } else if (platform === "win32" || wsl) {
      cmd = "cmd.exe";
      args = ["/c", "start", "", url];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }

    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", () => {});
    child.unref();
    return { opened: true };
  } catch {
    return { opened: false };
  }
}

export type DiffType = "uncommitted" | "staged" | "unstaged" | "last-commit" | "branch";

export interface DiffOption {
  id: DiffType | "separator";
  label: string;
}

export interface GitContext {
  currentBranch: string;
  defaultBranch: string;
  diffOptions: DiffOption[];
}

export type ReviewDecision =
  | { type: "submitted"; approved: boolean; feedback: string }
  | { type: "closed" };

export type AnnotateDecision =
  | { type: "submitted"; feedback: string }
  | { type: "closed" };

export interface ReviewServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<ReviewDecision>;
  stop: () => void;
}

export interface AnnotateServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<AnnotateDecision>;
  stop: () => void;
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

export function getGitContext(): GitContext {
  const currentBranch = git("rev-parse --abbrev-ref HEAD") || "HEAD";

  let defaultBranch = "";
  const symRef = git("symbolic-ref refs/remotes/origin/HEAD");
  if (symRef) defaultBranch = symRef.replace("refs/remotes/origin/", "");
  if (!defaultBranch) {
    const hasMain = git("show-ref --verify refs/heads/main");
    defaultBranch = hasMain ? "main" : "master";
  }

  const diffOptions: DiffOption[] = [
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "last-commit", label: "Last commit" },
  ];
  if (currentBranch !== defaultBranch) {
    diffOptions.push({ id: "branch", label: `vs ${defaultBranch}` });
  }

  return { currentBranch, defaultBranch, diffOptions };
}

export function runGitDiff(diffType: DiffType, defaultBranch = "main"): { patch: string; label: string } {
  switch (diffType) {
    case "uncommitted":
      return { patch: git("diff HEAD --src-prefix=a/ --dst-prefix=b/"), label: "Uncommitted changes" };
    case "staged":
      return { patch: git("diff --staged --src-prefix=a/ --dst-prefix=b/"), label: "Staged changes" };
    case "unstaged":
      return { patch: git("diff --src-prefix=a/ --dst-prefix=b/"), label: "Unstaged changes" };
    case "last-commit":
      return { patch: git("diff HEAD~1..HEAD --src-prefix=a/ --dst-prefix=b/"), label: "Last commit" };
    case "branch":
      return { patch: git(`diff ${defaultBranch}..HEAD --src-prefix=a/ --dst-prefix=b/`), label: `Changes vs ${defaultBranch}` };
    default:
      return { patch: "", label: "Unknown diff type" };
  }
}

function createDecisionResolver<T extends { type: "submitted" | "closed" }>() {
  let decisionResolved = false;
  let clientConnected = false;
  let lastClientSeenAt = 0;
  let resolveDecision!: (result: T) => void;

  const decisionPromise = new Promise<T>((r) => {
    resolveDecision = (result) => {
      if (decisionResolved) return;
      decisionResolved = true;
      r(result);
    };
  });

  const markClientSeen = (): void => {
    clientConnected = true;
    lastClientSeenAt = Date.now();
  };

  const heartbeatInterval = setInterval(() => {
    if (decisionResolved || !clientConnected) return;
    if (Date.now() - lastClientSeenAt > CLIENT_HEARTBEAT_TIMEOUT_MS) {
      resolveDecision({ type: "closed" } as T);
    }
  }, CLIENT_HEARTBEAT_CHECK_MS);

  const cleanup = (): void => clearInterval(heartbeatInterval);

  return {
    decisionPromise,
    resolveDecision,
    markClientSeen,
    cleanup,
  };
}

export async function startReviewServer(options: {
  rawPatch: string;
  gitRef: string;
  htmlContent: string;
  origin?: string;
  diffType?: DiffType;
  gitContext?: GitContext;
}): Promise<ReviewServerResult> {
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || "uncommitted";

  const { decisionPromise, resolveDecision, markClientSeen, cleanup } = createDecisionResolver<ReviewDecision>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (url.pathname === "/api/diff" && req.method === "GET") {
      markClientSeen();
      json(res, {
        rawPatch: currentPatch,
        gitRef: currentGitRef,
        origin: options.origin ?? "pi-feedback",
        diffType: currentDiffType,
        gitContext: options.gitContext,
      });
    } else if (url.pathname === "/api/diff/switch" && req.method === "POST") {
      markClientSeen();
      const body = await parseBody(req);
      const newType = body.diffType as DiffType;
      if (!newType) return json(res, { error: "Missing diffType" }, 400);
      const defaultBranch = options.gitContext?.defaultBranch || "main";
      const result = runGitDiff(newType, defaultBranch);
      currentPatch = result.patch;
      currentGitRef = result.label;
      currentDiffType = newType;
      json(res, { rawPatch: currentPatch, gitRef: currentGitRef, diffType: currentDiffType });
    } else if (url.pathname === "/api/feedback" && req.method === "POST") {
      markClientSeen();
      const body = await parseBody(req);
      resolveDecision({
        type: "submitted",
        approved: (body.approved as boolean) ?? false,
        feedback: (body.feedback as string) || "",
      });
      json(res, { ok: true });
    } else if (url.pathname === "/api/close" && req.method === "POST") {
      resolveDecision({ type: "closed" });
      json(res, { ok: true });
    } else if (url.pathname === "/api/ping" && req.method === "POST") {
      markClientSeen();
      json(res, { ok: true });
    } else {
      markClientSeen();
      html(res, injectLifecycleScript(options.htmlContent));
    }
  });

  const { port, portSource } = await listenOnPort(server);
  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => {
      cleanup();
      server.close();
    },
  };
}

export async function startAnnotateServer(options: {
  markdown: string;
  filePath: string;
  htmlContent: string;
  origin?: string;
}): Promise<AnnotateServerResult> {
  const { decisionPromise, resolveDecision, markClientSeen, cleanup } = createDecisionResolver<AnnotateDecision>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (url.pathname === "/api/plan" && req.method === "GET") {
      markClientSeen();
      json(res, {
        plan: options.markdown,
        origin: options.origin ?? "pi-feedback",
        mode: "annotate",
        filePath: options.filePath,
      });
    } else if (url.pathname === "/api/feedback" && req.method === "POST") {
      markClientSeen();
      const body = await parseBody(req);
      resolveDecision({ type: "submitted", feedback: (body.feedback as string) || "" });
      json(res, { ok: true });
    } else if (url.pathname === "/api/close" && req.method === "POST") {
      resolveDecision({ type: "closed" });
      json(res, { ok: true });
    } else if (url.pathname === "/api/ping" && req.method === "POST") {
      markClientSeen();
      json(res, { ok: true });
    } else {
      markClientSeen();
      html(res, injectLifecycleScript(options.htmlContent));
    }
  });

  const { port, portSource } = await listenOnPort(server);
  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => {
      cleanup();
      server.close();
    },
  };
}
