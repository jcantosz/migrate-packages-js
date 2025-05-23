import fs from "fs";
import path from "path";
import { cleanupTempDir, trackResource } from "../../shared/utils.js";

export function setupVersionWorkspace(tempDir, packageName, version) {
  const versionDir = path.join(tempDir, `${packageName}-${version}`);

  if (fs.existsSync(versionDir)) {
    cleanupTempDir(versionDir);
  }

  fs.mkdirSync(versionDir, { recursive: true });
  return trackResource(versionDir);
}

export function resetWorkspace(versionDir) {
  cleanupTempDir(versionDir);
  fs.mkdirSync(versionDir, { recursive: true });
  trackResource(versionDir);
}
