import * as core from "@actions/core";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as tar from "tar";
import { execSync } from "child_process";
import {
  getCommonInputs,
  parsePackagesInput,
  createOctokitClient,
  cleanupTempDir,
  outputResults,
  getBaseHostname,
  withRetry,
  createTempDir,
  fetchPackageVersions,
  createPackageResult,
  getRegistryUrl,
  migratePackagesWithContext,
  setupContext,
  trackResource,
} from "../../shared/utils.js";
import * as errors from "../../shared/errors.js";

// Helper functions to reduce nesting and make intent clear
function logError(message, packageName, version) {
  core.error(`${message} for ${packageName}@${version}`);
}

function logWarning(message, packageName, version) {
  core.warning(`${message} for ${packageName}@${version}`);
}

function buildSkipResult(packageName) {
  return createPackageResult(packageName, 0, 0, {
    skipped: true,
    reason: "No versions found",
  });
}

/**
 * Configure NPM authentication for target registry
 */
function setupNpmAuthentication(tempDir, targetOrg, targetRegistryUrl, ghTargetPat) {
  const npmrcPath = path.join(tempDir, ".npmrc");
  const config = [
    `@${targetOrg}:registry=${targetRegistryUrl}/`,
    `//${new URL(targetRegistryUrl).host}/:_authToken=${ghTargetPat}`,
  ].join("\n");

  fs.writeFileSync(npmrcPath, config);
  return trackResource(npmrcPath);
}

/**
 * Fetch package manifest from source registry
 */
async function fetchPackageManifest(packageName, versionName, sourceRegistryUrl, sourceOrg, ghSourcePat) {
  const manifestUrl = `${sourceRegistryUrl}/@${sourceOrg}/${packageName}`;

  try {
    const manifest = await axios.get(manifestUrl, {
      headers: { Authorization: `token ${ghSourcePat}` },
    });

    const tarballUrl = manifest.data.versions[versionName]?.dist.tarball;
    if (!tarballUrl) {
      logWarning("Version not found in manifest", packageName, versionName);
      return null;
    }

    return tarballUrl;
  } catch (error) {
    if (error.response?.status === 401) {
      logError("Failed to authenticate with source registry", packageName, versionName);
    } else if (error.response?.status === 404) {
      logWarning("Package manifest not found", packageName, versionName);
    } else {
      logError(`Failed to fetch manifest: ${error.message}`, packageName, versionName);
    }
    throw error;
  }
}

/**
 * Download and extract package contents
 */
async function downloadAndExtractPackage(tarballUrl, packageDir, ghSourcePat) {
  const response = await axios.get(tarballUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `token ${ghSourcePat}` },
  });

  await tar.x({
    cwd: packageDir,
    file: Buffer.from(response.data),
  });

  return path.join(packageDir, "package");
}

/**
 * Update package.json with target organization and repository
 */
function updatePackageMetadata(packageDir, sourceOrg, targetOrg, targetApiUrl, repoName) {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));

  // Update package scope to target organization
  pkgJson.name = pkgJson.name.replace(`@${sourceOrg}/`, `@${targetOrg}/`);

  // Update repository link if needed
  if (repoName || pkgJson.repository) {
    updateRepositoryDetails(pkgJson, repoName, targetOrg, targetApiUrl);
  }

  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
  return pkgJson;
}

/**
 * Update repository URL in package.json
 */
function updateRepositoryDetails(pkgJson, repoName, targetOrg, targetApiUrl) {
  const targetHostname = getBaseHostname(targetApiUrl);
  const existingUrl = typeof pkgJson.repository === "string" ? pkgJson.repository : pkgJson.repository?.url || "";

  const extractedName =
    repoName ||
    existingUrl
      ?.split("/")
      ?.pop()
      ?.replace(/\.git$/, "") ||
    null;

  if (extractedName) {
    const newRepoUrl = `git+https://${targetHostname}/${targetOrg}/${extractedName}.git`;
    if (typeof pkgJson.repository === "string") {
      pkgJson.repository = newRepoUrl;
    } else {
      pkgJson.repository = pkgJson.repository || {};
      pkgJson.repository.type = pkgJson.repository.type || "git";
      pkgJson.repository.url = newRepoUrl;
    }
    core.debug(`Updated repository URL to: ${newRepoUrl}`);
  }
}

/**
 * Publish package to target registry
 */
function publishToRegistry(packageDir, npmrcPath, packageName, version) {
  try {
    execSync(`npm publish --userconfig ${npmrcPath}`, {
      cwd: packageDir,
      stdio: "inherit",
    });
    core.info(`Published ${packageName}@${version} successfully`);
    return true;
  } catch (error) {
    logError(`Failed to publish package: ${error.message}`, packageName, version);
    return false;
  }
}

/**
 * Setup temporary directory for package processing
 */
function setupVersionWorkspace(tempDir, packageName, version) {
  const versionDir = path.join(tempDir, `${packageName}-${version}`);

  if (fs.existsSync(versionDir)) {
    cleanupTempDir(versionDir);
  }

  fs.mkdirSync(versionDir, { recursive: true });
  return trackResource(versionDir);
}

/**
 * Process a single version of a package
 */
async function processPackageVersion(packageName, version, context, versionDir) {
  const { sourceOrg, sourceRegistryUrl, ghSourcePat, targetOrg, targetApiUrl, repoName } = context;

  // Step 1: Get package tarball URL
  const tarballUrl = await fetchPackageManifest(packageName, version, sourceRegistryUrl, sourceOrg, ghSourcePat);
  if (!tarballUrl) return false;

  // Step 2: Download and extract package
  const packageDir = await downloadAndExtractPackage(tarballUrl, versionDir, ghSourcePat);
  trackResource(packageDir);

  // Step 3: Update package metadata
  await updatePackageMetadata(packageDir, sourceOrg, targetOrg, targetApiUrl, repoName);

  // Step 4: Publish to target registry
  return publishToRegistry(packageDir, context.npmrcPath, packageName, version);
}

/**
 * Migrate a single version with retries
 */
async function migrateVersion(packageName, version, context) {
  const versionDir = setupVersionWorkspace(context.tempDir, packageName, version);

  try {
    return await withRetry(
      () => processPackageVersion(packageName, version, context, versionDir),
      {
        onRetry: (error, attempt) => {
          core.info(`Retry attempt ${attempt} for ${packageName}@${version}. Error: ${error.message}`);
          core.debug(`Error details: ${JSON.stringify({ attempt }, null, 2)}`);

          // Reset workspace for retry
          cleanupTempDir(versionDir);
          fs.mkdirSync(versionDir, { recursive: true });
          trackResource(versionDir);
        },
      }
    );
  } finally {
    cleanupTempDir(versionDir);
  }
}

/**
 * Migrate all versions of a package
 */
async function migratePackage(pkg, context) {
  const { octokitSource, sourceOrg } = context;
  const packageName = pkg.name;
  const repoName = pkg.repository?.name || null;

  core.info(`Migrating npm package: ${packageName}${repoName ? ` from repo: ${repoName}` : ""}`);

  // Get all versions of the package
  const versions = await fetchPackageVersions(octokitSource, sourceOrg, packageName, "npm");
  if (!versions.length) {
    return buildSkipResult(packageName);
  }

  const versionNames = versions.map((version) => version.name);
  core.info(`Found ${versionNames.length} versions for package ${packageName}`);

  // Process each version
  let successCount = 0;
  let failureCount = 0;

  for (const version of versionNames) {
    const success = await migrateVersion(packageName, version, context);
    success ? successCount++ : failureCount++;
  }

  return createPackageResult(packageName, successCount, failureCount);
}

/**
 * Main function
 */
async function run() {
  let tempDir = null;

  try {
    // Parse input packages
    const packagesJson = core.getInput("packages", { required: true });
    const packages = parsePackagesInput(packagesJson, "npm");

    if (!packages.length) {
      core.info("No npm packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    // Setup workspace and context
    tempDir = createTempDir();
    const baseContext = setupContext(core, "npm");
    const repoName = core.getInput("repo-name", { required: false });

    // Setup npm authentication
    const npmrcPath = setupNpmAuthentication(
      tempDir,
      baseContext.targetOrg,
      baseContext.targetRegistryUrl,
      baseContext.ghTargetPat
    );

    // Create migration context
    const context = {
      ...baseContext,
      tempDir,
      npmrcPath,
      repoName,
    };

    // Run migration
    await migratePackagesWithContext(packages, context, migratePackage, "npm");
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  } finally {
    if (tempDir) {
      cleanupTempDir(tempDir);
    }
  }
}

run();
