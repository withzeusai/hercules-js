import type { Plugin, ViteDevServer } from "vite";

// Import from extracted modules
import { analyzeComponentClassName } from "./ast-analyzer";
import { updateComponentClassName } from "./ast-transformer";

export interface VisualEditorOptions {
  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * The data attribute to use for element identification
   * @default "data-hercules-id"
   */
  dataAttribute?: string;
}

export function visualEditorPlugin(options: VisualEditorOptions = {}): Plugin {
  const { debug = false, dataAttribute = "data-hercules-id" } = options;
  let server: ViteDevServer;

  return {
    name: "vite-plugin-hercules-visual-editor",
    enforce: "pre",

    configureServer(_server) {
      server = _server;

      // Serve the visual editor UI script
      server.middlewares.use("/__hercules_visual_editor.js", (req, res, next) => {
        if (req.method === "GET") {
          res.setHeader("Content-Type", "application/javascript");
          res.end(getVisualEditorScript(dataAttribute));
        } else {
          next();
        }
      });

      // Handle className update requests
      server.middlewares.use("/__hercules_update_class", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const data = JSON.parse(body);
              const { componentId, newClassName, updateType } = data;

              const result = await updateComponentClassName(
                componentId,
                newClassName,
                server.config.root,
                updateType
              );

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error updating className:", error);
              }
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, error: String(error) }));
            }
          });
        } else {
          next();
        }
      });

      // Handle className analysis requests
      server.middlewares.use("/__hercules_analyze_class", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const { componentId } = JSON.parse(body);

              const result = await analyzeComponentClassName(componentId, server.config.root);

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error analyzing className:", error);
              }
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ success: false, error: String(error) }));
            }
          });
        } else {
          next();
        }
      });
    },

    transformIndexHtml(html) {
      // Only inject in development mode
      if (process.env.NODE_ENV !== "production") {
        const editorScript = '<script type="module" src="/__hercules_visual_editor.js"></script>';

        if (html.includes("</body>")) {
          return html.replace("</body>", `${editorScript}\n</body>`);
        } else {
          return html + editorScript;
        }
      }
      return html;
    }
  };
}

function getVisualEditorScript(dataAttribute: string): string {
  // For now, return the old inline script
  // TODO: Replace with buildClientScript(dataAttribute) once the bundling is set up
  return `
(function() {
  let selectedElement = null;
  let editorPanel = null;
  let isEditorActive = false;
  
  // Create the visual editor UI
  function createEditorUI() {
    const style = document.createElement('style');
    style.textContent = \`
      #hercules-visual-editor {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: white;
        border: 2px solid #3b82f6;
        border-radius: 8px;
        padding: 16px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        z-index: 99999;
        font-family: system-ui, -apple-system, sans-serif;
        width: 320px;
        display: none;
      }
      
      #hercules-visual-editor.active {
        display: block;
      }
      
      #hercules-visual-editor h3 {
        margin: 0 0 12px 0;
        font-size: 16px;
        font-weight: 600;
        color: #1f2937;
      }
      
      #hercules-visual-editor .editor-content {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      #hercules-visual-editor label {
        font-size: 14px;
        font-weight: 500;
        color: #4b5563;
        display: block;
        margin-bottom: 4px;
      }
      
      #hercules-visual-editor input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        font-size: 14px;
        font-family: 'Consolas', 'Monaco', monospace;
      }
      
      #hercules-visual-editor input:focus {
        outline: none;
        border-color: #3b82f6;
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
      }
      
      #hercules-visual-editor .button-group {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      
      #hercules-visual-editor button {
        flex: 1;
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      #hercules-visual-editor .btn-primary {
        background: #3b82f6;
        color: white;
      }
      
      #hercules-visual-editor .btn-primary:hover {
        background: #2563eb;
      }
      
      #hercules-visual-editor .btn-secondary {
        background: #e5e7eb;
        color: #4b5563;
      }
      
      #hercules-visual-editor .btn-secondary:hover {
        background: #d1d5db;
      }
      
      #hercules-visual-editor .component-id {
        font-size: 12px;
        color: #6b7280;
        font-family: 'Consolas', 'Monaco', monospace;
        word-break: break-all;
      }
      
      #hercules-visual-editor .warning {
        background: #fef3c7;
        border: 1px solid #f59e0b;
        border-radius: 6px;
        padding: 10px;
        margin: 10px 0;
        font-size: 13px;
        color: #92400e;
      }
      
      #hercules-visual-editor .ternary-editor {
        background: #f3f4f6;
        border-radius: 6px;
        padding: 12px;
        margin: 10px 0;
      }
      
      #hercules-visual-editor .ternary-condition {
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 12px;
        color: #4b5563;
        margin-bottom: 8px;
        padding: 6px;
        background: white;
        border-radius: 4px;
      }
      
      #hercules-visual-editor .ternary-branch {
        margin: 8px 0;
      }
      
      #hercules-visual-editor .ternary-branch label {
        font-size: 12px;
        font-weight: 600;
        color: #374151;
      }
      
      .hercules-highlight {
        outline: 2px solid #3b82f6 !important;
        outline-offset: 2px !important;
        position: relative !important;
      }
      
      .hercules-highlight::after {
        content: attr(${dataAttribute});
        position: absolute;
        top: -24px;
        left: 0;
        background: #3b82f6;
        color: white;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-family: 'Consolas', 'Monaco', monospace;
        pointer-events: none;
        white-space: nowrap;
        z-index: 99998;
      }
      
      #hercules-toggle-btn {
        position: fixed;
        bottom: 20px;
        left: 20px;
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 8px;
        padding: 12px 20px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        z-index: 99998;
        transition: all 0.2s;
      }
      
      #hercules-toggle-btn:hover {
        background: #2563eb;
        transform: translateY(-1px);
        box-shadow: 0 6px 8px rgba(0, 0, 0, 0.15);
      }
      
      #hercules-toggle-btn.active {
        background: #dc2626;
      }
    \`;
    document.head.appendChild(style);
    
    // Create toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'hercules-toggle-btn';
    toggleBtn.textContent = 'Visual Editor';
    toggleBtn.onclick = toggleEditor;
    document.body.appendChild(toggleBtn);
    
    // Create editor panel
    editorPanel = document.createElement('div');
    editorPanel.id = 'hercules-visual-editor';
    editorPanel.innerHTML = \`
      <h3>Visual Class Editor</h3>
      <div class="editor-content" id="editor-content">
        <div>
          <label>Component ID:</label>
          <div class="component-id" id="component-id">Select an element</div>
        </div>
        <div id="class-editor-container">
          <!-- Dynamic content will be inserted here -->
        </div>
      </div>
    \`;
    document.body.appendChild(editorPanel);
  }
  
  function toggleEditor() {
    isEditorActive = !isEditorActive;
    const toggleBtn = document.getElementById('hercules-toggle-btn');
    
    if (isEditorActive) {
      toggleBtn.classList.add('active');
      toggleBtn.textContent = 'Exit Editor';
      document.addEventListener('click', handleElementClick, true); // Use capture phase
      document.addEventListener('mouseover', handleElementHover);
      document.addEventListener('mouseout', handleElementHover);
    } else {
      toggleBtn.classList.remove('active');
      toggleBtn.textContent = 'Visual Editor';
      document.removeEventListener('click', handleElementClick, true); // Use capture phase
      document.removeEventListener('mouseover', handleElementHover);
      document.removeEventListener('mouseout', handleElementHover);
      closeEditor();
    }
  }
  
  function handleElementHover(e) {
    if (!isEditorActive) return;
    
    const element = e.target;
    const componentId = element.getAttribute('${dataAttribute}');
    
    if (componentId && e.type === 'mouseover') {
      element.classList.add('hercules-highlight');
    } else if (e.type === 'mouseout') {
      element.classList.remove('hercules-highlight');
    }
  }
  
  function handleElementClick(e) {
    if (!isEditorActive) return;
    
    const element = e.target;
    const componentId = element.getAttribute('${dataAttribute}');
    
    if (componentId) {
      e.preventDefault();
      e.stopPropagation();
      selectElement(element, componentId);
    }
  }
  
  async function selectElement(element, componentId) {
    // Remove previous selection
    if (selectedElement) {
      selectedElement.classList.remove('hercules-highlight');
    }
    
    selectedElement = element;
    element.classList.add('hercules-highlight');
    
    // Show editor panel
    editorPanel.classList.add('active');
    
    // Update component ID
    document.getElementById('component-id').textContent = componentId;
    
    // Analyze the className
    try {
      const response = await fetch('/__hercules_analyze_class', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ componentId })
      });
      
      const result = await response.json();
      
      if (result.success && result.analysis) {
        renderClassEditor(result.analysis, element);
      } else {
        // Fallback to simple editor
        renderSimpleEditor(element.className.replace('hercules-highlight', '').trim());
      }
    } catch (error) {
      console.error('[Hercules] Error analyzing className:', error);
      // Fallback to simple editor
      renderSimpleEditor(element.className.replace('hercules-highlight', '').trim());
    }
  }
  
  function renderClassEditor(analysis, element) {
    const container = document.getElementById('class-editor-container');
    
    switch (analysis.type) {
      case 'ternary':
        container.innerHTML = \`
          <div class="ternary-editor">
            <div class="ternary-condition">
              Condition: <code>\${analysis.condition}</code>
            </div>
            <div class="ternary-branch">
              <label>When TRUE:</label>
              <input type="text" id="ternary-true-input" value="\${analysis.trueValue || ''}" placeholder="Enter classes for true condition" />
            </div>
            <div class="ternary-branch">
              <label>When FALSE:</label>
              <input type="text" id="ternary-false-input" value="\${analysis.falseValue || ''}" placeholder="Enter classes for false condition" />
            </div>
          </div>
          <div class="warning">
            ⚠️ This element uses a conditional expression. You can edit each branch separately, or replace the entire expression with a static value.
          </div>
          <div>
            <label>Replace with static value (optional):</label>
            <input type="text" id="static-replace-input" placeholder="Leave empty to preserve ternary" />
          </div>
          <div class="button-group">
            <button class="btn-primary" onclick="window.herculesApplyTernaryChanges()">Apply</button>
            <button class="btn-secondary" onclick="window.herculesCloseEditor()">Cancel</button>
          </div>
        \`;
        // Focus on the appropriate input based on current state
        const currentClasses = element.className.replace('hercules-highlight', '').trim();
        if (currentClasses === analysis.trueValue) {
          document.getElementById('ternary-true-input').focus();
        } else {
          document.getElementById('ternary-false-input').focus();
        }
        break;
        
      case 'template':
      case 'complex':
        container.innerHTML = \`
          <div class="warning">
            ⚠️ This element uses a dynamic expression: <code>\${analysis.expression}</code>
            <br><br>
            Editing will replace this expression with a static value.
          </div>
          <div>
            <label>className:</label>
            <input type="text" id="class-input" value="\${element.className.replace('hercules-highlight', '').trim()}" placeholder="Enter CSS classes" />
          </div>
          <div class="button-group">
            <button class="btn-primary" onclick="window.herculesApplyChanges()">Replace Expression</button>
            <button class="btn-secondary" onclick="window.herculesCloseEditor()">Cancel</button>
          </div>
        \`;
        document.getElementById('class-input').focus();
        break;
        
      default: // static
        renderSimpleEditor(analysis.value || '');
    }
  }
  
  function renderSimpleEditor(currentValue) {
    const container = document.getElementById('class-editor-container');
    container.innerHTML = \`
      <div>
        <label>className:</label>
        <input type="text" id="class-input" value="\${currentValue}" placeholder="Enter CSS classes" />
      </div>
      <div class="button-group">
        <button class="btn-primary" onclick="window.herculesApplyChanges()">Apply</button>
        <button class="btn-secondary" onclick="window.herculesCloseEditor()">Cancel</button>
      </div>
    \`;
    document.getElementById('class-input').focus();
  }
  
  function closeEditor() {
    if (selectedElement) {
      selectedElement.classList.remove('hercules-highlight');
      selectedElement = null;
    }
    editorPanel.classList.remove('active');
  }
  
  window.herculesCloseEditor = closeEditor;
  
  window.herculesApplyChanges = async function() {
    if (!selectedElement) return;
    
    const componentId = selectedElement.getAttribute('${dataAttribute}');
    const newClassName = document.getElementById('class-input').value.trim();
    
    try {
      const response = await fetch('/__hercules_update_class', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          componentId,
          newClassName,
          updateType: 'static'
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        // Update will trigger HMR reload
        console.log('[Hercules] className updated successfully');
      } else {
        console.error('[Hercules] Failed to update className:', result.error);
        alert('Failed to update className: ' + result.error);
      }
    } catch (error) {
      console.error('[Hercules] Error updating className:', error);
      alert('Error updating className: ' + error.message);
    }
    
    closeEditor();
  };
  
  window.herculesApplyTernaryChanges = async function() {
    if (!selectedElement) return;
    
    const componentId = selectedElement.getAttribute('${dataAttribute}');
    const staticReplace = document.getElementById('static-replace-input')?.value.trim();
    
    // If user wants to replace with static value
    if (staticReplace) {
      try {
        const response = await fetch('/__hercules_update_class', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            componentId,
            newClassName: staticReplace,
            updateType: 'replace'
          })
        });
        
        const result = await response.json();
        
        if (result.success) {
          console.log('[Hercules] Replaced ternary with static className');
        } else {
          console.error('[Hercules] Failed to update className:', result.error);
          alert('Failed to update className: ' + result.error);
        }
      } catch (error) {
        console.error('[Hercules] Error updating className:', error);
        alert('Error updating className: ' + error.message);
      }
    } else {
      // Update individual branches
      const trueValue = document.getElementById('ternary-true-input')?.value.trim();
      const falseValue = document.getElementById('ternary-false-input')?.value.trim();
      
      try {
        // Update true branch
        if (trueValue !== undefined) {
          await fetch('/__hercules_update_class', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              componentId,
              newClassName: trueValue,
              updateType: 'ternary-true'
            })
          });
        }
        
        // Update false branch
        if (falseValue !== undefined) {
          await fetch('/__hercules_update_class', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              componentId,
              newClassName: falseValue,
              updateType: 'ternary-false'
            })
          });
        }
        
        console.log('[Hercules] Updated ternary branches');
      } catch (error) {
        console.error('[Hercules] Error updating ternary:', error);
        alert('Error updating ternary: ' + error.message);
      }
    }
    
    closeEditor();
  };
  
  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createEditorUI);
  } else {
    createEditorUI();
  }
})();
  `;
}
