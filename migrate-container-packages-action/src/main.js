import * as core from "@actions/core";
import { parsePackagesInput, migratePackagesWithContext, setupContext } from "../../shared/utils.js";
import { checkDockerInstallation, setupSkopeo } from "./docker.js";
import { migratePackage } from "./migration.js";

/**
 * Main function
 */
export async function run() {
  try {
    core.debug("Parsing packages input");
    const packagesJson = core.getInput("packages", { required: true });
    const packages = parsePackagesInput(packagesJson, "container");

    if (!packages.length) {
      core.info("No container packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    // Set up required dependencies
    core.debug("Checking requirements");
    checkDockerInstallation();
    if (!setupSkopeo()) {
      throw new Error("Failed to set up Skopeo. Migration cannot continue.");
    }

    // Set up migration context and execute migrations
    const context = setupContext(core, "container");
    core.debug("Migrating packages");
    await migratePackagesWithContext(packages, context, migratePackage, "container");
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}
