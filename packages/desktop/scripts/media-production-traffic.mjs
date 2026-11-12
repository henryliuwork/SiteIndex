const PHASE_EXPECTATIONS = {
  success: { posts: 2, responses201: 2, uploaded: 2 },
  "auth-401": { posts: 2, responses201: 1, uploaded: 1, auth401: 1 },
  "forbidden-403": { posts: 2, responses201: 1, uploaded: 1, auth403: 1 },
  "post-lost": { posts: 1, responses201: 0, uploaded: 1, responseLost: 1 },
  retry: { posts: 0, responses201: 0, uploaded: 0, recoveryLookup: true },
  "post-429": { posts: 1, responses201: 0, uploaded: 1, http429: 1, retryAfterOneSecond: 1 },
  "retry-429": { posts: 0, responses201: 0, uploaded: 0, recoveryLookup: true },
  "post-503": { posts: 1, responses201: 0, uploaded: 1, http503: 1 },
  "retry-503": { posts: 0, responses201: 0, uploaded: 0, recoveryLookup: true },
};

export function mediaTrafficChecks(phase, traffic) {
  const expected = PHASE_EXPECTATIONS[phase];
  if (!expected) throw new Error(`Unknown media production traffic phase: ${phase}`);

  const checks = {
    createPostCountMatches: traffic.mediaCreatePosts === expected.posts,
    successfulCreateResponseCountMatches: traffic.mediaCreateResponses201 === expected.responses201,
    uploadedObjectCountMatches: traffic.uploadedObjects === expected.uploaded,
  };
  if (expected.auth401 !== undefined) checks.auth401CountMatches = traffic.auth401 === expected.auth401;
  if (expected.auth403 !== undefined) checks.auth403CountMatches = traffic.auth403 === expected.auth403;
  if (expected.http429 !== undefined) checks.http429CountMatches = traffic.http429 === expected.http429;
  if (expected.http503 !== undefined) checks.http503CountMatches = traffic.http503 === expected.http503;
  if (expected.retryAfterOneSecond !== undefined) {
    checks.retryAfterOneSecondHeaderSentOnce = traffic.retryAfterOneSecondHeadersSent === expected.retryAfterOneSecond;
  }
  if (expected.responseLost !== undefined) {
    checks.responseLostAfterCommitCountMatches = traffic.responseLostAfterCommit === expected.responseLost;
  }
  if (expected.recoveryLookup) {
    checks.slugLookupObserved = traffic.mediaSlugLookups >= 1;
    checks.retryUsesSlugLookupWithoutCreate =
      traffic.mediaSlugLookups >= 1 &&
      traffic.mediaCreatePosts === 0 &&
      traffic.mediaCreateResponses201 === 0 &&
      traffic.uploadedObjects === 0;
  }
  checks.matchesExpectedTraffic = Object.values(checks).every(Boolean);
  return checks;
}
