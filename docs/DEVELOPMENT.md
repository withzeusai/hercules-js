# Development Guide

This document contains information for maintainers and contributors working on the hercules-js monorepo.

## Development Setup

### Prerequisites

- Node.js 20+ 
- pnpm 10.13.1+

### Getting Started

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run development mode (watch mode)
pnpm dev

# Run tests
pnpm test
```

### Project Structure

This project uses:
- **pnpm workspaces** for monorepo management
- **Turbo** for build orchestration and caching
- **TypeScript** for type safety
- **GitHub Actions** for automated publishing

## Publishing

### Automated Publishing

Packages are automatically published to npm when you push a tag to the main branch. The GitHub Actions workflow will:

1. Build all packages
2. Run tests
3. Update package versions to match the tag
4. Publish to npm with public access
5. Create a GitHub release

### Creating a Release

Use the included release script for an interactive release process:

```bash
pnpm release
```

This script will:
- Check that your working directory is clean
- Prompt for the new version number
- Update all package.json files
- Build and test packages
- Create a git commit and tag
- Optionally push to GitHub to trigger publishing

### Manual Release

If you prefer to create releases manually:

```bash
# Update versions in all packages
pnpm --recursive exec -- npm version 1.2.3 --no-git-tag-version

# Commit and tag
git add .
git commit -m "chore: release v1.2.3"
git tag -a "v1.2.3" -m "Release v1.2.3"

# Push to trigger publishing
git push origin main
git push origin v1.2.3
```

### Setting up NPM Token

To enable publishing, you need to add an `NPM_TOKEN` secret to your GitHub repository:

1. Create an npm access token at https://www.npmjs.com/settings/tokens
2. Add it as a repository secret named `NPM_TOKEN`
3. The token needs publish permissions for the `@usehercules` organization

## Package Development

### Adding a New Package

1. Create a new directory under `packages/`
2. Add a `package.json` with the `@usehercules/` scope
3. Include the package in the workspace by updating `pnpm-workspace.yaml` (if needed)
4. Add build scripts and proper TypeScript configuration
5. Update the main README to include the new package

### Testing

Each package should include its own tests. Run tests across all packages with:

```bash
pnpm test
```

### Building

Build all packages:

```bash
pnpm build
```

Build a specific package:

```bash
# Build individual packages
pnpm --filter @usehercules/auth build
pnpm --filter @usehercules/database build
pnpm --filter @usehercules/vite build
pnpm --filter @usehercules/hercules-js build

# Or build all packages
pnpm build
```

### Linting and Formatting

(Add your linting setup here when implemented)

## Troubleshooting

### Common Issues

- **Build failures**: Ensure all dependencies are installed with `pnpm install`
- **Version conflicts**: Clear node_modules and reinstall dependencies
- **Publishing failures**: Check that NPM_TOKEN is properly set in GitHub secrets

### Debugging

Use the debug options in the Vite plugin for development:

```javascript
herculesPlugin({
  debug: true,
  message: 'Debug message here'
})
``` 