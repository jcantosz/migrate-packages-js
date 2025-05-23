import * as core from "@actions/core";
import { execSync } from "child_process";

/**
 * Check Docker installation
 */
export function checkDockerInstallation() {
  try {
    execSync("docker --version", { stdio: "pipe" });
    core.info("Docker installation verified");
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
    core.info("Successfully pulled Skopeo image");
    return true;
  } catch (err) {
    core.error(`Failed to pull Skopeo image: ${err.message}`);
    throw err;
  }
}

/**
 * Execute Skopeo command via Docker
 */
export function executeSkopeoCommand(skopeoCommand, packageName, reference) {
  const dockerCommand = `docker run -i --entrypoint /bin/bash quay.io/skopeo/stable:latest -c "${skopeoCommand}"`;
  core.debug(`Executing command: ${dockerCommand}`);

  try {
    core.info(`Starting migration for ${packageName} with reference ${reference}`);
    const output = execSync(dockerCommand, { stdio: "pipe" }).toString();
    core.info(`Skopeo command output: ${output}`);
    return true;
  } catch (err) {
    const errorMsg = err.message.toLowerCase();
    const errorOutput = err.stderr ? err.stderr.toString() : err.message;

    if (errorMsg.includes("unauthorized")) {
      core.error(`Failed to authenticate with registry for ${packageName}:${reference}`);
      core.error(`Error details: ${errorOutput}`);
    } else if (errorMsg.includes("not found")) {
      core.warning(`Image not found: ${packageName}:${reference}`);
      core.warning(`Error details: ${errorOutput}`);
    } else {
      core.error(`Skopeo command failed for ${packageName}:${reference}`);
      core.error(`Error details: ${errorOutput}`);
    }
    return false;
  }
}
