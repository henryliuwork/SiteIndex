export interface FakeSiteResponse {
  status?: number;
  body?: string;
  contentType?: string;
  delayMs?: number;
  timeout?: boolean;
}

export interface FakeSiteService {
  origin: string;
  boundHost: "127.0.0.1";
  feedUrl: string;
  productUrl(sku: string): string;
  setFeedRows(rows: readonly { sku: string; title?: string; link?: string; price?: string; availability?: string; product_type?: string }[]): void;
  snapshot(): {
    boundHost: string;
    totalRequests: number;
    routeCounts: Record<string, number>;
    statusCounts: Record<string, number>;
    outcomeCounts: Record<string, number>;
    requestBodiesRecorded: false;
    requestHeadersRecorded: false;
  };
  close(): Promise<void>;
}

export function createFakeSiteService(options?: {
  feedRows?: readonly { sku: string; title?: string; link?: string; price?: string; availability?: string; product_type?: string }[];
  feedResponse?: FakeSiteResponse;
  productResponsesBySku?: Record<string, FakeSiteResponse>;
  defaultProductResponse?: FakeSiteResponse;
}): Promise<FakeSiteService>;
