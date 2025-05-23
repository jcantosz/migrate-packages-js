import * as core from "@actions/core";
import fs from "fs";
import path from "path";
import os from "os";
import { trackResource } from "../../shared/utils.js";

export function setupEnvironment() {
  const tempDir = path.join(os.tmpdir(), `nuget-migrate-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  core.info(`Created temp directory: ${tempDir}`);
  return trackResource(tempDir);
}

export function setupVersionWorkspace(tempDir, packageName, version) {
  const versionDir = path.join(tempDir, `${packageName}-${version}`);
  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.mkdirSync(versionDir, { recursive: true });
  return trackResource(versionDir);
}
