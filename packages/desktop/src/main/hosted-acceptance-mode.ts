export const HOSTED_WINDOWS_ACCEPTANCE_ARGUMENT = "--siteindex-hosted-acceptance";

export interface HostedAcceptanceModeOptions {
  isPackaged: boolean;
  platform: string;
  argv: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Only the isolated GitHub-hosted Windows installer harness may opt into local
 * HTTP fixtures. Production launches keep Core and the credential vault strict.
 */
export function isHostedWindowsAcceptanceMode(options: HostedAcceptanceModeOptions): boolean {
  return options.isPackaged
    && options.platform === "win32"
    && options.environment.GITHUB_ACTIONS === "true"
    && options.environment.SITEINDEX_RUNNER_ENVIRONMENT === "github-hosted"
    && options.environment.SITEINDEX_HOSTED_ACCEPTANCE === "1"
    && options.argv.includes(HOSTED_WINDOWS_ACCEPTANCE_ARGUMENT);
}
