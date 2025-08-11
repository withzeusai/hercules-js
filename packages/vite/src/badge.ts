import type { Plugin } from "vite";

export interface BadgePluginOptions {
  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Text to display in the badge
   * @default "Made with Hercules"
   */
  text?: string;

  /**
   * CSS position from bottom in pixels
   * @default 20
   */
  bottom?: number;

  /**
   * CSS position from right in pixels
   * @default 20
   */
  right?: number;

  /**
   * Background color of the badge
   * @default "#1a1a1a"
   */
  backgroundColor?: string;

  /**
   * Text color of the badge
   * @default "#ffffff"
   */
  textColor?: string;

  /**
   * Z-index of the badge
   * @default 9999
   */
  zIndex?: number;

  /**
   * Whether to show the badge in production
   * @default false
   */
  showInProduction?: boolean;
}

/**
 * Creates a badge plugin that injects a "Made with Hercules" badge
 */
export function badgePlugin(options: BadgePluginOptions = {}): Plugin {
  const {
    debug = false,
    text = "Made with Hercules",
    bottom = 20,
    right = 20,
    backgroundColor = "#1a1a1a",
    textColor = "#ffffff",
    zIndex = 9999,
    showInProduction = false
  } = options;

  // Skip in production unless explicitly enabled
  if (process.env.NODE_ENV === "production" && !showInProduction) {
    return {
      name: "vite-plugin-hercules-badge",
      apply: () => false
    };
  }

  return {
    name: "vite-plugin-hercules-badge",

    transformIndexHtml(html) {
      if (debug) {
        console.log("[Hercules Badge] Injecting badge into HTML");
      }

      // Create the badge HTML with inline styles
      const badgeHtml = `
        <a href="https://hercules.app" target="_blank" rel="noopener noreferrer" id="hercules-badge" style="
          position: fixed;
          bottom: ${bottom}px;
          right: ${right}px;
          padding: 6px 12px;
          border-radius: 6px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          font-size: 13px;
          font-weight: 500;
          z-index: ${zIndex};
          pointer-events: auto;
          user-select: none;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: transform 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease;
          text-decoration: none;
          cursor: pointer;
          background-color: ${backgroundColor};
          color: ${textColor};
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        ">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="flex-shrink: 0;">
            <path d="m7.99 0-7.01 9.38 6.02-.42-4.96 7.04 12.96-10-7.01.47 7.01-6.47z"></path>
          </svg>
          <span>${text}</span>
        </a>
        <style>
          /* Light mode styles */
          @media (prefers-color-scheme: light) {
            #hercules-badge {
              background-color: #ffffff !important;
              color: #1a1a1a !important;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1), 0 0 0 1px rgba(0, 0, 0, 0.08) !important;
            }
            
            #hercules-badge:hover {
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.1) !important;
            }
          }
          
          /* Dark mode styles */
          @media (prefers-color-scheme: dark) {
            #hercules-badge {
              background-color: #1a1a1a !important;
              color: #ffffff !important;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1) !important;
            }
            
            #hercules-badge:hover {
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.15) !important;
            }
          }
          
          #hercules-badge:hover {
            transform: translateY(-2px);
          }
          
          #hercules-badge:active {
            transform: translateY(0);
          }
          
          @media (max-width: 640px) {
            #hercules-badge {
              font-size: 12px;
              padding: 5px 10px;
              gap: 5px;
              bottom: ${Math.max(10, bottom - 10)}px;
              right: ${Math.max(10, right - 10)}px;
            }
            
            #hercules-badge svg {
              width: 12px;
              height: 12px;
            }
          }
          
          @media print {
            #hercules-badge {
              display: none !important;
            }
          }
        </style>
      `;

      // Inject the badge before the closing body tag
      if (html.includes("</body>")) {
        return html.replace("</body>", `${badgeHtml}\n</body>`);
      } else {
        // Fallback: append to end of html if no body tag
        return html.replace("</html>", `${badgeHtml}\n</html>`);
      }
    }
  };
}

export default badgePlugin;
