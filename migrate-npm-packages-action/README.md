# migrate-npm-packages-action/migrate-npm-packages-action/README.md

# migrate-npm-packages-action

This GitHub Action migrates npm packages from a source organization to a target organization on GitHub. It utilizes the Octokit library to interact with the GitHub API and actions/core to manage inputs and outputs.

## Usage

To use this action in your GitHub workflow, you can include it as follows:

```yaml
name: Migrate npm Packages

on:
  workflow_dispatch:

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v2

      - name: Migrate npm packages
        uses: ./migrate-npm-packages-action
        with:
          source-org: '<source-org>'
          source-host: '<source-host>'
          target-org: '<target-org>'
          target-host: '<target-host>'
        env:
          GH_SOURCE_PAT: ${{ secrets.GH_SOURCE_PAT }}
          GH_TARGET_PAT: ${{ secrets.GH_TARGET_PAT }}
```

## Inputs

- `source-org`: The GitHub organization from which to migrate npm packages.
- `source-host`: The host of the source GitHub instance (e.g., `github.com`).
- `target-org`: The GitHub organization to which to migrate npm packages.
- `target-host`: The host of the target GitHub instance (e.g., `github.com`).

## Environment Variables

- `GH_SOURCE_PAT`: A GitHub Personal Access Token with `read:packages` and `read:org` scopes for the source organization.
- `GH_TARGET_PAT`: A GitHub Personal Access Token with `write:packages` and `read:org` scopes for the target organization.

## Example

To run the action, you need to set up the required environment variables and provide the necessary inputs. The example workflow above demonstrates how to trigger the action manually using the `workflow_dispatch` event.

## Notes

- Ensure that the target organization's repository names match those of the source organization.
- If a repository does not exist in the target organization, the package will still be imported but will not be mapped to a repository.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.