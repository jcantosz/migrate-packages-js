import * as core from "@actions/core";
import {
  parsePackagesInput,
  cleanupTempDir,
  fetchPackageVersions,
  createPackageResult,
  migratePackagesWithContext,
  setupContext,
  withRetry,
  logError,
  logWarning,
  logInfo,
} from "../../shared/utils.js";
import { checkDotNetInstallation, setupGpr } from "./dotnet-tools.js";
import { processPackageVersion } from "./package.js";
import { setupEnvironment, setupVersionWorkspace } from "./workspace.js";

function buildSkipResult(packageName) {
  return createPackageResult(packageName, 0, 0, {
    skipped: true,
    reason: "No versions found",
  });
}

async function migrateVersion(packageName, version, repoName, context, tempDir, gprPath) {
  const versionDir = setupVersionWorkspace(tempDir, packageName, version);
  return withRetry(() => processPackageVersion(packageName, version, repoName, context, versionDir, gprPath), {
    onRetry: (error, attempt) => {
      logInfo(`Retry attempt ${attempt} for ${packageName} version ${version}. Error: ${error.message}`);
    },
  });
}

async function migratePackage(pkg, context) {
  const { octokitSource, sourceOrg, tempDir, gprPath } = context;
  const packageName = pkg.name;
  const repoName = pkg.repository?.name;

  logInfo(`Migrating NuGet package: ${packageName}${repoName ? ` from repo: ${repoName}` : ""}`);

  const versions = await fetchPackageVersions(octokitSource, sourceOrg, packageName, "nuget");
  if (!versions.length) {
    return buildSkipResult(packageName);
  }

  const versionNames = versions.map((version) => version.name);
  logInfo(`Found ${versionNames.length} versions for package ${packageName}`);

  const results = await Promise.all(
    versionNames.map((version) => migrateVersion(packageName, version, repoName, context, tempDir, gprPath))
  );

  const successCount = results.filter(Boolean).length;
  const failureCount = versionNames.length - successCount;

  return createPackageResult(packageName, successCount, failureCount);
}

async function run() {
  let tempDir;
  try {
    const packages = parsePackagesInput(core.getInput("packages", { required: true }), "nuget");
    if (!packages.length) {
      logInfo("No NuGet packages to migrate");
      core.setOutput("result", JSON.stringify([]));
      return;
    }

    checkDotNetInstallation();
    tempDir = setupEnvironment();
    const gprPath = setupGpr(tempDir);
    const context = { ...setupContext(core, "nuget"), tempDir, gprPath };

    await migratePackagesWithContext(packages, context, migratePackage, "nuget");
  } catch (error) {
    logError(`Action failed: ${error.message}`);
  } finally {
    tempDir && cleanupTempDir(tempDir);
  }
}

run();
