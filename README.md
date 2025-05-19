# GitHub Package Migration Tool

This repository contains GitHub Actions for migrating packages (npm, container, and NuGet) between GitHub organizations or GitHub instances.

## Overview

These actions allow you to migrate the following package types:

- NPM packages
- Container packages (Docker)
- NuGet packages

## What Migrates and What Doesn't

### What Migrates ✅

- **Package artifacts** - The actual package content (npm modules, container images, NuGet packages)
- **Package versions** - All versions of each package
- **Package tags** - For container packages, all tags are preserved
- **Package digests** - For container packages, all digests (SHAs) are preserved
- **Basic package metadata** - Package name and type

### What Doesn't Migrate ❌

- **Package visibility settings** - Public/private/internal visibility does not transfer
- **Repository linkage** - The association between packages and repositories is not automatically recreated
- **Package permissions** - Access control settings are not transferred
- **Creation date** - New packages will have new creation timestamps
- **Download counts** - Statistics and metrics are not transferred
- **Webhooks** - Any webhooks configured for the packages
- **GitHub Enterprise metadata** - Any GHES-specific metadata or settings

## Usage

The migration process consists of the following steps:

1. Discover packages using the `get-packages-action`
2. Migrate packages using one of the specialized migration actions:
   - `migrate-npm-packages-action`
   - `migrate-container-packages-action`
   - `migrate-nuget-packages-action`

See the [workflow-example.yml](workflow-example.yml) for a complete end-to-end example.

## Actions

### Get Packages Action

This action discovers packages in a source organization. It can filter packages by type and repository.

### Migrate NPM Packages Action

Migrates NPM packages by downloading the package tarballs and republishing them to the target organization.

### Migrate Container Packages Action

Migrates container images using Skopeo to transfer the images between registries.

### Migrate NuGet Packages Action

Migrates NuGet packages by downloading the package files and republishing them to the target organization.

## Requirements

- GitHub PATs with appropriate permissions
- Docker installation (for container migration)
- .NET SDK (for NuGet migration)

## Post-Migration Steps

After migration, you may need to manually:

- Set the correct visibility for each package
- Re-establish repository connections
- Set up appropriate permissions
- Verify all package versions are available

## License

[LICENSE](LICENSE)
