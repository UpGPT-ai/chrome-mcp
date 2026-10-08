/* eslint-disable */
// fill-helper.js
// This script is injected into the page to handle form filling operations

if (window.__FILL_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__FILL_HELPER_INITIALIZED__ = true;

  function pierceFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; i < 30 && el && el.shadowRoot; i++) {
      let inner = null;
      try {
        inner = el.shadowRoot.elementFromPoint(x, y);
      } catch (_) {
        break;
      }
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function querySelectorDeep(selector) {
    if (!selector) return null;
    try {
      const direct = document.querySelector(selector);
      if (direct) return direct;
    } catch (_) {
      return null;
    }
    const stack = [];
    const seen = new Set();
    if (document.documentElement) stack.push(document.documentElement);
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      let shadow = null;
      try {
        shadow = node.shadowRoot;
      } catch (_) {
        shadow = null;
      }
      if (shadow) {
        try {
          const hit = shadow.querySelector(selector);
          if (hit) return hit;
        } catch (_) {
          /* ignore */
        }
        const shadowChildren = shadow.children || [];
        for (let i = 0; i < shadowChildren.length; i++) stack.push(shadowChildren[i]);
      }
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) stack.push(children[i]);
    }
    return null;
  }

  function setNativeValue(element, value) {
    const prototype = element ? Object.getPrototypeOf(element) : null;
    const descriptor =
      (prototype && Object.getOwnPropertyDescriptor(prototype, 'value')) ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') ||
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    const setter = descriptor && descriptor.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function setNativeChecked(element, checked) {
    const prototype = element ? Object.getPrototypeOf(element) : null;
    const descriptor =
      (prototype && Object.getOwnPropertyDescriptor(prototype, 'checked')) ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    const setter = descriptor && descriptor.set;
    if (setter) setter.call(element, checked);
    else element.checked = checked;
  }

  function isContentEditableHost(element) {
    if (!element || element.nodeType !== 1 || !element.getAttribute) return false;
    const attr = element.getAttribute('contenteditable');
    return attr === '' || attr === 'true' || attr === 'plaintext-only';
  }

  function setContentEditableText(element, text) {
    element.focus();
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (document.execCommand) document.execCommand('insertText', false, text);
    } catch (_) {
      /* fall through to textContent */
    }
    if ((element.textContent || '') !== text) element.textContent = text;
  }

  function isListedControl(element) {
    if (!element || element.nodeType !== 1) return false;
    if (isContentEditableHost(element)) return true;
    if (element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') return true;
    if (element.tagName === 'INPUT') {
      const skip = ['hidden', 'file', 'button', 'submit', 'reset', 'image'];
      return skip.indexOf(element.type) === -1;
    }
    return false;
  }

  function derefRef(ref) {
    try {
      const map = window.__claudeElementMap;
      const weak = map && map[ref];
      const el = weak && typeof weak.deref === 'function' ? weak.deref() : null;
      return el instanceof Element ? el : null;
    } catch (_) {
      return null;
    }
  }

  function ensureRef(element) {
    if (!window.__claudeElementMap) window.__claudeElementMap = {};
    if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;
    const map = window.__claudeElementMap;
    for (const key in map) {
      const weak = map[key];
      if (weak && typeof weak.deref === 'function' && weak.deref() === element) return key;
    }
    const refId = 'ref_' + ++window.__claudeRefCounter;
    map[refId] = new WeakRef(element);
    return refId;
  }

  function clipText(value) {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 180 ? text.slice(0, 180) : text;
  }

  function controlType(element) {
    if (isContentEditableHost(element)) return 'contenteditable';
    if (element.tagName === 'SELECT') return 'select';
    if (element.tagName === 'TEXTAREA') return 'textarea';
    if (element.tagName === 'INPUT') return element.type || 'text';
    return (element.tagName || '').toLowerCase();
  }

  function candidateFor(element) {
    const labels = [];
    try {
      const owned = element.labels ? Array.from(element.labels) : [];
      for (let i = 0; i < owned.length; i++) {
        const text = clipText(owned[i].innerText || owned[i].textContent || '');
        if (text) labels.push(text);
      }
    } catch (_) {
      /* labels is unsupported on some elements */
    }
    const aria = clipText(element.getAttribute && element.getAttribute('aria-label'));
    if (aria) labels.push(aria);
    const labelledBy = element.getAttribute && element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = String(labelledBy).split(/\s+/);
      for (let i = 0; i < ids.length; i++) {
        const node = ids[i] ? document.getElementById(ids[i]) : null;
        const text = node ? clipText(node.innerText || node.textContent || '') : '';
        if (text) labels.push(text);
      }
    }
    return {
      ref: ensureRef(element),
      id: element.id || '',
      name: element.name || '',
      type: controlType(element),
      tag: (element.tagName || '').toLowerCase(),
      labels: labels.slice(0, 6),
      placeholder: clipText(element.getAttribute && element.getAttribute('placeholder')),
    };
  }

  function walkElements(visit) {
    const stack = [];
    const seen = new Set();
    if (document.documentElement) stack.push(document.documentElement);
    let count = 0;
    while (stack.length && count < 4000) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      count++;
      if (node.nodeType === 1) visit(node);
      const children = node.children || [];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      try {
        if (node.shadowRoot) stack.push(node.shadowRoot);
      } catch (_) {
        /* closed or inaccessible shadow */
      }
    }
  }

  function listFormCandidates() {
    const candidates = [];
    walkElements((element) => {
      if (!isListedControl(element)) return;
      if (candidates.length >= 400) return;
      candidates.push(candidateFor(element));
    });
    return candidates;
  }

  function resolveSelectorRef(selector) {
    const element = querySelectorDeep(selector);
    if (!element) return { error: 'selector did not match an element' };
    const target = isListedControl(element) ? element : findInnerFillable(element);
    if (!target) return { error: 'selector did not match a fillable element' };
    return candidateFor(target);
  }

  function findInnerFillable(root) {
    const queue = [root];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      if (current !== root && isListedControl(current)) return current;
      const children = current.children || [];
      for (let i = 0; i < children.length; i++) queue.push(children[i]);
      try {
        const shadow = current.shadowRoot;
        if (shadow && shadow.children) {
          for (let i = 0; i < shadow.children.length; i++) queue.push(shadow.children[i]);
        }
      } catch (_) {
        /* ignore */
      }
    }
    return null;
  }

  function validityFact(element) {
    let nativeValid = true;
    let validationMessage = '';
    try {
      if (element.validity && typeof element.validity.valid === 'boolean') {
        nativeValid = element.validity.valid;
      }
      if (typeof element.validationMessage === 'string') {
        validationMessage = element.validationMessage;
      }
    } catch (_) {
      /* contenteditable has no validity */
    }
    const ariaInvalid = element.getAttribute ? element.getAttribute('aria-invalid') : null;
    let ariaErrorMessage = '';
    const errId = element.getAttribute && element.getAttribute('aria-errormessage');
    if (errId) {
      const node = document.getElementById(errId);
      ariaErrorMessage = node ? clipText(node.innerText || node.textContent || '') : '';
    }
    return {
      ref: ensureRef(element),
      valid: nativeValid,
      validationMessage,
      ariaInvalid,
      ariaErrorMessage,
    };
  }

  function readFormValidity(refs) {
    const facts = [];
    const seen = new Set();
    const push = (element) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      if (facts.length >= 80) return;
      facts.push(validityFact(element));
    };
    const list = Array.isArray(refs) ? refs : [];
    for (let i = 0; i < list.length; i++) push(derefRef(list[i]));
    walkElements((element) => {
      if (!element || element.nodeType !== 1 || !element.matches) return;
      let marked = false;
      try {
        marked = element.matches(':invalid');
      } catch (_) {
        marked = false;
      }
      if (!marked && element.getAttribute) {
        const aria = element.getAttribute('aria-invalid');
        marked = aria === 'true' || aria === 'grammar' || aria === 'spelling';
      }
      if (marked) push(element);
    });
    return facts;
  }

  async function applyFormFills(items) {
    const results = [];
    const refs = [];
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      const filled = await fillElement(null, item.value, item.ref);
      if (filled && filled.error) results.push({ ref: item.ref, error: filled.error });
      else {
        results.push({ ref: item.ref, ok: true });
        if (item.ref) refs.push(item.ref);
      }
    }
    return { success: true, results, validity: readFormValidity(refs) };
  }

  function submitFilledForm(ref) {
    const target = ref ? derefRef(ref) : null;
    if (
      target &&
      typeof target.click === 'function' &&
      target.tagName !== 'FORM' &&
      (target.tagName === 'BUTTON' ||
        target.type === 'submit' ||
        target.getAttribute('type') === 'submit')
    ) {
      target.click();
      return { ok: true };
    }
    const form =
      (target && target.tagName === 'FORM' && target) ||
      (target && target.form) ||
      document.querySelector('form');
    if (!form) return { error: 'no form to submit' };
    try {
      if (typeof form.requestSubmit === 'function') {
        const submitter = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submitter) form.requestSubmit(submitter);
        else form.requestSubmit();
      } else {
        form.submit();
      }
      return { ok: true };
    } catch (error) {
      return { error: error && error.message ? error.message : String(error) };
    }
  }

  function containsDeep(element, hit) {
    if (!element || !hit) return false;
    if (element === hit) return true;
    try {
      if (element.contains(hit)) return true;
    } catch (_) {
      /* ignore */
    }
    let node = hit;
    for (let guard = 0; node && guard < 50; guard++) {
      if (node === element) return true;
      const root = node.getRootNode ? node.getRootNode() : null;
      if (root && root instanceof ShadowRoot) {
        node = root.host;
        continue;
      }
      node = node.parentElement;
    }
    return false;
  }

  /**
   * Fill an input element with the specified value
   * @param {string} selector - CSS selector for the element to fill
   * @param {string} value - Value to fill into the element
   * @returns {Promise<Object>} - Result of the fill operation
   */
  async function fillElement(selector, value, ref = null) {
    try {
      // Find the element
      let element = null;
      if (ref && typeof ref === 'string') {
        try {
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          element = weak && typeof weak.deref === 'function' ? weak.deref() : null;
        } catch (e) {
          // ignore
        }
        if (!element || !(element instanceof Element)) {
          return {
            error: `Element ref "${ref}" not found. Please call chrome_read_page first and ensure the ref is still valid.`,
          };
        }
      } else {
        element = querySelectorDeep(selector);
      }
      if (!element) {
        return {
          error: selector
            ? `Element with selector "${selector}" not found`
            : `Element for ref not found`,
        };
      }

      // Bring off-screen fields into view before the visibility check.
      try {
        element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      } catch (_) {
        /* element may be detached */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get element information
      const rect = element.getBoundingClientRect();
      const elementInfo = {
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        type: element.type || null,
        isVisible: isElementVisible(element),
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        },
      };

      // Check if element is visible
      if (!elementInfo.isVisible) {
        return {
          error: `Element with selector "${selector}" is not visible`,
          elementInfo,
        };
      }

      if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
        return { error: 'Element is disabled', elementInfo };
      }

      if (isContentEditableHost(element)) {
        const text = String(value ?? '');
        setContentEditableText(element, text);
        element.dispatchEvent(
          new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }),
        );
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: 'Content editable filled',
          elementInfo: { ...elementInfo, value: text },
        };
      }

      // Check if element is an input, textarea, or select
      const validTags = ['INPUT', 'TEXTAREA', 'SELECT'];
      // Keep a permissive list to allow type-specific branches below to handle behavior
      const validInputTypes = [
        'text',
        'email',
        'password',
        'number',
        'search',
        'tel',
        'url',
        'date',
        'datetime-local',
        'month',
        'time',
        'week',
        'color',
        'checkbox',
        'radio',
        'range',
      ];

      if (!validTags.includes(element.tagName)) {
        // If the element is a custom element with open shadow root, try to find a fillable inner control
        try {
          const anyEl = /** @type {any} */ (element);
          const sr = anyEl && anyEl.shadowRoot ? anyEl.shadowRoot : null;
          if (sr) {
            // Search common fillable targets inside shadow root (breadth-first)
            const queue = Array.from(sr.children || []);
            const isFillable = (el) =>
              !!el &&
              (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
            while (queue.length) {
              const cur = queue.shift();
              if (!cur) continue;
              if (isFillable(cur)) {
                element = cur;
                break;
              }
              try {
                const children = cur.children || [];
                for (let i = 0; i < children.length; i++) queue.push(children[i]);
                const innerSr = /** @type {any} */ (cur).shadowRoot;
                if (innerSr && innerSr.children) {
                  for (let i = 0; i < innerSr.children.length; i++) queue.push(innerSr.children[i]);
                }
              } catch (_) {}
            }
            if (!validTags.includes(element.tagName)) {
              return {
                error: `Element with selector "${selector}" is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
                elementInfo,
              };
            }
          } else {
            return {
              error: `Element with selector "${selector}" is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
              elementInfo,
            };
          }
        } catch (_) {
          return {
            error: `Element with selector "${selector}" is not a fillable element (must be INPUT, TEXTAREA, or SELECT)`,
            elementInfo,
          };
        }
      }

      // For input elements, check if the type is valid (allow type-specific branches below)
      if (
        element.tagName === 'INPUT' &&
        !validInputTypes.includes(element.type) &&
        element.type !== null
      ) {
        return {
          error: `Input element with selector "${selector}" has type "${element.type}" which is not fillable`,
          elementInfo,
        };
      }

      // Focus the element
      element.focus();

      // Type-specific handling for tricky inputs first
      if (element.tagName === 'INPUT' && element.type === 'checkbox') {
        // Accept boolean or string-like boolean
        let checkedVal;
        if (typeof value === 'boolean') {
          checkedVal = value;
        } else if (typeof value === 'string') {
          const v = value.trim().toLowerCase();
          if (['true', '1', 'yes', 'on'].includes(v)) checkedVal = true;
          else if (['false', '0', 'no', 'off'].includes(v)) checkedVal = false;
        }
        if (typeof checkedVal !== 'boolean') {
          return {
            error:
              'Checkbox requires a boolean (true/false) or a boolean-like string ("true"/"false"/"on"/"off").',
            elementInfo,
          };
        }
        const previous = element.checked;
        setNativeChecked(element, checkedVal);
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Checkbox set to ${element.checked}`,
          elementInfo: { ...elementInfo, checked: element.checked, previousChecked: previous },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'radio') {
        // For radios, the selector/ref should target the specific input to select
        const previous = element.checked;
        setNativeChecked(element, true);
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: 'Radio selected',
          elementInfo: {
            ...elementInfo,
            checked: element.checked,
            previousChecked: previous,
            name: element.name || null,
          },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'range') {
        const numericValue = typeof value === 'number' ? value : Number(value);
        if (Number.isNaN(numericValue)) {
          return { error: 'Range input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        setNativeValue(element, String(numericValue));
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Set range to ${element.value} (min: ${element.min}, max: ${element.max})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      if (element.tagName === 'INPUT' && element.type === 'number') {
        if (value !== '' && value !== null && value !== undefined && Number.isNaN(Number(value))) {
          return { error: 'Number input requires a numeric value', elementInfo };
        }
        const previous = element.value;
        setNativeValue(element, String(value ?? ''));
        element.focus();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
        return {
          success: true,
          message: `Set number input to ${element.value} (previous: ${previous})`,
          elementInfo: { ...elementInfo, value: element.value },
        };
      }

      // Fill the element based on its type
      if (element.tagName === 'SELECT') {
        // For select elements, find the option with matching value or text
        let optionFound = false;
        for (const option of element.options) {
          if (option.value === value || option.text === String(value)) {
            setNativeValue(element, option.value);
            optionFound = true;
            break;
          }
        }

        if (!optionFound) {
          return {
            error: `No option with value or text "${value}" found in select element`,
            elementInfo,
          };
        }

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // For input and textarea elements. The native setter notifies React.
        const text = String(value);
        setNativeValue(element, '');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        setNativeValue(element, text);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Blur the element
      element.blur();

      return {
        success: true,
        message: 'Element filled successfully',
        elementInfo: {
          ...elementInfo,
          value: element.value, // Include the final value in the response
        },
      };
    } catch (error) {
      return {
        error: `Error filling element: ${error.message}`,
      };
    }
  }

  /**
   * Check if an element is visible
   * @param {Element} element - The element to check
   * @returns {boolean} - Whether the element is visible
   */
  function isElementVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    // Check if element is within viewport
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return false;
    }

    // Check if element is actually visible at its center point
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const elementAtPoint = pierceFromPoint(centerX, centerY);
    if (!elementAtPoint) return false;

    return containsDeep(element, elementAtPoint);
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'fillElement') {
      fillElement(request.selector, request.value, request.ref)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (
      request.action === 'chrome_fill_or_select_ping' ||
      request.action === 'chrome_fill_form_ping'
    ) {
      sendResponse({ status: 'pong' });
      return false;
    } else if (request.action === 'fillFormList') {
      try {
        sendResponse({ success: true, candidates: listFormCandidates() });
      } catch (error) {
        sendResponse({ error: error && error.message ? error.message : String(error) });
      }
      return false;
    } else if (request.action === 'fillFormResolve') {
      try {
        sendResponse(resolveSelectorRef(request.selector));
      } catch (error) {
        sendResponse({ error: error && error.message ? error.message : String(error) });
      }
      return false;
    } else if (request.action === 'fillFormApply') {
      applyFormFills(request.items)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ error: error && error.message ? error.message : String(error) });
        });
      return true;
    } else if (request.action === 'fillFormValidity') {
      try {
        sendResponse({ success: true, validity: readFormValidity(request.refs) });
      } catch (error) {
        sendResponse({ error: error && error.message ? error.message : String(error) });
      }
      return false;
    } else if (request.action === 'fillFormSubmit') {
      try {
        sendResponse(submitFilledForm(request.ref));
      } catch (error) {
        sendResponse({ error: error && error.message ? error.message : String(error) });
      }
      return false;
    }
  });
}
