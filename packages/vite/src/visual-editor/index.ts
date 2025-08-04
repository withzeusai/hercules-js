import type { Plugin, ViteDevServer } from "vite";

// Import from extracted modules
import { analyzeComponentClassName, analyzeComponentTextContent } from "./ast-analyzer";
import { updateComponentClassName, updateComponentTextContent, deleteComponent } from "./ast-transformer";

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

      // Handle element deletion requests
      server.middlewares.use("/__hercules_delete_element", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const data = JSON.parse(body);
              const { componentId } = data;

              const result = await deleteComponent(
                componentId,
                server.config.root
              );

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error deleting element:", error);
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
  let highlighterElement = null;
  let selectedHighlighterElement = null;
  let inlineEditingState = null;
  
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
      
      #hercules-visual-editor .btn-danger {
        background: #ef4444;
        color: white;
      }
      
      #hercules-visual-editor .btn-danger:hover {
        background: #dc2626;
      }
      
      #hercules-visual-editor .delete-section {
        border-top: 1px solid #e5e7eb;
        padding-top: 16px;
        margin-top: 16px;
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
      
      /* Inline editing styles */
      [contenteditable="true"] {
        cursor: text !important;
        min-height: 1em;
      }
      
      [contenteditable="true"]:focus {
        outline: none !important;
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
        <div id="class-editor-container">
          <!-- Dynamic content will be inserted here -->
        </div>
        <div class="delete-section">
          <button class="btn-danger" onclick="window.herculesDeleteElement()">Delete Element</button>
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
      document.addEventListener('keydown', handleKeyDown);
      window.addEventListener('scroll', handleScroll, true);
      window.addEventListener('resize', handleResize);
    } else {
      toggleBtn.classList.remove('active');
      toggleBtn.textContent = 'Visual Editor';
      document.removeEventListener('click', handleElementClick, true); // Use capture phase
      document.removeEventListener('mouseover', handleElementHover);
      document.removeEventListener('mouseout', handleElementHover);
      document.removeEventListener('keydown', handleKeyDown);
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

  function handleKeyDown(e) {
    if (!isEditorActive) return;
    
    // Check if Escape key is pressed
    if (e.key === 'Escape' && selectedElement) {
      closeEditor();
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
      // Don't re-select if we're already editing this element
      if (inlineEditingState && inlineEditingState.element === element) {
        return;
      }
      
      e.preventDefault();
      e.stopPropagation();
      selectElement(element, componentId, e);
    }
  }
  
  async function selectElement(element, componentId, clickEvent) {
    // Clean up any active inline editing
    if (inlineEditingState) {
      cleanupInlineEditing();
    }
    
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
    
    // Analyze className
    await updateEditorContent();
    
    // Analyze text content and enable inline editing if possible
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
        const analysis = result.analysis;
        // Enable inline editing if text is editable
        if (analysis.type === 'editable') {
          enableInlineTextEditing(element, analysis.value || '', clickEvent);
        }
      }
    } catch (error) {
      console.error('[Hercules] Error analyzing text content:', error);
      // Try to enable inline editing with current text content as fallback
      enableInlineTextEditing(element, element.textContent || '', clickEvent);
    }
  }
  
  async function updateEditorContent() {
    if (!selectedElement) return;
    
    const componentId = selectedElement.getAttribute('${dataAttribute}');
    
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
  }
  

  
  function enableInlineTextEditing(element, originalText, clickEvent) {
    // Clean up any previous inline editing state
    if (inlineEditingState) {
      cleanupInlineEditing();
    }
    
    // Store the original text and element
    inlineEditingState = {
      element,
      originalText,
      originalContentEditable: element.contentEditable,
      hasChanges: false,
      isInitializing: true
    };
    
    // Make the element editable
    element.contentEditable = 'true';
    element.focus();
    
    // Position caret based on click location if available (only during initialization)
    if (clickEvent && inlineEditingState.isInitializing) {
      // Small delay to ensure element is ready for caret positioning
      setTimeout(() => {
        // Only proceed if still initializing (prevents interfering with user selections)
        if (!inlineEditingState || !inlineEditingState.isInitializing) return;
        
        const x = clickEvent.clientX;
        const y = clickEvent.clientY;
        
        // Try to position caret at click location
        if (document.caretPositionFromPoint) {
          // Firefox
          const pos = document.caretPositionFromPoint(x, y);
          if (pos) {
            const range = document.createRange();
            range.setStart(pos.offsetNode, pos.offset);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } else if (document.caretRangeFromPoint) {
          // Chrome, Safari
          const range = document.caretRangeFromPoint(x, y);
          if (range) {
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } else {
          // Fallback: select all text
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        
        // Clear initialization flag after positioning
        inlineEditingState.isInitializing = false;
      }, 0);
    } else if (!clickEvent) {
      // No click event, select all text
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      inlineEditingState.isInitializing = false;
    } else {
      // Click event but already initialized, just clear the flag
      inlineEditingState.isInitializing = false;
    }
    
    // Text editing indicator removed
    
    // Add event listeners
    const handleInput = () => {
      inlineEditingState.hasChanges = true;
      
      // Update the highlighter to match the new size
      if (selectedHighlighterElement) {
        const tagName = getElementTagName(element);
        updateHighlighter(selectedHighlighterElement, element, tagName);
      }
      
      // Also update the editor panel position if needed
      positionEditorBelowElement(element);
    };
    
    const handleKeyDown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveInlineTextChanges();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelInlineTextEditing();
      }
    };
    
    const handleBlur = (e) => {
      // Small delay to allow for clicks on the editor panel
      setTimeout(() => {
        if (inlineEditingState && inlineEditingState.element === element) {
          saveInlineTextChanges();
        }
      }, 200);
    };
    
    // Handle window resize/scroll to keep highlighter in sync
    const handleResize = () => {
      if (selectedHighlighterElement) {
        const tagName = getElementTagName(element);
        updateHighlighter(selectedHighlighterElement, element, tagName);
        positionEditorBelowElement(element);
      }
    };
    
    element.addEventListener('input', handleInput);
    element.addEventListener('keydown', handleKeyDown);
    element.addEventListener('blur', handleBlur);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    
    // Store event listeners for cleanup
    inlineEditingState.eventListeners = {
      input: handleInput,
      keydown: handleKeyDown,
      blur: handleBlur,
      resize: handleResize
    };
  }
  
  function cleanupInlineEditing() {
    if (!inlineEditingState) return;
    
    const { element, originalContentEditable, eventListeners } = inlineEditingState;
    
    // Remove event listeners
    if (eventListeners) {
      element.removeEventListener('input', eventListeners.input);
      element.removeEventListener('keydown', eventListeners.keydown);
      element.removeEventListener('blur', eventListeners.blur);
      window.removeEventListener('resize', eventListeners.resize);
      window.removeEventListener('scroll', eventListeners.resize, true);
    }
    
    // Restore original contentEditable state
    element.contentEditable = originalContentEditable || 'inherit';
    
    // Clear selection
    window.getSelection().removeAllRanges();
    
    // Text editing indicator removal no longer needed
    
    inlineEditingState = null;
  }
  
  function cancelInlineTextEditing() {
    if (!inlineEditingState) return;
    
    // Restore original text
    inlineEditingState.element.textContent = inlineEditingState.originalText;
    
    cleanupInlineEditing();
  }
  
  async function saveInlineTextChanges() {
    if (!inlineEditingState || !inlineEditingState.hasChanges) {
      cleanupInlineEditing();
      return;
    }
    
    const newText = inlineEditingState.element.textContent || '';
    const componentId = inlineEditingState.element.getAttribute('${dataAttribute}');
    
    try {
      const response = await fetch('/__hercules_update_text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          componentId,
          newTextContent: newText
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        console.log('[Hercules] Text content updated successfully');
      } else {
        console.error('[Hercules] Failed to update text content:', result.error);
        alert('Failed to update text content: ' + result.error);
        // Restore original text on error
        inlineEditingState.element.textContent = inlineEditingState.originalText;
      }
    } catch (error) {
      console.error('[Hercules] Error updating text content:', error);
      alert('Error updating text content: ' + error.message);
      // Restore original text on error
      inlineEditingState.element.textContent = inlineEditingState.originalText;
    } finally {
      cleanupInlineEditing();
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
    // Clean up inline editing if active
    if (inlineEditingState) {
      cleanupInlineEditing();
    }
    
    // Hide both highlighters
    hideHighlighter(highlighterElement);
    hideHighlighter(selectedHighlighterElement);
    selectedElement = null;
    editorPanel.classList.remove('active');
  }
  
  window.herculesCloseEditor = closeEditor;
  
  window.herculesDeleteElement = async function() {
    if (!selectedElement) return;
    
    const componentId = selectedElement.getAttribute('${dataAttribute}');
    
    try {
      const response = await fetch('/__hercules_delete_element', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          componentId
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        // Close the editor after successful deletion
        closeEditor();
        console.log('[Hercules] Element deleted successfully');
      } else {
        console.error('[Hercules] Failed to delete element:', result.error);
        alert('Failed to delete element: ' + result.error);
      }
    } catch (error) {
      console.error('[Hercules] Error deleting element:', error);
      alert('Error deleting element: ' + error.message);
    }
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
  

  
  // Auto-apply functionality
  let isAutoApplying = false;
  
  window.herculesAutoApply = async function() {
    // Prevent concurrent auto-apply operations
    if (isAutoApplying) return;
    
    isAutoApplying = true;
    
    try {
      // Apply changes instantly
      await window.herculesApplyChanges(true); // Pass true for isAutoApply
    } finally {
      isAutoApplying = false;
    }
  };
  
  // Add input listeners for auto-apply
  window.herculesSetupAutoApply = function() {
    const classInput = document.getElementById('class-input');
    
    if (classInput) {
      classInput.addEventListener('input', () => window.herculesAutoApply());
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
