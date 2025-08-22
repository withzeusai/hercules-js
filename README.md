# hercules-js

Client JavaScript libraries for the Hercules project.

## Packages

- **[@usehercules/auth](./packages/auth)** - Authentication utilities using OIDC
- **[@usehercules/database](./packages/database)** - Database utilities for Hercules applications
- **[@usehercules/vite](./packages/vite)** - Vite plugin for Hercules applications
- **[@usehercules/hercules-js](./packages/hercules)** - Main entry point re-exporting all Hercules utilities

## Installation

```bash
# Install individual packages
npm install @usehercules/auth @usehercules/database @usehercules/vite

# Or install the main package that includes everything
npm install @usehercules/hercules-js
```

## Usage

### Authentication

```javascript
// Import from individual package
import { oidc, reactOidc } from "@usehercules/auth";

// Or import from the main package
import { auth, oidc, reactOidc } from "@usehercules/hercules-js";

// Use OIDC client directly
const client = new oidc.UserManager(settings);

// Or use React OIDC context
const { AuthProvider } = reactOidc;
```

### Vite Plugin

```javascript
import { defineConfig } from "vite";
import { herculesPlugin } from "@usehercules/vite";

export default defineConfig({
  plugins: [
    herculesPlugin({
      debug: true,
      message: "Hercules is running!",
    }),
  ],
});
```

## Documentation

- [Development Guide](./docs/DEVELOPMENT.md) - For contributors and maintainers

## License

MIT
