# Zero-Custody Local Secret Launcher (PowerShell)
# Holds secret strictly in process RAM — never writes to disk or command history.
# Usage: ./scripts/run_with_key.ps1 GEMINI_API_KEY node scripts/smoke.mjs --flag
param(
  [Parameter(Mandatory=$true, Position=0)][string]$EnvVarName,
  [Parameter(Mandatory=$true, Position=1)][string]$Executable,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$CmdArgs
)
if ($EnvVarName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
  Write-Error "Invalid environment variable name: $EnvVarName"
  exit 2
}
$sec = Read-Host "Paste value for $EnvVarName (input hidden)" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  Set-Item -Path "Env:$EnvVarName" -Value $plain
  & $Executable @CmdArgs
  exit $LASTEXITCODE
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item -Path "Env:$EnvVarName" -ErrorAction SilentlyContinue
}
