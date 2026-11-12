import { describe, expect, it } from "vitest";
import { hasMediaProgressEvidence } from "../src/main/media-production-assertions.js";
import { mediaTrafficChecks } from "../scripts/media-production-traffic.mjs";

describe("packaged media E2E progress assertion", () => {
  it("requires utilityProcess progress to reach the renderer through preload", () => {
    expect(hasMediaProgressEvidence(3, 2)).toBe(true);
    expect(hasMediaProgressEvidence(0, 2)).toBe(false);
    expect(hasMediaProgressEvidence(3, 0)).toBe(false);
  });
});

describe("packaged media E2E request evidence", () => {
  it("requires a slug lookup before a recovered retry and forbids a second create POST", () => {
    const checks = mediaTrafficChecks("retry-429", {
      mediaSlugLookups: 1,
      mediaCreatePosts: 0,
      mediaCreateResponses201: 0,
      uploadedObjects: 0,
    });

    expect(checks.slugLookupObserved).toBe(true);
    expect(checks.retryUsesSlugLookupWithoutCreate).toBe(true);
    expect(checks.matchesExpectedTraffic).toBe(true);
    expect(
      mediaTrafficChecks("retry-429", {
        mediaSlugLookups: 0,
        mediaCreatePosts: 0,
        mediaCreateResponses201: 0,
        uploadedObjects: 0,
      }).matchesExpectedTraffic,
    ).toBe(false);
  });

  it("checks successful 201 response baselines instead of inferring success from zero POSTs", () => {
    expect(
      mediaTrafficChecks("success", {
        mediaSlugLookups: 2,
        mediaCreatePosts: 2,
        mediaCreateResponses201: 2,
        uploadedObjects: 2,
      }).matchesExpectedTraffic,
    ).toBe(true);
    expect(
      mediaTrafficChecks("success", {
        mediaSlugLookups: 2,
        mediaCreatePosts: 2,
        mediaCreateResponses201: 0,
        uploadedObjects: 2,
      }).successfulCreateResponseCountMatches,
    ).toBe(false);
  });

  it("requires exactly one 429 response with Retry-After and no automatic resend", () => {
    const checks = mediaTrafficChecks("post-429", {
      mediaSlugLookups: 1,
      mediaCreatePosts: 1,
      mediaCreateResponses201: 0,
      uploadedObjects: 1,
      http429: 1,
      retryAfterOneSecondHeadersSent: 1,
    });

    expect(checks.http429CountMatches).toBe(true);
    expect(checks.retryAfterOneSecondHeaderSentOnce).toBe(true);
    expect(checks.createPostCountMatches).toBe(true);
    expect(checks.matchesExpectedTraffic).toBe(true);
    expect(
      mediaTrafficChecks("post-429", {
        mediaSlugLookups: 1,
        mediaCreatePosts: 2,
        mediaCreateResponses201: 0,
        uploadedObjects: 1,
        http429: 1,
        retryAfterOneSecondHeadersSent: 1,
      }).matchesExpectedTraffic,
    ).toBe(false);
  });
});
