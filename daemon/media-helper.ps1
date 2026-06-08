# claudpit media helper — persistent, hidden. Reads Windows SMTC (now-playing) and
# emits one compact JSON line per poll on stdout. Controls arrive via a command file
# (play/pause/next/prev) so there are no per-action process spawns / window flashes.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $t) { $m = $asTaskGeneric.MakeGenericMethod($t); $nt = $m.Invoke($null, @($op)); $nt.Wait(-1) | Out-Null; $nt.Result }

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$cmdFile = Join-Path $env:USERPROFILE '.coclaude-pit\media-cmd.txt'
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$lastKey = ''

function Emit($o) { [Console]::Out.WriteLine((ConvertTo-Json $o -Compress)); [Console]::Out.Flush() }

while ($true) {
  try {
    $s = $mgr.GetCurrentSession()
    if (-not $s) { Emit @{ ok = $true; playing = $false }; Start-Sleep -Milliseconds 700; continue }

    if (Test-Path $cmdFile) {
      $cmd = (Get-Content $cmdFile -Raw); Remove-Item $cmdFile -Force
      switch ($cmd.Trim()) {
        'playpause' { [void](Await ($s.TryTogglePlayPauseAsync()) ([bool])) }
        'next'      { [void](Await ($s.TrySkipNextAsync()) ([bool])) }
        'prev'      { [void](Await ($s.TrySkipPreviousAsync()) ([bool])) }
      }
      Start-Sleep -Milliseconds 120
      $s = $mgr.GetCurrentSession()
    }

    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $info = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()
    $key = "$($props.Title)|$($props.Artist)"

    $thumb = ''
    if ($key -ne $lastKey -and $props.Thumbnail) {
      try {
        $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
        $ms = New-Object System.IO.MemoryStream
        $net.CopyTo($ms)
        $bytes = $ms.ToArray()
        if ($bytes.Length -gt 0 -and $bytes.Length -lt 4000000) {
          $thumb = 'data:image/png;base64,' + [Convert]::ToBase64String($bytes)
        }
      } catch { }
      $lastKey = $key
    }

    Emit @{
      ok = $true; playing = ($info.PlaybackStatus -eq 'Playing'); status = "$($info.PlaybackStatus)";
      title = "$($props.Title)"; artist = "$($props.Artist)";
      position = [math]::Round($tl.Position.TotalSeconds); duration = [math]::Round($tl.EndTime.TotalSeconds);
      thumb = $thumb
    }
  } catch {
    Emit @{ ok = $false; error = "$($_.Exception.Message)" }
  }
  Start-Sleep -Milliseconds 700
}
