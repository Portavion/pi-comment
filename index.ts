/**
 * Derived from Plannotator and modified for the standalone pi-feedback project.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type AnnotateServerResult,
  type ReviewServerResult,
  startReviewServer,
  startAnnotateServer,
  getGitContext,
  runGitDiff,
  openBrowser,
} from "./server.js";

interface DecisionServer<T> {
  url: string;
  stop: () => void;
  waitForDecision: () => Promise<T>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
let annotatorHtmlContent = "";
let codeFeedbackHtmlContent = "";

try {
  annotatorHtmlContent = readFileSync(resolve(__dirname, "annotator.html"), "utf-8");
} catch {
  // HTML not built yet.
}

try {
  codeFeedbackHtmlContent = readFileSync(resolve(__dirname, "review-editor.html"), "utf-8");
} catch {
  // HTML not built yet.
}

async function runBrowserDecisionFlow<T extends { type: "submitted" | "closed" }>(server: DecisionServer<T>, ctx: ExtensionContext): Promise<T> {
  const browserResult = openBrowser(server.url);
  if (browserResult.isRemote) {
    ctx.ui.notify(`Remote session. Open manually: ${browserResult.url}`, "info");
  }

  const result = await server.waitForDecision();
  if (result.type === "submitted") {
    await new Promise((r) => setTimeout(r, 1500));
  }
  server.stop();
  return result;
}

function getStartupErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function isMarkdownFile(filePath: string): boolean {
  return /\.mdx?$/i.test(filePath);
}

function resolveMarkdownPath(cwd: string, rawFilePath: string): { displayPath: string; absolutePath: string } {
  const filePath = rawFilePath.trim();
  const absolutePath = resolve(cwd, filePath);
  if (existsSync(absolutePath)) {
    return { displayPath: filePath, absolutePath };
  }

  if (filePath.startsWith("@")) {
    const normalizedPath = filePath.slice(1);
    const normalizedAbsolutePath = resolve(cwd, normalizedPath);
    if (existsSync(normalizedAbsolutePath)) {
      return { displayPath: normalizedPath, absolutePath: normalizedAbsolutePath };
    }
  }

  return { displayPath: filePath, absolutePath };
}

export default function piFeedback(pi: ExtensionAPI): void {
  pi.registerCommand("feedback-code", {
    description: "Open interactive code feedback for current git changes",
    handler: async (_args, ctx) => {
      if (!codeFeedbackHtmlContent) {
        ctx.ui.notify("Code feedback UI not available. Expected review-editor.html next to the extension.", "error");
        return;
      }

      ctx.ui.notify("Opening code feedback UI...", "info");

      const gitCtx = getGitContext();
      const { patch: rawPatch, label: gitRef } = runGitDiff("uncommitted", gitCtx.defaultBranch);

      let server: ReviewServerResult;
      try {
        server = await startReviewServer({
          rawPatch,
          gitRef,
          origin: "pi-feedback",
          diffType: "uncommitted",
          gitContext: gitCtx,
          htmlContent: codeFeedbackHtmlContent,
        });
      } catch (err) {
        ctx.ui.notify(`Failed to start code feedback UI: ${getStartupErrorMessage(err)}`, "error");
        return;
      }

      const result = await runBrowserDecisionFlow(server, ctx);

      if (result.type === "closed") {
        ctx.ui.notify("Code feedback UI closed without feedback.", "info");
        return;
      }

      if (result.feedback) {
        if (result.approved) {
          pi.sendUserMessage("# Code Feedback\n\nCode feedback completed — no changes requested.");
        } else {
          pi.sendUserMessage(`${result.feedback}\n\nPlease address this code feedback.`);
        }
      } else {
        ctx.ui.notify("Code feedback closed (no feedback).", "info");
      }
    },
  });

  pi.registerCommand("feedback-file", {
    description: "Open a markdown file in the browser annotation UI",
    handler: async (args, ctx) => {
      const filePath = args?.trim();
      if (!filePath) {
        ctx.ui.notify("Usage: /feedback-file <file.md>", "error");
        return;
      }
      if (!isMarkdownFile(filePath)) {
        ctx.ui.notify("/feedback-file only supports .md and .mdx files.", "error");
        return;
      }
      if (!annotatorHtmlContent) {
        ctx.ui.notify("Annotation UI not available. Expected annotator.html next to the extension.", "error");
        return;
      }

      const { displayPath, absolutePath } = resolveMarkdownPath(ctx.cwd, filePath);
      if (!existsSync(absolutePath)) {
        ctx.ui.notify(`File not found: ${absolutePath}`, "error");
        return;
      }

      ctx.ui.notify(`Opening annotation UI for ${displayPath}...`, "info");

      const markdown = readFileSync(absolutePath, "utf-8");
      let server: AnnotateServerResult;
      try {
        server = await startAnnotateServer({
          markdown,
          filePath: absolutePath,
          origin: "pi-feedback",
          htmlContent: annotatorHtmlContent,
        });
      } catch (err) {
        ctx.ui.notify(`Failed to start annotation UI: ${getStartupErrorMessage(err)}`, "error");
        return;
      }

      const result = await runBrowserDecisionFlow(server, ctx);

      if (result.type === "closed") {
        ctx.ui.notify("Annotation UI closed without feedback.", "info");
        return;
      }

      if (result.feedback) {
        pi.sendUserMessage(
          `# Markdown Annotations\n\nFile: ${absolutePath}\n\n${result.feedback}\n\nPlease address the annotation feedback above.`,
        );
      } else {
        ctx.ui.notify("Annotation closed (no feedback).", "info");
      }
    },
  });
}
