#!/usr/bin/env bun

import { formatCliError } from "./core/errors";
import { pagePlainText } from "./core/pager";
import { prepareStartupPlan } from "./core/startup";
import { sanitizeTerminalText } from "./lib/terminalText";
import { serveSessionBrokerDaemon } from "./session-broker/brokerServer";
import { runSessionCommand } from "./session/commands";

async function main() {
  const startupPlan = await prepareStartupPlan();

  if (startupPlan.kind === "help") {
    process.stdout.write(startupPlan.text);
    process.exit(0);
  }

  if (startupPlan.kind === "daemon-serve") {
    const server = serveSessionBrokerDaemon();
    await server.stopped;
    return;
  }

  if (startupPlan.kind === "session-command") {
    process.stdout.write(await runSessionCommand(startupPlan.input));
    process.exit(0);
  }

  if (startupPlan.kind === "plain-text-pager") {
    await pagePlainText(startupPlan.text);
    process.exit(0);
  }

  if (startupPlan.kind === "passthrough") {
    process.stdout.write(sanitizeTerminalText(startupPlan.text));
    process.exit(0);
  }

  if (startupPlan.kind === "static-diff-pager") {
    const { renderStaticDiffPager } = await import("./ui/staticDiffPager");
    process.stdout.write(
      await renderStaticDiffPager(startupPlan.text, startupPlan.options, {
        customTheme: startupPlan.customTheme,
        stderr: process.stderr,
      }),
    );
    process.exit(0);
  }

  if (startupPlan.kind !== "app") {
    throw new Error("Unreachable startup plan.");
  }

  // OpenTUI stays behind the interactive plan so headless commands never
  // materialize its embedded native library.
  const { runInteractiveApp } = await import("./ui/runInteractiveApp");
  await runInteractiveApp(startupPlan);
}

await main().catch((error) => {
  process.stderr.write(formatCliError(error));
  process.exit(1);
});
