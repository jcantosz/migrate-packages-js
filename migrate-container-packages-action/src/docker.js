import * as core from "@actions/core";
import { execSync } from "child_process";

/**
 * Check Docker installation
 */
export function checkDockerInstallation() {
  try {
    execSync("docker --version", { stdio: "pipe" });
  } catch (err) {
    core.error("Docker is not installed or not accessible");
    throw err;
  }
}

/**
 * Setup Skopeo by pulling Docker image
 */
export function setupSkopeo() {
  try {
    core.info("Pulling skopeo Docker image...");
    execSync("docker pull quay.io/skopeo/stable:latest", { stdio: "inherit" });
    return true;
  } catch (err) {
    core.error("Failed to pull Skopeo image");
    throw err;
  }
}

/**
 * Execute Skopeo command via Docker
 */
export function executeSkopeoCommand(skopeoCommand, packageName, reference) {
  const dockerCommand = `docker run -i --entrypoint /bin/bash quay.io/skopeo/stable:latest -c "${skopeoCommand}"`;

  try {
    execSync(dockerCommand, { stdio: "inherit" });
    return true;
  } catch (err) {
    const errorMsg = err.message.toLowerCase();
    if (errorMsg.includes("unauthorized")) {
      core.error("Failed to authenticate with registry", packageName, reference);
    } else if (errorMsg.includes("not found")) {
      core.warning("Image not found", packageName, reference);
    } else {
      core.error(`Skopeo command failed: ${err.message}`, packageName, reference);
    }
    return false;
  }
}
