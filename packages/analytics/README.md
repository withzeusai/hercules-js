# @usehercules/analytics

A comprehensive, zero-dependency analytics library for Hercules applications with built-in support for Core Web Vitals, browser detection, UTM tracking, and more.

## Features

- 📊 **Comprehensive Event Tracking** - Pageviews, custom events, clicks, and user identification
- 🚀 **Performance Metrics** - Built-in Core Web Vitals (LCP, FID, CLS) and timing metrics
- 🔍 **Rich Context** - Automatic browser, OS, device type, and referrer detection
- 🏷️ **UTM Support** - Automatic UTM parameter tracking
- 🍪 **Smart Session Management** - Cookie-based visitor ID and session tracking
- 📦 **Event Buffering** - Batched sending with configurable buffer size
- 🔌 **Provider Pattern** - Extensible with custom providers
- 📴 **Offline Support** - Uses `sendBeacon` for reliable event delivery
- 🎯 **TypeScript First** - Full type safety and IntelliSense support
- 🪶 **Zero Dependencies** - Lightweight and self-contained

## Installation

```bash
npm install @usehercules/analytics
# or
pnpm add @usehercules/analytics
# or
yarn add @usehercules/analytics
```

## Quick Start

```typescript
import { initAnalytics } from '@usehercules/analytics';

// Initialize analytics
const analytics = initAnalytics({
  organizationId: 'your-org-id',
  websiteId: 'your-website-id',
  apiEndpoint: 'https://your-api.com/analytics/ingest',
  trackClicks: true,
  trackPerformance: true,
});

// Track custom events
analytics.track('button_clicked', {
  button_id: 'cta-hero',
  page_section: 'hero',
});

// Identify users
analytics.identify('user_123', {
  name: 'John Doe',
  email: 'john@example.com',
  plan: 'premium',
});

// Manual pageview tracking (automatic on init)
analytics.trackPageview({
  page_type: 'product',
  product_id: '123',
});
```

## Configuration

```typescript
interface AnalyticsConfig {
  // Required
  organizationId: string;        // Your organization ID
  websiteId: string;             // Your website ID
  
  // Optional
  apiEndpoint?: string;          // Analytics endpoint URL
  debug?: boolean;               // Enable debug logging (default: false)
  enabled?: boolean;             // Enable/disable tracking (default: true)
  bufferSize?: number;           // Events buffer size (default: 10)
  flushInterval?: number;        // Auto-flush interval in ms (default: 5000)
  trackClicks?: boolean;         // Auto-track clicks (default: false)
  trackPerformance?: boolean;    // Track performance metrics (default: true)
  cookieDomain?: string;         // Cookie domain for visitor ID
  cookiePath?: string;           // Cookie path (default: '/')
  sessionTimeout?: number;       // Session timeout in minutes (default: 30)
  beforeSend?: (events) => events; // Transform events before sending
}
```

## Event Structure

Each event contains comprehensive data:

```typescript
interface HerculesEvent {
  // Core fields
  event_id: string;
  event_type: 'pageview' | 'pageleave' | 'custom' | 'click' | 'identify';
  event_name: string;
  timestamp: number;
  
  // User & Session
  visitor_id: string;        // Persistent visitor ID (2-year cookie)
  session_id: string;        // Session ID (expires after inactivity)
  user_id?: string;          // Set via identify()
  
  // Page context
  url_path: string;
  url_query: string;
  url_hash: string;
  
  // Traffic source
  referrer: string;
  referrer_domain: string;
  referrer_source: string;   // google, facebook, twitter, etc.
  
  // UTM parameters
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  
  // Device & Browser
  browser: string;
  browser_version: string;
  os: string;
  os_version: string;
  device_type?: string;      // desktop, mobile, tablet
  screen_resolution?: string;
  viewport_size?: string;
  
  // Custom properties
  properties: Record<string, string>;
  properties_numeric: Record<string, number>;
  
  // Performance metrics (pageview only)
  page_load_time?: number;
  dom_interactive?: number;
  time_to_first_byte?: number;
  first_contentful_paint?: number;
  largest_contentful_paint?: number;
  first_input_delay?: number;
  cumulative_layout_shift?: number;
}
```

## Providers

Add custom providers to send events to multiple destinations:

```typescript
import { ConsoleProvider, LocalStorageProvider } from '@usehercules/analytics';

// Console provider for debugging
analytics.addProvider(new ConsoleProvider());

// Local storage provider for offline support
const storageProvider = new LocalStorageProvider('my_analytics', 100);
analytics.addProvider(storageProvider);

// Custom provider
class CustomProvider {
  name = 'custom';
  
  async send(events: HerculesEvent[]): Promise<void> {
    // Send events to your custom destination
    await fetch('https://custom-endpoint.com', {
      method: 'POST',
      body: JSON.stringify(events),
    });
  }
}

analytics.addProvider(new CustomProvider());
```

## Helper Functions

```typescript
import { track, identify, trackPageview } from '@usehercules/analytics';

// Direct function calls (requires initAnalytics to be called first)
track('event_name', { property: 'value' });
identify('user_id', { trait: 'value' });
trackPageview({ page: 'home' });
```

## Utility Functions

```typescript
import { utils } from '@usehercules/analytics';

// Debounced tracking
const trackScroll = utils.debounce(() => {
  track('scroll', { depth: window.scrollY });
}, 500);

// Throttled tracking
const trackMouseMove = utils.throttle((e) => {
  track('mouse_move', { x: e.clientX, y: e.clientY });
}, 1000);

// Get browser information
const browserInfo = utils.getBrowserInfo();

// Check Do Not Track
if (!utils.isDoNotTrackEnabled()) {
  // Track events
}

// Safe JSON stringify (handles circular refs)
const jsonString = utils.safeStringify(complexObject);
```

## Core Web Vitals

The library automatically tracks Core Web Vitals when `trackPerformance` is enabled:

- **LCP (Largest Contentful Paint)** - Loading performance
- **FID (First Input Delay)** - Interactivity
- **CLS (Cumulative Layout Shift)** - Visual stability
- **FCP (First Contentful Paint)** - First render
- **TTFB (Time to First Byte)** - Server response time

These metrics are automatically included in pageview events.

## Click Tracking

When `trackClicks` is enabled, the library automatically tracks clicks on:
- All `<a>` links
- All `<button>` elements  
- Any element with `data-track-click` attribute

Each click event includes:
- Element type (a, button, etc.)
- Text content (first 100 chars)
- Class names and ID
- Href (for links)

## Browser Support

- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+

The library gracefully handles missing features in older browsers.

## License

MIT

