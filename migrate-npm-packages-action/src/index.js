import * as core from "@actions/core";
import {
  parsePackagesInput,
  createTempDir,
  cleanupTempDir,
  fetchPackageVersions,
  createPackageResult,
  migratePackagesWithContext,
  setupContext,
  logError,
  logWarning,
  logInfo,
} from "../../shared/utils.js";
import { setupNpmAuthentication } from "./auth.js";
import { processPackageVersion } from "./package.js";
import { setupVersionWorkspace, resetWorkspace } from "./workspace.js";

function buildSkipResult(packageName) {
  return createPackageResult(packageName, 0, 0, {
    skipped: true,
    reason: "No versions found",
  });
}

async function migrateVersion(packageName, version, context) {
  const versionDir = setupVersionWorkspace(context.tempDir, packageName, version);

  try {
    return await withRetry(() => processPackageVersion(packageName, version, context, versionDir), {
      onRetry: (error, attempt) => {
        logInfo(`Retry attempt ${attempt} for ${packageName}@${version}. Error: ${error.message}`);
        core.debug(`Error details: ${JSON.stringify({ attempt }, null, 2)}`);
        resetWorkspace(versionDir);
      },
    });
  } finally {
    cleanupTempDir(versionDir);
  }
}

async function migratePackage(pkg, context) {
  const { octokitSource, sourceOrg } = context;
  const packageName = pkg.name;
  const repoName = pkg.repository?.name || null;

  logInfo(`Migrating npm package: ${packageName}${repoName ? ` from repo: ${repoName}` : ""}`);

  const versions = await fetchPackageVersions(octokitSource, sourceOrg, packageName, "npm");
  if (!versions.length) {
    return buildSkipResult(packageName);
  }

  const versionNames = versions.map((version) => version.name);
  logInfo(`Found ${versionNames.length} versions for package ${packageName}`);

  let successCount = 0;
  let failureCount = 0;

  for (const version of versionNames) {
    const success = await migrateVersion(packageName, version, context);
    success ? successCount++ : failureCount++;
  }

  return createPackageResult(packageName, successCount, failureCount);
}

async function setupMigrationContext() {
  const tempDir = createTempDir();
  const baseContext = setupContext(core, "npm");
  const repoName = core.getInput("repo-name", { required: false });

  const npmrcPath = setupNpmAuthentication(
    tempDir,
    baseContext.targetOrg,
    baseContext.targetRegistryUrl,
    baseContext.ghTargetPat
  );

  return {
    ...baseContext,
    tempDir,
    npmrcPath,
    repoName,
  };
}

async function run() {
  let tempDir = null;

  try {
    const packagesJson = core.getInput("packages", { required: true });
    const packages = parsePackagesInput(packagesJson, "npm");

    if (!packages.length) {
      logInfo("No npm packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    const context = await setupMigrationContext();
    tempDir = context.tempDir;

    await migratePackagesWithContext(packages, context, migratePackage, "npm");
  } catch (error) {
    logError(`Action failed: ${error.message}`);
  } finally {
    if (tempDir) {
      cleanupTempDir(tempDir);
    }
  }
}

run();
