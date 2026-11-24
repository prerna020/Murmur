# Murmur: On-Device Resource Measurement Guide

This guide provides exact **PowerShell** and **ADB** commands to measure physical device costs on an Android phone connected over USB from a Windows machine:
1. **Peak Memory (RAM)** during on-device model inference.
2. **Battery Drop** over a fixed benchmark run.
3. **App & Model Storage Size** on disk.

> [!NOTE]
> All measurements run from your laptop terminal via ADB. The mobile app itself does not include battery or memory polling code, keeping the runtime clean and private.

---

## Prerequisites

1. Connect your Android phone to your Windows PC via USB.
2. Enable **Developer Options** and **USB Debugging** on the phone.
3. Set your ADB alias in PowerShell (or use the full path):
   ```powershell
   $adb = "C:\Users\Prerna\AppData\Local\Android\Sdk\platform-tools\adb.exe"
   & $adb devices
   ```
   *Expected output:* Your device serial number with state `device`.

---

## 1. Peak Memory Measurement (RAM / PSS)

On Android, **PSS (Proportional Set Size)** is the standard metric for memory consumption. It represents the private memory of the process plus its proportional share of shared libraries. For Murmur, PSS includes both the ART runtime and the native C++ ExecuTorch / PyTorch runtime where model weights and KV caches reside.

### A. Single Memory Snapshot
To view a detailed breakdown of RAM usage at any moment:
```powershell
& $adb shell dumpsys meminfo com.murmur.app
```

Key lines to inspect in the output:
- **`TOTAL PSS:`** Total physical RAM consumed by Murmur (in KB).
- **`Native Heap:`** Memory allocated by ExecuTorch C++ runtime and Whisper/Qwen tensors.
- **`Java Heap:`** React Native JavaScript bridge and Android UI components.

### B. Continuous Peak Memory Monitor (Recommended during Benchmark Run)
Run this PowerShell loop *while* executing the 50-entry benchmark on the phone. It polls the memory every 2 seconds and tracks the maximum peak PSS:

```powershell
# Continuous Peak Memory Monitor (Run in PowerShell)
$adb = "C:\Users\Prerna\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$maxPssMb = 0
$samples = 0

Write-Host "Monitoring Murmur memory (Press Ctrl+C to stop)..." -ForegroundColor Cyan

while ($true) {
    $raw = & $adb shell dumpsys meminfo com.murmur.app 2>$null | Select-String "TOTAL PSS:"
    if ($raw -match 'TOTAL\s+PSS:\s+(\d+)') {
        $pssKb = [int]$matches[1]
        $pssMb = [math]::Round($pssKb / 1024, 1)
        if ($pssMb -gt $maxPssMb) {
            $maxPssMb = $pssMb
        }
        $timestamp = (Get-Date).ToString("HH:mm:ss")
        Write-Host "[$timestamp] Current PSS: $pssMb MB | Peak PSS: $maxPssMb MB" -ForegroundColor Yellow
        $samples++
    }
    Start-Sleep -Seconds 2
}
```

#### Procedure:
1. Start the PowerShell monitoring script above.
2. In the app, open **🔬 Benchmark** and tap **Run all clips**.
3. Observe memory during:
   - Idle state
   - Model execution (Qwen 3 0.6B prompt encoding and token decoding)
4. Record the final **Peak PSS** value.

---

## 2. Battery Drop Measurement (Over 50 Entries)

Normally, connecting an Android phone via USB continuously charges the battery, masking power consumption. Android provides ADB commands to simulate an unplugged state while maintaining the ADB data connection.

### Step 1: Simulate Unplugged Battery State
Tell Android to stop considering the USB connection as a power source:
```powershell
# Simulate running on battery (stops charging via USB)
& $adb shell dumpsys battery set usb 0
```

### Step 2: Reset Battery Statistics
Clear previous historical battery counters before starting your test:
```powershell
& $adb shell dumpsys batterystats --reset
```

### Step 3: Record Initial Battery Level
```powershell
& $adb shell dumpsys battery | Select-String "level"
```
*Note down the starting percentage (e.g., `level: 85`).*

### Step 4: Run the Benchmark
1. In the app, navigate to **🔬 Benchmark**.
2. Tap **Run all clips**.
3. Wait for all clips to finish.

### Step 5: Read Final Battery Drop & Estimated Consumption
```powershell
# 1. Read ending battery level
& $adb shell dumpsys battery | Select-String "level"

# 2. View estimated energy consumption attributed to Murmur (in mAh)
& $adb shell dumpsys batterystats com.murmur.app | Select-String -Pattern "Estimated power use", "Capacity:" -Context 1
```

### Step 6: Restore Normal USB Charging
**Important**: Always restore normal battery behavior when testing is complete:
```powershell
& $adb shell dumpsys battery reset
```

---

## 3. App Size & Storage Footprint

Murmur's on-device footprint:
1. Installed APK (code and native libraries).
2. Downloaded model files (Whisper small.en and Qwen 3 0.6B), in the app's
   private external files folder `react-native-executorch`.
3. The encrypted journal database.

A release build is not debuggable, so `adb shell run-as` does not work on it.
Use Murmur's own **Settings → Storage used** card, which measures the database,
models, temporary audio and benchmark clips on the phone.

### A. APK file size on the laptop

```powershell
$apk = Get-Item "android\app\build\outputs\apk\release\app-release.apk"
Write-Host ("APK File Size: {0:N1} MB ({1:N0} bytes)" -f ($apk.Length / 1MB), $apk.Length)
```

### B. Installed APK size on the phone

```powershell
$apkPath = (& $adb shell pm path com.murmur.app) -replace 'package:', '' | ForEach-Object { $_.Trim() }
& $adb shell ls -lh $apkPath
```

### C. Model files

```powershell
& $adb shell ls -l /sdcard/Android/data/com.murmur.app/files/react-native-executorch
```

Some phones block `adb shell` from listing `Android/data`. If so, use the
Settings card in the app.

---

## 4. Summary measurement sheet (fill in)

Download sizes were measured with HTTP HEAD on 2026-11-23. Everything else is
not measured until you fill it in.

| Resource metric | How | Measured value |
| :--- | :--- | :---: |
| Phone model | `adb shell getprop ro.product.model` | OPPO CPH2665 |
| Android version | `adb shell getprop ro.build.version.release` | 16 (API 36) |
| Release APK size | section 3A | |
| Whisper small.en download | HTTP HEAD | 510 MB (XNNPACK INT8) or 881 MB (Vulkan FP16) |
| Qwen 3 0.6B download | HTTP HEAD | 494 MB |
| Models on disk | Settings → Storage used | |
| Peak RAM, idle | `dumpsys meminfo com.murmur.app` | |
| Peak RAM, during tag suggestion | continuous PSS monitor | |
| Peak RAM, during English transcription | continuous PSS monitor | |
| Battery drop, one benchmark run | `dumpsys battery` level delta | |
| Latency per entry | `benchmark/results.md` | |