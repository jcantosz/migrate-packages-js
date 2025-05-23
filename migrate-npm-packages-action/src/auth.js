import fs from "fs";
import path from "path";
import { trackResource } from "../../shared/utils.js";

export function setupNpmAuthentication(tempDir, targetOrg, targetRegistryUrl, ghTargetPat) {
  const npmrcPath = path.join(tempDir, ".npmrc");
  const config = [
    `@${targetOrg}:registry=${targetRegistryUrl}/`,
    `//${new URL(targetRegistryUrl).host}/:_authToken=${ghTargetPat}`,
  ].join("\n");

  fs.writeFileSync(npmrcPath, config);
  return trackResource(npmrcPath);
}
