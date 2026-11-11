function Assert-CandidateRunSource {
  param($Run, [string]$Version, [string]$ExpectedSource, $TagRef, [string]$TagCommit)

  if ($Run.status -ne 'completed' -or $Run.conclusion -ne 'success') { throw 'Candidate Release workflow run did not complete successfully.' }
  if ($Run.head_sha -cne $ExpectedSource) { throw 'Candidate run source commit does not match the supplied commit.' }
  if ($Run.event -ceq 'workflow_dispatch' -and $Run.head_branch -ceq 'main') { return }
  $expectedTag = "v$Version"
  if ($Run.event -cne 'push' -or $Run.head_branch -cne $expectedTag) { throw 'Candidate run must be a main workflow_dispatch or matching version tag push.' }
  if ($TagRef.ref -cne "refs/tags/$expectedTag" -or $TagCommit -cne $ExpectedSource) { throw 'Candidate version tag does not resolve to the supplied source commit.' }
}
