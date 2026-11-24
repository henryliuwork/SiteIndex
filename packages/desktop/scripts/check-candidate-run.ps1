function Assert-CandidateRunSource {
  param($Run, [string]$Version, [string]$ExpectedSource, $TagRef, [string]$TagCommit)

  if ($Run.status -ne 'completed' -or $Run.conclusion -ne 'success') { throw 'Candidate Release workflow run did not complete successfully.' }
  if ($Run.head_sha -cne $ExpectedSource) { throw 'Candidate run source commit does not match the supplied commit.' }
  if ($Run.event -ceq 'workflow_dispatch' -and $Run.head_branch -ceq 'main') { return }
  if ($Version -ceq '0.8.2' -and $ExpectedSource -ceq 'e60447a079e95f6cfcbf259527f7e9a84098e439' -and $Run.event -ceq 'workflow_dispatch' -and $Run.head_branch -ceq 'c/version-0.8.2') { return }
  $expectedTag = "v$Version"
  if ($Run.event -cne 'push' -or $Run.head_branch -cne $expectedTag) { throw 'Candidate run must be a main workflow_dispatch or matching version tag push.' }
  if ($TagRef.ref -cne "refs/tags/$expectedTag" -or $TagCommit -cne $ExpectedSource) { throw 'Candidate version tag does not resolve to the supplied source commit.' }
}
