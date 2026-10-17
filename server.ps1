$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist'))
$rootPrefix = $root + [IO.Path]::DirectorySeparatorChar
$listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$url = "http://127.0.0.1:$port/"
Write-Host "PDF Studio is running at $url"
Write-Host 'Keep this window open. Close it to stop the local app.'
Start-Process $url
$types = @{'.html'='text/html; charset=utf-8';'.mjs'='text/javascript';'.js'='text/javascript';'.css'='text/css';'.wasm'='application/wasm';'.json'='application/json';'.svg'='image/svg+xml';'.png'='image/png';'.ttf'='font/ttf';'.otf'='font/otf';'.pdf'='application/pdf'}
try {
 while ($true) {
  $client = $listener.AcceptTcpClient()
  $client.ReceiveTimeout = 5000
  $client.SendTimeout = 10000
  $stream = $null
  $reader = $null
  try {
   $stream = $client.GetStream()
   $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
   $line = $reader.ReadLine()
   if (!$line -or $line.Length -gt 8192) { continue }
   $parts = $line.Split(' ')
   if ($parts.Length -ne 3) { continue }
   for ($i=0; $i -lt 64; $i++) { $h=$reader.ReadLine(); if ([string]::IsNullOrEmpty($h)) { break } }
   $code = '200 OK'
   $mime = 'application/octet-stream'
   $body = [byte[]]@()
   $method = $parts[0]
   if ($method -ne 'GET' -and $method -ne 'HEAD') { $code='405 Method Not Allowed' }
   else {
    $requestPath = [Uri]::UnescapeDataString(($parts[1] -split '\?',2)[0])
    if ($requestPath -eq '/') { $requestPath='/index.html' }
    $relative = $requestPath.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
    $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (!$path.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase) -or $relative.Contains(':')) { $code='403 Forbidden' }
    elseif (![IO.File]::Exists($path)) { $code='404 Not Found' }
    else { $body=[IO.File]::ReadAllBytes($path); $ext=[IO.Path]::GetExtension($path).ToLowerInvariant(); if ($types.ContainsKey($ext)) { $mime=$types[$ext] } }
   }
   $header="HTTP/1.1 $code`r`nContent-Type: $mime`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
   $headerBytes=[Text.Encoding]::ASCII.GetBytes($header)
   $stream.Write($headerBytes,0,$headerBytes.Length)
   if ($method -ne 'HEAD' -and $body.Length -gt 0) { $stream.Write($body,0,$body.Length) }
   $stream.Flush()
  } catch { Write-Host 'A browser request ended; the server is still running.' }
  finally { if ($reader) { $reader.Dispose() }; if ($stream) { $stream.Dispose() }; $client.Close() }
 }
} finally { $listener.Stop() }
