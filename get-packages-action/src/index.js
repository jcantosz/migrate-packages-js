import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { paginateRest } from "@octokit/plugin-paginate-rest";

// Extend Octokit with pagination support
const PaginatedOctokit = Octokit.plugin(paginateRest);

/**
 * Fetch all packages of a specific type for an organization
 * @param {Object} octokit - Authenticated Octokit instance
 * @param {string} org - Organization name
 * @param {string} packageType - Type of package (npm, docker, nuget)
 * @returns {Array} - List of packages with minimal required data
 */
async function fetchPackages(octokit, org, packageType) {
  try {
    const packages = await octokit.paginate("GET /orgs/{org}/packages", {
      org,
      package_type: packageType,
      per_page: 100,
    });

    // Only retain the essential fields needed by migration actions
    return packages.map((pkg) => ({
      name: pkg.name,
      type: packageType,
      repository: pkg.repository ? { name: pkg.repository.name } : null,
    }));
  } catch (err) {
    core.warning(`Error fetching ${packageType} packages: ${err.message}`);
    return [];
  }
}

/**
 * Filter packages based on repository name
 * @param {Array} packages - List of packages
 * @param {string} repoName - Repository name to filter by (undefined for no repo)
 * @returns {Array} - Filtered list of packages
 */
function filterPackagesByRepo(packages, repoName) {
  if (!repoName) {
    // Return packages that don't have a repository or have null repository
    return packages.filter((pkg) => !pkg.repository || !pkg.repository.name);
  } else {
    // Return packages that match the specified repository name
    return packages.filter((pkg) => pkg.repository && pkg.repository.name === repoName);
  }
}

/**
 * Main function to get and filter packages
 */
async function run() {
  try {
    // Get inputs
    const sourceOrg = core.getInput("source-org", { required: true });
    const sourceAPIUrl = core.getInput("source-api-url", { required: true });
    const ghSourcePat = core.getInput("gh-source-pat", { required: true });
    const repoName = core.getInput("repo-name");

    const packageTypes = packageTypesInput.split(",").map((type) => type.trim());

    // Create authenticated client
    const octokit = new PaginatedOctokit({
      auth: ghSourcePat,
      baseUrl: sourceAPIUrl,
    });

    // Store results by type
    const packagesByType = {};
    let totalPackages = 0;

    // Fetch and filter packages for each type
    for (const type of packageTypes) {
      if (!type) continue; // Skip empty types

      core.debug(`Fetching ${type}`);

      const allPackages = await fetchPackages(octokit, sourceOrg, type);
      core.debug(`Found ${allPackages.length} total ${type} packages`);

      const filteredPackages = filterPackagesByRepo(allPackages, repoName);

      // Store the filtered packages
      packagesByType[type] = filteredPackages;
      totalPackages += filteredPackages.length;

      // Set outputs for specific package type
      const packagesJson = JSON.stringify(filteredPackages);
      core.debug(`${type} packages JSON: ${packagesJson}`);
      core.setOutput(`${type}-packages`, packagesJson);
      core.setOutput(`${type}-count`, filteredPackages.length);

      core.info(
        `Found ${filteredPackages.length} ${type} packages${repoName ? ` for repo ${repoName}` : " without repo"}`
      );
    }

    if (totalPackages === 0) {
      core.info(`No packages found${repoName ? ` for repo ${repoName}` : " without repo"} in ${sourceOrg}`);
    } else {
      core.info(`Total packages found: ${totalPackages}`);
    }

    // Set composite output with all package data
    const allPackagesJson = JSON.stringify(packagesByType);
    core.debug(`All packages JSON: ${allPackagesJson}`);
    core.setOutput("all-packages", allPackagesJson);
    core.setOutput("total-count", totalPackages);
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
