import * as core from "@actions/core";
import { parsePackagesInput, migratePackagesWithContext, setupContext } from "../../shared/utils.js";
import { checkDockerInstallation, setupSkopeo } from "./docker.js";
import { migratePackage } from "./migration.js";

/**
 * Main function
 */
export async function run() {
  try {
    core.startGroup("Container Package Migration");
    core.info("Starting container package migration");
    
    // Parse and validate input
    const packagesJson = core.getInput("packages", { required: true });
    core.info("Parsing input packages");
    core.debug(`Packages JSON: ${packagesJson}`);
    
    const packages = parsePackagesInput(packagesJson, "container");
    core.info(`Found ${packages.length} packages to process`);

    if (!packages.length) {
      core.notice("No container packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      core.endGroup();
      return;
    }

    // Set up dependencies
    core.startGroup("Setting up dependencies");
    core.info("Checking Docker installation");
    checkDockerInstallation();
    
    core.info("Setting up Skopeo");
    if (!setupSkopeo()) {
      throw new Error("Failed to set up Skopeo. Migration cannot continue.");
    }
    core.endGroup();

    // Execute migration
    core.startGroup("Executing Migration");
    core.info("Setting up migration context");
    const context = setupContext(core, "container");
    
    core.info("Starting package migration");
    const results = await migratePackagesWithContext(packages, context, migratePackage, "container");

    // Log final summary
    core.info("Migration completed");
    core.info("Results summary:");
    core.info(JSON.stringify(results, null, 2));
    
    // Set outputs
    core.setOutput("result", JSON.stringify(results));
    core.endGroup();
    
    core.startGroup("Final Status");
    const totalSuccess = results.reduce((sum, r) => sum + (r.succeeded || 0), 0);
    const totalFailed = results.reduce((sum, r) => sum + (r.failed || 0), 0);
    core.info(`Total packages processed: ${results.length}`);
    core.info(`Total successful operations: ${totalSuccess}`);
    core.info(`Total failed operations: ${totalFailed}`);
    core.endGroup();

  } catch (error) {
    core.error(`Action failed: ${error.message}`);
    if (error.stack) {
      core.debug(`Stack trace: ${error.stack}`);
    }
    core.setFailed(error.message);
  }
}
