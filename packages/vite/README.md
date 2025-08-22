# @usehercules/vite

A dummy Vite plugin for the Hercules application. This plugin is designed for **Vite 6** and provides a basic structure for future development.

## Installation

```bash
npm install @usehercules/vite --save-dev
# or
pnpm add @usehercules/vite --save-dev
# or
yarn add @usehercules/vite --dev
```

## Usage

Add the plugin to your `vite.config.js` or `vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import { herculesPlugin } from "@usehercules/vite";

export default defineConfig({
  plugins: [
    herculesPlugin({
      debug: true,
      message: "Custom message here!",
    }),
  ],
});
```

## Options

| Option    | Type      | Default                         | Description                            |
| --------- | --------- | ------------------------------- | -------------------------------------- |
| `debug`   | `boolean` | `false`                         | Enable debug logging to console        |
| `message` | `string`  | `'Hercules plugin is running!'` | Custom message to display during build |

## Features

Currently, this is a dummy plugin that:

- ✅ Provides debug logging capabilities
- ✅ Adds a custom development server endpoint at `/hercules-status`
- ✅ Includes all necessary Vite 6 plugin hooks
- ✅ Has proper TypeScript support
- ⏳ Ready for future functionality implementation

## Development Server Endpoint

When running in development mode, the plugin adds a status endpoint:

```
GET /hercules-status
```

Returns:

```json
{
  "status": "active",
  "plugin": "hercules",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Compatibility

- **Vite**: 6.x
- **Node.js**: 20.19+ / 22.12+
- **TypeScript**: 5.x

## Development

```bash
# Install dependencies
pnpm install

# Build the plugin
pnpm run build

# Watch mode for development
pnpm run dev
```

## License

MIT
