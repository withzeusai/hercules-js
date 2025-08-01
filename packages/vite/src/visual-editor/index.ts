import type { Plugin, ViteDevServer } from "vite";

// Import from extracted modules
import { analyzeComponentClassName, analyzeComponentTextContent } from "./ast-analyzer";
import { updateComponentClassName, updateComponentTextContent } from "./ast-transformer";

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
              const { componentId, newClassName } = data;

              const result = await updateComponentClassName(
                componentId,
                newClassName,
                server.config.root
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

      // Handle text content analysis requests
      server.middlewares.use("/__hercules_analyze_text", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const { componentId } = JSON.parse(body);

              const result = await analyzeComponentTextContent(componentId, server.config.root);

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error analyzing text content:", error);
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

      // Handle text content update requests
      server.middlewares.use("/__hercules_update_text", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const data = JSON.parse(body);
              const { componentId, newTextContent } = data;

              const result = await updateComponentTextContent(
                componentId,
                newTextContent,
                server.config.root
              );

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error updating text content:", error);
              }
              res.statusCode = 500;
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
  let currentEditorMode = 'class';
  let highlighterElement = null;
  let selectedHighlighterElement = null;
  
  // Create the visual editor UI
  function createEditorUI() {
    const style = document.createElement('style');
    style.textContent = \`
      #hercules-visual-editor {
        position: absolute;
        background: white;
        border: 2px solid #3b82f6;
        border-radius: 8px;
        padding: 16px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        z-index: 99999;
        font-family: system-ui, -apple-system, sans-serif;
        width: 320px;
        max-height: 400px;
        overflow-y: auto;
        display: none;
        margin-top: 10px;
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
      
      #hercules-visual-editor .close-btn {
        position: absolute;
        top: 12px;
        right: 12px;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: #6b7280;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
        padding: 0;
        transition: color 0.2s;
      }
      
      #hercules-visual-editor .close-btn:hover {
        color: #1f2937;
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
      
      #hercules-visual-editor .editor-mode-toggle {
        display: flex;
        gap: 4px;
        margin: 12px 0;
        background: #f3f4f6;
        padding: 4px;
        border-radius: 6px;
      }
      
      #hercules-visual-editor .mode-btn {
        flex: 1;
        padding: 6px 12px;
        border: none;
        background: transparent;
        color: #6b7280;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.2s;
      }
      
      #hercules-visual-editor .mode-btn.active {
        background: white;
        color: #3b82f6;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
      }
      
      #hercules-visual-editor .mode-btn:hover:not(.active) {
        color: #4b5563;
      }
      
      #hercules-visual-editor .text-warning {
        background: #fef3c7;
        border: 1px solid #f59e0b;
        border-radius: 6px;
        padding: 10px;
        margin: 10px 0;
        font-size: 13px;
        color: #92400e;
      }
      
      .hercules-highlighter {
        position: fixed;
        pointer-events: none;
        z-index: 99997;
      }
      
      .hercules-highlighter-outline {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        outline: 2px solid #93bbf9;
        outline-offset: 2px;
        border-radius: 4px;
      }
      
      .hercules-highlighter-label {
        position: absolute;
        top: -24px;
        left: 0;
        background: #93bbf9;
        color: white;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-family: 'Consolas', 'Monaco', monospace;
        white-space: nowrap;
      }
      
      /* Selected state - darker blue */
      .hercules-highlighter.selected .hercules-highlighter-outline {
        outline-color: #3b82f6;
        outline-width: 2px;
      }
      
      .hercules-highlighter.selected .hercules-highlighter-label {
        background: #3b82f6;
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
      <button class="close-btn" onclick="window.herculesCloseEditor()" aria-label="Close">&times;</button>
      <div class="editor-content" id="editor-content">
				<div class="component-id" id="component-id">Select an element</div>
        <div class="editor-mode-toggle">
          <button class="mode-btn active" data-mode="class" onclick="window.herculesSetEditorMode('class')">Class</button>
          <button class="mode-btn" data-mode="text" onclick="window.herculesSetEditorMode('text')">Text</button>
        </div>
        <div id="class-editor-container">
          <!-- Dynamic content will be inserted here -->
        </div>
        <div id="text-editor-container" style="display: none;">
          <!-- Dynamic text content will be inserted here -->
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
      window.addEventListener('scroll', handleScroll, true);
      window.addEventListener('resize', handleResize);
    } else {
      toggleBtn.classList.remove('active');
      toggleBtn.textContent = 'Visual Editor';
      document.removeEventListener('click', handleElementClick, true); // Use capture phase
      document.removeEventListener('mouseover', handleElementHover);
      document.removeEventListener('mouseout', handleElementHover);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
      closeEditor();
    }
  }
  
  // Helper function to get a friendly tag name from an element
  function getElementTagName(element) {
    // Get the raw tag name
    let tagName = element.tagName.toLowerCase();
    
    // Check if this is a React component by looking at data attributes or class names
    // Many React component libraries add specific classes or data attributes
    const className = element.className;
    
    // Common patterns for React components
    if (className && typeof className === 'string') {
      // Check for common component patterns
      if (className.includes('card-title')) return 'card title';
      if (className.includes('card-header')) return 'card header';
      if (className.includes('card-content')) return 'card content';
      if (className.includes('card-footer')) return 'card footer';
      if (className.includes('card')) return 'card';
      if (className.includes('button')) return 'button';
      if (className.includes('input')) return 'input';
      if (className.includes('select')) return 'select';
      if (className.includes('dialog')) return 'dialog';
      if (className.includes('modal')) return 'modal';
      if (className.includes('dropdown')) return 'dropdown';
      if (className.includes('tooltip')) return 'tooltip';
      if (className.includes('badge')) return 'badge';
      if (className.includes('alert')) return 'alert';
      if (className.includes('avatar')) return 'avatar';
      if (className.includes('checkbox')) return 'checkbox';
      if (className.includes('radio')) return 'radio';
      if (className.includes('switch')) return 'switch';
      if (className.includes('slider')) return 'slider';
      if (className.includes('progress')) return 'progress';
      if (className.includes('spinner')) return 'spinner';
      if (className.includes('tab')) return 'tab';
      if (className.includes('accordion')) return 'accordion';
      if (className.includes('breadcrumb')) return 'breadcrumb';
      if (className.includes('pagination')) return 'pagination';
      if (className.includes('nav')) return 'nav';
      if (className.includes('sidebar')) return 'sidebar';
      if (className.includes('header')) return 'header';
      if (className.includes('footer')) return 'footer';
    }
    
    // Return the HTML tag name as fallback
    return tagName;
  }

  function createHighlighter() {
    const highlighter = document.createElement('div');
    highlighter.className = 'hercules-highlighter';
    highlighter.innerHTML = \`
      <div class="hercules-highlighter-outline"></div>
      <div class="hercules-highlighter-label"></div>
    \`;
    highlighter.style.display = 'none';
    document.body.appendChild(highlighter);
    return highlighter;
  }

  function updateHighlighter(highlighter, element, tagName) {
    const rect = element.getBoundingClientRect();
    
    // Since the highlighter uses position: fixed, we don't need to add scroll offsets
    // getBoundingClientRect() already returns viewport-relative coordinates
    highlighter.style.left = rect.left + 'px';
    highlighter.style.top = rect.top + 'px';
    highlighter.style.width = rect.width + 'px';
    highlighter.style.height = rect.height + 'px';
    highlighter.style.display = 'block';
    
    const label = highlighter.querySelector('.hercules-highlighter-label');
    label.textContent = tagName;
  }

  function hideHighlighter(highlighter) {
    if (highlighter) {
      highlighter.style.display = 'none';
    }
  }

  function positionEditorBelowElement(element) {
    if (!editorPanel || !element) return;
    
    const rect = element.getBoundingClientRect();
    const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    
    // Calculate position - centered below the element
    const elementCenterX = rect.left + rect.width / 2;
    const editorWidth = 320; // Width set in CSS
    let leftPosition = elementCenterX - editorWidth / 2 + scrollX;
    
    // Keep the editor within viewport bounds
    const viewportWidth = window.innerWidth;
    const rightEdge = leftPosition + editorWidth;
    
    if (leftPosition < 10) {
      leftPosition = 10; // 10px margin from left edge
    } else if (rightEdge > viewportWidth - 10) {
      leftPosition = viewportWidth - editorWidth - 10; // 10px margin from right edge
    }
    
    // Get approximate editor height (you may need to adjust this)
    const editorHeight = 400; // Approximate height
    const viewportHeight = window.innerHeight;
    const gap = 10; // Gap between element and editor
    
    let topPosition;
    
    // Check if there's enough space below the element
    if (rect.bottom + gap + editorHeight <= viewportHeight) {
      // Position below the element
      topPosition = rect.bottom + scrollY + gap;
    } else if (rect.top - gap - editorHeight >= 0) {
      // Position above the element if not enough space below
      topPosition = rect.top + scrollY - editorHeight - gap;
    } else {
      // If not enough space above or below, position at the top of viewport with some margin
      topPosition = scrollY + 20;
    }
    
    editorPanel.style.left = leftPosition + 'px';
    editorPanel.style.top = topPosition + 'px';
  }

  function handleScroll() {
    // Deselect element when scrolling
    if (selectedElement) {
      hideHighlighter(selectedHighlighterElement);
      selectedElement = null;
      editorPanel.classList.remove('active');
    }
  }

  function handleResize() {
    // Update highlighter and editor positions on resize
    if (selectedElement && selectedHighlighterElement) {
      const tagName = getElementTagName(selectedElement);
      updateHighlighter(selectedHighlighterElement, selectedElement, tagName);
      positionEditorBelowElement(selectedElement);
    }
  }

  function handleElementHover(e) {
    if (!isEditorActive) return;
    
    const element = e.target;
    const componentId = element.getAttribute('${dataAttribute}');
    
    if (componentId && e.type === 'mouseover') {
      // Don't add another highlight if this is the selected element
      if (element !== selectedElement) {
        if (!highlighterElement) {
          highlighterElement = createHighlighter();
        }
        const tagName = getElementTagName(element);
        updateHighlighter(highlighterElement, element, tagName);
      }
    } else if (e.type === 'mouseout') {
      // Check if we're moving to a child element
      const relatedTarget = e.relatedTarget;
      if (relatedTarget && element.contains(relatedTarget)) {
        return; // Don't remove highlight when moving to child elements
      }
      
      // Don't remove highlight from the selected element
      if (element !== selectedElement) {
        hideHighlighter(highlighterElement);
      }
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
    // Hide hover highlighter when selecting
    hideHighlighter(highlighterElement);
    
    // Remove previous selection
    if (selectedHighlighterElement) {
      hideHighlighter(selectedHighlighterElement);
    }
    
    selectedElement = element;
    
    // Create a separate highlighter for the selected element
    if (!selectedHighlighterElement) {
      selectedHighlighterElement = createHighlighter();
      selectedHighlighterElement.classList.add('selected');
    }
    
    const tagName = getElementTagName(element);
    updateHighlighter(selectedHighlighterElement, element, tagName);
    
    // Position and show editor panel
    positionEditorBelowElement(element);
    editorPanel.classList.add('active');
    
    // Update component ID
    document.getElementById('component-id').textContent = componentId;
    
    // Analyze both className and text content
    await updateEditorContent();
  }
  
  async function updateEditorContent() {
    if (!selectedElement) return;
    
    const componentId = selectedElement.getAttribute('${dataAttribute}');
    
    if (currentEditorMode === 'class') {
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
          renderClassEditor(result.analysis, selectedElement);
        } else {
          // Fallback to simple editor
          renderSimpleEditor(selectedElement.className.replace('hercules-highlight', '').trim());
        }
      } catch (error) {
        console.error('[Hercules] Error analyzing className:', error);
        // Fallback to simple editor
        renderSimpleEditor(selectedElement.className.replace('hercules-highlight', '').trim());
      }
    } else {
      // Analyze text content
      try {
        const response = await fetch('/__hercules_analyze_text', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ componentId })
        });
        
        const result = await response.json();
        
        if (result.success && result.analysis) {
          renderTextEditor(result.analysis, selectedElement);
        } else {
          renderTextEditor({ type: 'static', value: selectedElement.textContent || '', hasChildren: false }, selectedElement);
        }
      } catch (error) {
        console.error('[Hercules] Error analyzing text content:', error);
        renderTextEditor({ type: 'static', value: selectedElement.textContent || '', hasChildren: false }, selectedElement);
      }
    }
  }
  
  function renderTextEditor(analysis, element) {
    const container = document.getElementById('text-editor-container');
    
    // Check if we cannot edit the value
    const cannotEditValue = analysis.type !== 'static' && analysis.type !== 'empty';
    
    if (cannotEditValue) {
      // Show unified warning for non-editable content
      container.innerHTML = \`
        <div class="warning">
          ⚠️ Cannot edit the value, ask the engineer to assist.
        </div>
      \`;
    } else {
      // Show normal editor for static or empty content
      container.innerHTML = \`
        <div>
          <label>Text Content:</label>
          <textarea id="text-input" rows="4" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; font-family: system-ui, -apple-system, sans-serif; resize: vertical;">\${analysis.type === 'static' ? (analysis.value || '') : ''}</textarea>
        </div>
      \`;
      
      document.getElementById('text-input')?.focus();
      window.herculesSetupAutoApply();
    }
  }
  
  function renderClassEditor(analysis, element) {
    const container = document.getElementById('class-editor-container');
    
    // Check if we cannot edit the value
    const cannotEditValue = analysis.type !== 'static';
    
    if (cannotEditValue) {
      // Show unified warning for non-editable classNames
      container.innerHTML = \`
        <div class="warning">
          ⚠️ Cannot edit the value, ask the engineer to assist.
        </div>
      \`;
    } else {
      // Show normal editor for static classNames
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
    \`;
                  document.getElementById('class-input').focus();
              window.herculesSetupAutoApply();
  }
  
  function closeEditor() {
    // Hide both highlighters
    hideHighlighter(highlighterElement);
    hideHighlighter(selectedHighlighterElement);
    selectedElement = null;
    editorPanel.classList.remove('active');
  }
  
  window.herculesCloseEditor = closeEditor;
  
  window.herculesSetEditorMode = function(mode) {
    currentEditorMode = mode;
    
    // Update button states
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    document.querySelector(\`.mode-btn[data-mode="\${mode}"]\`).classList.add('active');
    
    // Show/hide containers
    const classContainer = document.getElementById('class-editor-container');
    const textContainer = document.getElementById('text-editor-container');
    
    if (mode === 'class') {
      classContainer.style.display = 'block';
      textContainer.style.display = 'none';
    } else {
      classContainer.style.display = 'none';
      textContainer.style.display = 'block';
    }
    
    // Update content
    updateEditorContent();
  };
  
  window.herculesApplyChanges = async function(isAutoApply = false) {
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
          newClassName
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        // Update will trigger HMR reload
        console.log('[Hercules] className updated successfully');
      } else {
        console.error('[Hercules] Failed to update className:', result.error);
        if (!isAutoApply) {
          alert('Failed to update className: ' + result.error);
        }
      }
    } catch (error) {
      console.error('[Hercules] Error updating className:', error);
      if (!isAutoApply) {
        alert('Error updating className: ' + error.message);
      }
    }
    
    // Only close editor if not auto-applying
    if (!isAutoApply) {
      closeEditor();
    }
  };
  
  window.herculesApplyTextChanges = async function(isAutoApply = false) {
    if (!selectedElement) return;
    
    const componentId = selectedElement.getAttribute('${dataAttribute}');
    const newTextContent = document.getElementById('text-input')?.value || '';
    
    try {
      const response = await fetch('/__hercules_update_text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          componentId,
          newTextContent
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        // Update will trigger HMR reload
        console.log('[Hercules] Text content updated successfully');
      } else {
        console.error('[Hercules] Failed to update text content:', result.error);
        if (!isAutoApply) {
          alert('Failed to update text content: ' + result.error);
        }
      }
    } catch (error) {
      console.error('[Hercules] Error updating text content:', error);
      if (!isAutoApply) {
        alert('Error updating text content: ' + error.message);
      }
    }
    
    // Only close editor if not auto-applying
    if (!isAutoApply) {
      closeEditor();
    }
  };
  
  // Auto-apply functionality
  let isAutoApplying = false;
  
  window.herculesAutoApply = async function(type) {
    // Prevent concurrent auto-apply operations
    if (isAutoApplying) return;
    
    isAutoApplying = true;
    
    try {
      // Apply changes instantly
      if (type === 'class') {
        await window.herculesApplyChanges(true); // Pass true for isAutoApply
      } else if (type === 'text') {
        await window.herculesApplyTextChanges(true); // Pass true for isAutoApply
      }
    } finally {
      isAutoApplying = false;
    }
  };
  
  // Add input listeners for auto-apply
  window.herculesSetupAutoApply = function() {
    const classInput = document.getElementById('class-input');
    const textInput = document.getElementById('text-input');
    
    if (classInput) {
      classInput.addEventListener('input', () => window.herculesAutoApply('class'));
    }
    
    if (textInput) {
      textInput.addEventListener('input', () => window.herculesAutoApply('text'));
    }
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
