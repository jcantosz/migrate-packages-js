import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";
import pRetry from "p-retry";

/**
 * Shared utilities for package migration actions
 */

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
 * @param {number} options.retries - Maximum number of retries (default: 3)
 * @param {number} options.minTimeout - Minimum timeout between retries in ms (default: 1000)
 * @param {number} options.maxTimeout - Maximum timeout between retries in ms (default: 10000)
 * @param {Function} options.onRetry - Function called on retry with error and attempt count
 * @returns {Promise<any>} - Result of the operation
 */
export async function withRetry(operation, options = {}) {
  const {
    retries = 3,
    minTimeout = 1000,
    maxTimeout = 10000,
    onRetry = (error, attempt) => core.info(`Retry attempt ${attempt} after error: ${error.message}`),
  } = options;

  return pRetry(operation, {
    retries,
    minTimeout,
    maxTimeout,
    onFailedAttempt: (error) => {
      const attempt = error.attemptNumber;
      onRetry(error, attempt);
      core.info(`Attempt ${attempt} failed. ${error.retriesLeft} retries left.`);
    },
  });
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
 * Fetch all versions for a package
 */
export async function fetchVersions(octokitClient, org, packageName, packageType) {
  try {
    // Different package types have different version fetching logic
    switch (packageType.toLowerCase()) {
      case "npm":
        const npmResult = await octokitClient.packages.getAllPackageVersionsForPackageOwnedByOrg({
          package_type: "npm",
          package_name: packageName,
          org: org,
        });
        return npmResult.data;

      case "nuget":
        const nugetResult = await octokitClient.packages.getAllPackageVersionsForPackageOwnedByOrg({
          package_type: "nuget",
          package_name: packageName,
          org: org,
        });
        return nugetResult.data;

      case "container":
        const containerResult = await octokitClient.packages.getAllPackageVersionsForPackageOwnedByOrg({
          package_type: "container",
          package_name: packageName,
          org: org,
        });
        return containerResult.data;

      default:
        throw new Error(`Unsupported package type: ${packageType}`);
    }
  } catch (error) {
    console.error(`Error fetching versions for ${packageName}: ${error.message}`);
    return [];
  }
}

/**
 * Clean up a temporary directory
 */
export function cleanupTempDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
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
  const tempDir = path.join(basePath, "temp");
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });
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
