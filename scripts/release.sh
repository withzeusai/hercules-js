#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in the root directory
if [ ! -f "package.json" ] || [ ! -f "pnpm-workspace.yaml" ]; then
    print_error "This script must be run from the root directory of the project"
    exit 1
fi

# Check if git is clean
if [ -n "$(git status --porcelain)" ]; then
    print_error "Git working directory is not clean. Please commit or stash changes before releasing."
    exit 1
fi

# Check if we're on main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    print_warning "You are not on the main branch (currently on: $CURRENT_BRANCH)"
    read -p "Do you want to continue? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_error "Release cancelled"
        exit 1
    fi
fi

# Get current version from auth package (as reference)
CURRENT_VERSION=$(node -p "require('./packages/auth/package.json').version")
print_status "Current version: $CURRENT_VERSION"

# Prompt for new version
echo "Enter the new version (current: $CURRENT_VERSION):"
echo "  - For patch: $(npm version --preid='' patch --no-git-tag-version --dry-run | sed 's/v//')"
echo "  - For minor: $(npm version --preid='' minor --no-git-tag-version --dry-run | sed 's/v//')"
echo "  - For major: $(npm version --preid='' major --no-git-tag-version --dry-run | sed 's/v//')"
read -p "Version: " NEW_VERSION

# Validate version format
if ! [[ $NEW_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9-]+(\.[0-9]+)?)?$ ]]; then
    print_error "Invalid version format. Please use semantic versioning (e.g., 1.0.0, 1.0.0-beta.1)"
    exit 1
fi

print_status "Preparing release for version $NEW_VERSION"

# Update package versions
print_status "Updating package.json files..."
pnpm --recursive exec -- npm version $NEW_VERSION --no-git-tag-version

# Build packages to ensure everything works
print_status "Building packages..."
pnpm build

# Run tests if they exist
print_status "Running tests..."
pnpm test

# Create git commit and tag
print_status "Creating git commit and tag..."
git add .
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

print_success "Release v$NEW_VERSION prepared successfully!"

# Ask if user wants to push
echo
read -p "Do you want to push the release to GitHub? This will trigger the publish workflow. (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_status "Pushing to GitHub..."
    git push origin main
    git push origin "v$NEW_VERSION"
    
    print_success "Release pushed! Check GitHub Actions for publishing status."
    print_status "GitHub Actions: https://github.com/withzeusai/hercules-js/actions"
else
    print_warning "Release not pushed. To push later, run:"
    echo "  git push origin main"
    echo "  git push origin v$NEW_VERSION"
fi

print_success "Release process completed!" 