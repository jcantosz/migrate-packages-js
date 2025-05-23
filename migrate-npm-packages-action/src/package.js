import * as core from "@actions/core";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as tar from "tar";
import { execSync } from "child_process";
import { logError, logWarning, logInfo, trackResource } from "../../shared/utils.js";
import { updateRepositoryDetails } from "./repository.js";

async function downloadPackage(tarballUrl, ghSourcePat) {
  return await axios.get(tarballUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `token ${ghSourcePat}` },
  });
}

async function extractPackage(packageData, packageDir) {
  await tar.x({
    cwd: packageDir,
    file: Buffer.from(packageData),
  });
  return path.join(packageDir, "package");
}

export async function downloadAndExtractPackage(tarballUrl, packageDir, ghSourcePat) {
  const response = await downloadPackage(tarballUrl, ghSourcePat);
  return extractPackage(response.data, packageDir);
}

function updatePackageName(pkgJson, sourceOrg, targetOrg) {
  pkgJson.name = pkgJson.name.replace(`@${sourceOrg}/`, `@${targetOrg}/`);
}

export function updatePackageMetadata(packageDir, sourceOrg, targetOrg, targetApiUrl, repoName) {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));

  updatePackageName(pkgJson, sourceOrg, targetOrg);

  if (repoName || pkgJson.repository) {
    updateRepositoryDetails(pkgJson, repoName, targetOrg, targetApiUrl);
  }

  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
  return pkgJson;
}

export function publishToRegistry(packageDir, npmrcPath, packageName, version) {
  try {
    execSync(`npm publish --userconfig ${npmrcPath}`, {
      cwd: packageDir,
      stdio: "inherit",
    });
    logInfo(`Published ${packageName}@${version} successfully`);
    return true;
  } catch (error) {
    logError(`Failed to publish package: ${error.message}`, packageName, version);
    return false;
  }
}

export async function fetchPackageManifest(packageName, versionName, sourceRegistryUrl, sourceOrg, ghSourcePat) {
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

export async function processPackageVersion(packageName, version, context, versionDir) {
  const { sourceOrg, sourceRegistryUrl, ghSourcePat, targetOrg, targetApiUrl, repoName, npmrcPath } = context;

  try {
    const tarballUrl = await fetchPackageManifest(packageName, version, sourceRegistryUrl, sourceOrg, ghSourcePat);
    if (!tarballUrl) return false;

    const packageDir = await downloadAndExtractPackage(tarballUrl, versionDir, ghSourcePat);
    trackResource(packageDir);

    await updatePackageMetadata(packageDir, sourceOrg, targetOrg, targetApiUrl, repoName);

    return publishToRegistry(packageDir, npmrcPath, packageName, version);
  } catch (error) {
    logError(error.message, packageName, version);
    return false;
  }
}
