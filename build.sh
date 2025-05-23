#!/bin/bash

# Array of directories to process
DIRS=(
  "."
  "get-packages-action"
  "migrate-container-packages-action"
  "migrate-npm-packages-action"
  "migrate-nuget-packages-action"
)

# Install dependencies in each directory
for dir in "${DIRS[@]}"; do
  echo "Installing dependencies in $dir..."
  cd "$dir" || exit 1
  npm install
  cd - || exit 1
done

# Run build at the root
echo "Running build at root..."
npm run build

echo "Build complete!"