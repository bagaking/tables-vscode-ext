(function () {
  const vscode = acquireVsCodeApi();
  const gridElement = document.getElementById('grid');
  const statusElement = document.getElementById('status');
  const addRowButton = document.getElementById('add-row');
  const removeRowButton = document.getElementById('remove-row');
  const addColumnButton = document.getElementById('add-column');
  const removeColumnButton = document.getElementById('remove-column');
  const saveButton = document.getElementById('save');

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
      onCellValueChanged: handleCellValueChanged
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

    const columnDefs = [];
    for (let index = 0; index < columnCount; index += 1) {
      columnDefs.push({
        headerName: `Column ${index + 1}`,
        field: `c${index}`,
        editable: true,
        cellDataType: 'text'
      });
    }

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

    if (typeof api.setGridOption === 'function') {
      api.setGridOption('columnDefs', columnDefs);
      api.setGridOption('rowData', rowModels);
    } else {
      api.setColumnDefs(columnDefs);
      api.setRowData(rowModels);
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

  initializeGrid();
  restoreFromState();
  vscode.postMessage({ type: 'ready' });
  setStatus('Ready');
})();
