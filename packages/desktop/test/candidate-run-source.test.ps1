$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../scripts/check-candidate-run.ps1"
$sha = '0123456789abcdef0123456789abcdef01234567'
$otherSha = '1123456789abcdef0123456789abcdef01234567'
$tag = @{ ref = 'refs/tags/v0.4.1' }
function Test-Source($run, $ref, $commit, [bool]$expected) {
  $accepted = $true
  try { Assert-CandidateRunSource -Run $run -Version '0.4.1' -ExpectedSource $sha -TagRef $ref -TagCommit $commit }
  catch { $accepted = $false }
  if ($accepted -ne $expected) { throw "Unexpected provenance decision for $($run | ConvertTo-Json -Compress)" }
}
$base = @{ status = 'completed'; conclusion = 'success'; head_sha = $sha }
Test-Source ($base + @{ event = 'workflow_dispatch'; head_branch = 'main' }) $null '' $true
Test-Source ($base + @{ event = 'push'; head_branch = 'v0.4.1' }) $tag $sha $true
Test-Source ($base + @{ event = 'push'; head_branch = 'main' }) $tag $sha $false
Test-Source ($base + @{ event = 'push'; head_branch = 'v0.4.2' }) $tag $sha $false
Test-Source ($base + @{ event = 'workflow_dispatch'; head_branch = 'v0.4.1' }) $tag $sha $false
Test-Source ($base + @{ event = 'push'; head_branch = 'v0.4.1' }) @{ ref = 'refs/tags/v0.4.2' } $sha $false
Test-Source ($base + @{ event = 'push'; head_branch = 'v0.4.1' }) $tag $otherSha $false
$wrongHead = @{ status = 'completed'; conclusion = 'success'; head_sha = $otherSha; event = 'push'; head_branch = 'v0.4.1' }
Test-Source $wrongHead $tag $sha $false
$failed = @{ status = 'completed'; conclusion = 'failure'; head_sha = $sha; event = 'push'; head_branch = 'v0.4.1' }
Test-Source $failed $tag $sha $false
Write-Output 'Candidate run source checks passed.'
