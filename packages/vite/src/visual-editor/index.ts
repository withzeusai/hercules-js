import type { Plugin, ViteDevServer } from "vite";

// Import from extracted modules
import { analyzeElement } from "./ast-analyzer";
import { updateComponentElement, deleteComponent } from "./ast-transformer";

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

      // Handle unified element analysis requests
      server.middlewares.use("/__hercules_analyze_element", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const { componentId } = JSON.parse(body);

              const result = await analyzeElement(componentId, server.config.root);

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error analyzing element:", error);
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

      // Handle unified element update requests
      server.middlewares.use("/__hercules_update_element", async (req, res, next) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const data = JSON.parse(body);
              const { componentId, className, textContent } = data;

              const updates: { className?: string; textContent?: string } = {};
              if (className !== undefined) updates.className = className;
              if (textContent !== undefined) updates.textContent = textContent;

              const result = await updateComponentElement(componentId, updates, server.config.root);

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              if (debug) {
                console.error("[Visual Editor] Error updating element:", error);
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

              const result = await deleteComponent(componentId, server.config.root);

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
  return `
(function() {
  const EDITOR_VERSION = '1.0.0';
  let selectedElement = null;
  let editorPanel = null;
  let isEditorActive = false;
  let highlighterElement = null;
  let selectedHighlighterElement = null;
  let inlineEditingState = null;
  
  // PostMessage helper function
  function emitToParent(eventType, data) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        source: 'hercules-visual-editor',
        type: eventType,
        data: data
      }, '*');
    } 
  }
  
  // Create the visual editor UI
  function createEditorUI() {
    const style = document.createElement('style');
    style.textContent = \`
      #hercules-visual-editor {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
        z-index: 99999;
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
        outline-offset: 1px;
        background-color: rgba(59, 130, 246, 0.05);
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
        outline-width: 1px;
      }
      
      .hercules-highlighter.selected .hercules-highlighter-label {
        background: #3b82f6;
      }

      
      /* Inline editing styles */
      [contenteditable="true"] {
        cursor: text !important;
        min-height: 1em;
        /* Prevent formatting UI/hints */
        -webkit-user-modify: read-write-plaintext-only;
        user-modify: read-write-plaintext-only;
      }
      
      [contenteditable="true"]:focus {
        outline: none !important;
      }
      
      /* Disable browser formatting suggestions */
      [contenteditable="true"]::selection {
        background-color: rgba(59, 130, 246, 0.3);
      }
    \`;
    document.head.appendChild(style);

    
    // Create editor panel - just a 1x1 invisible div for position handling
    editorPanel = document.createElement('div');
    editorPanel.id = 'hercules-visual-editor';
    // No innerHTML needed - just an empty div
    document.body.appendChild(editorPanel);
  }
  
  // Helper function to get a friendly tag name from an element
  function getElementTagName(element) {
    // First, try to get the React component name from fiber nodes
    // React stores fiber information on DOM elements with various property names
    const fiberKey = Object.keys(element).find(key => 
      key.startsWith('__reactFiber') || 
      key.startsWith('__reactInternalInstance') ||
      key.startsWith('_reactInternal')
    );
    
    if (fiberKey) {
      const fiber = element[fiberKey];
      
      // Check if the immediate parent is a React component
      if (fiber && fiber.return) {
        const parentFiber = fiber.return;
        const parentElementType = parentFiber.elementType;
        
        // Check if parent is a React function/class component
        if (parentElementType && typeof parentElementType === 'function') {
          const componentName = parentElementType.displayName || parentElementType.name;
          
          // Make sure it's a meaningful component name
          if (componentName && 
              componentName !== 'Component' && 
              componentName !== 'Unknown' &&
              !componentName.startsWith('_')) {
            // Convert PascalCase to space-separated lowercase
            const result = componentName
              .replace(/([A-Z])/g, ' $1')
              .trim()
            return result;
          }
        }
        
        // Check for forwardRef components
        if (parentElementType && 
            parentElementType.$$typeof && 
            parentElementType.displayName) {
          const componentName = parentElementType.displayName;
          if (componentName) {
            return componentName
              .replace(/([A-Z])/g, ' $1')
              .trim()
          }
        }
      }
    }
    
    // Fallback: Get the raw tag name
    let tagName = element.tagName.toLowerCase();
    
    // Return the HTML tag name as final fallback
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

  function calculateEditorPosition(element) {
    if (!element) return null;
    
    const rect = element.getBoundingClientRect();
    
    // Calculate position - centered below the element
    const elementCenterX = rect.left + rect.width / 2;
    const editorWidth = 1; // Width set in CSS
    let leftPosition = elementCenterX - editorWidth / 2;
    
    // Keep the editor within viewport bounds
    const viewportWidth = window.innerWidth;
    const rightEdge = leftPosition + editorWidth;
    
    if (leftPosition < 10) {
      leftPosition = 10; // 10px margin from left edge
    } else if (rightEdge > viewportWidth - 10) {
      leftPosition = viewportWidth - editorWidth - 10; // 10px margin from right edge
    }
    
    // Get actual editor height or use a reasonable default
    const editorHeight = editorPanel?.offsetHeight || 400;
    const viewportHeight = window.innerHeight;
    const gap = 5; // Gap between element and editor
    
    let topPosition;
    
    // Check if there's enough space below the element
    if (rect.bottom + gap + editorHeight <= viewportHeight) {
      // Position below the element
      topPosition = rect.bottom  + gap;
    } else if (rect.top - gap - editorHeight >= 0) {
      // Position above the element if not enough space below
      topPosition = rect.top - editorHeight - gap;
    } else {
      // If not enough space above or below, position at the top of viewport with some margin
      topPosition =  20;
    }
    
    return {
      x: leftPosition,
      y: topPosition,
      elementRect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        right: rect.right
      }
    };
  }

  function positionEditorBelowElement(element) {
    if (!editorPanel || !element) return;
    
    const position = calculateEditorPosition(element);
    if (position) {
      editorPanel.style.left = position.x + 'px';
      editorPanel.style.top = position.y + 'px';
    }
  }

  function emitPositionUpdate() {
    if (selectedElement) {
      const position = calculateEditorPosition(selectedElement);
      emitToParent('selected-element-position', {
        position: position
      });
    }
  }

  function handleScroll() {
    // Update hover highlighter position if it's visible
    if (highlighterElement && highlighterElement.style.display !== 'none') {
      // Find the element being hovered by checking which element has the data attribute
      // and the mouse is over it
      const hoveredElement = document.querySelector(':hover[' + '${dataAttribute}' + ']');
      if (hoveredElement && hoveredElement !== selectedElement) {
        const tagName = getElementTagName(hoveredElement);
        updateHighlighter(highlighterElement, hoveredElement, tagName);
      }
    }
    
		if (selectedElement) {
			closeEditor();
		}
  }

  function handleResize() {
    // Update highlighter and editor positions on resize
    if (selectedElement && selectedHighlighterElement) {
      const tagName = getElementTagName(selectedElement);
      updateHighlighter(selectedHighlighterElement, selectedElement, tagName);
      positionEditorBelowElement(selectedElement);
      emitPositionUpdate();
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
    
    // Analyze element (both className and textContent in one call)
    try {
      const response = await fetch('/__hercules_analyze_element', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ componentId })
      });
      
      const result = await response.json();
      
      if (result.success) {
        // Calculate position for the element
        const position = calculateEditorPosition(element);
        
        // Emit selected element event with analysis data and position
        emitToParent('selected-element', {
          data: {
            componentId: componentId,
            className: result.className,
            textContent: result.textContent,
            elementType: result.elementType,
            element: {
              tagName: getElementTagName(element),
              className: element.className,
              textContent: element.textContent
            },
            position: position
          }
        });
        
        // Handle text content analysis
        if (result.textContent && result.textContent.type === 'static') {
          enableInlineTextEditing(element, result.textContent.value || '', clickEvent);
        }
      } else {
        // Fallback behavior
        console.error('[Hercules] Error analyzing element:', result.error);
        enableInlineTextEditing(element, element.textContent || '', clickEvent);
        
        // Calculate position for the element
        const position = calculateEditorPosition(element);
        
        // Still emit selected element event with basic data and position
        emitToParent('selected-element', {
          data: {
            componentId: componentId,
            element: {
              tagName: getElementTagName(element),
              className: element.className,
              textContent: element.textContent
            },
            position: position
          }
        });
      }

    } catch (error) {
      console.error('[Hercules] Error analyzing element:', error);
      // Fallback to simple editors
      renderSimpleEditor(element.className.replace('hercules-highlight', '').trim());
      enableInlineTextEditing(element, element.textContent || '', clickEvent);
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
    const handleBeforeInput = (e) => {
      // Prevent formatting-related input types
      const formattingTypes = ['formatBold', 'formatItalic', 'formatUnderline', 'formatStrikethrough', 
                               'formatSuperscript', 'formatSubscript', 'formatJustifyFull', 
                               'formatJustifyCenter', 'formatJustifyRight', 'formatJustifyLeft',
                               'formatIndent', 'formatOutdent', 'formatFontName', 'formatFontSize'];
      
      if (formattingTypes.includes(e.inputType)) {
        e.preventDefault();
      }
    };
    
    const handleInput = () => {
      inlineEditingState.hasChanges = true;
      
      // Update the highlighter to match the new size
      if (selectedHighlighterElement) {
        const tagName = getElementTagName(element);
        updateHighlighter(selectedHighlighterElement, element, tagName);
      }
      
      // Also update the editor panel position if needed
      positionEditorBelowElement(element);
      emitPositionUpdate();
    };
    
    const handleKeyDownInlineEditing = (e) => {
      if (e.key === 'Enter' && !e.shiftKey || e.key === 'Escape') {
        e.preventDefault();
        saveInlineTextChanges();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B' || e.key === 'i' || e.key === 'I' || e.key === 'u' || e.key === 'U')) {
        // Prevent bold, italic, and underline formatting
        e.preventDefault();
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
        emitPositionUpdate();
      }
    };
    
    // Prevent pasting formatted content
    const handlePaste = (e) => {
      e.preventDefault();
      
      // Get plain text from clipboard
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      
      // Insert plain text at cursor position
      const selection = window.getSelection();
      if (!selection.rangeCount) return;
      
      selection.deleteFromDocument();
      selection.getRangeAt(0).insertNode(document.createTextNode(text));
      
      // Move cursor to end of inserted text
      selection.collapseToEnd();
      
      // Trigger input event manually
      handleInput();
    };
    
    element.addEventListener('beforeinput', handleBeforeInput);
    element.addEventListener('input', handleInput);
    element.addEventListener('keydown', handleKeyDownInlineEditing);
    element.addEventListener('blur', handleBlur);
    element.addEventListener('paste', handlePaste);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    
    // Store event listeners for cleanup
    inlineEditingState.eventListeners = {
      beforeinput: handleBeforeInput,
      input: handleInput,
      keydown: handleKeyDownInlineEditing,
      blur: handleBlur,
      paste: handlePaste,
      resize: handleResize
    };
  }
  
  function cleanupInlineEditing() {
    if (!inlineEditingState) return;
    
    const { element, originalContentEditable, eventListeners } = inlineEditingState;
    
    // Remove event listeners
    if (eventListeners) {
      element.removeEventListener('beforeinput', eventListeners.beforeinput);
      element.removeEventListener('input', eventListeners.input);
      element.removeEventListener('keydown', eventListeners.keydown);
      element.removeEventListener('blur', eventListeners.blur);
      element.removeEventListener('paste', eventListeners.paste);
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
  
  async function saveInlineTextChanges() {
    if (!inlineEditingState || !inlineEditingState.hasChanges) {
      cleanupInlineEditing();
      return;
    }
    
    const newText = inlineEditingState.element.textContent || '';
    const componentId = inlineEditingState.element.getAttribute('${dataAttribute}');
    
    try {
      const response = await fetch('/__hercules_update_element', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          componentId,
          textContent: newText
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
    
    // Emit selected element event with null to indicate deselection
    emitToParent('selected-element', { data: null });
  }
    
  async function deleteElement() {
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
        // Emit element removed event
        emitToParent('element-removed', {
          success: true,
          reason: null
        });
        
        // Close the editor after successful deletion
        closeEditor();
        console.log('[Hercules] Element deleted successfully');
      } else {
        console.error('[Hercules] Failed to delete element:', result.error);
        alert('Failed to delete element: ' + result.error);
        
        // Emit element removed event with failure
        emitToParent('element-removed', {
          success: false,
          reason: result.error
        });
      }
    } catch (error) {
      console.error('[Hercules] Error deleting element:', error);
      alert('Error deleting element: ' + error.message);
      
      // Emit element removed event with failure
      emitToParent('element-removed', {
        success: false,
        reason: error.message
      });
    }
  };
    
	function listenForMessages() {
  // Listen for messages from parent
  window.addEventListener("message", function (event) {
    // Only process messages with our source identifier
    if (!event.data || event.data.source !== "hercules-visual-editor-parent") {
      return;
    }

    const { type, data } = event.data;

    switch (type) {
      case "change-editor-state":
        if (data && typeof data.active === "boolean") {
          setEditorActive(data.active);
        }
        break;

      case "update-element":
        if (data && selectedElement) {
          updateSelectedElement(data);
        }
        break;

      case "delete-element":
        if (selectedElement) {
          deleteElement();
        }
        break;

      case "unselect-element":
        if (selectedElement) {
          closeEditor();
        }
        break;
    }
  });

  // Function to set editor active state
  function setEditorActive(active) {
    isEditorActive = active;

    // Update UI based on active state
    if (!active) {
      // Remove all event listeners
      document.removeEventListener("click", handleElementClick);
      document.removeEventListener("mouseover", handleElementHover);
      document.removeEventListener("mouseout", handleElementHover);
			window.removeEventListener("scroll", handleScroll, true);
			window.removeEventListener("resize", handleResize);
      closeEditor();
    } else {
			// Add event listeners
      document.addEventListener("click", handleElementClick, true);
      document.addEventListener("mouseover", handleElementHover);
			document.addEventListener("mouseout", handleElementHover);
			window.addEventListener("scroll", handleScroll, true);
			window.addEventListener("resize", handleResize);
    }

    // Emit state change
    emitToParent("editor-state", { active: isEditorActive });
  }

  // Helper function to update selected element
  async function updateSelectedElement(data) {
    if (!selectedElement) return;

    const componentId = selectedElement.getAttribute("${dataAttribute}");

    try {
      const response = await fetch("/__hercules_update_element", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          componentId,
          ...data
        })
      });

      const result = await response.json();

      emitToParent("element-updated", {
        success: result.success,
        data: data,
        reason: result.success ? null : result.error
      });

      if (result.success) {
        console.log("[Hercules] Element updated successfully");
        // Re-analyze the element to update the UI
        const componentId = selectedElement.getAttribute("${dataAttribute}");
        await selectElement(selectedElement, componentId, null);
      }
    } catch (error) {
      emitToParent("element-updated", {
        success: false,
        data: data,
        reason: error.message
      });
    }
  }
}

  
  // Initialize editor
  function init() {
    // Return early if we're not in an iframe
    if (window.self === window.top) {
      return;
    }

    createEditorUI();
    listenForMessages();
    // Emit ready event
    emitToParent('ready', {
      active: isEditorActive,
      version: EDITOR_VERSION
    });
  }

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
  `;
}
