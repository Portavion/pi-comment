/**
 * Derived from Plannotator and modified for the standalone pi-comment project.
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
let reviewHtmlContent = "";

try {
  annotatorHtmlContent = readFileSync(resolve(__dirname, "annotator.html"), "utf-8");
} catch {
  // HTML not built yet.
}

try {
  reviewHtmlContent = readFileSync(resolve(__dirname, "review-editor.html"), "utf-8");
} catch {
  // HTML not built yet.
}

async function runBrowserReview<T>(server: DecisionServer<T>, ctx: ExtensionContext): Promise<T> {
  const browserResult = openBrowser(server.url);
  if (browserResult.isRemote) {
    ctx.ui.notify(`Remote session. Open manually: ${browserResult.url}`, "info");
  }

  const result = await server.waitForDecision();
  await new Promise((r) => setTimeout(r, 1500));
  server.stop();
  return result;
}

function getStartupErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function isMarkdownFile(filePath: string): boolean {
  return /\.mdx?$/i.test(filePath);
}

export default function piComment(pi: ExtensionAPI): void {
  pi.registerCommand("codereview", {
    description: "Open interactive code review for current git changes",
    handler: async (_args, ctx) => {
      if (!reviewHtmlContent) {
        ctx.ui.notify("Review UI not available. Expected review-editor.html next to the extension.", "error");
        return;
      }

      ctx.ui.notify("Opening code review UI...", "info");

      const gitCtx = getGitContext();
      const { patch: rawPatch, label: gitRef } = runGitDiff("uncommitted", gitCtx.defaultBranch);

      let server: ReviewServerResult;
      try {
        server = await startReviewServer({
          rawPatch,
          gitRef,
          origin: "pi-comment",
          diffType: "uncommitted",
          gitContext: gitCtx,
          htmlContent: reviewHtmlContent,
        });
      } catch (err) {
        ctx.ui.notify(`Failed to start code review UI: ${getStartupErrorMessage(err)}`, "error");
        return;
      }

      const result = await runBrowserReview(server, ctx);

      if (result.feedback) {
        if (result.approved) {
          pi.sendUserMessage("# Code Review\n\nCode review completed — no changes requested.");
        } else {
          pi.sendUserMessage(`# Code Review Feedback\n\n${result.feedback}\n\nPlease address this feedback.`);
        }
      } else {
        ctx.ui.notify("Code review closed (no feedback).", "info");
      }
    },
  });

  pi.registerCommand("annotate", {
    description: "Open a markdown file in the browser annotation UI",
    handler: async (args, ctx) => {
      const filePath = args?.trim();
      if (!filePath) {
        ctx.ui.notify("Usage: /annotate <file.md>", "error");
        return;
      }
      if (!isMarkdownFile(filePath)) {
        ctx.ui.notify("/annotate only supports .md and .mdx files.", "error");
        return;
      }
      if (!annotatorHtmlContent) {
        ctx.ui.notify("Annotation UI not available. Expected annotator.html next to the extension.", "error");
        return;
      }

      const absolutePath = resolve(ctx.cwd, filePath);
      if (!existsSync(absolutePath)) {
        ctx.ui.notify(`File not found: ${absolutePath}`, "error");
        return;
      }

      ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");

      const markdown = readFileSync(absolutePath, "utf-8");
      let server: AnnotateServerResult;
      try {
        server = await startAnnotateServer({
          markdown,
          filePath: absolutePath,
          origin: "pi-comment",
          htmlContent: annotatorHtmlContent,
        });
      } catch (err) {
        ctx.ui.notify(`Failed to start annotation UI: ${getStartupErrorMessage(err)}`, "error");
        return;
      }

      const result = await runBrowserReview(server, ctx);

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
