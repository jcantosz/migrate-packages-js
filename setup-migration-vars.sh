#!/bin/bash
# Script to create GitHub Actions variables and secrets for package migration workflow
# This script uses GitHub CLI (gh) to create variables and secrets at the repo or org level

# Configuration - Update these values
TARGET_TYPE="repo"  # Set to "repo" or "org"
TARGET_NAME="username/repo-name"  # For repo: "username/repo-name", for org: "org-name"

# Source values
SOURCE_ORG="source-org-name"
SOURCE_API_URL="https://api.github.com"  # For GitHub.com or "https://github.example.com/api/v3" for GHES
SOURCE_REGISTRY_URL=""  # Leave empty to derive from API URL

# Target values
TARGET_ORG="target-org-name"
TARGET_API_URL="https://api.github.com"  # For GitHub.com or "https://github.example.com/api/v3" for GHES
TARGET_REGISTRY_URL=""  # Leave empty to derive from API URL

# GitHub PATs - Best to read from environment or prompt for security
GH_SOURCE_PAT=${GH_SOURCE_PAT:-""}
GH_TARGET_PAT=${GH_TARGET_PAT:-""}

# Ensure PATs are provided
if [ -z "$GH_SOURCE_PAT" ]; then
  echo "Please enter the source GitHub PAT (will not be echoed):"
  read -s GH_SOURCE_PAT
  echo
fi

if [ -z "$GH_TARGET_PAT" ]; then
  echo "Please enter the target GitHub PAT (will not be echoed):"
  read -s GH_TARGET_PAT
  echo
fi

# Validate inputs
if [ -z "$GH_SOURCE_PAT" ] || [ -z "$GH_TARGET_PAT" ]; then
  echo "Error: GitHub PATs cannot be empty."
  exit 1
fi

# Set scope flag based on target type
if [ "$TARGET_TYPE" == "org" ]; then
  SCOPE="--org $TARGET_NAME"
  echo "Setting variables and secrets at the organization level for: $TARGET_NAME"
else
  SCOPE="--repo $TARGET_NAME"
  echo "Setting variables and secrets at the repository level for: $TARGET_NAME"
fi

echo "Creating variables..."

# Create variables
gh variable set source-org --body "$SOURCE_ORG" $SCOPE
echo "✅ Set variable: source-org"

gh variable set source-api-url --body "$SOURCE_API_URL" $SCOPE
echo "✅ Set variable: source-api-url"

if [ -n "$SOURCE_REGISTRY_URL" ]; then
  gh variable set source-registry-url --body "$SOURCE_REGISTRY_URL" $SCOPE
  echo "✅ Set variable: source-registry-url"
fi

gh variable set target-org --body "$TARGET_ORG" $SCOPE
echo "✅ Set variable: target-org"

gh variable set target-api-url --body "$TARGET_API_URL" $SCOPE
echo "✅ Set variable: target-api-url"

if [ -n "$TARGET_REGISTRY_URL" ]; then
  gh variable set target-registry-url --body "$TARGET_REGISTRY_URL" $SCOPE
  echo "✅ Set variable: target-registry-url"
fi

echo "Creating secrets..."

# Create secrets
gh secret set GH_SOURCE_PAT --body "$GH_SOURCE_PAT" $SCOPE
echo "✅ Set secret: GH_SOURCE_PAT"

gh secret set GH_TARGET_PAT --body "$GH_TARGET_PAT" $SCOPE
echo "✅ Set secret: GH_TARGET_PAT"

echo "Setup complete! All variables and secrets have been created."
echo "You can now run the package migration workflow."