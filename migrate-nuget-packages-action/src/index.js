import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import os from "os";
import axios from "axios";
import AdmZip from "adm-zip";

/**
 * Sets up the environment for NuGet package migration
 * @returns {string} - Path to the temp directory
 */
function setupEnvironment() {
  // Create a temp directory
  const tempDir = path.join(os.tmpdir(), "nuget-migrate-" + Math.random().toString(36).substring(2, 10));
  core.info(`Creating temp directory: ${tempDir}`);

  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Checks if dotnet is installed
 * @throws {Error} If dotnet is not installed
 */
function checkDotNetInstallation() {
  try {
    execSync("dotnet --version", { stdio: "pipe" });
    core.info("dotnet is installed");
  } catch (err) {
    throw new Error("dotnet is not installed or not accessible. dotnet is required for NuGet package migration.");
  }
}

/**
 * Installs the GPR tool
 * @param {string} tempDir - Path to the temp directory
 * @returns {string} - Path to the installed GPR tool
 */
function installGpr(tempDir) {
  try {
    const toolsDir = path.join(tempDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    core.info("Installing gpr tool...");
    spawnSync("dotnet", ["tool", "install", "gpr", "--tool-path", toolsDir], {
      stdio: "inherit",
      encoding: "utf-8",
    });

    // Get the appropriate extension based on OS
    const extension = process.platform === "win32" ? ".exe" : "";
    const gprPath = path.join(toolsDir, `gpr${extension}`);

    // Verify GPR was installed
    if (!fs.existsSync(gprPath)) {
      throw new Error(`Failed to install gpr tool. Could not find ${gprPath}`);
    }

    core.info(`Successfully installed gpr at ${gprPath}`);
    return gprPath;
  } catch (err) {
    throw new Error(`Error installing gpr: ${err.message}`);
  }
}

/**
 * Fetch all versions for a NuGet package
 * @param {Octokit} octokit - Authenticated Octokit instance
 * @param {string} org - Organization name
 * @param {string} packageName - Package name
 * @returns {Array} - List of versions
 */
async function fetchVersions(octokit, org, packageName) {
  try {
    const versions = await octokit.paginate("GET /orgs/{org}/packages/nuget/{package_name}/versions", {
      org,
      package_name: packageName,
      per_page: 100,
    });

    // Extract just the version names
    const versionNames = versions.map((version) => version.name);
    core.info(`Found ${versionNames.length} versions for package ${packageName}`);
    return versionNames;
  } catch (err) {
    core.warning(`Error fetching versions for NuGet package ${packageName}: ${err.message}`);
    return [];
  }
}

/**
 * Download a single NuGet package version
 * @param {string} packageName - Package name
 * @param {string} version - Package version
 * @param {string} sourceOrg - Source organization
 * @param {string} sourceHost - Source host
 * @param {string} token - GitHub PAT for source
 * @param {string} outputDir - Directory to save the package
 * @returns {string} - Path to the downloaded package
 */
async function downloadPackage(packageName, version, sourceOrg, sourceHost, token, outputDir) {
  try {
    const outputPath = path.join(outputDir, `${packageName}_${version}.nupkg`);
    const url = `https://nuget.pkg.${sourceHost}/${sourceOrg}/download/${packageName}/${version}/${packageName}.${version}.nupkg`;

    core.info(`Downloading ${packageName} version ${version} from ${url}`);

    const response = await axios({
      method: "get",
      url: url,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/octet-stream",
      },
      responseType: "arraybuffer",
    });

    fs.writeFileSync(outputPath, response.data);
    core.info(`Successfully downloaded ${packageName} version ${version} to ${outputPath}`);

    return outputPath;
  } catch (err) {
    throw new Error(`Failed to download ${packageName} version ${version}: ${err.message}`);
  }
}

/**
 * Fix NuGet package by removing duplicate files that cause errors with GPR
 * @param {string} packagePath - Path to the NuGet package
 * @returns {boolean} - True if successful
 */
function fixNuGetPackage(packagePath) {
  try {
    core.info(`Fixing NuGet package: ${packagePath}`);

    // Use adm-zip to remove the problematic files
    const zip = new AdmZip(packagePath);

    // Remove the problematic entries that cause errors in gpr
    const filesToRemove = ["_rels/.rels", "[Content_Types].xml"];

    // Get all entries
    const entries = zip.getEntries();

    // Keep track of seen entries to handle duplicates
    const seenPaths = new Set();

    // Filter entries to keep just one copy of each file
    entries.forEach((entry) => {
      if (filesToRemove.includes(entry.entryName)) {
        if (seenPaths.has(entry.entryName)) {
          // This is a duplicate, remove it
          zip.deleteFile(entry.entryName);
        } else {
          seenPaths.add(entry.entryName);
        }
      }
    });

    // Write the fixed zip back to disk
    zip.writeZip(packagePath);

    core.info(`Successfully fixed NuGet package: ${packagePath}`);
    return true;
  } catch (err) {
    core.warning(`Failed to fix NuGet package: ${err.message}`);
    return false;
  }
}

/**
 * Push a NuGet package to the target organization
 * @param {string} packagePath - Path to the NuGet package
 * @param {string} gprPath - Path to the GPR tool
 * @param {string} targetOrg - Target organization
 * @param {string} repoName - Repository name
 * @param {string} token - GitHub PAT for target
 * @returns {boolean} - True if successful
 */
function pushPackage(packagePath, gprPath, targetOrg, repoName, token) {
  try {
    core.info(`Pushing ${packagePath} to ${targetOrg}/${repoName}`);

    const result = spawnSync(
      gprPath,
      ["push", packagePath, "--repository", `https://github.com/${targetOrg}/${repoName}`, "-k", token],
      {
        stdio: "pipe",
        encoding: "utf-8",
      }
    );

    if (result.status !== 0) {
      throw new Error(`GPR push failed: ${result.stderr || result.stdout}`);
    }

    core.info(`Successfully pushed ${packagePath} to ${targetOrg}/${repoName}`);
    return true;
  } catch (err) {
    core.warning(`Failed to push package: ${err.message}`);
    return false;
  }
}

/**
 * Migrate a single version of a NuGet package
 * @param {string} packageName - Package name
 * @param {string} version - Package version
 * @param {string} repoName - Repository name
 * @param {Object} context - Migration context
 * @param {string} tempDir - Temporary directory
 * @param {string} gprPath - Path to the GPR tool
 * @returns {boolean} - True if successful
 */
async function migrateVersion(packageName, version, repoName, context, tempDir, gprPath) {
  const { sourceOrg, sourceHost, targetOrg, targetHost, ghSourcePat, ghTargetPat } = context;

  try {
    // Download the package
    const packagePath = await downloadPackage(packageName, version, sourceOrg, sourceHost, ghSourcePat, tempDir);

    // Fix the package (remove duplicate entries)
    const fixResult = fixNuGetPackage(packagePath);
    if (!fixResult) {
      throw new Error(`Failed to fix package ${packageName} version ${version}`);
    }

    // Push the package to the target
    const pushResult = pushPackage(packagePath, gprPath, targetOrg, repoName, ghTargetPat);
    if (!pushResult) {
      throw new Error(`Failed to push package ${packageName} version ${version}`);
    }

    return true;
  } catch (err) {
    core.warning(`Failed to migrate ${packageName} version ${version}: ${err.message}`);
    return false;
  }
}

/**
 * Migrate a single NuGet package with all its versions
 * @param {Object} pkg - Package object
 * @param {Object} context - Migration context
 * @param {string} tempDir - Temporary directory
 * @param {string} gprPath - Path to the GPR tool
 * @returns {Object} - Migration result
 */
async function migratePackage(pkg, context, tempDir, gprPath) {
  const { octokitSource, sourceOrg } = context;
  let successCount = 0;
  let failureCount = 0;

  const packageName = pkg.name;
  const repoName = pkg.repository?.name || packageName; // If no repo, use package name

  core.info(`Migrating NuGet package: ${packageName} from repo: ${repoName}`);

  // Get all versions for this NuGet package
  const versions = await fetchVersions(octokitSource, sourceOrg, packageName);

  if (versions.length === 0) {
    core.warning(`No versions found for package ${packageName}`);
    return {
      package: packageName,
      versionsSucceeded: 0,
      versionsFailed: 0,
      skipped: true,
      reason: "No versions found",
    };
  }

  // Migrate each version
  for (const version of versions) {
    const success = await migrateVersion(packageName, version, repoName, context, tempDir, gprPath);
    if (success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  return {
    package: packageName,
    versionsSucceeded: successCount,
    versionsFailed: failureCount,
  };
}

/**
 * Format migration results as a summary
 * @param {Array} results - Migration results
 * @returns {string} - Formatted summary
 */
function formatResults(results) {
  let summary = "Migration completed. Summary:\n";

  results.forEach((r) => {
    if (r.skipped) {
      summary += `- ${r.package}: SKIPPED (${r.reason})\n`;
    } else {
      summary += `- ${r.package}: ${r.versionsSucceeded} versions succeeded, ${r.versionsFailed} versions failed\n`;
    }
  });

  return summary;
}

/**
 * Parse packages input from JSON
 * @param {string} packagesJson - JSON string
 * @returns {Array} - Parsed packages
 */
function parsePackagesInput(packagesJson) {
  try {
    const packages = JSON.parse(packagesJson);
    core.info(`Found ${packages.length} NuGet packages to migrate`);
    return packages;
  } catch (err) {
    throw new Error(`Invalid packages input: ${err.message}`);
  }
}

/**
 * Clean up temporary directories and resources
 * @param {string} tempDir - Path to the temp directory
 */
function cleanUp(tempDir) {
  try {
    core.info(`Cleaning up temporary directory: ${tempDir}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    core.warning(`Failed to clean up temporary directory: ${err.message}`);
  }
}

/**
 * Main function
 */
async function run() {
  let tempDir = null;

  try {
    // Get action inputs
    const sourceOrg = core.getInput("source-org", { required: true });
    const sourceHost = core.getInput("source-host", { required: true });
    const targetOrg = core.getInput("target-org", { required: true });
    const targetHost = core.getInput("target-host", { required: true });
    const ghSourcePat = core.getInput("gh-source-pat", { required: true });
    const ghTargetPat = core.getInput("gh-target-pat", { required: true });

    // Parse packages input
    const packagesJson = core.getInput("packages", { required: true });
    const packages = parsePackagesInput(packagesJson);

    if (packages.length === 0) {
      core.info("No NuGet packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    // Check prerequisites and setup environment
    checkDotNetInstallation();
    tempDir = setupEnvironment();
    const gprPath = installGpr(tempDir);

    // Set up Octokit client
    const octokitSource = new Octokit({
      auth: ghSourcePat,
      baseUrl: `https://${sourceHost}/api/v3`,
    });

    // Prepare context with all configuration
    const context = {
      octokitSource,
      sourceOrg,
      sourceHost,
      targetOrg,
      targetHost,
      ghSourcePat,
      ghTargetPat,
    };

    // Migrate all packages
    const results = [];
    for (const pkg of packages) {
      const result = await migratePackage(pkg, context, tempDir, gprPath);
      results.push(result);
    }

    // Output results
    const summary = formatResults(results);
    core.info(summary);
    core.setOutput("result", JSON.stringify(results));
    core.info("NuGet packages migration complete.");
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  } finally {
    // Clean up temp directory
    if (tempDir) {
      cleanUp(tempDir);
    }
  }
}

run();
