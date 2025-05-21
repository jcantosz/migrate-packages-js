import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { getBaseHostname, createOctokitClient, outputResults } from "../../shared/utils.js";

const SKOPEO_RETRIES = 3;
/**
 * Get registry URL based on API URL or use custom registry URL if provided
 * @param {string} apiUrl - GitHub API URL (e.g., https://api.github.com)
 * @param {string|null} customRegistryUrl - Custom registry URL if provided
 * @returns {string} - Registry URL
 */
function getRegistryUrl(apiUrl, customRegistryUrl) {
  if (customRegistryUrl) {
    return customRegistryUrl;
  }

  const hostname = new URL(apiUrl).hostname;

  // Handle github.com case
  if (hostname === "api.github.com") {
    return "ghcr.io";
  }

  // Use the shared utility function to get the base hostname
  const baseDomain = getBaseHostname(apiUrl);
  return `containers.${baseDomain}`;
}

/**
 * Build full image reference
 * @param {string} registry - Registry URL
 * @param {string} org - Organization name
 * @param {string} packageName - Package name
 * @param {string} reference - Tag or digest reference
 * @param {boolean} isDigest - Whether reference is a digest or tag
 * @returns {string} - Full image reference
 */
function buildImageReference(registry, org, packageName, reference, isDigest) {
  const referencePrefix = isDigest ? "@" : ":";
  return `docker://${registry}/${org}/${packageName}${referencePrefix}${reference}`;
}

/**
 * Setup Skopeo by pulling Docker image
 * @returns {boolean} - True if setup was successful
 */
function setupSkopeo() {
  try {
    core.info("Pulling skopeo Docker image...");
    execSync("docker pull quay.io/skopeo/stable:latest", { stdio: "inherit" });
    return true;
  } catch (err) {
    core.error(`Failed to pull Skopeo image: ${err.message}`);
    return false;
  }
}

/**
 * Check Docker installation
 * @throws {Error} If Docker is not installed
 */
function checkDockerInstallation() {
  try {
    execSync("docker --version", { stdio: "pipe" });
  } catch (err) {
    throw new Error(
      "Docker is not installed or not accessible. Docker is required for container migration with Skopeo."
    );
  }
}

/**
 * Execute Skopeo command via Docker
 * @param {string} skopeoCommand - Skopeo command to execute
 */
function executeSkopeoCommand(skopeoCommand) {
  const dockerCommand = `docker run -i --entrypoint /bin/bash quay.io/skopeo/stable:latest -c "${skopeoCommand}"`;
  execSync(dockerCommand, { stdio: "inherit" });
}

/**
 * Migrate a single container image reference (tag or digest)
 * @param {string} packageName - Name of the package
 * @param {string} reference - Tag or SHA reference
 * @param {object} context - Migration context
 * @param {boolean} isDigest - Whether the reference is a digest (SHA) or tag
 * @returns {boolean} - Success status
 */
async function migrateImageReference(packageName, reference, context, isDigest) {
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

  try {
    // Determine registries and build image references
    const sourceRegistry = getRegistryUrl(sourceApiUrl, sourceRegistryUrl);
    const targetRegistry = getRegistryUrl(targetApiUrl, targetRegistryUrl);

    // Build source and target image references
    const sourceImage = buildImageReference(sourceRegistry, sourceOrg, packageName, reference, isDigest);
    const targetImage = buildImageReference(targetRegistry, targetOrg, packageName, reference, isDigest);

    const referenceType = isDigest ? "digest" : "tag";
    const referencePrefix = isDigest ? "@" : ":";
    core.info(`Migrating ${packageName}${referencePrefix}${reference} (${referenceType})`);

    // Build and execute Skopeo command
    const skopeoCommand = `skopeo copy --preserve-digests --all --retry-times ${SKOPEO_RETRIES} --src-creds USERNAME:${ghSourcePat} --dest-creds USERNAME:${ghTargetPat} ${sourceImage} ${targetImage}`;

    executeSkopeoCommand(skopeoCommand);

    core.info(`Successfully migrated ${packageName}${referencePrefix}${reference}`);
    return true;
  } catch (err) {
    core.warning(`Failed to migrate ${packageName}${referencePrefix}${reference}: ${err.message}`);
    return false;
  }
}

/**
 * Fetch all versions (digests/SHAs) for a container package
 * @param {Octokit} octokit - Authenticated Octokit instance
 * @param {string} org - Organization name
 * @param {string} packageName - Package name
 * @returns {Array} - List of versions
 */
async function fetchVersions(octokit, org, packageName) {
  try {
    const versions = await octokit.paginate("GET /orgs/{org}/packages/container/{package_name}/versions", {
      org,
      package_name: packageName,
      per_page: 100,
    });
    core.info(`Found ${versions.length} versions for package ${packageName}`);
    return versions;
  } catch (err) {
    core.warning(`Error fetching versions for container package ${packageName}: ${err.message}`);
    return [];
  }
}

/**
 * Migrate all digests (SHAs) for a package
 * @param {string} packageName - Package name
 * @param {Array} versions - List of versions
 * @param {Object} context - Migration context
 * @returns {Object} - Success and failure counts
 */
async function migrateDigests(packageName, versions, context) {
  let successCount = 0;
  let failureCount = 0;

  core.info(`Copying all image digests for ${packageName}`);
  for (const version of versions) {
    const digestReference = version.name; // This is the SHA/digest

    // Migrate the digest
    const success = await migrateImageReference(packageName, digestReference, context, true);
    if (success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  return { successCount, failureCount };
}

/**
 * Migrate all tags for a package
 * @param {string} packageName - Package name
 * @param {Array} versions - List of versions
 * @param {Object} context - Migration context
 * @returns {Object} - Success and failure counts
 */
async function migrateTags(packageName, versions, context) {
  let successCount = 0;
  let failureCount = 0;

  core.info(`Copying all image tags for ${packageName}`);
  for (const version of versions) {
    // Get all tags for this version (if any)
    const tags = version.metadata?.container?.tags || [];

    for (const tag of tags) {
      // Migrate the tag
      const success = await migrateImageReference(packageName, tag, context, false);
      if (success) {
        successCount++;
      } else {
        failureCount++;
      }
    }
  }

  return { successCount, failureCount };
}

/**
 * Migrate a single container package with all its tags and digests
 * @param {Object} pkg - Package object
 * @param {Object} context - Migration context
 * @returns {Object} - Migration result
 */
async function migratePackage(pkg, context) {
  const { octokitSource, sourceOrg } = context;
  const packageName = pkg.name;
  const repoName = pkg.repository?.name || "unknown";

  core.info(`Migrating container package: ${packageName} from repo: ${repoName}`);

  // Get all versions for this container package
  const versions = await fetchVersions(octokitSource, sourceOrg, packageName);

  if (versions.length === 0) {
    core.warning(`No versions found for package ${packageName}`);
    return {
      package: packageName,
      digestsSucceeded: 0,
      digestsFailed: 0,
      tagsSucceeded: 0,
      tagsFailed: 0,
      succeeded: 0, // Standard property for shared utilities
      failed: 0, // Standard property for shared utilities
      skipped: true,
      reason: "No versions found",
    };
  }

  // First copy all image digests (SHAs)
  const digestResults = await migrateDigests(packageName, versions, context);

  // Then copy all image tags
  const tagResults = await migrateTags(packageName, versions, context);

  // Calculate total success and failure counts
  const totalSucceeded = digestResults.successCount + tagResults.successCount;
  const totalFailed = digestResults.failureCount + tagResults.failureCount;

  return {
    package: packageName,
    digestsSucceeded: digestResults.successCount,
    digestsFailed: digestResults.failureCount,
    tagsSucceeded: tagResults.successCount,
    tagsFailed: tagResults.failureCount,
    succeeded: totalSucceeded, // Standard property for shared utilities
    failed: totalFailed, // Standard property for shared utilities
  };
}

/**
 * Parse packages input from JSON
 * @param {string} packagesJson - JSON string
 * @returns {Array} - Parsed packages
 */
function parsePackagesInput(packagesJson) {
  try {
    const packages = JSON.parse(packagesJson);
    core.info(`Found ${packages.length} container packages to migrate`);
    return packages;
  } catch (err) {
    throw new Error(`Invalid packages input: ${err.message}`);
  }
}

/**
 * Main function
 */
async function run() {
  try {
    // Get action inputs
    const sourceOrg = core.getInput("source-org", { required: true });
    const sourceApiUrl = core.getInput("source-api-url", { required: true });
    const sourceRegistryUrl = core.getInput("source-registry-url", { required: false });
    const targetOrg = core.getInput("target-org", { required: true });
    const targetApiUrl = core.getInput("target-api-url", { required: true });
    const targetRegistryUrl = core.getInput("target-registry-url", { required: false });
    const ghSourcePat = core.getInput("gh-source-pat", { required: true });
    const ghTargetPat = core.getInput("gh-target-pat", { required: true });

    // Parse packages input
    const packagesJson = core.getInput("packages", { required: true });
    const packages = parsePackagesInput(packagesJson);

    if (packages.length === 0) {
      core.info("No container packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    // Check prerequisites
    checkDockerInstallation();
    if (!setupSkopeo()) {
      throw new Error("Failed to set up Skopeo. Migration cannot continue.");
    }

    // Set up Octokit client using the shared utility function
    const octokitSource = createOctokitClient(ghSourcePat, sourceApiUrl);

    // Prepare context with all configuration
    const context = {
      octokitSource,
      sourceOrg,
      sourceApiUrl,
      sourceRegistryUrl,
      targetOrg,
      targetApiUrl,
      targetRegistryUrl,
      ghSourcePat,
      ghTargetPat,
    };

    // Migrate all packages
    const results = [];
    for (const pkg of packages) {
      const result = await migratePackage(pkg, context);
      results.push(result);
    }

    // Output results using the shared utility function
    outputResults(results, "container");
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
