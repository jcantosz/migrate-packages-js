import * as core from "@actions/core";
import { withRetry, fetchPackageVersions, createPackageResult, getRegistryUrl } from "../../shared/utils.js";
import { executeSkopeoCommand } from "./docker.js";

/**
 * Build full image reference
 */
function buildImageReference(registry, org, packageName, reference, isDigest) {
  return `docker://${registry}/${org}/${packageName}${isDigest ? "@" : ":"}${reference}`;
}

/**
 * Parse versions into tags and digests
 */
function parseVersions(versions) {
  core.info(`Processing ${versions.length} version entries`);
  const references = [];

  for (const version of versions) {
    references.push({
      reference: version.name,
      isDigest: true,
    });
    core.debug(`Added digest: ${version.name}`);

    const tags = version.metadata?.container?.tags || [];
    core.info(`Found ${tags.length} tags for version ${version.name}`);
    references.push(
      ...tags.map((tag) => ({
        reference: tag,
        isDigest: false,
      }))
    );
    tags.forEach((tag) => core.debug(`Added tag: ${tag}`));
  }

  core.info(
    `Total references to migrate: ${references.length} (${references.filter((r) => r.isDigest).length} digests, ${
      references.filter((r) => !r.isDigest).length
    } tags)`
  );
  return references;
}

/**
 * Track migration results for a single reference
 */
function updateReferenceResults(results, success, isDigest) {
  success ? results.successCount++ : results.failureCount++;
  if (success) {
    isDigest ? results.digestsSucceeded++ : results.tagsSucceeded++;
  } else {
    isDigest ? results.digestsFailed++ : results.tagsFailed++;
  }
}

/**
 * Performs the actual image migration operation
 */
function performImageMigration(packageName, reference, context, isDigest) {
  const {
    sourceOrg,
    sourceApiUrl,
    sourceRegistryUrl,
    targetOrg,
    targetApiUrl,
    targetRegistryUrl,
    ghSourcePat,
    ghTargetPat,
  } = context;

  const sourceRegistry = getRegistryUrl("container", sourceApiUrl, sourceRegistryUrl);
  const targetRegistry = getRegistryUrl("container", targetApiUrl, targetRegistryUrl);

  const sourceImage = buildImageReference(sourceRegistry, sourceOrg, packageName, reference, isDigest);
  const targetImage = buildImageReference(targetRegistry, targetOrg, packageName, reference, isDigest);

  const referencePrefix = isDigest ? "@" : ":";
  core.info(`Migrating ${packageName}${referencePrefix}${reference}`);
  core.debug(`Source image: ${sourceImage}`);
  core.debug(`Target image: ${targetImage}`);

  const skopeoCommand = `skopeo copy --preserve-digests --all --src-creds USERNAME:${ghSourcePat} --dest-creds USERNAME:${ghTargetPat} ${sourceImage} ${targetImage}`;

  const success = executeSkopeoCommand(skopeoCommand, packageName, reference);

  if (success) {
    core.info(`Successfully migrated ${packageName}${referencePrefix}${reference}`);
  } else {
    core.error(`Failed to migrate ${packageName}${referencePrefix}${reference}`);
  }

  return success;
}

/**
 * Migrate a container package's references (both tags and digests)
 */
async function migrateReferences(packageName, references, context) {
  const results = {
    successCount: 0,
    failureCount: 0,
    digestsSucceeded: 0,
    digestsFailed: 0,
    tagsSucceeded: 0,
    tagsFailed: 0,
  };

  core.info(`Starting migration of ${references.length} references for package ${packageName}`);

  for (const { reference, isDigest } of references) {
    const success = await withRetry(() => performImageMigration(packageName, reference, context, isDigest), {
      onRetry: (error, attempt) => {
        const referenceType = isDigest ? "digest" : "tag";
        const referencePrefix = isDigest ? "@" : ":";
        core.info(
          `Retry attempt ${attempt} for ${packageName}${referencePrefix}${reference} (${referenceType}). Error: ${error.message}`
        );
      },
    });

    updateReferenceResults(results, success, isDigest);
  }

  core.info(`Migration results for ${packageName}:
    Total Success: ${results.successCount}
    Total Failed: ${results.failureCount}
    Digests Succeeded: ${results.digestsSucceeded}
    Digests Failed: ${results.digestsFailed}
    Tags Succeeded: ${results.tagsSucceeded}
    Tags Failed: ${results.tagsFailed}`);

  return results;
}

/**
 * Creates a skip result for packages with no versions
 */
export function buildSkipResult(packageName) {
  return createPackageResult(packageName, 0, 0, {
    skipped: true,
    reason: "No versions found",
    digestsSucceeded: 0,
    digestsFailed: 0,
    tagsSucceeded: 0,
    tagsFailed: 0,
  });
}

/**
 * Migrate a single container package with all its tags and digests
 */
export async function migratePackage(pkg, context) {
  const { octokitSource, sourceOrg } = context;
  const packageName = pkg.name;
  const repoName = pkg.repository?.name || "unknown";

  core.info(`Migrating container package: ${packageName} from repo: ${repoName}`);

  const versions = await fetchPackageVersions(octokitSource, sourceOrg, packageName, "container");
  if (!versions.length) {
    core.warning(`No versions found for package ${packageName}`);
    return buildSkipResult(packageName);
  }
  core.info(`Found ${versions.length} versions for package ${packageName}`);

  const references = parseVersions(versions);
  const results = await migrateReferences(packageName, references, context);

  return createPackageResult(packageName, results.successCount, results.failureCount, {
    digestsSucceeded: results.digestsSucceeded,
    digestsFailed: results.digestsFailed,
    tagsSucceeded: results.tagsSucceeded,
    tagsFailed: results.tagsFailed,
  });
}
