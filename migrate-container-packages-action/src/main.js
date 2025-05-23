import * as core from "@actions/core";
import { parsePackagesInput, migratePackagesWithContext, setupContext } from "../../shared/utils.js";
import { checkDockerInstallation, setupSkopeo } from "./docker.js";
import { migratePackage } from "./migration.js";

/**
 * Main function
 */
export async function run() {
  try {
    core.info("Starting container package migration");
    const packagesJson = core.getInput("packages", { required: true });
    core.info("Parsing input packages");
    const packages = parsePackagesInput(packagesJson, "container");

    if (!packages.length) {
      core.info("No container packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    core.info(`Found ${packages.length} container packages to migrate`);

    // Set up required dependencies
    core.info("Checking Docker installation");
    checkDockerInstallation();
    core.info("Setting up Skopeo");
    if (!setupSkopeo()) {
      throw new Error("Failed to set up Skopeo. Migration cannot continue.");
    }

    // Set up migration context and execute migrations
    core.info("Setting up migration context");
    const context = setupContext(core, "container");
    core.info("Starting package migration");
    await migratePackagesWithContext(packages, context, migratePackage, "container");
    core.info("Container package migration completed");
  } catch (error) {
    core.error(`Action failed: ${error.message}`);
    core.setFailed(`Action failed: ${error.message}`);
  }
}
