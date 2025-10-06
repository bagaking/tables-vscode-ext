(function () {
  const vscode = acquireVsCodeApi();
  const gridElement = document.getElementById('grid');
  const statusElement = document.getElementById('status');
  const addRowButton = document.getElementById('add-row');
  const removeRowButton = document.getElementById('remove-row');
  const addColumnButton = document.getElementById('add-column');
  const removeColumnButton = document.getElementById('remove-column');
  const saveButton = document.getElementById('save');

  const ROW_NUMBER_FIELD = '__rowNumber';

  const khModeSelect = document.getElementById('kh-mode-select');
  const khModeStatus = document.getElementById('kh-mode-status');

  /**
   * @typedef {{ active: boolean; override: 'auto' | 'on' | 'off'; detection: { hasMarkers: boolean; markRowIndex: number | null; tokenHits: string[]; confidence: number } }} KhTablesViewState
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
  /** @type {{ markClasses: string[]; fieldClasses: string[]; dataClasses: string[] }[]} */
  let columnTokenStyles = [];


  function createDefaultKhTablesState() {
    return {
      active: false,
      override: 'auto',
      detection: { hasMarkers: false, markRowIndex: null, tokenHits: [], confidence: 0 }
    };
  }

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

  function setStatus(message, tone) {
    statusElement.textContent = message || '';
    statusElement.dataset.tone = tone || 'info';
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
        minWidth: 120,
        wrapHeaderText: true,
        autoHeaderHeight: true
      },
      rowSelection: 'single',
      animateRows: true,
      onCellValueChanged: handleCellValueChanged,
      getRowClass: deriveRowClass
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

    const columnIndex = Number.parseInt(colId.replace('c', ''), 10);
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
    const columnDefs = buildColumnDefs(columnCount, columnTokenStyles);

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

    const pinnedTopRows =
      markRowIndex != null ? buildPinnedTopRows(rowModels, markRowIndex) : [];
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

  function queueFitColumns() {
    const api = gridOptions.api || gridApi;
    if (!api || typeof api.sizeColumnsToFit !== 'function') {
      return;
    }

    if (columnFitQueued) {
      return;
    }

    columnFitQueued = true;
    requestAnimationFrame(() => {
      columnFitQueued = false;
      if (!gridElement || gridElement.offsetWidth === 0) {
        return;
      }
      api.sizeColumnsToFit();
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

  function buildColumnDefs(totalColumns, tokenStyles) {
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
        width: 46,
        minWidth: 34,
        maxWidth: 60,
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
      defs.push({
        colId: `col-${index}`,
        headerName: toColumnLabel(index),
        field: `c${index}`,
        editable: true,
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

  function classifyToken(tokenText, fieldText) {
    const raw = (tokenText || '').trim();
    const fieldRaw = (fieldText || '').trim();
    const normalized = raw.toLowerCase();
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

    if (!raw) {
      return {
        markClasses: Array.from(markClasses),
        fieldClasses: Array.from(fieldClasses),
        dataClasses: Array.from(dataClasses)
      };
    }

    if (normalized.includes('error') || normalized.includes('invalid')) {
      markClasses.add('kh-token-error');
      fieldClasses.add('kh-token-error');
    }
    if (raw.includes('@')) {
      markClasses.add('kh-token-at');
      fieldClasses.add('kh-token-at');
    }
    if (normalized.includes('alias') || normalized.startsWith('enum') || normalized.includes('map') || normalized.includes('pair')) {
      markClasses.add('kh-token-alias');
      fieldClasses.add('kh-token-alias');
    }
    if (normalized.includes('tid')) {
      markClasses.add('kh-token-tid');
      fieldClasses.add('kh-token-tid');
    }
    if (/[\{\}\[\]]/.test(raw) || normalized.includes('struct')) {
      markClasses.add('kh-token-struct');
      fieldClasses.add('kh-token-struct');
    }

    return {
      markClasses: Array.from(markClasses),
      fieldClasses: Array.from(fieldClasses),
      dataClasses: Array.from(dataClasses)
    };
  }

  function parseCsv(csvText) {
    if (typeof csvText !== 'string' || csvText.length === 0) {
      return [[]];
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

    const rows = Array.isArray(parseResult.data)
      ? parseResult.data.map((row) => (Array.isArray(row) ? row : [row]))
      : [[]];

    const inferredColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
    columnCount = Math.max(1, inferredColumns);
    table = rows.length > 0 ? rows : [[]];
    ensureTableShape();
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
  }

  function addRow() {
    ensureTableShape();
    const insertIndex = getFocusedRowIndex() + 1;
    const rowTemplate = new Array(columnCount).fill('');
    table.splice(insertIndex, 0, rowTemplate);
    rebuildGrid();
    focusRow(insertIndex);
    sendUpdate('Row added');
  }

  function removeRow() {
    if (table.length === 0) {
      setStatus('No rows to remove', 'warn');
      return;
    }
    let targetIndex = getFocusedRowIndex();
    if (Number.isNaN(targetIndex) || targetIndex < 0) {
      targetIndex = table.length - 1;
    }
    table.splice(targetIndex, 1);
    if (table.length === 0) {
      table.push(new Array(columnCount).fill(''));
    }
    rebuildGrid();
    focusRow(Math.max(0, targetIndex - 1));
    sendUpdate('Row removed');
  }

  function addColumn() {
    columnCount += 1;
    ensureTableShape();
    rebuildGrid();
    sendUpdate('Column added');
  }

  function removeColumn() {
    if (columnCount <= 1) {
      setStatus('Minimum one column required', 'warn');
      return;
    }
    columnCount -= 1;
    ensureTableShape();
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
        updateFromText(message.text || '');
        applyKhTablesState(message.khTables);
        break;
      case 'khTablesState':
        applyKhTablesState(message.khTables);
        break;
      default:
        break;
    }
  });

  addRowButton.addEventListener('click', addRow);
  removeRowButton.addEventListener('click', removeRow);
  addColumnButton.addEventListener('click', addColumn);
  removeColumnButton.addEventListener('click', removeColumn);
  saveButton.addEventListener('click', requestSave);

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

  initializeGrid();
  restoreFromState();
  vscode.postMessage({ type: 'ready' });
  setStatus('Ready');
})();
