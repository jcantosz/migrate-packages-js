import * as core from "@actions/core";
import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import os from "os";
import axios from "axios";
import AdmZip from "adm-zip";
import {
  withRetry,
  parsePackagesInput,
  cleanupTempDir,
  fetchPackageVersions,
  createPackageResult,
  migratePackagesWithContext,
  setupContext,
  trackResource,
} from "../../shared/utils.js";

// Helper functions to reduce nesting and repetition
function logError(message, packageName, version) {
  core.error(`${message} for ${packageName} ${version}`);
}

function logWarning(message, packageName, version) {
  core.warning(`${message} for ${packageName} ${version}`);
}

function buildSkipResult(packageName) {
  return createPackageResult(packageName, 0, 0, {
    skipped: true,
    reason: "No versions found",
  });
}

/**
 * Sets up the environment for NuGet package migration
 */
function setupEnvironment() {
  const timestamp = Date.now();
  const tempDir = path.join(os.tmpdir(), `nuget-migrate-${timestamp}`);
  core.info(`Creating temp directory: ${tempDir}`);

  fs.mkdirSync(tempDir, { recursive: true });
  return trackResource(tempDir);
}

/**
 * Checks if dotnet is installed
 */
function checkDotNetInstallation() {
  try {
    execSync("dotnet --version", { stdio: "pipe" });
    core.info("dotnet is installed");
  } catch (err) {
    core.error("dotnet is not installed or not accessible");
    throw err;
  }
}

/**
 * Installs the GPR tool
 */
function installGpr(tempDir) {
  const toolsDir = path.join(tempDir, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  trackResource(toolsDir);

  core.info("Installing gpr tool...");
  const result = spawnSync("dotnet", ["tool", "install", "gpr", "--tool-path", toolsDir], {
    stdio: "inherit",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    core.error("Failed to install gpr tool");
    throw new Error("Failed to install gpr");
  }

  const extension = process.platform === "win32" ? ".exe" : "";
  const gprPath = path.join(toolsDir, `gpr${extension}`);

  if (!fs.existsSync(gprPath)) {
    core.error("Could not find gpr after installation");
    throw new Error("gpr not found after installation");
  }

  core.info(`Successfully installed gpr at ${gprPath}`);
  return gprPath;
}

/**
 * Download a single NuGet package version
 */
async function downloadPackage(packageName, version, sourceOrg, sourceRegistryUrl, token, outputDir) {
  const outputPath = path.join(outputDir, `${packageName}_${version}.nupkg`);
  trackResource(outputPath);

  try {
    const url = `${sourceRegistryUrl}/${sourceOrg}/download/${packageName}/${version}/${packageName}.${version}.nupkg`;
    core.info(`Downloading ${packageName} version ${version}`);
    core.debug(`Download URL: ${url}`);

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
    core.info(`Successfully downloaded ${packageName} version ${version}`);
    return outputPath;
  } catch (err) {
    if (err.response?.status === 401) {
      logError("Failed to authenticate with source registry", packageName, version);
    } else if (err.response?.status === 404) {
      logWarning("Package not found in source registry", packageName, version);
    } else {
      logError(`Download failed: ${err.message}`, packageName, version);
    }
    throw err;
  }
}

/**
 * Fix NuGet package metadata
 */
function fixNuGetPackage(packagePath, packageName, version) {
  try {
    core.info(`Fixing NuGet package: ${packagePath}`);

    const zip = new AdmZip(packagePath);
    const filesToRemove = ["_rels/.rels", "[Content_Types].xml"];
    const seenPaths = new Set();

    zip.getEntries().forEach((entry) => {
      if (filesToRemove.includes(entry.entryName)) {
        if (seenPaths.has(entry.entryName)) {
          zip.deleteFile(entry.entryName);
          core.debug(`Removed duplicate file: ${entry.entryName}`);
        } else {
          seenPaths.add(entry.entryName);
        }
      }
    });

    zip.writeZip(packagePath);
    core.info("Successfully fixed NuGet package");
    return true;
  } catch (err) {
    logError(`Failed to fix package: ${err.message}`, packageName, version);
    throw err;
  }
}

/**
 * Push package to target registry
 */
function pushPackage(packagePath, gprPath, targetOrg, repoName, token, targetApiUrl, packageName, version) {
  try {
    if (repoName) {
      core.info(`Pushing ${packageName} to ${targetOrg}/${repoName}`);
    } else {
      core.info(`Pushing ${packageName} to ${targetOrg}`);
    }

    const gprArgs = ["push", packagePath, "-k", token];

    if (repoName) {
      const url = new URL(targetApiUrl);
      const targetHostname = url.hostname.startsWith("api.") ? url.hostname.substring(4) : url.hostname;
      gprArgs.push("--repository", `https://${targetHostname}/${targetOrg}/${repoName}`);
    }

    const result = spawnSync(gprPath, gprArgs, {
      stdio: "pipe",
      encoding: "utf-8",
    });

    if (result.status !== 0) {
      if (result.stderr?.toLowerCase().includes("unauthorized")) {
        logError("Failed to authenticate with target registry", packageName, version);
      } else {
        logError(`GPR push failed: ${result.stderr || result.stdout}`, packageName, version);
      }
      throw new Error(result.stderr || result.stdout);
    }

    core.info(`Successfully pushed ${packageName} version ${version}`);
    return true;
  } catch (err) {
    logError(`Unexpected error during push: ${err.message}`, packageName, version);
    throw err;
  }
}

/**
 * Performs the actual NuGet package version migration
 */
async function performNuGetVersionMigration(packageName, version, repoName, context, tempDir, gprPath) {
  const { sourceOrg, sourceRegistryUrl, targetOrg, targetApiUrl, ghSourcePat, ghTargetPat } = context;

  try {
    // Download the package
    const packagePath = await downloadPackage(packageName, version, sourceOrg, sourceRegistryUrl, ghSourcePat, tempDir);

    // Fix the package
    await fixNuGetPackage(packagePath, packageName, version);

    // Push the package
    await pushPackage(packagePath, gprPath, targetOrg, repoName, ghTargetPat, targetApiUrl, packageName, version);

    return true;
  } catch (error) {
    if (error.response?.status === 401) {
      logError("Authentication failed", packageName, version);
    } else if (error.response?.status === 404) {
      logWarning("Package/version not found", packageName, version);
    } else {
      logError(`Migration failed: ${error.message}`, packageName, version);
    }
    return false;
  }
}

/**
 * Migrate a single version of a package
 */
async function migrateVersion(packageName, version, repoName, context, tempDir, gprPath) {
  return await withRetry(
    () => performNuGetVersionMigration(packageName, version, repoName, context, tempDir, gprPath),
    {
      onRetry: (error, attempt) => {
        core.info(`Retry attempt ${attempt} for ${packageName} version ${version}. Error: ${error.message}`);
        core.debug(`Error details: ${JSON.stringify({ attempt }, null, 2)}`);
      },
    }
  );
}

/**
 * Migrate a single NuGet package with all its versions
 */
async function migratePackage(pkg, context) {
  const { octokitSource, sourceOrg, tempDir, gprPath } = context;
  const packageName = pkg.name;
  const repoName = pkg.repository?.name || null;

  core.info(`Migrating NuGet package: ${packageName}${repoName ? ` from repo: ${repoName}` : ""}`);

  const versions = await fetchPackageVersions(octokitSource, sourceOrg, packageName, "nuget");
  if (!versions.length) {
    return buildSkipResult(packageName);
  }

  const versionNames = versions.map((version) => version.name);
  core.info(`Found ${versionNames.length} versions for package ${packageName}`);

  let successCount = 0;
  let failureCount = 0;

  for (const version of versionNames) {
    const success = await migrateVersion(packageName, version, repoName, context, tempDir, gprPath);
    if (success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  return createPackageResult(packageName, successCount, failureCount);
}

/**
 * Main function
 */
async function run() {
  let tempDir = null;

  try {
    const packagesJson = core.getInput("packages", { required: true });
    const packages = parsePackagesInput(packagesJson, "nuget");

    if (!packages.length) {
      core.info("No NuGet packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    checkDotNetInstallation();
    tempDir = setupEnvironment();
    const gprPath = installGpr(tempDir);

    const baseContext = setupContext(core, "nuget");
    const context = {
      ...baseContext,
      tempDir,
      gprPath,
    };

    await migratePackagesWithContext(packages, context, migratePackage, "nuget");
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  } finally {
    if (tempDir) {
      cleanupTempDir(tempDir);
    }
  }
}

run();
