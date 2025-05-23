import { withRetry, fetchPackageVersions, createPackageResult, getRegistryUrl, logInfo } from "../../shared/utils.js";
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
  const references = [];

  for (const version of versions) {
    references.push({
      reference: version.name,
      isDigest: true,
    });

    const tags = version.metadata?.container?.tags || [];
    references.push(
      ...tags.map((tag) => ({
        reference: tag,
        isDigest: false,
      }))
    );
  }

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
  logInfo(`Migrating ${packageName}${referencePrefix}${reference}`);

  const skopeoCommand = `skopeo copy --preserve-digests --all --src-creds USERNAME:${ghSourcePat} --dest-creds USERNAME:${ghTargetPat} ${sourceImage} ${targetImage}`;

  const success = executeSkopeoCommand(skopeoCommand, packageName, reference);

  if (success) {
    logInfo(`Successfully migrated ${packageName}${referencePrefix}${reference}`);
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

  for (const { reference, isDigest } of references) {
    const success = await withRetry(() => performImageMigration(packageName, reference, context, isDigest), {
      onRetry: (error, attempt) => {
        const referenceType = isDigest ? "digest" : "tag";
        const referencePrefix = isDigest ? "@" : ":";
        logInfo(
          `Retry attempt ${attempt} for ${packageName}${referencePrefix}${reference} (${referenceType}). Error: ${error.message}`
        );
      },
    });

    updateReferenceResults(results, success, isDigest);
  }

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

  logInfo(`Migrating container package: ${packageName} from repo: ${repoName}`);

  const versions = await fetchPackageVersions(octokitSource, sourceOrg, packageName, "container");
  if (!versions.length) {
    return buildSkipResult(packageName);
  }

  const references = parseVersions(versions);
  const results = await migrateReferences(packageName, references, context);

  return createPackageResult(packageName, results.successCount, results.failureCount, {
    digestsSucceeded: results.digestsSucceeded,
    digestsFailed: results.digestsFailed,
    tagsSucceeded: results.tagsSucceeded,
    tagsFailed: results.tagsFailed,
  });
}
