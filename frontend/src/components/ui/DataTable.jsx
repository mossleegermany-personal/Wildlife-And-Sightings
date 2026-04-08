import { useMemo } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community'
import '../../css/components/DataTable.css'

ModuleRegistry.registerModules([AllCommunityModule])

const wildlifeTheme = themeQuartz.withParams({
  accentColor: '#4a8a3a',
  headerBackgroundColor: '#1e4022',
  headerTextColor: '#d4edaa',
  headerFontSize: 18,
  rowHoverColor: '#d8f0c8',
  backgroundColor: '#fafdf8',
  oddRowBackgroundColor: '#f0f9e8',
  borderColor: '#cdddc5',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 20,
  cellHorizontalPaddingScale: 1.1,

})

function DataTable({ rows }) {
  if (!rows || rows.length < 2) return <p className="dt-empty">No data available.</p>

  const [headers, ...dataRows] = rows

  const columnDefs = useMemo(() =>
    headers.map((h) => ({
      headerName: h || '—',
      field: h,
      sortable: true,
    })),
    [headers]
  )

  const rowData = useMemo(() =>
    dataRows.map((row) =>
      Object.fromEntries(
        headers.map((h, i) => [h, String(row[i] ?? '').replace(/^'/, '')])
      )
    ),
    [dataRows, headers]
  )

  return (
    <div className="dt-wrapper">
      <AgGridReact
        className="dt-grid"
        theme={wildlifeTheme}
        columnDefs={columnDefs}
        rowData={rowData}
        defaultColDef={{ sortable: true, suppressSizeToFit: false }}
        autoSizeStrategy={{ type: 'fitCellContents', skipHeader: false }}
        suppressMovableColumns={false}
        rowHeight={48}
        headerHeight={52}
        pagination
        paginationPageSize={30}
        suppressScrollOnNewData
      />
    </div>
  )
}

export default DataTable
