# hercules-js

Client JavaScript libraries for the Hercules project.

## Packages

- **[@usehercules/auth](./packages/auth)** - Authentication utilities using OIDC
- **[@usehercules/vite](./packages/vite)** - Vite plugin for Hercules applications

## Installation

```bash
npm install @usehercules/auth @usehercules/vite
```

## Usage

### Authentication

```javascript
import { oidc, reactOidc } from '@usehercules/auth';

// Use OIDC client directly
const client = new oidc.UserManager(settings);

// Or use React OIDC context
const { AuthProvider } = reactOidc;
```

### Vite Plugin

```javascript
import { defineConfig } from 'vite';
import { herculesPlugin } from '@usehercules/vite';

export default defineConfig({
  plugins: [
    herculesPlugin({
      debug: true,
      message: 'Hercules is running!'
    })
  ],
});
```

## Documentation

- [Development Guide](./docs/DEVELOPMENT.md) - For contributors and maintainers

## License

MIT
