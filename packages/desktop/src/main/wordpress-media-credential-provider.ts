import type { ProjectId } from "@siteindex/shared";
import type { WordPressCredential } from "../shared/wordpress-credential-types.js";
import type { WordPressCredentialVault } from "./wordpress-credential-vault.js";

interface MediaProjectConfig {
  base_url: string;
  edm?: { image_host?: { type: string } };
}

interface MediaCredentialProviderOptions {
  getProject(id: ProjectId): Promise<{ config: MediaProjectConfig }>;
  vault: Pick<WordPressCredentialVault, "getForHost">;
}

function credentialError(code: "PROJECT_NOT_FOUND" | "WP_NOT_CONFIGURED", message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Resolve a media credential only in the main process, using the project's configured origin.
 * The vault accessor is intentionally not exposed to IPC or the renderer.
 */
export function createWordPressMediaCredentialProvider(options: MediaCredentialProviderOptions) {
  return async (projectId: ProjectId): Promise<WordPressCredential> => {
    let project: { config: MediaProjectConfig };
    try {
      project = await options.getProject(projectId);
    } catch {
      throw credentialError("PROJECT_NOT_FOUND", "项目配置不可用，无法准备媒体任务。");
    }

    if (project.config.edm?.image_host?.type !== "wordpress") {
      throw credentialError("WP_NOT_CONFIGURED", "该项目尚未配置 WordPress 媒体托管。");
    }

    let credential: WordPressCredential | null;
    try {
      credential = await options.vault.getForHost(project.config.base_url);
    } catch {
      // Storage and decrypt details may contain machine-local information; expose a stable prompt only.
      throw credentialError("WP_NOT_CONFIGURED", "本机 WordPress 凭据不可用，请在设置中重新保存。");
    }
    if (credential) return credential;
    throw credentialError("WP_NOT_CONFIGURED", "尚未配置此项目的 WordPress 应用程序密码。");
  };
}
