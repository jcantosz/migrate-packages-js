import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";

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
  // Calculate totals
  const totalPackages = results.length;
  const totalSuccess = results.reduce((acc, r) => acc + r.succeeded, 0);
  const totalFailed = results.reduce((acc, r) => acc + r.failed, 0);
  const totalSkipped = results.filter((r) => r.skipped).length;

  // Log summary
  core.info(`\n=== ${packageType.toUpperCase()} Migration Summary ===`);
  core.info(`Total packages processed: ${totalPackages}`);
  core.info(`Successful version migrations: ${totalSuccess}`);
  core.info(`Failed version migrations: ${totalFailed}`);
  if (totalSkipped > 0) {
    core.info(`Skipped packages: ${totalSkipped}`);
  }

  // Set output
  core.setOutput("result", JSON.stringify(results));

  // Set job status based on results
  if (totalFailed > 0 && totalSuccess === 0) {
    core.setFailed(`All ${packageType} package migrations failed`);
  } else if (totalFailed > 0) {
    core.warning(`Some ${packageType} package migrations failed`);
  }
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
