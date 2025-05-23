import * as core from "@actions/core";
import { getBaseHostname } from "../../shared/utils.js";

export function extractRepoName(repoName, existingUrl) {
  return (
    repoName ||
    existingUrl
      ?.split("/")
      ?.pop()
      ?.replace(/\.git$/, "") ||
    null
  );
}

export function buildRepoUrl(targetHostname, targetOrg, repoName) {
  return `git+https://${targetHostname}/${targetOrg}/${repoName}.git`;
}

export function updateRepositoryDetails(pkgJson, repoName, targetOrg, targetApiUrl) {
  const targetHostname = getBaseHostname(targetApiUrl);
  const existingUrl = typeof pkgJson.repository === "string" ? pkgJson.repository : pkgJson.repository?.url || "";
  const extractedName = extractRepoName(repoName, existingUrl);

  if (!extractedName) {
    return;
  }

  const newRepoUrl = buildRepoUrl(targetHostname, targetOrg, extractedName);
  if (typeof pkgJson.repository === "string") {
    pkgJson.repository = newRepoUrl;
  } else {
    pkgJson.repository = pkgJson.repository || {};
    pkgJson.repository.type = pkgJson.repository.type || "git";
    pkgJson.repository.url = newRepoUrl;
  }
  core.debug(`Updated repository URL to: ${newRepoUrl}`);
}
