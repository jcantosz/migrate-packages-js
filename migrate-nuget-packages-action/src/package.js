import * as core from "@actions/core";
import fs from "fs";
import path from "path";
import axios from "axios";
import AdmZip from "adm-zip";
import { spawnSync } from "child_process";
import { trackResource } from "../../shared/utils.js";

async function downloadPackage(packageName, version, sourceOrg, sourceRegistryUrl, token, outputDir) {
  const outputPath = path.join(outputDir, `${packageName}_${version}.nupkg`);
  trackResource(outputPath);

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
}

function fixNuGetPackage(packagePath, packageName, version) {
  core.info(`Fixing NuGet package: ${packagePath}`);
  const zip = new AdmZip(packagePath);
  const filesToRemove = ["_rels/.rels", "[Content_Types].xml"];
  const seenPaths = new Set();

  zip.getEntries().forEach((entry) => {
    if (filesToRemove.includes(entry.entryName) && seenPaths.has(entry.entryName)) {
      zip.deleteFile(entry.entryName);
      core.debug(`Removed duplicate file: ${entry.entryName}`);
    } else {
      seenPaths.add(entry.entryName);
    }
  });

  zip.writeZip(packagePath);
  core.info("Successfully fixed NuGet package");
  return true;
}

function pushPackage(packagePath, gprPath, targetOrg, repoName, token, targetApiUrl, packageName, version) {
  const targetInfo = repoName ? `${targetOrg}/${repoName}` : targetOrg;
  core.info(`Pushing ${packageName} to ${targetInfo}`);

  const gprArgs = ["push", packagePath, "-k", token];

  if (repoName) {
    const url = new URL(targetApiUrl);
    const targetHostname = url.hostname.startsWith("api.") ? url.hostname.substring(4) : url.hostname;
    gprArgs.push("--repository", `https://${targetHostname}/${targetOrg}/${repoName}`);
  }

  const result = spawnSync(gprPath, gprArgs, { stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) {
    const errorMessage = result.stderr?.toLowerCase().includes("unauthorized")
      ? "Failed to authenticate with target registry"
      : `GPR push failed: ${result.stderr || result.stdout}`;
    throw new Error(errorMessage);
  }

  core.info(`Successfully pushed ${packageName} version ${version}`);
  return true;
}

export async function processPackageVersion(packageName, version, repoName, context, tempDir, gprPath) {
  const { sourceOrg, sourceRegistryUrl, targetOrg, targetApiUrl, ghSourcePat, ghTargetPat } = context;

  try {
    const packagePath = await downloadPackage(packageName, version, sourceOrg, sourceRegistryUrl, ghSourcePat, tempDir);
    await fixNuGetPackage(packagePath, packageName, version);
    await pushPackage(packagePath, gprPath, targetOrg, repoName, ghTargetPat, targetApiUrl, packageName, version);
    return true;
  } catch (error) {
    const status = error.response?.status;
    if (status === 401) {
      core.error(`Authentication failed for ${packageName} ${version}`);
    } else if (status === 404) {
      core.info(`Package/version not found for ${packageName} ${version}`);
    } else {
      core.error(`Migration failed: ${error.message} for ${packageName} ${version}`);
    }
    return false;
  }
}
