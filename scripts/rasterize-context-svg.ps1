param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName WindowsBase, PresentationCore
$svgDocument = New-Object System.Xml.XmlDocument
$svgDocument.XmlResolver = $null
$svgDocument.Load([System.IO.Path]::GetFullPath($InputPath))
$svgRoot = $svgDocument.DocumentElement
if ($svgRoot.LocalName -ne 'svg' -or $svgRoot.GetAttribute('viewBox') -ne '0 0 51 51') { throw 'Unexpected pinned AP SVG canvas' }
$svgPaths = @($svgRoot.ChildNodes | Where-Object { $_.NodeType -eq 'Element' })
if ($svgPaths.Count -ne 1 -or $svgPaths[0].LocalName -ne 'path' -or $svgPaths[0].GetAttribute('fill') -ne 'white') { throw 'Unsupported pinned AP SVG shape' }
$pathData = $svgPaths[0].GetAttribute('d')
if ($pathData -notmatch '^[MmZzLlHhVvCcSsQqTtAa0-9eE+., \-]+$') { throw 'Unsupported SVG path commands' }
$geometry = [System.Windows.Media.Geometry]::Parse('F1 ' + $pathData)
$visual = New-Object System.Windows.Media.DrawingVisual
$drawing = $visual.RenderOpen()
$drawing.DrawGeometry([System.Windows.Media.Brushes]::White, $null, $geometry)
$drawing.Close()
$bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap(51, 51, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
$bitmap.Render($visual)
$encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
$encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
$stream = [System.IO.File]::Open([System.IO.Path]::GetFullPath($OutputPath), [System.IO.FileMode]::Create)
try { $encoder.Save($stream) } finally { $stream.Dispose() }
