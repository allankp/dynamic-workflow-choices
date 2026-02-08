# Dynamic Workflow Choices

[![CI](https://github.com/allankp/dynamic-workflow-choices/actions/workflows/ci.yml/badge.svg)](https://github.com/allankp/dynamic-workflow-choices/actions/workflows/ci.yml)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Dynamic%20Workflow%20Choices-blue?logo=github)](https://github.com/marketplace/actions/dynamic-workflow-choices)

A GitHub Action to dynamically add, update, or delete choices from `workflow_dispatch` input options in your repository workflows.

## Features

- **Add** new choices to workflow input options
- **Update** existing choices to new values
- **Delete** choices from workflow inputs
- Supports updating multiple workflows at once

## Usage

### Basic Example - Add a Choice

```yaml
name: Add Environment
on:
  workflow_dispatch:
    inputs:
      new-environment:
        description: 'New environment name to add'
        required: true
        type: string

jobs:
  add-choice:
    runs-on: ubuntu-latest
    steps:
      - name: Add environment choice
        uses: allankp/dynamic-workflow-choices@v2.0.0 # x-release-please-version
        with:
          action: add
          input-name: environment
          workflows: deploy.yml
          choice-value: ${{ inputs.new-environment }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Delete a Choice

```yaml
- name: Delete old environment
  uses: allankp/dynamic-workflow-choices@v2.0.0 # x-release-please-version
  with:
    action: delete
    input-name: environment
    workflows: deploy.yml,release.yml
    choice-value: deprecated-env
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Update a Choice

```yaml
- name: Rename environment
  uses: allankp/dynamic-workflow-choices@v2.0.0 # x-release-please-version
  with:
    action: update
    input-name: environment
    workflows: deploy.yml
    choice-value: staging
    new-choice-value: stage
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `action` | Action to perform: `add`, `update`, or `delete` | Yes | - |
| `input-name` | Name of the workflow input to modify | Yes | - |
| `workflows` | Comma-separated list of workflow files to update | Yes | - |
| `choice-value` | The choice value to add, update, or delete | Yes | - |
| `new-choice-value` | New value (required for `update` action) | No | - |
| `github-token` | GitHub token with repo write permissions | Yes | `${{ github.token }}` |
| `commit-message` | Custom commit message | No | `chore: update workflow input choices` |
| `branch` | Branch to commit changes to | No | Current branch |

## Outputs

| Output | Description |
|--------|-------------|
| `updated-workflows` | Comma-separated list of workflows that were updated |
| `changes-made` | Whether any changes were made (`true` or `false`) |

## Requirements

The workflow using this action needs:

1. **Write permissions** to the repository contents
2. A target workflow with `workflow_dispatch` trigger and `choice` type inputs

### Target Workflow Example

The workflows you're updating should have inputs like this:

```yaml
name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options:
          - development
          - staging
          - production
```

## Permissions

You may need to grant additional permissions to the `GITHUB_TOKEN`:

```yaml
permissions:
  contents: write
```

Or use a Personal Access Token (PAT) with `repo` scope for cross-repository updates.

## Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Run all checks
npm run all
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

MIT License - see [LICENSE](LICENSE) for details.
