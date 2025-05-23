import { execSync } from "child_process";
import { logError, logWarning, logInfo } from "../../shared/utils.js";

/**
 * Check Docker installation
 */
export function checkDockerInstallation() {
  try {
    execSync("docker --version", { stdio: "pipe" });
  } catch (err) {
    logError("Docker is not installed or not accessible");
    throw err;
  }
}

/**
 * Setup Skopeo by pulling Docker image
 */
export function setupSkopeo() {
  try {
    logInfo("Pulling skopeo Docker image...");
    execSync("docker pull quay.io/skopeo/stable:latest", { stdio: "inherit" });
    return true;
  } catch (err) {
    logError("Failed to pull Skopeo image");
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
      logError("Failed to authenticate with registry", packageName, reference);
    } else if (errorMsg.includes("not found")) {
      logWarning("Image not found", packageName, reference);
    } else {
      logError(`Skopeo command failed: ${err.message}`, packageName, reference);
    }
    return false;
  }
}
