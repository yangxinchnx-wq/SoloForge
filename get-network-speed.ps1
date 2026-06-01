# Get Network Speed PowerShell Script
try {
    $counters = Get-Counter -Counter '\Network Interface(*)\Bytes Sent/sec','\Network Interface(*)\Bytes Received/sec' -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop
    foreach ($sample in $counters.CounterSamples) {
        Write-Output $sample.CookedValue
    }
} catch {
    Write-Output "ERROR: $($_.Exception.Message)"
}
