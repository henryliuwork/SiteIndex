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

export interface FakeWordPressService {
  origin: string;
  boundHost: "127.0.0.1";
  currentUserEndpoint: string;
  mediaEndpoint: string;
  snapshot(): {
    boundHost: string;
    origin: string;
    totalRequests: number;
    routeCounts: Record<string, number>;
    statusCounts: Record<string, number>;
    outcomeCounts: Record<string, number>;
    mediaCount: number;
    requestBodiesRecorded: false;
    requestHeadersRecorded: false;
  };
  close(): Promise<void>;
}

export interface FakeCredentialCanary {
  username: string;
  applicationPassword: string;
  basicToken: string;
  authorization: string;
}

export interface FakeWordPressStoredMedia {
  slug: string;
  source_url: string;
  body: Uint8Array;
}

export function createFakeGraphqlService(options?: {
  responsesBySku?: Record<string, FakeGraphqlResponse>;
  rateLimitAfter?: number;
  defaultResponse?: FakeGraphqlResponse;
}): Promise<FakeGraphqlService>;

export function createFakeWordPressService(options?: {
  credentials?: FakeCredentialCanary;
  currentUserStatus?: number;
  mediaGetStatus?: number;
  mediaGetStatuses?: number[];
  mediaPostStatus?: number;
  mediaPostStatuses?: number[];
  persistMediaBeforePostFailure?: boolean;
  mediaSourcePath?: string;
  onMediaPersist?: (media: FakeWordPressStoredMedia) => void | Promise<void>;
  mediaMetaStatus?: number;
  uploadFilesCapability?: boolean;
  rateLimitAfter?: number;
  disconnectAfterPersist?: number;
}): Promise<FakeWordPressService>;

export function createFakeCredentialCanary(): FakeCredentialCanary;

export function scanCredentialCanary(value: unknown, credentials: FakeCredentialCanary): {
  passed: boolean;
  matchCount: number;
  matchedKinds: string[];
};
