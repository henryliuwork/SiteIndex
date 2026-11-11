export interface FakeGraphqlResponse {
  httpStatus?: number;
  body?: unknown;
  delayMs?: number;
}

export interface FakeGraphqlService {
  origin: string;
  endpoint: string;
  boundHost: "127.0.0.1";
  snapshot(): {
    boundHost: string;
    origin: string;
    totalRequests: number;
    routeCounts: Record<string, number>;
    statusCounts: Record<string, number>;
    outcomeCounts: Record<string, number>;
    requestBodiesRecorded: false;
    requestHeadersRecorded: false;
  };
  close(): Promise<void>;
}

export function createFakeGraphqlService(options?: {
  responsesBySku?: Record<string, FakeGraphqlResponse>;
  rateLimitAfter?: number;
  defaultResponse?: FakeGraphqlResponse;
}): Promise<FakeGraphqlService>;
