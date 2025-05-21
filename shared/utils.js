import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";
import pRetry from "p-retry";
import * as errors from "./errors.js";

/**
 * Shared utilities for package migration actions
 */

// Enhanced retry configuration
const DEFAULT_RETRY_CONFIG = {
  retries: 3,
  minTimeout: 1000,
  maxTimeout: 10000,
  factor: 2,
  retryableErrors: [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EADDRNOTAVAIL",
  ],
};

/**
 * Get common inputs from GitHub Actions core
 */
export function getCommonInputs(core) {
  const sourceOrg = core.getInput("source-org", { required: true });
  const sourceApiUrl = core.getInput("source-api-url", { required: true });
  const sourceRegistryUrl = core.getInput("source-registry-url", { required: false });
  const targetOrg = core.getInput("target-org", { required: true });
  const targetApiUrl = core.getInput("target-api-url", { required: true });
  const targetRegistryUrl = core.getInput("target-registry-url", { required: false });
  const ghSourcePat = core.getInput("gh-source-pat", { required: true });
  const ghTargetPat = core.getInput("gh-target-pat", { required: true });

  return {
    sourceOrg,
    sourceApiUrl,
    sourceRegistryUrl,
    targetOrg,
    targetApiUrl,
    targetRegistryUrl,
    ghSourcePat,
    ghTargetPat,
  };
}

/**
 * Retry an operation with exponential backoff using p-retry
 * @param {Function} operation - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise<any>} - Result of the operation
 */
export async function withRetry(operation, options = {}) {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options };

  return pRetry(
    async () => {
      try {
        return await operation();
      } catch (error) {
        // Don't retry authentication or not found errors
        if (error instanceof errors.AuthenticationError || error instanceof errors.PackageNotFoundError) {
          throw new pRetry.AbortError(error.message);
        }
        throw error;
      }
    },
    {
      ...config,
      onFailedAttempt: (error) => {
        const attempt = error.attemptNumber;
        if (config.onRetry) {
          config.onRetry(error, attempt);
        }
        core.info(`Attempt ${attempt} failed. ${error.retriesLeft} retries left.`);

        // Log detailed error information
        core.debug(
          `Error details: ${JSON.stringify(
            {
              name: error.name,
              code: error.code,
              statusCode: error.statusCode,
              message: error.message,
            },
            null,
            2
          )}`
        );
      },
    }
  );
}

/**
 * Parse packages input from JSON string
 */
export function parsePackagesInput(packagesJson, packageType) {
  try {
    const pkgObjects = JSON.parse(packagesJson);
    if (!Array.isArray(pkgObjects)) {
      throw new Error(`Packages input is not an array for ${packageType} migration`);
    }

    // Filter for the specified package type if provided
    if (packageType) {
      return pkgObjects.filter((pkg) => pkg.type?.toLowerCase() === packageType.toLowerCase() || !pkg.type);
    }

    return pkgObjects;
  } catch (error) {
    throw new Error(`Failed to parse packages input: ${error.message}`);
  }
}

/**
 * Create an Octokit client
 */
export function createOctokitClient(token, apiUrl) {
  return new Octokit({
    auth: token,
    baseUrl: apiUrl,
  });
}

/**
 * Derive npm registry URL from API URL or use custom registry URL
 */
export function getNpmRegistryUrl(apiUrl, customRegistryUrl) {
  if (customRegistryUrl) {
    return customRegistryUrl;
  }

  // Extract the domain from API URL
  const url = new URL(apiUrl);
  const hostname = url.hostname;

  // Handle github.com case
  if (hostname === "api.github.com") {
    return "https://npm.pkg.github.com";
  }

  // Handle GitHub Data Residency case with subdomain pattern: api.SUBDOMAIN.ghe.com
  if (hostname.startsWith("api.")) {
    // Remove the "api." prefix to get the base domain
    const baseDomain = hostname.substring(4);
    return `https://npm.${baseDomain}`;
  }

  // Fallback for other patterns
  return `https://npm.${hostname}`;
}

/**
 * Derive NuGet registry URL from API URL or use custom registry URL
 */
export function getNuGetRegistryUrl(apiUrl, customRegistryUrl) {
  if (customRegistryUrl) {
    return customRegistryUrl;
  }

  // Extract the domain from API URL
  const url = new URL(apiUrl);
  const hostname = url.hostname;

  // Handle github.com case
  if (hostname === "api.github.com") {
    return "https://nuget.pkg.github.com";
  }

  // Handle GitHub Data Residency case with subdomain pattern: api.SUBDOMAIN.ghe.com
  if (hostname.startsWith("api.")) {
    // Remove the "api." prefix to get the base domain
    const baseDomain = hostname.substring(4);
    return `https://nuget.${baseDomain}`;
  }

  // Fallback for other patterns
  return `https://nuget.${hostname}`;
}

/**
 * Get registry URL for any package type based on API URL or use custom registry URL
 * @param {string} packageType - Type of package (npm, nuget, container)
 * @param {string} apiUrl - GitHub API URL
 * @param {string|null} customRegistryUrl - Custom registry URL if provided
 * @returns {string} - Registry URL
 */
export function getRegistryUrl(packageType, apiUrl, customRegistryUrl) {
  if (customRegistryUrl) return customRegistryUrl;

  switch (packageType.toLowerCase()) {
    case "npm":
      return getNpmRegistryUrl(apiUrl);
    case "nuget":
      return getNuGetRegistryUrl(apiUrl);
    case "container":
      const hostname = new URL(apiUrl).hostname;
      if (hostname === "api.github.com") {
        return "ghcr.io";
      }
      const baseDomain = getBaseHostname(apiUrl);
      return `containers.${baseDomain}`;
    default:
      throw new Error(`Unsupported package type: ${packageType}`);
  }
}

/**
 * Extract the base hostname from an API URL
 * @param {string} apiUrl - The API URL to extract the hostname from
 * @returns {string} - The base hostname without any "api." prefix
 */
export function getBaseHostname(apiUrl) {
  const url = new URL(apiUrl);
  const hostname = url.hostname;

  // Remove "api." prefix if present
  if (hostname.startsWith("api.")) {
    return hostname.substring(4);
  }

  return hostname;
}

/**
 * Fetch package versions for any package type
 * @param {Object} octokitClient - Authenticated Octokit instance
 * @param {string} org - Organization name
 * @param {string} packageName - Package name
 * @param {string} packageType - Type of package (npm, nuget, container)
 * @returns {Array} - List of versions
 */
export async function fetchPackageVersions(octokitClient, org, packageName, packageType) {
  try {
    // Build the API path directly using the packageType
    const apiPath = `GET /orgs/{org}/packages/${packageType.toLowerCase()}/{package_name}/versions`;

    const versions = await octokitClient.paginate(apiPath, {
      org,
      package_name: packageName,
      per_page: 100,
    });

    core.info(`Found ${versions.length} versions for package ${packageName}`);
    return versions;
  } catch (err) {
    core.warning(`Error fetching versions for ${packageType} package ${packageName}: ${err.message}`);
    return [];
  }
}

/**
 * Create a standardized package result object
 * @param {string} packageName - Name of the package
 * @param {number} succeeded - Count of successfully migrated versions
 * @param {number} failed - Count of failed migrations
 * @param {Object} options - Additional result options
 * @returns {Object} - Standardized result object
 */
export function createPackageResult(packageName, succeeded = 0, failed = 0, options = {}) {
  const result = {
    package: packageName,
    succeeded,
    failed,
  };

  // Add skipped status if specified
  if (options.skipped) {
    result.skipped = true;
    result.reason = options.reason || "No versions found";
  }

  // Add container-specific properties if provided
  if (options.digestsSucceeded !== undefined) {
    result.digestsSucceeded = options.digestsSucceeded;
    result.digestsFailed = options.digestsFailed || 0;
  }

  if (options.tagsSucceeded !== undefined) {
    result.tagsSucceeded = options.tagsSucceeded;
    result.tagsFailed = options.tagsFailed || 0;
  }

  return result;
}

/**
 * Fetch all versions for a package
 */
export async function fetchVersions(octokitClient, org, packageName, packageType) {
  try {
    // Use the new unified version fetching function
    return await fetchPackageVersions(octokitClient, org, packageName, packageType);
  } catch (error) {
    console.error(`Error fetching versions for ${packageName}: ${error.message}`);
    return [];
  }
}

/**
 * Resource tracking for temporary files and directories
 */
const resources = new Set();

// Set up cleanup handlers
process.on("exit", () => cleanupAllResources());
process.on("SIGINT", () => {
  cleanupAllResources();
  process.exit(1);
});
process.on("SIGTERM", () => {
  cleanupAllResources();
  process.exit(1);
});

/**
 * Track a resource for cleanup
 */
export function trackResource(resource) {
  resources.add(resource);
  return resource; // Return for easy chaining
}

/**
 * Clean up a resource and remove it from tracking
 */
export function cleanupResource(resource) {
  if (fs.existsSync(resource)) {
    fs.rmSync(resource, { recursive: true, force: true });
  }
  resources.delete(resource);
}

/**
 * Clean up all tracked resources
 */
export function cleanupAllResources() {
  for (const resource of resources) {
    cleanupResource(resource);
  }
}

/**
 * Clean up a temporary directory
 */
export function cleanupTempDir(dirPath) {
  cleanupResource(dirPath);
}

/**
 * Output results to GitHub Actions
 */
export function outputResults(results, packageType) {
  // Calculate totals once
  const totals = {
    packages: results.length,
    success: results.reduce((acc, r) => acc + (r.succeeded || 0), 0),
    failed: results.reduce((acc, r) => acc + (r.failed || 0), 0),
    skipped: results.filter((r) => r.skipped).length,
  };

  // Log summary to console
  core.info(`\n=== ${packageType.toUpperCase()} Migration Summary ===`);
  core.info(`Total packages processed: ${totals.packages}`);
  core.info(`Successful version migrations: ${totals.success}`);
  core.info(`Failed version migrations: ${totals.failed}`);

  // For container packages, also calculate digest and tag totals
  if (packageType.toLowerCase() === "container") {
    totals.digestsSucceeded = results.reduce((acc, r) => acc + (r.digestsSucceeded || 0), 0);
    totals.digestsFailed = results.reduce((acc, r) => acc + (r.digestsFailed || 0), 0);
    totals.tagsSucceeded = results.reduce((acc, r) => acc + (r.tagsSucceeded || 0), 0);
    totals.tagsFailed = results.reduce((acc, r) => acc + (r.tagsFailed || 0), 0);
    core.info(`Successful digest migrations: ${totals.digestsSucceeded}`);
    core.info(`Failed digest migrations: ${totals.digestsFailed}`);
    core.info(`Successful tag migrations: ${totals.tagsSucceeded}`);
    core.info(`Failed tag migrations: ${totals.tagsFailed}`);
  }

  // Generate both GitHub markdown summary and plain text summary
  const summary = generateActionSummary(results, packageType, totals);

  if (totals.skipped > 0) {
    core.info(`Skipped packages: ${totals.skipped}`);
  }
  core.info(summary);

  // Set output
  core.setOutput("result", JSON.stringify(results));
  core.setOutput("result-summary", summary);

  // Set job status based on results
  if (totals.failed > 0 && totals.success === 0) {
    core.setFailed(`All ${packageType} package migrations failed`);
  } else if (totals.failed > 0) {
    core.warning(`Some ${packageType} package migrations failed`);
  }
}

/**
 * Generate a GitHub Actions summary using core.summary and return the text summary
 * @param {Array} results - Migration results
 * @param {string} packageType - Type of package (npm, nuget, container)
 * @param {Object} totals - Pre-calculated totals
 * @returns {string} - Text summary for console output and action outputs
 */
function generateActionSummary(results, packageType, totals) {
  // Start building the GitHub summary
  core.summary
    .addHeading(`${packageType.toUpperCase()} Package Migration`, 2)
    .addRaw("Migration completed.")
    .addBreak()
    .addBreak();

  // Add statistics table
  core.summary
    .addTable([
      [
        { data: "Statistics", header: true },
        { data: "Count", header: true },
      ],
      ["Total Packages", totals.packages.toString()],
      ["Versions Succeeded", totals.success.toString()],
      ["Versions Failed", totals.failed.toString()],
      ["Packages Skipped", totals.skipped.toString()],
    ])
    .addBreak();

  // Add results list with core.summary.addList
  core.summary.addHeading("Per-Package Results:", 3);

  // Create an array of formatted results for both markdown and plaintext output
  // using strong tags instead of ** because the latter gets printed as a literal
  const resultItems = results.map((r) => {
    if (r.skipped) {
      return `<strong>${r.package}</strong>: SKIPPED (${r.reason || "No reason provided"})`;
    } else if (packageType.toLowerCase() === "container" && r.digestsSucceeded !== undefined) {
      // For container packages, show breakdown of digests and tags
      const digestsTotal = (r.digestsSucceeded || 0) + (r.digestsFailed || 0);
      const tagsTotal = (r.tagsSucceeded || 0) + (r.tagsFailed || 0);
      return `<strong>${r.package}</strong>: ${r.succeeded} versions succeeded, ${r.failed} versions failed (${r.digestsSucceeded} of ${digestsTotal} digests, ${r.tagsSucceeded} of ${tagsTotal} tags)`;
    } else {
      return `<strong>${r.package}</strong>: ${r.succeeded} versions succeeded, ${r.failed} versions failed`;
    }
  });

  // Add the list to the summary (GitHub will render the markdown)
  core.summary.addList(resultItems);

  // Write the summary to the output
  core.summary.write();

  // Build text summary by joining the result items with newlines
  // Markdown is still readable as plain text
  const textSummary = "Migration completed. Summary:\n" + resultItems.join("\n");

  // Return the text summary for console output and action outputs
  return textSummary;
}

/**
 * Create a temporary directory for processing
 */
export function createTempDir(basePath = process.cwd()) {
  const tempDir = path.join(basePath, `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  // Track the temporary directory
  trackResource(tempDir);

  return tempDir;
}

/**
 * Format package name based on org and type
 */
export function formatPackageName(packageName, org, packageType) {
  switch (packageType.toLowerCase()) {
    case "npm":
      return `@${org}/${packageName}`;
    case "nuget":
      return packageName;
    case "container":
      return `${org}/${packageName}`;
    default:
      return packageName;
  }
}

/**
 * Common function for migrating packages with a given migration strategy
 * @param {Array} packages - List of packages to migrate
 * @param {Object} context - Migration context with all necessary configuration
 * @param {Function} migratePackageFn - The package-specific migration function
 * @param {string} packageType - Type of packages (npm, nuget, container)
 * @returns {Array} - Migration results
 */
export async function migratePackagesWithContext(packages, context, migratePackageFn, packageType) {
  try {
    if (packages.length === 0) {
      core.info(`No ${packageType} packages to migrate`);
      core.setOutput("result", JSON.stringify([]));
      return [];
    }

    // Migrate all packages with the provided strategy
    const results = [];
    for (const pkg of packages) {
      const result = await migratePackageFn(pkg, context);
      results.push(result);
    }

    // Output results using the shared utility
    outputResults(results, packageType);

    return results;
  } catch (error) {
    core.setFailed(`Migration failed: ${error.message}`);
    return [];
  }
}

/**
 * Setup a complete migration context with common inputs, Octokit client, and registry URLs
 * @param {Object} core - GitHub Actions core
 * @param {string} packageType - Type of package (npm, nuget, container)
 * @param {Object} additionalInputs - Additional inputs to include in the context
 * @returns {Object} - Complete context object for migration
 */
export function setupContext(core, packageType, additionalInputs = {}) {
  // Get common inputs first
  const commonInputs = getCommonInputs(core);

  // Create Octokit client
  const octokitSource = createOctokitClient(commonInputs.ghSourcePat, commonInputs.sourceApiUrl);

  // Determine registry URLs for source and target
  const sourceRegistryUrl = getRegistryUrl(packageType, commonInputs.sourceApiUrl, commonInputs.sourceRegistryUrl);

  const targetRegistryUrl = getRegistryUrl(packageType, commonInputs.targetApiUrl, commonInputs.targetRegistryUrl);

  // Create and return the complete context object
  return {
    ...commonInputs,
    octokitSource,
    sourceRegistryUrl,
    targetRegistryUrl,
    packageType,
    ...additionalInputs,
  };
}
