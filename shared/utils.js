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
  const sourceHost = core.getInput("source-host", { required: true });
  const targetOrg = core.getInput("target-org", { required: true });
  const targetHost = core.getInput("target-host", { required: true });
  const ghSourcePat = core.getInput("source-token", { required: true });
  const ghTargetPat = core.getInput("target-token", { required: true });
  
  return {
    sourceOrg,
    sourceHost,
    targetOrg,
    targetHost,
    ghSourcePat,
    ghTargetPat
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
      return pkgObjects.filter(pkg => 
        pkg.type?.toLowerCase() === packageType.toLowerCase() || !pkg.type);
    }
    
    return pkgObjects;
  } catch (error) {
    throw new Error(`Failed to parse packages input: ${error.message}`);
  }
}

/**
 * Create an Octokit client
 */
export function createOctokitClient(token, host = 'github.com') {
  return new Octokit({
    auth: token,
    baseUrl: host === 'github.com' 
      ? 'https://api.github.com'
      : `https://${host}/api/v3`
  });
}

/**
 * Fetch all versions for a package
 */
export async function fetchVersions(octokitClient, org, packageName, packageType) {
  try {
    // Different package types have different version fetching logic
    switch(packageType.toLowerCase()) {
      case 'npm':
        const npmResult = await octokitClient.packages.getAllPackageVersionsForPackageOwnedByOrg({
          package_type: 'npm',
          package_name: packageName,
          org: org
        });
        return npmResult.data;
        
      case 'nuget':
        const nugetResult = await octokitClient.packages.getAllPackageVersionsForPackageOwnedByOrg({
          package_type: 'nuget',
          package_name: packageName,
          org: org
        });
        return nugetResult.data;
        
      case 'container':
        const containerResult = await octokitClient.packages.getAllPackageVersionsForPackageOwnedByOrg({
          package_type: 'container',
          package_name: packageName,
          org: org
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
  const core = require('@actions/core');
  
  // Calculate totals
  const totalPackages = results.length;
  const totalSuccess = results.reduce((acc, r) => acc + r.succeeded, 0);
  const totalFailed = results.reduce((acc, r) => acc + r.failed, 0);
  const totalSkipped = results.filter(r => r.skipped).length;
  
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
  switch(packageType.toLowerCase()) {
    case 'npm':
      return `@${org}/${packageName}`;
    case 'nuget':
      return packageName;
    case 'container':
      return `${org}/${packageName}`;
    default:
      return packageName;
  }
}