import * as core from "@actions/core";
import { execSync } from "child_process";
import {
  withRetry,
  parsePackagesInput,
  fetchPackageVersions,
  createPackageResult,
  getRegistryUrl,
  migratePackagesWithContext,
  setupContext,
} from "../../shared/utils.js";

/**
 * Build full image reference
 */
function buildImageReference(registry, org, packageName, reference, isDigest) {
  const separator = isDigest ? "@" : ":";
  return `${registry}/${org}/${packageName}${separator}${reference}`;
}

/**
 * Setup Skopeo by pulling Docker image
 */
function setupSkopeo() {
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
 * Check Docker installation
 */
function checkDockerInstallation() {
  try {
    execSync("docker --version", { stdio: "pipe" });
  } catch (err) {
    core.error("Docker is not installed or not accessible");
    throw err;
  }
}

// Helper functions to reduce repetition and nesting
function logError(message, packageName, reference) {
  core.error(`${message} for ${packageName}:${reference}`);
}

function logWarning(message, packageName, reference) {
  core.warning(`${message} for ${packageName}:${reference}`);
}

function buildSkipResult(packageName) {
  return createPackageResult(packageName, 0, 0, {
    skipped: true,
    reason: "No versions found",
    digestsSucceeded: 0,
    digestsFailed: 0,
    tagsSucceeded: 0,
    tagsFailed: 0,
  });
}

/**
 * Execute Skopeo command via Docker
 */
function executeSkopeoCommand(skopeoCommand, packageName, reference) {
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

/**
 * Parse versions into tags and digests
 */
function parseVersions(versions) {
  const references = [];

  for (const version of versions) {
    references.push({
      reference: version.name,
      isDigest: true,
    });

    const tags = version.metadata?.container?.tags || [];
    references.push(
      ...tags.map((tag) => ({
        reference: tag,
        isDigest: false,
      }))
    );
  }

  return references;
}

/**
 * Performs the actual image migration operation
 */
function performImageMigration(packageName, reference, context, isDigest) {
  const {
    sourceOrg,
    sourceApiUrl,
    sourceRegistryUrl,
    targetOrg,
    targetApiUrl,
    targetRegistryUrl,
    ghSourcePat,
    ghTargetPat,
  } = context;

  const sourceRegistry = getRegistryUrl("container", sourceApiUrl, sourceRegistryUrl);
  const targetRegistry = getRegistryUrl("container", targetApiUrl, targetRegistryUrl);

  const sourceImage = buildImageReference(sourceRegistry, sourceOrg, packageName, reference, isDigest);
  const targetImage = buildImageReference(targetRegistry, targetOrg, packageName, reference, isDigest);

  const referencePrefix = isDigest ? "@" : ":";
  core.info(`Migrating ${packageName}${referencePrefix}${reference}`);

  const skopeoCommand = `skopeo copy --preserve-digests --all --src-creds USERNAME:${ghSourcePat} --dest-creds USERNAME:${ghTargetPat} ${sourceImage} ${targetImage}`;

  const success = executeSkopeoCommand(skopeoCommand, packageName, reference);

  if (success) {
    core.info(`Successfully migrated ${packageName}${referencePrefix}${reference}`);
  }

  return success;
}

/**
 * Track migration results for a single reference
 */
function updateReferenceResults(results, success, isDigest) {
  success ? results.successCount++ : results.failureCount++;
  if (success) {
    isDigest ? results.digestsSucceeded++ : results.tagsSucceeded++;
  } else {
    isDigest ? results.digestsFailed++ : results.tagsFailed++;
  }
}

/**
 * Migrate a container package's references (both tags and digests)
 */
async function migrateReferences(packageName, references, context) {
  const results = {
    successCount: 0,
    failureCount: 0,
    digestsSucceeded: 0,
    digestsFailed: 0,
    tagsSucceeded: 0,
    tagsFailed: 0,
  };

  for (const { reference, isDigest } of references) {
    const success = await withRetry(() => performImageMigration(packageName, reference, context, isDigest), {
      onRetry: (error, attempt) => {
        const referenceType = isDigest ? "digest" : "tag";
        const referencePrefix = isDigest ? "@" : ":";

        core.info(
          `Retry attempt ${attempt} for ${packageName}${referencePrefix}${reference} (${referenceType}). Error: ${error.message}`
        );
        core.debug(`Error details: ${JSON.stringify({ isDigest, attempt }, null, 2)}`);
      },
    });

    updateReferenceResults(results, success, isDigest);
  }

  return results;
}

/**
 * Migrate a single container package with all its tags and digests
 */
async function migratePackage(pkg, context) {
  const { octokitSource, sourceOrg } = context;
  const packageName = pkg.name;
  const repoName = pkg.repository?.name || "unknown";

  core.info(`Migrating container package: ${packageName} from repo: ${repoName}`);

  const versions = await fetchPackageVersions(octokitSource, sourceOrg, packageName, "container");
  if (!versions.length) {
    return buildSkipResult(packageName);
  }

  const references = parseVersions(versions);
  const results = await migrateReferences(packageName, references, context);

  return createPackageResult(packageName, results.successCount, results.failureCount, {
    digestsSucceeded: results.digestsSucceeded,
    digestsFailed: results.digestsFailed,
    tagsSucceeded: results.tagsSucceeded,
    tagsFailed: results.tagsFailed,
  });
}

/**
 * Main function
 */
async function run() {
  try {
    const packagesJson = core.getInput("packages", { required: true });
    const packages = parsePackagesInput(packagesJson, "container");

    if (!packages.length) {
      core.info("No container packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    checkDockerInstallation();
    if (!setupSkopeo()) {
      throw new Error("Failed to set up Skopeo. Migration cannot continue.");
    }

    const context = setupContext(core, "container");
    await migratePackagesWithContext(packages, context, migratePackage, "container");
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
