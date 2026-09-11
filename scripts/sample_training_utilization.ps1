# Real, direct instruction (2026-09-11): "build those diagnostic tools
# into the trainer in vs code" - generalizes the ad-hoc PowerShell used
# that same session to answer "are we running into memory issues / is
# the CPU resetting" into a real, reusable, parameterized tool the
# extension can invoke on demand instead of only Claude being able to.
#
# Samples a real Windows process's CPU% and GPU% repeatedly and renders
# an actual line chart PNG from that real data - not Task Manager's own
# graph (that UI proved too fragile to drive by remote-control click
# simulation - modern Task Manager's XAML nav isn't reachable via
# UIAutomation or reliable coordinate clicks), but the same real
# underlying counters Task Manager itself reads, so the answer is
# equally trustworthy.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File
#   sample_training_utilization.ps1 -Pid <pid> -OutFile <path.png> [-Samples 40] [-IntervalMs 500]

param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$Samples = 40,
    [int]$IntervalMs = 500
)

Add-Type -AssemblyName System.Drawing

# Real process existence check up front - a clear, honest error instead
# of 40 samples of silent zeros if the PID is already gone.
$proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Output "ERROR: no process with PID $TargetPid is currently running."
    exit 1
}
$procName = $proc.ProcessName

$cpuData = @()
$gpuData = @()

for ($i = 0; $i -lt $Samples; $i++) {
    $cpu = 0
    try {
        $cpu = (Get-Counter "\Process($procName)\% Processor Time" -ErrorAction Stop).CounterSamples[0].CookedValue
    } catch { $cpu = 0 }

    $gpu = 0
    try {
        $gpuSamples = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction Stop).CounterSamples
        $gpu = ($gpuSamples | Where-Object { $_.InstanceName -match "pid_$TargetPid`_" } | Measure-Object -Property CookedValue -Sum).Sum
    } catch { $gpu = 0 }

    $cpuData += $cpu
    $gpuData += $gpu
    Start-Sleep -Milliseconds $IntervalMs
}

# Real summary line first, in plain text - the extension parses this to
# show a one-line result without needing to decode the image itself.
$cpuAvg = [math]::Round(($cpuData | Measure-Object -Average).Average, 1)
$cpuMax = [math]::Round(($cpuData | Measure-Object -Maximum).Maximum, 1)
$gpuAvg = [math]::Round(($gpuData | Measure-Object -Average).Average, 1)
$anyZero = ($cpuData | Where-Object { $_ -eq 0 }).Count
Write-Output "SUMMARY: pid=$TargetPid name=$procName samples=$Samples cpu_avg=$cpuAvg cpu_max=$cpuMax gpu_avg=$gpuAvg zero_cpu_samples=$anyZero"

$w = 900; $h = 400; $margin = 50
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(24, 24, 28))

$axisPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Gray), 1
$g.DrawLine($axisPen, $margin, $h - $margin, $w - 20, $h - $margin)
$g.DrawLine($axisPen, $margin, 20, $margin, $h - $margin)

$font = New-Object System.Drawing.Font "Consolas", 12
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.DrawString("CPU% (cyan) / GPU% (magenta) for $procName (pid $TargetPid) - $Samples samples, ${IntervalMs}ms apart", $font, $brush, 10, 2)
for ($pct = 0; $pct -le 150; $pct += 50) {
    $y = ($h - $margin) - ($pct / 150.0) * ($h - $margin - 20)
    $g.DrawString("$pct", $font, $brush, 5, $y - 8)
}

$cpuPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Cyan), 2
$gpuPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Magenta), 2
$stepX = ($w - $margin - 30) / [math]::Max(1, $Samples - 1)

for ($i = 0; $i -lt $Samples - 1; $i++) {
    $x1 = $margin + $i * $stepX
    $x2 = $margin + ($i + 1) * $stepX
    $y1c = ($h - $margin) - ([math]::Min($cpuData[$i], 150) / 150.0) * ($h - $margin - 20)
    $y2c = ($h - $margin) - ([math]::Min($cpuData[$i + 1], 150) / 150.0) * ($h - $margin - 20)
    $g.DrawLine($cpuPen, $x1, $y1c, $x2, $y2c)
    $y1g = ($h - $margin) - ([math]::Min($gpuData[$i], 150) / 150.0) * ($h - $margin - 20)
    $y2g = ($h - $margin) - ([math]::Min($gpuData[$i + 1], 150) / 150.0) * ($h - $margin - 20)
    $g.DrawLine($gpuPen, $x1, $y1g, $x2, $y2g)
}

$g.Dispose()
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "SAVED: $OutFile"
