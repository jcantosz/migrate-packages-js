import * as core from "@actions/core";
import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { trackResource } from "../../shared/utils.js";

export function checkDotNetInstallation() {
  try {
    execSync("dotnet --version", { stdio: "pipe" });
    core.info("dotnet is installed");
  } catch (err) {
    core.error("dotnet is not installed or not accessible");
    throw err;
  }
}

function getGprPath(toolsDir) {
  const extension = process.platform === "win32" ? ".exe" : "";
  const gprPath = path.join(toolsDir, `gpr${extension}`);

  if (!fs.existsSync(gprPath)) {
    core.error("Could not find gpr after installation");
    throw new Error("gpr not found after installation");
  }

  return gprPath;
}

function installGprTool(toolsDir) {
  core.info("Installing gpr tool...");
  const result = spawnSync("dotnet", ["tool", "install", "gpr", "--tool-path", toolsDir], {
    stdio: "inherit",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    core.error("Failed to install gpr tool");
    throw new Error("Failed to install gpr");
  }
}

export function setupGpr(tempDir) {
  const toolsDir = path.join(tempDir, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  trackResource(toolsDir);

  installGprTool(toolsDir);
  const gprPath = getGprPath(toolsDir);

  core.info(`Successfully installed gpr at ${gprPath}`);
  return gprPath;
}
