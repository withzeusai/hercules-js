# @usehercules/vite

A Vite plugin for the Hercules application. This plugin supports **Vite 7 and Vite 8**.

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

| Option                    | Type      | Default                         | Description                                             |
| ------------------------- | --------- | ------------------------------- | ------------------------------------------------------- |
| `debug`                   | `boolean` | `false`                         | Enable debug logging to console                         |
| `message`                 | `string`  | `'Hercules plugin is running!'` | Custom message to display during build                  |
| `componentTagger.enabled` | `boolean` | `true`                          | Tag JSX elements with data attributes on the dev server |
| `visualEditor.enabled`    | `boolean` | `true`                          | Enable the visual editor (dev server only)              |

## Component tagging is dev-only

During `vite dev`, the component tagger adds `data-hercules-id` and
`data-hercules-name` attributes to JSX elements so the visual editor can map
DOM nodes back to source.

Both the tagger and the visual editor are `apply: "serve"` plugins, so they are
dropped from the `vite build` pipeline entirely. Built output contains no
tagging attributes and no injected editor script — published sites ship
white-label markup regardless of how `NODE_ENV` is set.

## Features

Currently, this is a dummy plugin that:

- ✅ Provides debug logging capabilities
- ✅ Adds a custom development server endpoint at `/hercules-status`
- ✅ Includes all necessary Vite plugin hooks
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

- **Vite**: 7.x / 8.x
- **Node.js**: 20.19+ / 22.12+
- **TypeScript**: 5.x / 6.x

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
