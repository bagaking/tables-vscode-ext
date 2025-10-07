(function () {
  const vscode = acquireVsCodeApi();
  const gridElement = document.getElementById('grid');
  const statusElement = document.getElementById('status');
  const saveButton = document.getElementById('save');
  const rawToggleButton = document.getElementById('toggle-raw');
  const rawViewElement = document.getElementById('raw-view');
  const editStatusElement = document.getElementById('edit-status');

  const ROW_NUMBER_FIELD = '__rowNumber';

  const khModeSelect = document.getElementById('kh-mode-select');
  const khModeStatus = document.getElementById('kh-mode-status');

  /**
   * @typedef {{ active: boolean; override: 'auto' | 'on' | 'off'; detection: { hasMarkers: boolean; markRowIndex: number | null; tokenHits: string[]; confidence: number } }} KhTablesViewState
   */
  /**
   * @typedef {{ key: string; value: string; description?: string; source?: 'context' | 'fallback' }} EnumOption
   */

  /** @type {KhTablesViewState} */
  let khTablesState = createDefaultKhTablesState();
  /** @type {boolean} */
  let suppressModeSelectNotifications = false;

  /** @type {string} */
  let lastCsvText = '';
  /** @type {number} */
  let columnCount = 1;
  /** @type {string} */
  let newline = '\n';
  /** @type {boolean} */
  let trailingNewline = false;
  /** @type {string[][]} */
  let table = [[]];
  /** @type {import('ag-grid-community').GridApi | null} */
  let gridApi = null;
  /** @type {import('ag-grid-community').GridOptions} */
  let gridOptions;
  /** @type {ResizeObserver | null} */
  let gridResizeObserver = null;
  /** @type {boolean} */
  let columnFitQueued = false;
  /** @type {{ markClasses: string[]; fieldClasses: string[]; dataClasses: string[]; columnType: string; enumToken?: string }[]} */
  let columnTokenStyles = [];
  /** @type {number[]} */
  let columnAutoWidths = [];
  /** @type {boolean} */
  let columnWidthsApplied = false;
  /** @type {boolean} */
  let rawViewActive = false;
  /** @type {number | null} */
  let rawViewInputTimer = null;
  /** @type {HTMLDivElement | null} */
  let contextMenuElement = null;
  /** @type {() => void} | null */
  let contextMenuCleanup = null;
  /** @type {Record<string, EnumOption[]>} */
  let enumContextOptions = {};

  const BRACKET_PAIRS = {
    '(': ')',
    '[': ']',
    '{': '}'
  };
  const BRACKET_OPENERS = new Set(Object.keys(BRACKET_PAIRS));
  const BRACKET_CLOSERS = Object.entries(BRACKET_PAIRS).reduce((acc, [open, close]) => {
    acc[close] = open;
    return acc;
  }, {});
  const BRACKET_DEPTH_CLASSES = [
    'kh-rainbow-depth-0',
    'kh-rainbow-depth-1',
    'kh-rainbow-depth-2',
    'kh-rainbow-depth-3',
    'kh-rainbow-depth-4',
    'kh-rainbow-depth-5'
  ];

  const APPROX_CHAR_WIDTH = 8;
  const MIN_COLUMN_WIDTH = 12;
  const MAX_AUTO_COLUMN_WIDTH = 520;
  const EMPTY_COLUMN_WIDTH = 12;
  const COLUMN_WIDTH_BUFFER = 4;
  const HEADER_WIDTH_BUFFER = 6;
  const RAW_VIEW_DEBOUNCE_MS = 250;
  const CONTEXT_MENU_ID = 'kh-context-menu';

  /**
   * @param {number | null | undefined} columnIndex
   * @returns {string | undefined}
   */
  function getEnumTokenForColumn(columnIndex) {
    if (typeof columnIndex !== 'number' || columnIndex < 0 || columnIndex >= columnTokenStyles.length) {
      return undefined;
    }
    return columnTokenStyles[columnIndex]?.enumToken;
  }

  /**
   * @returns {number | null}
   */
  function getFirstTidColumnIndex() {
    for (let index = 0; index < columnTokenStyles.length; index += 1) {
      if (columnTokenStyles[index]?.columnType === 'tid') {
        return index;
      }
    }
    return null;
  }

  function getTableCellValue(rowIndex, columnIndex) {
    if (!Number.isFinite(rowIndex) || !Number.isFinite(columnIndex)) {
      return '';
    }
    const row = table[rowIndex];
    if (!Array.isArray(row) || columnIndex < 0 || columnIndex >= row.length) {
      return '';
    }
    const value = row[columnIndex];
    return value != null ? String(value) : '';
  }

  async function copyTextToClipboard(text) {
    if (!text) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('clipboard API unavailable');
      }
    } catch (err) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    }
    setStatus('tid copied to clipboard', 'info');
  }

  /**
   * @param {{ enums?: Record<string, EnumOption[]> } | undefined} payload
   */
  function applyEnumContextPayload(payload) {
    if (!payload || typeof payload !== 'object' || !payload.enums || typeof payload.enums !== 'object') {
      enumContextOptions = {};
      return;
    }

    const normalized = {};
    Object.entries(payload.enums).forEach(([enumName, options]) => {
      if (!Array.isArray(options)) {
        return;
      }
      const cleaned = options
        .map((option) => {
          if (!option || typeof option !== 'object') {
            return null;
          }
          const key = typeof option.key === 'string' ? option.key : String(option.key ?? '');
          const value = typeof option.value === 'string' ? option.value : String(option.value ?? '');
          if (value.length === 0) {
            return null;
          }
          const description =
            typeof option.description === 'string' && option.description.trim().length > 0
              ? option.description.trim()
              : undefined;
          const source = option.source === 'fallback' ? 'fallback' : 'context';
          return { key, value, description, source };
        })
        .filter(Boolean);

      if (cleaned.length > 0) {
        normalized[enumName] = cleaned;
      }
    });

    enumContextOptions = normalized;
  }

  /** @type {HTMLSpanElement | null} */
  let textMeasureProbe = null;
  /** @type {string} */
  let textMeasureFontSize = '';
  /** @type {string} */
  let textMeasureFontFamily = '';


  function createDefaultKhTablesState() {
    return {
      active: false,
      override: 'auto',
      detection: { hasMarkers: false, markRowIndex: null, tokenHits: [], confidence: 0 }
    };
  }

  function resolveGridFontDescriptor() {
    const target = gridElement || document.body;
    if (!target) {
      return { size: '12px', family: 'system-ui, sans-serif' };
    }
    const styles = window.getComputedStyle(target);
    const customFontSize = styles.getPropertyValue('--ag-font-size')?.trim();
    const customFontFamily = styles.getPropertyValue('--ag-font-family')?.trim();
    const fontSize = customFontSize && customFontSize.length > 0 ? customFontSize : styles.fontSize || '12px';
    const fontFamily = customFontFamily && customFontFamily.length > 0 ? customFontFamily : styles.fontFamily || 'system-ui, sans-serif';
    return {
      size: (fontSize || '12px').trim(),
      family: (fontFamily || 'system-ui, sans-serif').trim()
    };
  }

  function ensureMeasurementProbe() {
    if (!textMeasureProbe) {
      textMeasureProbe = document.createElement('span');
      textMeasureProbe.style.position = 'absolute';
      textMeasureProbe.style.visibility = 'hidden';
      textMeasureProbe.style.whiteSpace = 'pre';
      textMeasureProbe.style.pointerEvents = 'none';
      textMeasureProbe.style.top = '-10000px';
      textMeasureProbe.style.left = '-10000px';
      textMeasureProbe.style.margin = '0';
      textMeasureProbe.style.padding = '0';
      textMeasureProbe.style.fontStyle = 'normal';
      textMeasureProbe.style.fontVariant = 'normal';
      textMeasureProbe.style.letterSpacing = 'normal';
      textMeasureProbe.style.textTransform = 'none';
      document.body.appendChild(textMeasureProbe);
    }
    const { size, family } = resolveGridFontDescriptor();
    if (textMeasureFontSize !== size) {
      textMeasureFontSize = size;
      textMeasureProbe.style.fontSize = size;
    }
    if (textMeasureFontFamily !== family) {
      textMeasureFontFamily = family;
      textMeasureProbe.style.fontFamily = family;
    }
  }

  function measureTextWidth(text, options) {
    if (!text || text.length === 0) {
      return 0;
    }
    ensureMeasurementProbe();
    if (textMeasureProbe) {
      const resolved = typeof options === 'object' && options !== null
        ? options
        : { fontWeight: typeof options === 'string' ? options : undefined };
      textMeasureProbe.style.fontWeight = resolved.fontWeight || '400';
      textMeasureProbe.style.fontStyle = resolved.fontStyle || 'normal';
      textMeasureProbe.textContent = text;
      const rect = textMeasureProbe.getBoundingClientRect();
      if (rect && rect.width) {
        return rect.width;
      }
    }
    return text.length * APPROX_CHAR_WIDTH;
  }

  function escapeHtml(value) {
    if (value == null) {
      return '';
    }
    return String(value).replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return char;
      }
    });
  }

  function buildBracketSpan(char, depth) {
    const className = BRACKET_DEPTH_CLASSES[Math.abs(depth) % BRACKET_DEPTH_CLASSES.length];
    return `<span class="kh-bracket ${className}">${escapeHtml(char)}</span>`;
  }

  function highlightRainbowBrackets(value) {
    const text = value == null ? '' : String(value);
    if (text.length === 0) {
      return '';
    }

    /** @type {string[]} */
    const stack = [];
    const fragments = [];

    for (const char of Array.from(text)) {
      if (BRACKET_OPENERS.has(char)) {
        const depth = stack.length;
        stack.push(BRACKET_PAIRS[char]);
        fragments.push(buildBracketSpan(char, depth));
        continue;
      }

      if (BRACKET_CLOSERS[char]) {
        let matchedIndex = -1;
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          if (stack[index] === char) {
            matchedIndex = index;
            stack.splice(index, 1);
            break;
          }
        }

        if (matchedIndex >= 0) {
          fragments.push(buildBracketSpan(char, matchedIndex));
        } else {
          fragments.push(escapeHtml(char));
        }
        continue;
      }

      fragments.push(escapeHtml(char));
    }

    return fragments.join('');
  }

  function buildRainbowHtml(value) {
    const text = value == null ? '' : String(value);
    if (text.length === 0) {
      return '';
    }
    return highlightRainbowBrackets(text);
  }

  function rainbowCellRenderer(params) {
    if (!params) {
      return '';
    }

    const value = params.value != null ? String(params.value) : '';
    if (value.length === 0) {
      return '';
    }

    const container = document.createElement('span');
    container.className = 'kh-cell-content';
    container.innerHTML = buildRainbowHtml(value);
    return container;
  }

  const ENUM_TAG_PALETTE = [
    { background: '#e0f2ff', foreground: '#0b4870' },
    { background: '#fce1ff', foreground: '#6a2f76' },
    { background: '#e8f7e7', foreground: '#1f5d2d' },
    { background: '#fff5da', foreground: '#725016' },
    { background: '#ffecee', foreground: '#7b1c36' },
    { background: '#e9e6ff', foreground: '#3e2f82' },
    { background: '#dff7ff', foreground: '#0b4c61' },
    { background: '#fff1e5', foreground: '#7b4516' }
  ];

  function pickEnumTagPalette(label) {
    if (!label) {
      return ENUM_TAG_PALETTE[0];
    }
    let hash = 0;
    for (let index = 0; index < label.length; index += 1) {
      hash = (hash * 31 + label.charCodeAt(index)) & 0xffffffff;
    }
    const paletteIndex = Math.abs(hash) % ENUM_TAG_PALETTE.length;
    return ENUM_TAG_PALETTE[paletteIndex] || ENUM_TAG_PALETTE[0];
  }

  function createEnumCellRenderer(enumMeta) {
    return (params) => {
      if (!params) {
        return '';
      }
      const value = params.value != null ? String(params.value) : '';
      if (value.length === 0) {
        return '';
      }

      const container = document.createElement('span');
      container.className = 'kh-cell-content';
      const rowIndex = params.data?.__rowIndex;
      const rowClass = typeof rowIndex === 'number' ? getRowClassByIndex(rowIndex) : undefined;
      if (enumMeta?.tooltip) {
        container.title = `Options: ${enumMeta.tooltip}`;
      }

      const optionLookup = new Map();
      if (enumMeta && Array.isArray(enumMeta.options)) {
        enumMeta.options.forEach((option) => {
          if (option && typeof option.value === 'string') {
            optionLookup.set(option.value, option);
          }
        });
      }

      if (rowClass === 'kh-mark-row' || rowClass === 'kh-field-row') {
        container.innerHTML = buildRainbowHtml(value);
        return container;
      }

      const tokens = value
        .split('|')
        .map((token) => token.trim())
        .filter(Boolean);

      if (tokens.length === 0) {
        container.innerHTML = buildRainbowHtml(value);
        return container;
      }

      tokens.forEach((token) => {
        const badge = document.createElement('span');
        badge.className = 'kh-enum-tag';
        const palette = pickEnumTagPalette(token);
        badge.style.backgroundColor = palette.background;
        badge.style.color = palette.foreground;
        badge.innerHTML = buildRainbowHtml(token);
        const optionDetails = optionLookup.get(token);
        if (optionDetails?.description) {
          badge.title = optionDetails.description;
        } else if (optionDetails?.source === 'fallback') {
          badge.title = 'Fallback literal';
        }
        if (optionDetails?.source === 'fallback') {
          badge.dataset.source = 'fallback';
        }
        container.appendChild(badge);
      });

      return container;
    };
  }

  function EnumSelectEditor() {}

  EnumSelectEditor.prototype.init = function init(params) {
    this.params = params;
    const currentValue = params.value != null ? String(params.value) : '';
    const select = document.createElement('select');
    select.className = 'kh-enum-editor';
    select.setAttribute('aria-label', 'Enum value');

    const seen = new Set();
    const addOption = (value, label, optionMeta) => {
      if (seen.has(value)) {
        return null;
      }
      seen.add(value);
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label ?? value;
      if (optionMeta?.description) {
        option.title = optionMeta.description;
      }
      if (optionMeta?.source) {
        option.dataset.source = optionMeta.source;
      }
      select.appendChild(option);
      return option;
    };

    addOption('', '');

    const options = Array.isArray(params.options) ? params.options : [];

    const buildOptionLabel = (optionMeta) => {
      if (!optionMeta) {
        return '';
      }
      const baseLabel =
        optionMeta.key && optionMeta.key !== optionMeta.value
          ? `${optionMeta.key} · ${optionMeta.value}`
          : optionMeta.key || optionMeta.value;
      const descriptors = [];
      if (optionMeta.source === 'fallback') {
        descriptors.push('fallback');
      }
      if (optionMeta.description) {
        descriptors.push(optionMeta.description);
      }
      if (descriptors.length > 0) {
        return `${baseLabel} — ${descriptors.join(' · ')}`;
      }
      return baseLabel;
    };

    options.forEach((optionMeta) => {
      if (!optionMeta || typeof optionMeta.value !== 'string' || optionMeta.value.length === 0) {
        return;
      }
      addOption(optionMeta.value, buildOptionLabel(optionMeta), optionMeta);
    });

    if (currentValue && !seen.has(currentValue)) {
      addOption(currentValue, `${currentValue} — raw value`);
    }

    select.value = currentValue;
    this.gui = select;
  };

  EnumSelectEditor.prototype.getGui = function getGui() {
    return this.gui;
  };

  EnumSelectEditor.prototype.afterGuiAttached = function afterGuiAttached() {
    if (this.gui) {
      this.gui.focus({ preventScroll: true });
    }
  };

  EnumSelectEditor.prototype.getValue = function getValue() {
    return this.gui ? this.gui.value : '';
  };

  EnumSelectEditor.prototype.destroy = function destroy() {
    this.gui = null;
  };

  function applyKhTablesState(nextState) {
    if (!nextState || typeof nextState !== 'object') {
      nextState = createDefaultKhTablesState();
    }

    const override = nextState.override === 'on' || nextState.override === 'off' ? nextState.override : 'auto';
    const detection = nextState.detection || {};

    khTablesState = {
      active: Boolean(nextState.active),
      override,
      detection: {
        hasMarkers: Boolean(detection.hasMarkers),
        markRowIndex:
          typeof detection.markRowIndex === 'number' && Number.isFinite(detection.markRowIndex)
            ? Math.max(0, Math.floor(detection.markRowIndex))
            : null,
        tokenHits: Array.isArray(detection.tokenHits) ? detection.tokenHits.map(String) : [],
        confidence: typeof detection.confidence === 'number' ? detection.confidence : 0
      }
    };
    updateKhTablesModeUi();
    if (gridOptions && (gridOptions.api || gridApi)) {
      rebuildGrid();
    }
  }

  function updateKhTablesModeUi() {
    const { active, override, detection } = khTablesState;
    if (khModeStatus) {
      const modeText = active ? 'Enabled' : 'Disabled';
      let detail;
      switch (override) {
        case 'on':
          detail = 'forced on';
          break;
        case 'off':
          detail = 'forced off';
          break;
        default:
          detail = detection.hasMarkers ? 'auto · markers detected' : 'auto';
          break;
      }
      khModeStatus.textContent = `${modeText} (${detail})`;
      khModeStatus.dataset.active = String(active);
      khModeStatus.title = detection.tokenHits.length > 0 ? `Detected tokens: ${detection.tokenHits.join(', ')}` : '';
    }

    if (khModeSelect) {
      suppressModeSelectNotifications = true;
      if (khModeSelect.value !== override) {
        khModeSelect.value = override;
      }
      suppressModeSelectNotifications = false;
    }
  }

  function toColumnLabel(index) {
    let label = '';
    let current = index + 1;
    while (current > 0) {
      const remainder = (current - 1) % 26;
      label = String.fromCharCode(65 + remainder) + label;
      current = Math.floor((current - 1) / 26);
    }
    return label;
  }

  function getRowClassByIndex(rowIndex) {
    if (!khTablesState.active || !khTablesState.detection.hasMarkers) {
      return undefined;
    }

    const markRowIndex = khTablesState.detection.markRowIndex ?? 0;
    if (rowIndex === markRowIndex) {
      return 'kh-mark-row';
    }
    if (rowIndex === markRowIndex + 1) {
      return 'kh-field-row';
    }
    return undefined;
  }

  function deriveRowClass(params) {
    if (!params || !params.data || typeof params.data.__rowIndex !== 'number') {
      return undefined;
    }
    return getRowClassByIndex(params.data.__rowIndex);
  }

  function ensureContextMenuElement() {
    if (contextMenuElement) {
      return contextMenuElement;
    }
    const menu = document.createElement('div');
    menu.id = CONTEXT_MENU_ID;
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-hidden', 'true');
    document.body.appendChild(menu);
    contextMenuElement = menu;
    return menu;
  }

  function closeContextMenu() {
    if (contextMenuCleanup) {
      contextMenuCleanup();
      contextMenuCleanup = null;
    }
    if (contextMenuElement) {
      contextMenuElement.replaceChildren();
      contextMenuElement.setAttribute('aria-hidden', 'true');
      contextMenuElement.style.left = '-9999px';
      contextMenuElement.style.top = '-9999px';
    }
  }

  function openContextMenu(items, clientX, clientY) {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }

    closeContextMenu();

    const menu = ensureContextMenuElement();
    const fragment = document.createDocumentFragment();

    items.forEach((item, index) => {
      if (!item) {
        return;
      }
      if (item.type === 'separator') {
        const separator = document.createElement('div');
        separator.className = 'context-menu-separator';
        separator.setAttribute('role', 'separator');
        fragment.appendChild(separator);
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.setAttribute('role', 'menuitem');
      if (item.disabled) {
        button.disabled = true;
      } else if (typeof item.action === 'function') {
        button.addEventListener('click', () => {
          closeContextMenu();
          item.action();
        });
      }
      fragment.appendChild(button);
    });

    menu.replaceChildren(fragment);

    menu.setAttribute('aria-hidden', 'false');
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';

    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const measuredWidth = menu.offsetWidth || 200;
    const measuredHeight = menu.offsetHeight || items.length * 28;
    const menuWidth = Math.min(measuredWidth, viewportWidth - 16);
    const menuHeight = Math.min(measuredHeight, viewportHeight - 16);
    const left = Math.min(clientX, viewportWidth - menuWidth - 8);
    const top = Math.min(clientY, viewportHeight - menuHeight - 8);

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const dismiss = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') {
        return;
      }
      closeContextMenu();
    };

    const firstAction = menu.querySelector('button:not([disabled])');
    if (firstAction) {
      firstAction.focus({ preventScroll: true });
    }

    const pointerHandler = (ev) => dismiss(ev);
    const wheelHandler = (ev) => dismiss(ev);
    const keyHandler = (ev) => dismiss(ev);

    window.addEventListener('pointerdown', pointerHandler, true);
    window.addEventListener('wheel', wheelHandler, true);
    window.addEventListener('keydown', keyHandler, true);

    contextMenuCleanup = () => {
      window.removeEventListener('pointerdown', pointerHandler, true);
      window.removeEventListener('wheel', wheelHandler, true);
      window.removeEventListener('keydown', keyHandler, true);
    };
  }

  function buildRowContextMenu(rowIndex, options) {
    const canRemove = options?.canRemove !== false;
    const items = [];
    items.push({
      label: 'Add Row Above',
      action: () => addRow(rowIndex - 1)
    });
    items.push({
      label: 'Add Row Below',
      action: () => addRow(rowIndex)
    });
    items.push({ type: 'separator' });
    items.push({
      label: 'Remove Row',
      disabled: table.length <= 1 || !canRemove,
      action: () => removeRow(rowIndex)
    });
    const tidColumnIndex = getFirstTidColumnIndex();
    if (tidColumnIndex != null) {
      const rawValue = getTableCellValue(rowIndex, tidColumnIndex);
      items.push({ type: 'separator' });
      items.push({
        label: 'Copy tid',
        disabled: !rawValue,
        action: () => copyTextToClipboard(rawValue)
      });
    }
    return items;
  }

  function buildHeaderContextMenu(columnIndex) {
    const items = [];
    items.push({
      label: 'Add Column Left',
      action: () => addColumn(columnIndex)
    });
    items.push({
      label: 'Add Column Right',
      action: () => addColumn(columnIndex + 1)
    });
    items.push({ type: 'separator' });
    items.push({
      label: 'Remove Column',
      disabled: columnCount <= 1,
      action: () => removeColumn(columnIndex)
    });
    return items;
  }

  function handleCellContextMenu(params) {
    if (!params || rawViewActive) {
      return;
    }
    const event = params.event;
    if (event?.preventDefault) {
      event.preventDefault();
    }
    closeContextMenu();

    const column = params.column;
    const colId = column?.getColId?.();
    const node = params.node;
    if (!column || colId !== ROW_NUMBER_FIELD || !event || typeof event.clientX !== 'number') {
      return;
    }
    const isPinned = node?.rowPinned != null;
    const rowIndex = typeof node?.rowIndex === 'number' ? node.rowIndex : table.length - 1;
    const items = buildRowContextMenu(rowIndex, { canRemove: !isPinned });
    openContextMenu(items, event.clientX, event.clientY);
  }

  function handleHeaderContextMenu(params) {
    if (!params || rawViewActive) {
      return;
    }
    const event = params.event;
    if (event?.preventDefault) {
      event.preventDefault();
    }
    closeContextMenu();

    const column = params.column;
    const colId = column?.getColId?.();
    if (!column || !colId || colId === ROW_NUMBER_FIELD || !event || typeof event.clientX !== 'number') {
      return;
    }

    const columnIndex = parseColumnIndexFromId(colId);
    if (!Number.isFinite(columnIndex)) {
      return;
    }

    const items = buildHeaderContextMenu(columnIndex);
    openContextMenu(items, event.clientX, event.clientY);
  }

  function setStatus(message, tone) {
    statusElement.textContent = message || '';
    statusElement.dataset.tone = tone || 'info';
  }

  function setEditStatus(state, label) {
    if (!editStatusElement) {
      return;
    }
    editStatusElement.textContent = label;
    editStatusElement.dataset.state = state;
  }

  function updateRawViewText(csvText) {
    if (!rawViewElement || typeof csvText !== 'string') {
      return;
    }
    if (rawViewInputTimer != null) {
      window.clearTimeout(rawViewInputTimer);
      rawViewInputTimer = null;
    }
    rawViewElement.value = csvText;
    rawViewElement.removeAttribute('data-error');
    rawViewElement.removeAttribute('aria-invalid');
  }

  function applyRawViewState(nextActive) {
    rawViewActive = Boolean(nextActive);
    if (!rawToggleButton || !gridElement || !rawViewElement) {
      return;
    }
    closeContextMenu();
    rawToggleButton.setAttribute('aria-pressed', rawViewActive ? 'true' : 'false');
    rawToggleButton.textContent = rawViewActive ? 'Table View' : 'Raw CSV';
    if (rawViewActive) {
      gridElement.style.display = 'none';
      gridElement.setAttribute('aria-hidden', 'true');
      rawViewElement.hidden = false;
      rawViewElement.setAttribute('aria-hidden', 'false');
    } else {
      flushRawViewPendingChanges();
      rawViewElement.hidden = true;
      rawViewElement.setAttribute('aria-hidden', 'true');
      gridElement.style.removeProperty('display');
      gridElement.setAttribute('aria-hidden', 'false');
      queueFitColumns();
    }
  }

  function toggleRawView() {
    applyRawViewState(!rawViewActive);
  }

  function flushRawViewPendingChanges() {
    if (!rawViewElement) {
      return;
    }
    if (rawViewInputTimer != null) {
      window.clearTimeout(rawViewInputTimer);
      rawViewInputTimer = null;
    }
    applyRawViewChanges(rawViewElement.value);
  }

  function initializeGrid() {
    if (typeof window.agGrid === 'undefined' || typeof window.agGrid.createGrid !== 'function') {
      setStatus('Failed to load AG Grid assets', 'error');
      return;
    }

    gridOptions = {
      columnDefs: [],
      rowData: [],
      suppressFieldDotNotation: true,
      defaultColDef: {
        editable: true,
        resizable: true,
        sortable: false,
        filter: false,
        minWidth: MIN_COLUMN_WIDTH,
        wrapHeaderText: true,
        autoHeaderHeight: true
      },
      rowSelection: 'single',
      animateRows: true,
      onCellValueChanged: handleCellValueChanged,
      getRowClass: deriveRowClass,
      onCellContextMenu: handleCellContextMenu,
      onHeaderContextMenu: handleHeaderContextMenu
    };

    gridApi = window.agGrid.createGrid(gridElement, gridOptions);
    if (!gridOptions.api) {
      gridOptions.api = gridApi;
    }

    if (typeof ResizeObserver === 'function') {
      gridResizeObserver = new ResizeObserver(() => queueFitColumns());
      gridResizeObserver.observe(gridElement);
    }
    window.addEventListener('resize', queueFitColumns, { passive: true });
    gridElement.addEventListener('scroll', closeContextMenu, { passive: true });
    queueFitColumns();
  }

  function handleCellValueChanged(event) {
    if (!event || !event.data) {
      return;
    }

    const colId = event.column?.getColId?.();
    const rowIndex = event.data.__rowIndex;
    if (typeof rowIndex !== 'number' || typeof colId !== 'string') {
      return;
    }

    const columnIndex = parseColumnIndexFromId(colId);
    if (!Number.isFinite(columnIndex)) {
      return;
    }

    ensureTableShape();
    const normalizedValue = event.newValue != null ? String(event.newValue) : '';
    table[rowIndex][columnIndex] = normalizedValue;
    sendUpdate('Edited');
  }

  function ensureTableShape() {
    columnCount = Math.max(columnCount, 1);
    if (table.length === 0) {
      table = [new Array(columnCount).fill('')];
    }
    for (let rowIndex = 0; rowIndex < table.length; rowIndex += 1) {
      const row = table[rowIndex];
      if (!Array.isArray(row)) {
        table[rowIndex] = new Array(columnCount).fill('');
        continue;
      }
      while (row.length < columnCount) {
        row.push('');
      }
      if (row.length > columnCount) {
        row.length = columnCount;
      }
    }
  }

  function rebuildGrid() {
    ensureTableShape();

    const markRowIndex = khTablesState.detection.hasMarkers
      ? khTablesState.detection.markRowIndex ?? 0
      : null;

    columnTokenStyles = deriveTokenStyles(markRowIndex, columnCount);
    const rowModels = table.map((row, rowIndex) => {
      const record = { __rowIndex: rowIndex };
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const key = `c${columnIndex}`;
        record[key] = row[columnIndex] != null ? String(row[columnIndex]) : '';
      }
      return record;
    });

    const api = gridOptions.api || gridApi;
    if (!api) {
      return;
    }

    const pinnedTopRows = markRowIndex != null ? buildPinnedTopRows(rowModels, markRowIndex) : [];
    const columnDefs = buildColumnDefs(columnCount, columnTokenStyles, markRowIndex, pinnedTopRows);
    const remainingRows = filterPinnedRows(rowModels, pinnedTopRows);

    if (typeof api.setGridOption === 'function') {
      api.setGridOption('columnDefs', columnDefs);
      api.setGridOption('rowData', remainingRows);
      api.setGridOption('pinnedTopRowData', pinnedTopRows);
    } else {
      api.setColumnDefs(columnDefs);
      api.setPinnedTopRowData(pinnedTopRows);
      api.setRowData(remainingRows);
    }

    queueFitColumns();
  }

  function parseColumnIndexFromId(colId) {
    if (typeof colId !== 'string') {
      return NaN;
    }
    if (colId.startsWith('col-')) {
      return Number.parseInt(colId.slice(4), 10);
    }
    if (colId.startsWith('c')) {
      return Number.parseInt(colId.slice(1), 10);
    }
    return Number.parseInt(colId, 10);
  }

  function queueFitColumns() {
    const api = (gridOptions?.api) || gridApi;
    if (!api || typeof api.setColumnWidth !== 'function') {
      return;
    }

    if (columnFitQueued) {
      return;
    }
    if (columnWidthsApplied) {
      return;
    }

    columnFitQueued = true;
    requestAnimationFrame(() => {
      columnFitQueued = false;
      if (!api || !gridElement || gridElement.offsetWidth === 0) {
        return;
      }

      if (!Array.isArray(columnAutoWidths) || columnAutoWidths.length === 0) {
        return;
      }

      const columns = typeof api.getAllDisplayedColumns === 'function'
        ? api.getAllDisplayedColumns()
        : typeof api.getColumns === 'function'
          ? api.getColumns()
          : [];
      columns.forEach((column) => {
        const colId = column.getColId?.();
        const columnIndex = parseColumnIndexFromId(colId);
        if (!Number.isFinite(columnIndex)) {
          return;
        }
        const targetWidth = columnAutoWidths[columnIndex];
        if (!Number.isFinite(targetWidth)) {
          return;
        }
        api.setColumnWidth(column, targetWidth, false);
      });
      columnWidthsApplied = true;
    });
  }

  function buildPinnedTopRows(rowModels, markRowIndex) {
    if (!khTablesState.active || !khTablesState.detection.hasMarkers) {
      return [];
    }

    const descriptionRowIndex = markRowIndex + 1;
    const pinned = [];

    rowModels.forEach((row) => {
      if (row.__rowIndex === markRowIndex || row.__rowIndex === descriptionRowIndex) {
        pinned.push({ ...row, __pinned: true, [ROW_NUMBER_FIELD]: '' });
      }
    });

    if (pinned.length === 0 && rowModels.length > 0) {
      pinned.push({ ...rowModels[0], __pinned: true, [ROW_NUMBER_FIELD]: '' });
    }

    return pinned.map((row) => ({ ...row, __rowIndex: row.__rowIndex ?? -1 }));
  }

  function filterPinnedRows(rowModels, pinnedRows) {
    if (!Array.isArray(rowModels) || rowModels.length === 0) {
      return [];
    }
    if (!Array.isArray(pinnedRows) || pinnedRows.length === 0) {
      return rowModels;
    }

    const pinnedIndices = new Set(
      pinnedRows
        .map((row) => row.__rowIndex)
        .filter((value) => typeof value === 'number' && value >= 0)
    );

    return rowModels.filter((row) => !pinnedIndices.has(row.__rowIndex));
  }

  function deriveInitialColumnWidths(totalColumns, markRowIndex, pinnedRows) {
    const widths = new Array(totalColumns);
    for (let index = 0; index < totalColumns; index += 1) {
      widths[index] = calculateInitialColumnWidth(index, markRowIndex, pinnedRows);
    }
    return widths;
  }

  function normalizeEnumTokenText(token) {
    if (typeof token !== 'string') {
      return '';
    }
    let text = token.trim();
    while (text.endsWith('?')) {
      text = text.slice(0, -1).trim();
    }
    let changed = true;
    while (changed) {
      changed = false;
      if (text.endsWith('[]')) {
        text = text.slice(0, -2).trim();
        changed = true;
      }
    }
    return text;
  }

  function parseEnumTokenDetails(token) {
    const normalized = normalizeEnumTokenText(token);
    if (!normalized.toLowerCase().startsWith('enum')) {
      return null;
    }
    const openIndex = normalized.indexOf('<');
    const closeIndex = normalized.lastIndexOf('>');
    if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex + 1) {
      return null;
    }
    const inner = normalized.slice(openIndex + 1, closeIndex);
    const parts = inner
      .split('|')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      return null;
    }
    const [enumName, ...fallbacks] = parts;
    return {
      enumName: enumName.length > 0 ? enumName : undefined,
      fallbacks: fallbacks.filter((value, index, array) => array.indexOf(value) === index)
    };
  }

  function collectEnumMetadata(columnIndex, markRowIndex) {
    const enumToken = getEnumTokenForColumn(columnIndex);
    const parsed = parseEnumTokenDetails(enumToken);
    if (!parsed || !parsed.enumName) {
      return null;
    }

    const contextOptions = enumContextOptions[parsed.enumName];
    if (!Array.isArray(contextOptions) || contextOptions.length === 0) {
      return null;
    }

    const mergedOptions = [];
    const seenValues = new Set();

    contextOptions.forEach((option) => {
      if (!option || typeof option.value !== 'string') {
        return;
      }
      const normalizedValue = option.value;
      if (seenValues.has(normalizedValue)) {
        return;
      }
      seenValues.add(normalizedValue);
      mergedOptions.push(option);
    });

    parsed.fallbacks.forEach((fallback) => {
      if (!fallback || seenValues.has(fallback)) {
        return;
      }
      seenValues.add(fallback);
      mergedOptions.push({ key: fallback, value: fallback, source: 'fallback' });
    });

    if (mergedOptions.length === 0) {
      return null;
    }

    const tooltip = mergedOptions
      .map((option) => {
        if (option.description && option.description.length > 0) {
          return `${option.key}: ${option.description}`;
        }
        if (option.source === 'fallback') {
          return `${option.key} (fallback)`;
        }
        return option.key;
      })
      .join(', ');

    return {
      enumName: parsed.enumName,
      options: mergedOptions,
      tooltip,
      values: mergedOptions.map((option) => option.value)
    };
  }

  function calculateInitialColumnWidth(columnIndex, markRowIndex, pinnedRows) {
    const headerLabel = toColumnLabel(columnIndex);
    const headerWidth = measureTextWidth(headerLabel, { fontWeight: '600' }) + HEADER_WIDTH_BUFFER;

    let columnType = 'default';
    if (khTablesState.active && khTablesState.detection.hasMarkers && markRowIndex != null) {
      const markRow = Array.isArray(table[markRowIndex]) ? table[markRowIndex] : [];
      if (markRow && markRow.length > columnIndex) {
        columnType = determineColumnType(markRow[columnIndex]);
      } else if (Array.isArray(pinnedRows)) {
        const pinnedMarkRow = pinnedRows.find((row) => row.__rowIndex === markRowIndex);
        if (pinnedMarkRow && Object.prototype.hasOwnProperty.call(pinnedMarkRow, `c${columnIndex}`)) {
          columnType = determineColumnType(pinnedMarkRow[`c${columnIndex}`]);
        }
      }
    }

    let maxContentWidth = 0;
    const measurementEntries = [];

    for (let rowIndex = 0; rowIndex < table.length; rowIndex += 1) {
      const row = table[rowIndex];
      const rawValue = Array.isArray(row) ? row[columnIndex] : undefined;
      measurementEntries.push({
        text: rawValue != null ? String(rawValue) : '',
        rowIndex
      });
    }

    if (Array.isArray(pinnedRows) && pinnedRows.length > 0) {
      const key = `c${columnIndex}`;
      pinnedRows.forEach((row) => {
        if (!row) {
          return;
        }
        const value = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : '';
        measurementEntries.push({
          text: value != null ? String(value) : '',
          rowIndex: typeof row.__rowIndex === 'number' ? row.__rowIndex : null
        });
      });
    }

    measurementEntries.forEach((entry) => {
      const rowClass = typeof entry.rowIndex === 'number' ? getRowClassByIndex(entry.rowIndex) : undefined;
      const isMarkOrField = rowClass === 'kh-mark-row' || rowClass === 'kh-field-row';
      const fontWeight = isMarkOrField || columnType === 'at' || columnType === 'alias' || columnType === 'tid' ? '600' : '400';
      const fontStyle = columnType === 'comment' ? 'italic' : 'normal';
      const width = measureTextWidth(entry.text, { fontWeight, fontStyle });
      if (width > maxContentWidth) {
        maxContentWidth = width;
      }
    });

    const contentWidth = maxContentWidth > 0
      ? maxContentWidth + COLUMN_WIDTH_BUFFER
      : EMPTY_COLUMN_WIDTH;

    const unclampedWidth = Math.max(headerWidth, contentWidth);
    const normalized = Math.ceil(unclampedWidth);
    return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_AUTO_COLUMN_WIDTH, normalized));
  }

  function buildColumnDefs(totalColumns, tokenStyles, markRowIndex, pinnedRows) {
    columnAutoWidths = deriveInitialColumnWidths(totalColumns, markRowIndex, pinnedRows);
    columnWidthsApplied = false;
    const pinnedDataColumns = calculatePinnedDataColumns(tokenStyles);

    const defs = [
      {
        headerName: '#',
        field: ROW_NUMBER_FIELD,
        pinned: 'left',
        editable: false,
        sortable: false,
        resizable: false,
        suppressMenu: true,
        suppressMovable: true,
        width: 32,
        minWidth: 24,
        maxWidth: 40,
        valueGetter: (params) => {
          const node = params?.node;
          if (!node || node.rowPinned) {
            return '';
          }
          return (node.rowIndex ?? 0) + 1;
        },
        cellClass: 'kh-row-number-cell',
        headerClass: 'kh-row-number-header'
      }
    ];

    for (let index = 0; index < totalColumns; index += 1) {
      const tokenInfo = tokenStyles[index];
      const enumToken = tokenInfo?.enumToken;
      const enumMeta = enumToken ? collectEnumMetadata(index, markRowIndex ?? null) : null;
      defs.push({
        headerName: toColumnLabel(index),
        field: `c${index}`,
        editable: true,
        minWidth: MIN_COLUMN_WIDTH,
        width: columnAutoWidths[index],
        pinned: index < pinnedDataColumns ? 'left' : undefined,
        lockPinned: index < pinnedDataColumns,
        cellRenderer: enumMeta ? createEnumCellRenderer(enumMeta) : rainbowCellRenderer,
        cellEditor: enumMeta ? EnumSelectEditor : undefined,
        cellEditorParams: enumMeta ? { options: enumMeta.options } : undefined,
        cellClass: (params) => composeCellClasses(index, params, tokenStyles),
        cellDataType: 'text'
      });
    }

    return defs;
  }

  function composeCellClasses(columnIndex, params, tokenStyles) {
    const classes = [];
    const baseClass = getColumnBaseClass(columnIndex);
    if (baseClass) {
      classes.push(baseClass);
    }

    const rowIndex = params?.data?.__rowIndex;
    const tokenInfo = tokenStyles[columnIndex];
    const rowClass = typeof rowIndex === 'number' ? getRowClassByIndex(rowIndex) : undefined;

    if (rowClass === 'kh-mark-row' && tokenInfo) {
      classes.push('kh-mark-cell');
      classes.push(...tokenInfo.markClasses);
    } else if (rowClass === 'kh-field-row' && tokenInfo) {
      classes.push('kh-field-cell');
      classes.push(...tokenInfo.fieldClasses);
    } else if (tokenInfo) {
      classes.push(...tokenInfo.dataClasses);
    }

    if (classes.length === 0) {
      return undefined;
    }
    return classes.join(' ');
  }

  function getColumnBaseClass(columnIndex) {
    if (columnIndex === 0 && khTablesState.detection.hasMarkers) {
      return 'kh-col-primary-key';
    }
    return undefined;
  }

  function deriveTokenStyles(markRowIndex, totalColumns) {
    if (!khTablesState.active || markRowIndex == null) {
      return new Array(totalColumns).fill(undefined);
    }

    const styles = [];
    const markRow = Array.isArray(table[markRowIndex]) ? table[markRowIndex] : [];
    const fieldRow = Array.isArray(table[markRowIndex + 1]) ? table[markRowIndex + 1] : [];

    for (let index = 0; index < totalColumns; index += 1) {
      const token = markRow[index] != null ? String(markRow[index]) : '';
      const field = fieldRow[index] != null ? String(fieldRow[index]) : '';
      styles[index] = classifyToken(token, field);
    }

    return styles;
  }

  function calculatePinnedDataColumns(tokenStyles) {
    if (
      !khTablesState.active ||
      !khTablesState.detection.hasMarkers ||
      !Array.isArray(tokenStyles) ||
      tokenStyles.length === 0
    ) {
      return 0;
    }

    let count = 0;
    for (let index = 0; index < tokenStyles.length; index += 1) {
      const info = tokenStyles[index];
      if (!info) {
        break;
      }
      if (info.columnType === 'at' || info.columnType === 'alias' || info.columnType === 'enum') {
        count += 1;
      } else {
        break;
      }
    }
    return count;
  }

  function determineColumnType(tokenText) {
    const raw = (tokenText || '').trim();
    const normalized = raw.toLowerCase();
    if (!raw || raw === '#') {
      return 'comment';
    }
    if (/[\{\}\[\]]/.test(raw) || normalized.includes('struct')) {
      return 'struct';
    }
    if (normalized.startsWith('enum')) {
      return 'enum';
    }
    if (
      normalized.includes('alias') ||
      normalized.includes('map') ||
      normalized.includes('pair')
    ) {
      return 'alias';
    }
    if (raw.includes('@')) {
      return 'at';
    }
    if (normalized.includes('tid')) {
      return 'tid';
    }
    return 'default';
  }

  function classifyToken(tokenText, fieldText) {
    const raw = (tokenText || '').trim();
    const fieldRaw = (fieldText || '').trim();
    const markClasses = new Set();
    const fieldClasses = new Set();
    const dataClasses = new Set();

    const optional = raw.endsWith('?') || fieldRaw.endsWith('?');
    if (optional) {
      markClasses.add('kh-token-optional');
      fieldClasses.add('kh-token-optional');
      dataClasses.add('kh-data-optional');
    } else {
      markClasses.add('kh-token-required');
      fieldClasses.add('kh-token-required');
      dataClasses.add('kh-data-required');
    }

    const columnType = determineColumnType(raw);
    const enumToken = columnType === 'enum' ? raw : undefined;

    const typeClass = `kh-col-type-${columnType}`;
    markClasses.add(typeClass);
    fieldClasses.add(typeClass);
    dataClasses.add(typeClass);

    if (columnType === 'comment') {
      markClasses.add('kh-col-comment');
      fieldClasses.add('kh-col-comment');
      dataClasses.add('kh-col-comment');
    }

    if (columnType === 'struct') {
      markClasses.add('kh-col-struct');
      fieldClasses.add('kh-col-struct');
      dataClasses.add('kh-col-struct');
    }

    if (columnType === 'at' || columnType === 'alias' || columnType === 'enum' || columnType === 'tid') {
      markClasses.add('kh-col-emphasis');
      fieldClasses.add('kh-col-emphasis');
      dataClasses.add('kh-col-emphasis');
    }

    return {
      markClasses: Array.from(markClasses),
      fieldClasses: Array.from(fieldClasses),
      dataClasses: Array.from(dataClasses),
      columnType,
      enumToken
    };
  }

  function normalizeParsedRows(rawRows) {
    if (!Array.isArray(rawRows)) {
      return [[]];
    }
    return rawRows.map((row) => (Array.isArray(row) ? row : [row]));
  }

  function applyRowsToTable(rows) {
    const normalized = normalizeParsedRows(rows);
    const inferredColumns = normalized.reduce((max, row) => Math.max(max, row.length), 0);
    columnCount = Math.max(1, inferredColumns);
    table = normalized.length > 0 ? normalized : [[]];
    ensureTableShape();
  }

  function parseCsv(csvText) {
    if (typeof csvText !== 'string' || csvText.length === 0) {
      applyRowsToTable([[]]);
      return;
    }

    const parseResult = Papa.parse(csvText, {
      dynamicTyping: false,
      skipEmptyLines: false
    });

    if (parseResult.errors && parseResult.errors.length > 0) {
      const firstError = parseResult.errors[0];
      const message = firstError.message || 'Failed to parse CSV';
      setStatus(message, 'error');
    } else {
      setStatus('Ready');
    }

    applyRowsToTable(parseResult.data);
  }

  function applyRawViewChanges(csvText) {
    if (!rawViewElement || typeof csvText !== 'string') {
      return;
    }
    if (csvText === lastCsvText) {
      rawViewElement.removeAttribute('data-error');
      rawViewElement.removeAttribute('aria-invalid');
      return;
    }

    const parseResult = Papa.parse(csvText, {
      dynamicTyping: false,
      skipEmptyLines: false
    });

    if (parseResult.errors && parseResult.errors.length > 0) {
      const firstError = parseResult.errors[0];
      const message = firstError.message || 'Failed to parse CSV';
      setStatus(message, 'error');
      rawViewElement.setAttribute('data-error', 'true');
      rawViewElement.setAttribute('aria-invalid', 'true');
      return;
    }

    rawViewElement.removeAttribute('data-error');
    rawViewElement.removeAttribute('aria-invalid');
    setStatus('Raw view updated', 'info');

    lastCsvText = csvText;
    newline = detectLineEnding(csvText);
    trailingNewline = newline.length > 0 && csvText.endsWith(newline);
    applyRowsToTable(parseResult.data);
    rebuildGrid();
    vscode.setState({ csv: csvText });
    vscode.postMessage({ type: 'update', text: csvText });
    setEditStatus('dirty', 'Unsaved changes');
  }

  function handleRawViewInput() {
    if (!rawViewElement) {
      return;
    }
    const text = rawViewElement.value;
    if (rawViewInputTimer != null) {
      window.clearTimeout(rawViewInputTimer);
    }
    rawViewInputTimer = window.setTimeout(() => {
      rawViewInputTimer = null;
      applyRawViewChanges(text);
    }, RAW_VIEW_DEBOUNCE_MS);
  }

  function updateFromText(csvText) {
    if (csvText === lastCsvText) {
      return;
    }

    lastCsvText = csvText;
    newline = detectLineEnding(csvText);
    trailingNewline = newline.length > 0 && csvText.endsWith(newline);
    parseCsv(csvText);
    rebuildGrid();
    updateRawViewText(csvText);
    setEditStatus('saved', 'Saved');
  }

  function detectLineEnding(text) {
    if (text.includes('\r\n')) {
      return '\r\n';
    }
    return '\n';
  }

  function serializeCsv() {
    ensureTableShape();
    const rows = table.map((row) => row.slice(0, columnCount));
    const csv = Papa.unparse(rows, { newline });
    if (trailingNewline && !csv.endsWith(newline)) {
      return csv + newline;
    }
    return csv;
  }

  function sendUpdate(message) {
    const csv = serializeCsv();
    if (csv === lastCsvText) {
      return;
    }
    lastCsvText = csv;
    vscode.setState({ csv });
    vscode.postMessage({ type: 'update', text: csv });
    if (message) {
      setStatus(message, 'info');
    }
    updateRawViewText(csv);
    setEditStatus('dirty', 'Unsaved changes');
  }

  function addRow(afterIndex) {
    ensureTableShape();
    const baseIndex = typeof afterIndex === 'number' ? afterIndex : getFocusedRowIndex();
    const clampedBase = Number.isFinite(baseIndex) ? Math.max(-1, Math.min(baseIndex, table.length - 1)) : table.length - 1;
    const insertIndex = clampedBase + 1;
    const rowTemplate = new Array(columnCount).fill('');
    table.splice(insertIndex, 0, rowTemplate);
    rebuildGrid();
    if (!rawViewActive) {
      focusRow(insertIndex);
    }
    sendUpdate('Row added');
  }

  function removeRow(targetIndex) {
    if (table.length === 0) {
      setStatus('No rows to remove', 'warn');
      return;
    }
    let rowIndex = typeof targetIndex === 'number' ? targetIndex : getFocusedRowIndex();
    if (!Number.isFinite(rowIndex) || rowIndex < 0) {
      rowIndex = table.length - 1;
    }
    table.splice(rowIndex, 1);
    if (table.length === 0) {
      table.push(new Array(columnCount).fill(''));
    }
    rebuildGrid();
    if (!rawViewActive) {
      focusRow(Math.max(0, Math.min(rowIndex, table.length - 1)));
    }
    sendUpdate('Row removed');
  }

  function addColumn(insertIndex) {
    ensureTableShape();
    const targetIndex = Number.isFinite(insertIndex) ? Math.max(0, Math.min(insertIndex, columnCount)) : columnCount;
    table.forEach((row) => {
      if (Array.isArray(row)) {
        row.splice(targetIndex, 0, '');
      }
    });
    columnCount += 1;
    rebuildGrid();
    sendUpdate('Column added');
  }

  function removeColumn(targetIndex) {
    if (columnCount <= 1) {
      setStatus('Minimum one column required', 'warn');
      return;
    }
    let columnIndex = Number.isFinite(targetIndex) ? targetIndex : columnCount - 1;
    columnIndex = Math.max(0, Math.min(columnIndex, columnCount - 1));
    table.forEach((row) => {
      if (Array.isArray(row)) {
        if (row.length > columnIndex) {
          row.splice(columnIndex, 1);
        } else {
          row.splice(row.length - 1, 1);
        }
      }
    });
    columnCount -= 1;
    rebuildGrid();
    sendUpdate('Column removed');
  }

  function focusRow(rowIndex) {
    const api = gridOptions.api || gridApi;
    if (!api) {
      return;
    }
    const targetIndex = Math.min(Math.max(rowIndex, 0), table.length - 1);
    const columnKey = 'c0';
    window.requestAnimationFrame(() => {
      api.ensureIndexVisible(targetIndex, 'middle');
      api.setFocusedCell(targetIndex, columnKey);
    });
  }

  function getFocusedRowIndex() {
    const api = gridOptions.api || gridApi;
    if (!api) {
      return table.length - 1;
    }
    const focusedCell = api.getFocusedCell?.();
    if (focusedCell && typeof focusedCell.rowIndex === 'number') {
      return focusedCell.rowIndex;
    }
    const selectedNodes = api.getSelectedNodes?.();
    if (Array.isArray(selectedNodes) && selectedNodes.length > 0) {
      const [node] = selectedNodes;
      if (node && typeof node.rowIndex === 'number') {
        return node.rowIndex;
      }
    }
    return table.length - 1;
  }

  function requestSave() {
    const csv = serializeCsv();
    lastCsvText = csv;
    vscode.postMessage({ type: 'requestSave', text: csv });
    setStatus('Save requested', 'info');
    updateRawViewText(csv);
    setEditStatus('saving', 'Saving…');
  }

  function restoreFromState() {
    const state = vscode.getState();
    if (state && typeof state.csv === 'string' && state.csv.length > 0) {
      updateFromText(state.csv);
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'init':
      case 'externalUpdate':
        applyEnumContextPayload(message.context);
        updateFromText(message.text || '');
        applyKhTablesState(message.khTables);
        break;
      case 'khTablesState':
        applyEnumContextPayload(message.context);
        applyKhTablesState(message.khTables);
        break;
      default:
        break;
    }
  });

  if (saveButton) {
    saveButton.addEventListener('click', requestSave);
  }

  if (rawToggleButton) {
    rawToggleButton.addEventListener('click', toggleRawView);
  }

  if (rawViewElement) {
    rawViewElement.addEventListener('input', handleRawViewInput);
    rawViewElement.addEventListener('change', () => applyRawViewChanges(rawViewElement.value));
  }

  if (khModeSelect) {
    khModeSelect.addEventListener('change', () => {
      if (suppressModeSelectNotifications) {
        return;
      }
      const override = khModeSelect.value;
      if (override === 'auto' || override === 'on' || override === 'off') {
        vscode.postMessage({ type: 'setKhMode', override });
      }
    });
  }

  updateKhTablesModeUi();
  applyRawViewState(false);
  setEditStatus('saved', 'Saved');

  initializeGrid();
  restoreFromState();
  vscode.postMessage({ type: 'ready' });
  setStatus('Ready');
})();
