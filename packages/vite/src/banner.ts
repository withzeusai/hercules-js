import { loadEnv, type Plugin } from "vite";

export interface BannerPluginOptions {
  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Text to display in the banner
   * @default "Powered by Hercules"
   */
  text?: string;

  /**
   * CSS position from top in pixels
   * @default 0
   */
  top?: number;

  /**
   * Background color of the banner
   * @default "#1a1a1a"
   */
  backgroundColor?: string;

  /**
   * Text color of the banner
   * @default "#ffffff"
   */
  textColor?: string;

  /**
   * Z-index of the banner
   * @default 9999
   */
  zIndex?: number;

  /**
   * Height of the banner in pixels
   * @default 44
   */
  height?: number;
}

/**
 * Creates a banner plugin that injects a "Powered by Hercules" banner
 */
export function bannerPlugin(options: BannerPluginOptions = {}): Plugin {
  const {
    debug = false,
    text = "Powered by Hercules",
    top = 0,
    backgroundColor = "#1a1a1a",
    textColor = "#ffffff",
    zIndex = 9999,
    height = 44,
  } = options;

  let enabled = false;

  return {
    name: "vite-plugin-hercules-banner",

    config(_config, { mode }) {
      const env = loadEnv(mode, process.cwd());
      enabled = env.VITE_HERCULES_SHOW_WATERMARK?.trim() === "true";
    },

    transformIndexHtml(html) {
      if (!enabled) {
        return html;
      }

      if (debug) {
        console.log("[Hercules Banner] Injecting banner into HTML");
      }

      // Create the banner HTML with inline styles
      const bannerHtml = `
        <a href="https://hercules.app" target="_blank" rel="noopener noreferrer" id="hercules-banner" style="
          position: fixed;
          top: ${top}px;
          left: 0;
          right: 0;
          width: 100%;
          height: ${height}px;
          padding: 0 16px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          font-size: 13px;
          font-weight: 500;
          z-index: ${zIndex};
          pointer-events: auto;
          user-select: none;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: background-color 0.2s ease, box-shadow 0.2s ease;
          text-decoration: none;
          cursor: pointer;
          background-color: ${backgroundColor};
          color: ${textColor};
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        ">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="flex-shrink: 0;">
            <path d="m7.99 0-7.01 9.38 6.02-.42-4.96 7.04 12.96-10-7.01.47 7.01-6.47z"></path>
          </svg>
          <span>${text}</span>
        </a>
        <style>
          /* Light mode styles */
          @media (prefers-color-scheme: light) {
            #hercules-banner {
              background-color: #ffffff !important;
              color: #1a1a1a !important;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1), 0 1px 0 rgba(0, 0, 0, 0.08) !important;
            }
            
            #hercules-banner:hover {
              background-color: #f8f9fa !important;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15), 0 1px 0 rgba(0, 0, 0, 0.1) !important;
            }
          }
          
          /* Dark mode styles */
          @media (prefers-color-scheme: dark) {
            #hercules-banner {
              background-color: #1a1a1a !important;
              color: #ffffff !important;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), 0 1px 0 rgba(255, 255, 255, 0.1) !important;
            }
            
            #hercules-banner:hover {
              background-color: #2a2a2a !important;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(255, 255, 255, 0.15) !important;
            }
          }
          
          #hercules-banner:hover {
            background-color: rgba(255, 255, 255, 0.05);
          }
          
          #hercules-banner:active {
            background-color: rgba(255, 255, 255, 0.1);
          }
          
          @media (max-width: 640px) {
            #hercules-banner {
              font-size: 12px;
              height: ${Math.max(32, height - 8)}px;
              gap: 6px;
              padding: 0 12px;
            }
            
            #hercules-banner svg {
              width: 14px;
              height: 14px;
            }
          }
          
          @media print {
            #hercules-banner {
              display: none !important;
            }
          }
        </style>
      `;

      // Inject the banner before the closing body tag
      if (html.includes("</body>")) {
        return html.replace("</body>", `${bannerHtml}\n</body>`);
      } else {
        // Fallback: append to end of html if no body tag
        return html.replace("</html>", `${bannerHtml}\n</html>`);
      }
    },
  };
}

export default bannerPlugin;
