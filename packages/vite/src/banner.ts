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

      const randomId = Math.random().toString(36).substring(2, 15);

      // Create the banner HTML with inline styles and tracking script
      const bannerHtml = `
        <script>
          (function() {
            // Wait for DOM to be ready
            function initHerculesBanner() {
              const banner = document.getElementById('${randomId}');
              if (!banner) return;
              
              // Get referral information
              const hostname = window.location.hostname || 'unknown';
              const pathname = window.location.pathname || '/';
              const protocol = window.location.protocol || 'https:';
              const fullUrl = encodeURIComponent(window.location.href);
              
              // Build tracking URL with UTM parameters
              const baseUrl = 'https://hercules.app';
              const params = new URLSearchParams({
                utm_source: hostname,
                utm_medium: 'watermark_banner',
                utm_campaign: 'powered_by_hercules',
                referrer: fullUrl
              });
              
              // Update the banner href with tracking parameters
              banner.href = baseUrl + '?' + params.toString();
            }
            
            // Initialize when DOM is ready
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', initHerculesBanner);
            } else {
              initHerculesBanner();
            }
          })();
        </script>
        <a href="https://hercules.app" target="_blank" rel="noopener noreferrer" id="${randomId}" style="
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
            #${randomId} {
              background-color: #ffffff !important;
              color: #1a1a1a !important;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1), 0 1px 0 rgba(0, 0, 0, 0.08) !important;
            }
            
            #${randomId}:hover {
              background-color: #f8f9fa !important;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15), 0 1px 0 rgba(0, 0, 0, 0.1) !important;
            }
          }
          
          /* Dark mode styles */
          @media (prefers-color-scheme: dark) {
            #${randomId} {
              background-color: #1a1a1a !important;
              color: #ffffff !important;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), 0 1px 0 rgba(255, 255, 255, 0.1) !important;
            }
            
            #${randomId}:hover {
              background-color: #2a2a2a !important;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(255, 255, 255, 0.15) !important;
            }
          }
          
          #${randomId}:hover {
            background-color: rgba(255, 255, 255, 0.05);
          }
          
          #${randomId}:active {
            background-color: rgba(255, 255, 255, 0.1);
          }
          
          @media (max-width: 640px) {
            #${randomId} {
              font-size: 12px;
              height: ${Math.max(32, height - 8)}px;
              gap: 6px;
              padding: 0 12px;
            }
            
            #${randomId} svg {
              width: 14px;
              height: 14px;
            }
          }
          
          @media print {
            #${randomId} {
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
