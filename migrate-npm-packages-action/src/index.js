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
  fetchVersions,
  cleanupTempDir,
  outputResults,
  getNpmRegistryUrl,
} from "../../shared/utils.js";

/**
 * Write .npmrc for target registry and return its path
 */
function writeNpmrc(tempDir, targetOrg, targetRegistryUrl, ghTargetPat) {
  const npmrcPath = path.join(tempDir, ".npmrc");
  fs.writeFileSync(
    npmrcPath,
    `@${targetOrg}:registry=${targetRegistryUrl}/\n//${new URL(targetRegistryUrl).host}/:_authToken=${ghTargetPat}\n`
  );
  return npmrcPath;
}

/**
 * Migrate a single npm package version
 */
async function migrateVersion(packageName, versionName, context) {
  const { sourceOrg, sourceApiUrl, sourceRegistryUrl, ghSourcePat, tempDir, npmrcPath, targetOrg, targetApiUrl } =
    context;
  const versionTempDir = path.join(tempDir, `${packageName}-${versionName}`);

  // Clean up any previous directory
  if (fs.existsSync(versionTempDir)) {
    fs.rmSync(versionTempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(versionTempDir, { recursive: true });

  try {
    core.info(`Migrating ${packageName}@${versionName}`);

    // Step 1: Get the tarball URL from the package manifest
    const manifestUrl = `${sourceRegistryUrl}/@${sourceOrg}/${packageName}`;
    const manifest = await axios.get(manifestUrl, {
      headers: { Authorization: `token ${ghSourcePat}` },
    });

    const tarballUrl = manifest.data.versions[versionName]?.dist.tarball;
    if (!tarballUrl) {
      core.warning(`Version ${versionName} not found for package ${packageName}`);
      cleanupTempDir(versionTempDir);
      return false;
    }

    // Step 2: Download the package tarball
    const tarballPath = path.join(versionTempDir, `${packageName}-${versionName}.tgz`);
    const tarballResp = await axios.get(tarballUrl, {
      responseType: "arraybuffer",
      headers: { Authorization: `token ${ghSourcePat}` },
    });
    fs.writeFileSync(tarballPath, tarballResp.data);

    // Step 3: Extract the tarball
    await tar.x({ file: tarballPath, cwd: versionTempDir });
    const packageDir = path.join(versionTempDir, "package");

    // Step 4: Update the package.json to use the target organization
    const pkgJsonPath = path.join(packageDir, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    pkgJson.name = pkgJson.name.replace(`@${sourceOrg}/`, `@${targetOrg}/`);

    // Step 4a: Update repository URL for repo migration
    let targetApiHostname = new URL(targetApiUrl).hostname;
    // Remove 'api.' prefix if present (e.g., convert api.github.com to github.com)
    targetApiHostname = targetApiHostname.startsWith("api.") ? targetApiHostname.substring(4) : targetApiHostname;
    const repoName = pkgJson.name.replace(`@${targetOrg}/`, "");

    const repoUrl = `git+https://${targetApiHostname}/${targetOrg}/${repoName}.git`;

    core.info(`Setting repo url in package.json to "${repoUrl}"`);
    if (!pkgJson.repository) {
      core.info("Repository key not found, adding");
      // Add repository field if it doesn't exist
      pkgJson.repository = {
        type: "git",
        url: repoUrl,
      };
    } else if (typeof pkgJson.repository === "string") {
      // Update repository string
      core.info("Repository key not found updating");
      pkgJson.repository = repoUrl;
    } else if (typeof pkgJson.repository === "object") {
      // Update repository.url
      core.info("Repository key is an object, Updating repository.url");
      pkgJson.repository.url = repoUrl;
      if (!pkgJson.repository.type) {
        pkgJson.repository.type = "git";
      }
    }

    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

    // Step 5: Publish the package to the target registry
    execSync(`npm publish --userconfig ${npmrcPath}`, {
      cwd: packageDir,
      stdio: "inherit",
    });
    core.info(`Published ${packageName}@${versionName} successfully`);

    // Clean up after successful migration
    cleanupTempDir(versionTempDir);
    return true;
  } catch (err) {
    core.warning(`Failed to migrate ${packageName}@${versionName}: ${err.message}`);
    cleanupTempDir(versionTempDir);
    return false;
  }
}

/**
 * Migrate a single npm package with all its versions
 */
async function migratePackage(pkg, context) {
  const { octokitSource, sourceOrg } = context;
  let successCount = 0;
  let failureCount = 0;
  const packageName = pkg.name;
  const repoName = pkg.repository?.name || "unknown";

  core.info(`Migrating npm package: ${packageName} from repo: ${repoName}`);

  // Get all versions for this npm package
  const versions = await fetchVersions(octokitSource, sourceOrg, packageName, "npm");

  if (versions.length === 0) {
    core.warning(`No versions found for package ${packageName}`);
    return { package: packageName, succeeded: 0, failed: 0, skipped: true, reason: "No versions found" };
  }

  // Process each npm version
  for (const version of versions) {
    const versionName = version.name;
    const success = await migrateVersion(packageName, versionName, context);
    if (success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  return { package: packageName, succeeded: successCount, failed: failureCount };
}

/**
 * Main function
 */
async function run() {
  try {
    // Get common inputs using the shared utility
    const {
      sourceOrg,
      sourceApiUrl,
      sourceRegistryUrl,
      targetOrg,
      targetApiUrl,
      targetRegistryUrl,
      ghSourcePat,
      ghTargetPat,
    } = getCommonInputs(core);

    // Parse packages from input using the shared utility
    const packagesJson = core.getInput("packages", { required: true });
    const packages = parsePackagesInput(packagesJson, "npm");

    if (packages.length === 0) {
      core.info("No npm packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    // Set up work directory
    const tempDir = path.join(process.cwd(), "temp");
    fs.mkdirSync(tempDir, { recursive: true });

    // Get registry URLs
    const sourceNpmRegistry = sourceRegistryUrl || getNpmRegistryUrl(sourceApiUrl);
    const targetNpmRegistry = targetRegistryUrl || getNpmRegistryUrl(targetApiUrl);

    // Set up Octokit client using the shared utility
    const octokitSource = createOctokitClient(ghSourcePat, sourceApiUrl);

    // Set up npmrc file
    const npmrcPath = writeNpmrc(tempDir, targetOrg, targetNpmRegistry, ghTargetPat);

    // Prepare context with all configuration
    const context = {
      octokitSource,
      sourceOrg,
      sourceApiUrl,
      sourceRegistryUrl: sourceNpmRegistry,
      targetOrg,
      targetApiUrl,
      targetRegistryUrl: targetNpmRegistry,
      ghSourcePat,
      ghTargetPat,
      tempDir,
      npmrcPath,
    };

    // Migrate all packages
    const results = [];
    for (const pkg of packages) {
      const result = await migratePackage(pkg, context);
      results.push(result);
    }

    // Output results using the shared utility
    outputResults(results, "npm");
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
